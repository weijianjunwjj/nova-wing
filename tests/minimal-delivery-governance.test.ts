import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PlanningService, PlanningStore, planningReviewContentHash } from '../packages/development-guardian/planning/service.js'
import { PlanningEventStore } from '../packages/development-guardian/planning/telemetry.js'
import type { PlanningSemanticReviewer } from '../packages/development-guardian/planning/semantic-reviewer.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { inspectDeliveryTarget } from '../packages/development-guardian/delivery/runtime-plan.js'
import { stagedVerificationContract } from '../packages/development-guardian/delivery/staged-verification.js'
import { assertionContractHash, verifyApprovedBlueprint } from '../packages/development-guardian/delivery/verification-blueprint.js'
import { bindObligationsAtCommit, blueprintReviewEvidenceHash, type BlueprintBatchReviewer } from '../packages/development-guardian/delivery/verification-blueprint-batch.js'
import { resolveCapability, conservativeCapabilityResolver } from '../packages/development-guardian/delivery/capability-layer.js'
import { planDraftSchema } from '../packages/development-guardian/planning/model.js'

const fixture = JSON.parse(await readFile('tests/fixtures/minimal-module-plan.json', 'utf8')) as { requirement: string; draft: unknown }
const draft = planDraftSchema.parse(fixture.draft)

async function failedPlan() {
  const root = await mkdtemp(join(tmpdir(), 'nw-same-plan-'))
  const store = new PlanningStore(join(root, 'plans')), events = new PlanningEventStore(join(root, 'events.jsonl'))
  let generations = 0
  const provider = async () => { generations++; return { text: JSON.stringify(draft), provider: 'codex' } }
  const service = new PlanningService(provider, store, events, async () => { throw new Error('fixture unavailable') })
  const { plan } = await service.generate(fixture.requirement)
  assert.equal(plan.status, 'planning_failed')
  return { root, store, plan, generations: () => generations,
    restart: (reviewer: PlanningSemanticReviewer) => new PlanningService(provider, store, events, reviewer) }
}
const pass: PlanningSemanticReviewer = async () => ({ review: { verdict: 'PASS', issues: [] }, provider: 'deepseek', model: 'deepseek-fixture' })

test('production HTTP re-review after restart keeps version/content, issues bound receipt and never freezes', async () => {
  const f = await failedPlan(); let calls = 0
  const service = f.restart(async input => { calls++; input.plan.tasks[0]!.objective = 'untrusted mutation'; return pass(input) })
  const launchpad = await createNovaWingLaunchpad({ configDirectory: join(f.root, 'configs'), dependencies: {
    planningService: service, createWorkSession: async () => { throw new Error('must never execute') },
  } })
  try {
    const address = await launchpad.start()
    const body = { planId: f.plan.id, version: f.plan.version, contentHash: planningReviewContentHash(f.plan) }
    const post = (value: unknown, authorized = true) => fetch(`${address.url}/api/planning/review`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: address.url,
        ...(authorized ? { 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest() } : {}) }, body: JSON.stringify(value) })
    assert.equal((await post(body, false)).status, 403)
    assert.equal((await post({ ...body, version: 2 })).status, 409)
    assert.equal((await post({ ...body, contentHash: '0'.repeat(64) })).status, 409)
    assert.equal(calls, 0)
    assert.equal((await post(body)).status, 200)
    const saved = (await service.get(f.plan.id))!
    assert.equal(saved.status, 'ready_for_approval'); assert.equal(saved.version, 1)
    assert.equal(planningReviewContentHash(saved), body.contentHash)
    assert.deepEqual(saved.acceptancePlan, f.plan.acceptancePlan)
    assert.equal(saved.semanticReviewBinding?.contentHash, body.contentHash)
    assert.equal(saved.semanticReviewBinding?.planId, f.plan.id)
    assert.equal(saved.semanticReviewBinding?.planVersion, 1)
    assert.equal(saved.approvedAt, null); assert.equal(await service.getSnapshot(saved.id, 1), undefined)
    assert.equal(calls, 1); assert.equal(f.generations(), 1)
    saved.tasks[0]!.objective += ' post-review change'; await f.store.save(saved)
    await assert.rejects(service.approve(saved.id, 1), /not ready/u)
  } finally { await launchpad.close() }
})

