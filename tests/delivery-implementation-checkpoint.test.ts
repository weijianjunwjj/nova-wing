/**
 * E0-H1 host-owned implementation checkpoint handoff.
 *
 * Proves the required safety scenarios around the Delivery VERIFY implementation
 * commit: no false drift, tamper refusal, no forged authority, host-generated
 * dispatchId binding, one-time acknowledgement, full evidence invalidation, and
 * the ordering rule that no verifier runs before ownership is acknowledged and
 * durably persisted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, type PlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { bindDeliveryTarget, compileRuntimePlan, workSessionDefinitionFor,
  type VerificationCapabilityResolver } from '../packages/development-guardian/delivery/runtime-plan.js'
import { DeliveryStore } from '../packages/development-guardian/delivery/service.js'
import { createDeliveryRuntimeDispatcher } from '../packages/development-guardian/delivery/runtime-adapter.js'
import { createTaskStateV2, loadTaskStateV2, type TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { V2ControllerTaskRunner, type V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import { ImplementationCheckpointError, consumeImplementationCheckpoint,
  createImplementationCheckpointAuthority } from '../packages/development-guardian/work-session/implementation-checkpoint.js'

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

const supported: VerificationCapabilityResolver = () => ({ capability: 'SUPPORTED', capabilityId: 'fixture-business-observation-v1',
  contractAssertionId: 'A1', verificationCommand: 'node --test tests/cart.test.js',
  reason: '隔离 fixture 收集行为前后业务状态。' })

function snapshotFixture(): PlanSnapshot {
  const requirement = '顾客增加两件不同商品、修改数量并删除一件后，购物车总金额必须精确更新。'
  const behavior = '顾客加入两件不同商品、改变第一件数量并删除第二件后，页面和持久化购物车都显示精确合计。'
  const draft: PlanDraft = {
    clauses: [{ id: 'R1', statement: requirement, type: 'business-rule', priority: 'must',
      source: { excerpt: requirement, location: 'fixture:1', origin: 'customer_requirement' },
      ambiguity: { ambiguous: false, note: '' } }],
    analysis: { productGoal: '精确计算购物车金额', summary: '顾客操作购物车后可观察金额变化。',
      userRoles: [{ id: 'U1', name: '顾客', goals: ['看到购物车金额变化'] }],
      businessFlows: [{ id: 'F1', title: '购物车金额', steps: ['加入两件不同商品', '修改数量并删除一件后查看合计'], requirementIds: ['R1'] }] },
    productScope: { inScope: ['购物车金额计算'], outOfScope: ['支付'] },
    architecture: { summary: '以商品单价、数量和购物车状态计算合计。', components: ['购物车'], decisions: [] },
    tasks: [{ id: 'T1', title: '购物车金额', objective: '实现增减、删除和精确合计', requirementIds: ['R1'],
      outputs: ['可观察的购物车状态'], dependencyIds: [], acceptanceCriterionIds: ['C1'], complexity: 'small' }],
    acceptancePlan: { strategy: '在隔离数据上操作并读取持久化结果。', criteria: [{ id: 'C1', requirementIds: ['R1'],
      description: behavior, level: 'integration', expectedEvidence: '操作前后状态及金额', blocking: true,
      assertions: [{ id: 'A1', requirementId: 'R1', observableBehavior: behavior,
        expectedOutcome: '两种商品的数量、删除结果及剩余精确合计与持久化值一致。',
        expectedEvidence: '逐步状态、数量、单价和最终合计的可复核记录。', blocking: true }] }] },
    risks: [], assumptions: [], customerQuestions: [],
  }
  const id = '33333333-3333-4333-8333-333333333333'
  const plan = createDevelopmentPlan(draft, { id, text: requirement, receivedAt: new Date().toISOString() }, id)
  plan.semanticReview = { verdict: 'PASS', issues: [] }
  plan.status = 'ready_for_approval'
  const approval = { planId: id, planVersion: 1, approvedAt: new Date().toISOString(), actor: 'customer' as const,
    source: 'customer_mode' as const, contentHash: planContentHash(canonicalPlanContent(plan)) }
  return createPlanSnapshot(plan, approval, null)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nw-e0h1-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'checkout', '-qb', 'codex/e0h1-fixture')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await mkdir(join(repo, 'tests'))
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test tests/cart.test.js' } }))
  await writeFile(join(repo, 'tests/cart.test.js'), "const items = [{ price: 12, count: 2 }, { price: 5, count: 1 }]; items.pop(); if (items.reduce((sum, item) => sum + item.price * item.count, 0) !== 24) throw new Error('cart total')\n")
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'fixture baseline')
  return { root, repo, snapshot: snapshotFixture() }
}

async function trustedGitState(repo: string) {
  const status = (await exec('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo })).stdout
  const entries = parseGitStatus(status)
  const indexDiff = (await exec('git', ['diff', '--cached', '--binary'], { cwd: repo })).stdout
  return { repositoryIdentity: await realpath(repo), branch: await git(repo, 'branch', '--show-current'),
    headSha: await git(repo, 'rev-parse', 'HEAD'), changedFiles: entries.map((item) => item.path),
    worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(repo, entries,
      { strict: true })).update(indexDiff).digest('hex') }
}

/** Bind one inspected implementation file as a host checkpoint for an exact dispatch. */
async function issueCheckpoint(repo: string, dispatchId: string, filename = 'feature.js') {
  await writeFile(join(repo, filename), 'export const implemented = true\n')
  const before = await trustedGitState(repo)
  const authority = await createImplementationCheckpointAuthority({
    repoPath: repo, sessionId: 's', taskId: 'T1', dispatchId, action: 'VERIFY',
    allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: before.repositoryIdentity,
    expectedBranch: before.branch, baselineCommit: before.headSha, before })
  assert.ok(authority, 'expected a host checkpoint authority for a dirty implementation')
  return { before, authority, observed: await trustedGitState(repo) }
}

const AGENT_EXECUTOR = { id: 'executor', identity: { agent: 'executor', provider: 'executor-provider', runtimeIdentity: 'runtime-executor' },
  available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true, review: false } }
const AGENT_REVIEWER = { id: 'reviewer', identity: { agent: 'reviewer', provider: 'reviewer-provider', runtimeIdentity: 'runtime-reviewer' },
  available: true, quotaExhausted: false, degraded: false, capabilities: { coding: false, reasoning: true, verification: false, review: true } }

async function deliveryHarness(execute: 'dirty' | 'commit' | 'none', verify: 'pass' | 'blocked') {
  const f = await fixture()
  const target = await bindDeliveryTarget(f.snapshot, f.repo, 'trusted_test')
  const compiled = await compileRuntimePlan(f.snapshot, target, { resolver: supported,
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  // Place the owner binding in the exact BOUND_EXECUTABLE readiness the adapter's
  // deterministic command path supports; blueprint provisioning is orthogonal here.
  const plan = { ...compiled, acceptanceBindings: compiled.acceptanceBindings.map((binding) => ({
    ...binding, stagedVerification: { ...binding.stagedVerification, readiness: 'BOUND_EXECUTABLE' as const } })) }
  const definition = workSessionDefinitionFor(compiled, 'e0h1-session')
  const store = new DeliveryStore(join(f.root, 'delivery'))
  const actions: string[] = []
  const observer: { persisted: TaskStateV2[]; verifierSawPersistedState: TaskStateV2 | undefined } =
    { persisted: [], verifierSawPersistedState: undefined }
  const fallback: V2ActionDispatcher = {
    inspectRepository: () => trustedGitState(f.repo),
    dispatch: async ({ action }) => {
      actions.push(action)
      if (action === 'EXECUTE') {
        if (execute === 'dirty') {
          await writeFile(join(f.repo, 'feature.js'), 'export const implemented = true\n')
          return { status: 'SUCCESS', changedFiles: ['feature.js'], repositoryChanged: true }
        }
        if (execute === 'commit') {
          await writeFile(join(f.repo, 'feature.js'), 'export const implemented = true\n')
          await git(f.repo, 'add', '.')
          await git(f.repo, 'commit', '-qm', 'executor committed directly')
          return { status: 'SUCCESS', changedFiles: ['feature.js'], repositoryChanged: true }
        }
        return { status: 'SUCCESS' }
      }
      if (action === 'VERIFY') {
        // The verifier records the durable state it can see. If the controller has
        // not already accepted and persisted the checkpoint, this is the old HEAD.
        observer.verifierSawPersistedState = observer.persisted.at(-1)
        if (verify === 'blocked') return { status: 'BLOCKED', blockers: ['exact delivery verifier unavailable in fixture'] }
        return { status: 'SUCCESS', verificationResults: [{ name: 'node --test tests/cart.test.js',
          stepId: 'node --test tests/cart.test.js', status: 'passed' }] }
      }
      return { status: 'BLOCKED', blockers: ['independent reviewer unavailable in fixture'] }
    },
  }
  const dispatcher = createDeliveryRuntimeDispatcher(plan, store, fallback)
  const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch,
    agents: [AGENT_EXECUTOR, AGENT_REVIEWER], dispatcher })
  const context = (taskState: TaskStateV2) => ({ taskStateV2: taskState,
    persistTaskStateV2: async (state: TaskStateV2) => { observer.persisted.push(state) } })
  return { ...f, plan, definition, runner, actions, store, observer, context }
}