test('re-review discards drift in flight and blocks concurrent, unavailable and self-review results', async () => {
  const f = await failedPlan(); let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve })
  const service = f.restart(async input => { started(); await held; return pass(input) })
  const hash = planningReviewContentHash(f.plan)
  const pending = service.review(f.plan.id, 1, hash); await entered
  await assert.rejects(service.review(f.plan.id, 1, hash), /busy/u)
  const changed = structuredClone(f.plan); changed.tasks[0]!.objective += ' changed in flight'; await f.store.save(changed)
  release(); await assert.rejects(pending, /changed/u)
  assert.equal((await f.store.get(f.plan.id))!.semanticReviewBinding, undefined)
  for (const reviewer of [async () => { throw new Error('offline') },
    async () => ({ review: { verdict: 'PASS' as const, issues: [] }, provider: 'codex' })]) {
    const result = await f.restart(reviewer).review(changed.id, 1, planningReviewContentHash(changed))
    assert.equal(result.plan.status, 'planning_failed'); assert.equal(result.plan.semanticReviewBinding, undefined)
  }
  assert.equal(f.generations(), 1)
})

const run = promisify(execFile)
async function blueprintFixture(all = false) {
  const repo = await mkdtemp(join(tmpdir(), 'nw-blueprint-batch-'))
  const git = async (...args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim()
  await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await mkdir(join(repo, 'tests'))
  const pairs = (all ? draft.acceptancePlan.criteria : [draft.acceptancePlan.criteria[0]!])
    .flatMap(criterion => criterion.assertions.map(assertion => ({ criterion, assertion })))
  const assertions = pairs.map(pair => pair.assertion)
  for (const assertion of assertions) await writeFile(join(repo, `tests/${assertion.id}.test.mjs`),
    `import test from 'node:test'; import assert from 'node:assert/strict';\n` +
    `const assertionId = '${assertion.id}'; const assertionContractHash = '${assertionContractHash(assertion)}';\n` +
    `// Frozen structural fixture contract: ${JSON.stringify(assertion)}\n` +
    `test('exported module is callable', () => { assert.equal(typeof add, 'function'); assert.equal(add(1, 2), 3) });\n` +
    `import { add } from '../sum.mjs';\n`)
  await writeFile(join(repo, 'sum.mjs'), 'export function add(a, b) { return a + b }\n')
  await git('add', '.'); await git('commit', '-qm', 'independent batch fixture')
  const inspected = await inspectDeliveryTarget(repo)
  const target = { ...inspected, id: 'fixture', snapshotId: 'fixture', targetType: 'existing_repository' as const,
    boundAt: new Date().toISOString(), platform: process.platform, source: 'trusted_test' as const }
  const inputs = pairs.map(({ assertion, criterion }) => {
    const capability = resolveCapability({ assertion, criterion, requirement: draft.clauses.find(clause => clause.id === assertion.requirementId)! }, conservativeCapabilityResolver)
    const staged = stagedVerificationContract({ assertion, criterion, ownerTaskId: 'T1', coveringTaskIds: ['T1'], target, capability })
    return { assertion, criterion, obligation: staged.obligation!, target, commit: inspected.baselineCommit }
  })
  return { inputs, repo }
}
const batchPass: BlueprintBatchReviewer = async inputs => ({ results: inputs.map(input => ({
  assertionId: input.assertion.id, evidenceHash: blueprintReviewEvidenceHash(input), verdict: 'PASS', issues: [],
})) })

test('one batch review returns distinct bound approvals; missing, duplicate, unknown, stale and rejected rows fail closed', async () => {
  const f = await blueprintFixture(); let calls = 0
  const approved = await bindObligationsAtCommit(f.inputs, async inputs => { calls++; return batchPass(inputs) })
  assert.equal(calls, 1); assert.equal(approved.length, 2)
  assert.notEqual(approved[0]!.review.binding!.evidenceHash, approved[1]!.review.binding!.evidenceHash)
  const input = f.inputs[1]!
  assert.throws(() => verifyApprovedBlueprint({ ...approved[1]!, review: approved[0]!.review }, {
    assertion: input.assertion, criterion: input.criterion, runtimeTaskId: 'T1', target: input.target,
    obligation: input.obligation, implementationCommit: input.commit }), /invalid or stale/u)
  const stripped = structuredClone(approved[1]!)
  delete stripped.review.binding
  assert.throws(() => verifyApprovedBlueprint(stripped, {
    assertion: input.assertion, criterion: input.criterion, runtimeTaskId: 'T1', target: input.target,
    obligation: input.obligation, implementationCommit: input.commit }), /invalid or stale/u)
  for (const mode of ['missing', 'duplicate', 'unknown', 'hash', 'rejected']) {
    let attempts = 0
    await assert.rejects(bindObligationsAtCommit(f.inputs, async inputs => {
      attempts++
      const results = inputs.map(packet => ({ assertionId: packet.assertion.id,
        evidenceHash: blueprintReviewEvidenceHash(packet), verdict: 'PASS', issues: [] as { code: string; message: string }[] }))
      if (mode === 'missing') results.pop()
      if (mode === 'duplicate') results[1] = results[0]!
      if (mode === 'unknown') results[1]!.assertionId = 'UNKNOWN'
      if (mode === 'hash') results[1]!.evidenceHash = results[0]!.evidenceHash
      if (mode === 'rejected') { results[1]!.verdict = 'REVISION_REQUIRED'; results[1]!.issues = [{ code: 'OTHER', message: 'weak evidence' }] }
      return { results }
    }))
    assert.equal(attempts, 1)
  }
})

test('batch source or branch mutation during review invalidates every approval', async () => {
  for (const mutation of ['source', 'branch']) {
    const f = await blueprintFixture()
    await assert.rejects(bindObligationsAtCommit(f.inputs, async inputs => {
      if (mutation === 'source') await writeFile(join(f.repo, 'sum.mjs'), 'export const add = () => 0\n')
      else await run('git', ['checkout', '-qb', 'changed-branch'], { cwd: f.repo })
      return batchPass(inputs)
    }), /changed/u)
  }
})

test('actual pure-module plan retains all 40 assertions and uses exact command evidence, never invented HTTP', () => {
  let assertions = 0
  for (const criterion of draft.acceptancePlan.criteria) for (const assertion of criterion.assertions) {
    assertions++
    const capability = resolveCapability({ assertion, criterion,
      requirement: draft.clauses.find(clause => clause.id === assertion.requirementId)! }, conservativeCapabilityResolver)
    assert.equal(capability.family, 'command', assertion.id)
    assert.equal(capability.verificationCommand, undefined, 'An absent exact test must not become a fabricated command')
  }
  assert.equal(assertions, 40)
})

test('explicit API and browser criteria remain external interfaces even when they mention functions', () => {
  const criterion = structuredClone(draft.acceptancePlan.criteria[0]!)
  const assertion = { ...criterion.assertions[0]!, observableBehavior: 'GET /api/add calls add(a,b)', expectedEvidence: 'HTTP JSON response' }
  criterion.level = 'api'
  const input = { assertion, criterion, requirement: draft.clauses[0]! }
  assert.equal(resolveCapability(input, conservativeCapabilityResolver).family, 'http_api')
  criterion.level = 'ui'
  assert.equal(resolveCapability(input, conservativeCapabilityResolver).family, 'browser_ui')
})

// Structural fixture only: the mock reviewer does not establish real semantic acceptance.
test('the complete saved 40-assertion set prepares and reviews in one call without grouping away assertions', async () => {
  const f = await blueprintFixture(true); let calls = 0
  const approved = await bindObligationsAtCommit(f.inputs, async inputs => {
    calls++; assert.equal(inputs.length, 40); return batchPass(inputs)
  })
  assert.equal(calls, 1); assert.equal(approved.length, 40)
  assert.equal(new Set(approved.map(value => value.review.binding!.evidenceHash)).size, 40)
})