test('S1 EXECUTE → VERIFY implementation commit is accepted and the Controller continues to REVIEW', async () => {
  const h = await deliveryHarness('dirty', 'pass')
  const base = await trustedGitState(h.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: base }
  const result = await h.runner.run(h.definition.tasks[0]!, undefined, undefined, h.context(initial))
  assert.ok(h.actions.includes('REVIEW'), JSON.stringify({ actions: h.actions, status: result.status, humanRequired: result.humanRequired }))
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  const head = await git(h.repo, 'rev-parse', 'HEAD')
  assert.notEqual(head, base.headSha)
  assert.equal(result.taskStateV2?.gitState.headSha, head)
  assert.equal(result.taskStateV2?.gitState.changedFiles.length, 0)
  assert.equal((result.taskStateV2?.implementationCheckpoints ?? []).length, 1)
  assert.equal(loadTaskStateV2(result.taskStateV2).implementationCheckpoints?.[0]?.commitSha, head)
  assert.equal(await git(h.repo, 'status', '--porcelain'), '')
})

test('S2 tampering with the inspection, parent, branch, scope, symlink and hardlink is refused', async () => {
  const f = await fixture()
  const branch = await git(f.repo, 'branch', '--show-current')
  const identity = await realpath(f.repo)
  const baseline = await git(f.repo, 'rev-parse', 'HEAD')
  const base = { repoPath: f.repo, sessionId: 's', taskId: 'T1', dispatchId: 'dispatch-tamper', action: 'VERIFY' as const,
    allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: identity, expectedBranch: branch,
    baselineCommit: baseline }

  // A descendant commit the host did not create can never be retroactively blessed.
  await writeFile(join(f.repo, 'a.js'), 'export const a = 1\n')
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'external descendant commit')
  const descendant = await git(f.repo, 'rev-parse', 'HEAD')
  await assert.rejects(createImplementationCheckpointAuthority({ ...base,
    before: { repositoryIdentity: identity, branch, headSha: baseline, changedFiles: [],
      worktreeFingerprint: 'a'.repeat(64) } }), /drifted/u)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), descendant, 'an unowned descendant commit is never adopted')

  // An inspection that no longer matches the worktree is refused before any commit.
  const f2 = await fixture()
  await writeFile(join(f2.repo, 'a.js'), 'export const a = 1\n')
  await writeFile(join(f2.repo, 'b.js'), 'export const b = 1\n')
  const dirty = await trustedGitState(f2.repo)
  const f2Base = await git(f2.repo, 'rev-parse', 'HEAD')
  await assert.rejects(createImplementationCheckpointAuthority({ ...base, repoPath: f2.repo,
    expectedRepositoryIdentity: await realpath(f2.repo), expectedBranch: await git(f2.repo, 'branch', '--show-current'),
    baselineCommit: f2Base, before: { ...dirty, changedFiles: ['a.js'] } }), /changed after trusted repository inspection/u)
  assert.equal(await git(f2.repo, 'rev-parse', 'HEAD'), f2Base)

  // Branch drift is refused.
  await assert.rejects(createImplementationCheckpointAuthority({ ...base, repoPath: f2.repo,
    expectedRepositoryIdentity: await realpath(f2.repo), expectedBranch: 'codex/other-branch',
    baselineCommit: f2Base, before: { ...dirty, headSha: f2Base } }), /drifted/u)
  assert.equal(await git(f2.repo, 'rev-parse', 'HEAD'), f2Base)

  // Out-of-scope, symlink and hardlink paths never enter a checkpoint commit.
  const f3 = await fixture()
  const f3Base = await git(f3.repo, 'rev-parse', 'HEAD')
  await writeFile(join(f3.repo, 'outside.js'), 'export const outside = 1\n')
  const outside = await trustedGitState(f3.repo)
  await assert.rejects(createImplementationCheckpointAuthority({ ...base, repoPath: f3.repo, allowedPaths: ['src'],
    expectedRepositoryIdentity: await realpath(f3.repo), expectedBranch: await git(f3.repo, 'branch', '--show-current'),
    baselineCommit: f3Base, before: outside }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_SCOPE_VIOLATION')
  assert.equal(await git(f3.repo, 'rev-parse', 'HEAD'), f3Base)

  const f4 = await fixture()
  const f4Base = await git(f4.repo, 'rev-parse', 'HEAD')
  await symlink('README.md', join(f4.repo, 'link.js'))
  const linked = await trustedGitState(f4.repo)
  await assert.rejects(createImplementationCheckpointAuthority({ ...base, repoPath: f4.repo,
    expectedRepositoryIdentity: await realpath(f4.repo), expectedBranch: await git(f4.repo, 'branch', '--show-current'),
    baselineCommit: f4Base, before: linked }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_SYMLINK_REJECTED')
  assert.equal(await git(f4.repo, 'rev-parse', 'HEAD'), f4Base)

  const f5 = await fixture()
  const f5Base = await git(f5.repo, 'rev-parse', 'HEAD')
  await link(join(f5.repo, 'README.md'), join(f5.repo, 'hard.js'))
  const hard = await trustedGitState(f5.repo)
  await assert.rejects(createImplementationCheckpointAuthority({ ...base, repoPath: f5.repo,
    expectedRepositoryIdentity: await realpath(f5.repo), expectedBranch: await git(f5.repo, 'branch', '--show-current'),
    baselineCommit: f5Base, before: hard }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_HARDLINK_REJECTED')
  assert.equal(await git(f5.repo, 'rev-parse', 'HEAD'), f5Base)
})

test('S3 a SHA, plain object, persisted record, or dispatch-result injection never obtains authority', async () => {
  const h = await deliveryHarness('none', 'pass')
  const base = await trustedGitState(h.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: base }
  const forged: unknown[] = [
    { kind: 'NOVAWING_HOST_IMPLEMENTATION_CHECKPOINT' },
    { commitSha: 'f'.repeat(40) },
    { sessionId: h.definition.id, taskId: 'T1', dispatchId: 'forged', action: 'EXECUTE', commitSha: 'f'.repeat(40),
      parentSha: base.headSha, treeHash: 'f'.repeat(40), changedFiles: [], before: base, after: base },
  ]
  for (const authority of forged) {
    const recorded: string[] = []
    let calls = 0
    const runner = new V2ControllerTaskRunner({ sessionId: h.definition.id, branch: h.definition.branch,
      agents: [AGENT_EXECUTOR], dispatcher: {
        inspectRepository: async () => (++calls === 1 ? base : { ...base, headSha: 'f'.repeat(40), worktreeFingerprint: 'f'.repeat(64) }),
        // A dispatcher cannot push authority into the Controller through its result.
        dispatch: async () => { recorded.push('EXECUTE')
          return { status: 'SUCCESS' as const, ...(authority === undefined ? {} : { implementationCheckpoint: authority }) } },
      } })
    const result = await runner.run(h.definition.tasks[0]!, undefined, undefined, { taskStateV2: initial })
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT', JSON.stringify({ authority, humanRequired: result.humanRequired }))
    assert.deepEqual(recorded, ['EXECUTE'])
  }

  // Persisted/cloned copies are not authority, and consumption is one-time.
  const f = await fixture()
  const { before, authority, observed } = await issueCheckpoint(f.repo, 'dispatch-s3')
  const expected = { sessionId: 's', taskId: 'T1', dispatchId: 'dispatch-s3', action: 'VERIFY', before, observed }
  const clone = JSON.parse(JSON.stringify(authority)) as unknown
  assert.equal(consumeImplementationCheckpoint(clone, expected).ok, false, 'a persisted copy is not authority')
  assert.equal(consumeImplementationCheckpoint({ ...(clone as object) }, expected).ok, false, 'a plain object is not authority')
  const persistedRecord = { commitSha: observed.headSha, parentSha: before.headSha, treeHash: 'a'.repeat(40),
    dispatchId: 'dispatch-s3', action: 'VERIFY', changedFiles: before.changedFiles,
    beforeHeadSha: before.headSha, afterHeadSha: observed.headSha, acceptedAt: new Date().toISOString() }
  assert.equal(consumeImplementationCheckpoint(persistedRecord, expected).ok, false, 'a persisted audit record is not authority')
  assert.equal(consumeImplementationCheckpoint(authority, expected).ok, true)
})

test('S4 authority is bound to its host-generated dispatchId and can be consumed only once', async () => {
  const f1 = await fixture()
  const first = await issueCheckpoint(f1.repo, 'dispatch-A')
  const expectedA = { sessionId: 's', taskId: 'T1', dispatchId: 'dispatch-A', action: 'VERIFY',
    before: first.before, observed: first.observed }
  const wrongDispatch = consumeImplementationCheckpoint(first.authority, { ...expectedA, dispatchId: 'dispatch-B' })
  assert.equal(wrongDispatch.ok, false, 'a different dispatch cannot consume the authority')
  assert.match(wrongDispatch.ok === false ? wrongDispatch.reason : '', /different dispatch/u)
  assert.equal(consumeImplementationCheckpoint(first.authority, expectedA).ok, false,
    'a refused dispatch still burns the authority')

  const f2 = await fixture()
  const second = await issueCheckpoint(f2.repo, 'dispatch-A')
  const expectedSecond = { sessionId: 's', taskId: 'T1', dispatchId: 'dispatch-A', action: 'VERIFY',
    before: second.before, observed: second.observed }
  assert.equal(consumeImplementationCheckpoint(second.authority, expectedSecond).ok, true)
  const replay = consumeImplementationCheckpoint(second.authority, expectedSecond)
  assert.equal(replay.ok, false)
  assert.match(replay.ok === false ? replay.reason : '', /not issued by this host process/u)
})

test('S5 accepting a checkpoint voids old verification results, evidence, review and approval', async () => {
  const h = await deliveryHarness('dirty', 'blocked')
  await writeFile(join(h.repo, 'feature.js'), 'export const implemented = true\n')
  const before = await trustedGitState(h.repo)
  const base = createTaskStateV2(h.definition, h.definition.tasks[0]!)
  const seed: TaskStateV2 = { ...base,
    status: 'PENDING', humanConstraints: { verifyOnly: true }, gitState: before,
    verificationState: { results: [{ name: 'stale verifier', stepId: 'stale verifier', status: 'passed' }] },
    completion: { ...base.completion,
      evidence: [{ type: 'stale verifier', status: 'PASSED', source: 'deterministic',
        repositoryIdentity: before.repositoryIdentity, branch: before.branch, headSha: before.headSha,
        workspaceIdentity: before.worktreeFingerprint, timestamp: new Date().toISOString() }],
      review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
        reviewer: { agent: 'reviewer', provider: 'reviewer-provider', runtimeIdentity: 'runtime-reviewer' },
        implementer: { agent: 'executor', provider: 'executor-provider', runtimeIdentity: 'runtime-executor' },
        reviewedRepository: before.repositoryIdentity, reviewedBranch: before.branch, reviewedCommit: before.headSha,
        reviewedWorkspace: before.worktreeFingerprint, reviewedFiles: ['feature.js'], timestamp: new Date().toISOString() },
      approval: { approved: true, repositoryIdentity: before.repositoryIdentity, branch: before.branch,
        workspaceIdentity: before.worktreeFingerprint, reviewedCommit: before.headSha, risk: 'HIGH', timestamp: new Date().toISOString() } } }
  const loaded = loadTaskStateV2(seed)
  assert.equal(loaded.completion.evidence.length, 1)
  assert.ok(loaded.completion.review)
  assert.ok(loaded.completion.approval)
  const result = await h.runner.run(h.definition.tasks[0]!, undefined, undefined, h.context(loaded))
  const head = await git(h.repo, 'rev-parse', 'HEAD')
  assert.notEqual(head, before.headSha)
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  const final = loadTaskStateV2(result.taskStateV2)
  assert.equal(final.gitState.headSha, head)
  assert.deepEqual(final.verificationState.results, [], 'old deterministic evidence is void after the checkpoint')
  assert.deepEqual(final.completion.evidence, [], 'old completion evidence is void after the checkpoint')
  assert.equal(final.completion.review, undefined, 'a review bound to the previous HEAD cannot survive')
  assert.equal(final.completion.approval, undefined, 'an approval bound to the previous HEAD cannot survive')
  assert.equal(final.implementationCheckpoints?.[0]?.commitSha, head)
  assert.equal(final.implementationCheckpoints?.[0]?.beforeHeadSha, before.headSha)
})

test('S6 no verifier runs before ownership is acknowledged and the new state is persisted', async () => {
  const h = await deliveryHarness('dirty', 'pass')
  const base = await trustedGitState(h.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: base }
  const result = await h.runner.run(h.definition.tasks[0]!, undefined, undefined, h.context(initial))
  const head = await git(h.repo, 'rev-parse', 'HEAD')
  assert.notEqual(head, base.headSha)
  const seen = h.observer.verifierSawPersistedState
  assert.ok(seen, 'the verifier must have run')
  assert.equal(seen.gitState.headSha, head, 'the durable state already named the new commit when the verifier ran')
  assert.deepEqual(seen.verificationState.results, [], 'old verification results were already void when the verifier ran')
  assert.deepEqual(seen.completion.evidence, [], 'old completion evidence was already void when the verifier ran')
  assert.equal((seen.implementationCheckpoints ?? []).length, 1, 'ownership was durably recorded before verification')
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
})

test('S7 a refused acknowledgement blocks the verifier instead of adopting the commit', async () => {
  const h = await deliveryHarness('dirty', 'pass')
  const before = await trustedGitState(h.repo)
  await writeFile(join(h.repo, 'feature.js'), 'export const implemented = true\n')
  const dirty = await trustedGitState(h.repo)
  const task = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: dirty }
  const agent = { id: 'fixture', identity: { agent: 'fixture', provider: 'fixture', runtimeIdentity: 'fixture' },
    available: true, quotaExhausted: false, degraded: false,
    capabilities: { coding: true, reasoning: true, verification: true, review: true } }
  let verifierRuns = 0
  const dispatcher = createDeliveryRuntimeDispatcher(h.plan, h.store, {
    inspectRepository: () => trustedGitState(h.repo),
    dispatch: async () => { verifierRuns += 1; return { status: 'SUCCESS' as const } },
  })
  const refused = await dispatcher.dispatch({ action: 'VERIFY', agent, task,
    implementationCheckpoint: { dispatchId: 'dispatch-refused', acknowledge: async () => ({ accepted: false, reason: 'host refused ownership' }) } })
  assert.equal(refused.status, 'BLOCKED')
  assert.match(refused.blockers?.[0] ?? '', /IMPLEMENTATION_CHECKPOINT_BLOCKED: host refused ownership/u)
  assert.equal(verifierRuns, 0, 'no verifier may run before ownership is acknowledged')
  assert.notEqual(await git(h.repo, 'rev-parse', 'HEAD'), before.headSha, 'the host commit exists but is not authoritative')
})

test('S8 the Controller seam refuses an authority minted under a different dispatchId', async () => {
  // An authority minted for some other dispatch, on a separate repository.
  const other = await fixture()
  const foreign = await issueCheckpoint(other.repo, 'some-other-dispatch')

  const f = await fixture()
  const target = await bindDeliveryTarget(f.snapshot, f.repo, 'trusted_test')
  const compiled = await compileRuntimePlan(f.snapshot, target, { resolver: supported,
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(compiled, 'e0h1-cross-dispatch')
  await writeFile(join(f.repo, 'feature.js'), 'export const implemented = true\n')
  const observed: { dispatchId: string | undefined; crossAccepted: boolean | undefined;
    crossReason: string | undefined; ownAccepted: boolean | undefined } =
    { dispatchId: undefined, crossAccepted: undefined, crossReason: undefined, ownAccepted: undefined }
  const dispatcher: V2ActionDispatcher = {
    inspectRepository: () => trustedGitState(f.repo),
    dispatch: async ({ action, task, implementationCheckpoint }) => {
      if (action !== 'VERIFY') return { status: 'SUCCESS' }
      assert.ok(implementationCheckpoint, 'the Controller must hand the dispatch a host-owned seam')
      observed.dispatchId = implementationCheckpoint.dispatchId
      // A different dispatch's authority can never be consumed through this seam.
      const cross = await implementationCheckpoint.acknowledge(foreign.authority)
      observed.crossAccepted = cross.accepted
      observed.crossReason = cross.reason
      const own = await createImplementationCheckpointAuthority({
        repoPath: f.repo, sessionId: definition.id, taskId: task.identity.taskId,
        dispatchId: implementationCheckpoint.dispatchId, action: 'VERIFY',
        allowedPaths: task.permissions.allowedPaths, forbiddenPaths: task.permissions.forbiddenPaths,
        expectedRepositoryIdentity: task.gitState.repositoryIdentity!, expectedBranch: definition.branch,
        baselineCommit: await git(f.repo, 'rev-parse', 'HEAD'),
        before: { repositoryIdentity: task.gitState.repositoryIdentity!, branch: task.gitState.branch!,
          headSha: task.gitState.headSha!, changedFiles: task.gitState.changedFiles,
          worktreeFingerprint: task.gitState.worktreeFingerprint! } })
      assert.ok(own)
      observed.ownAccepted = (await implementationCheckpoint.acknowledge(own)).accepted
      return { status: 'BLOCKED', blockers: ['stop the fixture run'] }
    },
  }
  const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch,
    agents: [AGENT_EXECUTOR], dispatcher })
  const base = await trustedGitState(f.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(definition, definition.tasks[0]!), gitState: base,
    status: 'PENDING', humanConstraints: { verifyOnly: true } }
  const persisted: TaskStateV2[] = []
  const result = await runner.run(definition.tasks[0]!, undefined, undefined, { taskStateV2: initial,
    persistTaskStateV2: async (state: TaskStateV2) => { persisted.push(state) } })
  assert.ok(observed.dispatchId, 'a host-generated dispatchId was bound')
  assert.equal(observed.crossAccepted, false, 'another dispatch cannot consume this authority')
  assert.match(observed.crossReason ?? '', /different dispatch/u)
  assert.equal(observed.ownAccepted, true, 'the owning dispatch consumes it normally')
  assert.equal(result.taskStateV2?.gitState.headSha, await git(f.repo, 'rev-parse', 'HEAD'))
  assert.deepEqual(loadTaskStateV2(result.taskStateV2).completion.evidence, [])
})
