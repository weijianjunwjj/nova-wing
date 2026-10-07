/**
 * E0-H1 host-owned implementation checkpoint handoff.
 *
 * Proves the six required safety scenarios around the Delivery VERIFY
 * implementation commit: no false drift, tamper refusal, no forged authority,
 * one-time consumption, evidence invalidation, and no fabricated ownership.
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
  createImplementationCheckpointAuthority, verifyImplementationCheckpointCommit,
  type ImplementationCheckpointAuthority } from '../packages/development-guardian/work-session/implementation-checkpoint.js'

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
  return { ...f, plan, definition, runner, actions, store }
}

test('S1 EXECUTE → VERIFY implementation commit is accepted and the Controller continues to REVIEW', async () => {
  const h = await deliveryHarness('dirty', 'pass')
  const base = await trustedGitState(h.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: base }
  const result = await h.runner.run(h.definition.tasks[0]!, undefined, undefined, { taskStateV2: initial })
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

test('S2 checkpoint parent, branch, tree and scope tampering are refused', async () => {
  const f = await fixture()
  const branch = await git(f.repo, 'branch', '--show-current')
  const identity = await realpath(f.repo)
  const baseline = await git(f.repo, 'rev-parse', 'HEAD')
  const binding = { repoPath: f.repo, sessionId: 's', taskId: 'T1', action: 'VERIFY' as const,
    allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: identity, expectedBranch: branch,
    baselineCommit: baseline }

  // parent: HEAD (C2) descends from the observed commit through an intermediate commit.
  await writeFile(join(f.repo, 'a.js'), 'export const a = 1\n')
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'C1')
  await writeFile(join(f.repo, 'b.js'), 'export const b = 1\n')
  await git(f.repo, 'add', 'b.js')
  await git(f.repo, 'commit', '-qm', 'C2')
  const c2 = await git(f.repo, 'rev-parse', 'HEAD')
  await assert.rejects(verifyImplementationCheckpointCommit({ ...binding, commitSha: c2,
    before: { repositoryIdentity: identity, branch, headSha: baseline, changedFiles: ['a.js', 'b.js'],
      worktreeFingerprint: 'a'.repeat(64) } }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_PARENT_MISMATCH')

  // branch: the observed branch is not the checked-out branch.
  await assert.rejects(verifyImplementationCheckpointCommit({ ...binding, expectedBranch: 'codex/other-branch', commitSha: c2,
    before: { repositoryIdentity: identity, branch, headSha: baseline, changedFiles: ['a.js', 'b.js'],
      worktreeFingerprint: 'a'.repeat(64) } }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_BRANCH_CHANGED')

  // tree/content: the commit does not carry exactly the inspected implementation files.
  await writeFile(join(f.repo, 'extra.js'), 'export const extra = 1\n')
  await git(f.repo, 'add', 'extra.js')
  await git(f.repo, 'commit', '-qm', 'C3 with an extra file')
  const c3 = await git(f.repo, 'rev-parse', 'HEAD')
  await assert.rejects(verifyImplementationCheckpointCommit({ ...binding, commitSha: c3,
    before: { repositoryIdentity: identity, branch, headSha: c2, changedFiles: ['a.js'],
      worktreeFingerprint: 'a'.repeat(64) } }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_CONTENT_MISMATCH')

  // scope: the committed file set is not inside the Task scope.
  await assert.rejects(verifyImplementationCheckpointCommit({ ...binding, allowedPaths: ['src'], commitSha: c3,
    before: { repositoryIdentity: identity, branch, headSha: c2, changedFiles: ['extra.js'],
      worktreeFingerprint: 'a'.repeat(64) } }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_SCOPE_VIOLATION')
})

test('S2b symlink, hardlink and out-of-scope paths never enter a checkpoint commit', async () => {
  const f = await fixture()
  const base = await git(f.repo, 'rev-parse', 'HEAD')
  const binding = { repoPath: f.repo, sessionId: 's', taskId: 'T1', action: 'VERIFY' as const,
    allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: await realpath(f.repo),
    expectedBranch: await git(f.repo, 'branch', '--show-current'), baselineCommit: base }

  await symlink('README.md', join(f.repo, 'link.js'))
  await assert.rejects(createImplementationCheckpointAuthority({ ...binding, before: await trustedGitState(f.repo) }),
    (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_SYMLINK_REJECTED')
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), base, 'a refused checkpoint must not create a commit')

  const f2 = await fixture()
  await link(join(f2.repo, 'README.md'), join(f2.repo, 'hard.js'))
  await assert.rejects(createImplementationCheckpointAuthority({ ...binding, repoPath: f2.repo,
    expectedRepositoryIdentity: await realpath(f2.repo), expectedBranch: await git(f2.repo, 'branch', '--show-current'),
    baselineCommit: await git(f2.repo, 'rev-parse', 'HEAD'), before: await trustedGitState(f2.repo) }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_HARDLINK_REJECTED')

  const f3 = await fixture()
  const f3Base = await git(f3.repo, 'rev-parse', 'HEAD')
  await writeFile(join(f3.repo, 'outside.js'), 'export const outside = 1\n')
  await assert.rejects(createImplementationCheckpointAuthority({ ...binding, repoPath: f3.repo, allowedPaths: ['src'],
    expectedRepositoryIdentity: await realpath(f3.repo), expectedBranch: await git(f3.repo, 'branch', '--show-current'),
    baselineCommit: f3Base, before: await trustedGitState(f3.repo) }),
  (error: unknown) => error instanceof ImplementationCheckpointError && error.checkpointReason === 'CHECKPOINT_SCOPE_VIOLATION')
  assert.equal(await git(f3.repo, 'rev-parse', 'HEAD'), f3Base, 'an out-of-scope checkpoint must not create a commit')
})

test('S3 a SHA, plain object, or persisted record never obtains checkpoint authority', async () => {
  const h = await deliveryHarness('none', 'pass')
  const base = await trustedGitState(h.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!), gitState: base }
  const forged: unknown[] = [
    { kind: 'NOVAWING_HOST_IMPLEMENTATION_CHECKPOINT' },
    { commitSha: 'f'.repeat(40) },
    { sessionId: h.definition.id, taskId: 'T1', action: 'EXECUTE', commitSha: 'f'.repeat(40), parentSha: base.headSha,
      treeHash: 'f'.repeat(40), changedFiles: [], before: base, after: base },
  ]
  for (const authority of forged) {
    const recorded: string[] = []
    let calls = 0
    const runner = new V2ControllerTaskRunner({ sessionId: h.definition.id, branch: h.definition.branch,
      agents: [AGENT_EXECUTOR], dispatcher: {
        inspectRepository: async () => (++calls === 1 ? base : { ...base, headSha: 'f'.repeat(40), worktreeFingerprint: 'f'.repeat(64) }),
        dispatch: async () => { recorded.push('EXECUTE')
          return { status: 'SUCCESS' as const, implementationCheckpoint: authority as ImplementationCheckpointAuthority } },
      } })
    const result = await runner.run(h.definition.tasks[0]!, undefined, undefined, { taskStateV2: initial })
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT', JSON.stringify({ authority, humanRequired: result.humanRequired }))
    assert.match(result.humanRequired?.reason ?? '', /not issued by this host process|no host-owned/u)
    assert.deepEqual(recorded, ['EXECUTE'])
  }

  // A real authority survives the host process only as an inert record; clones and
  // persisted JSON are not authority, and consumption is one-time.
  const f = await fixture()
  await writeFile(join(f.repo, 'feature.js'), 'export const implemented = true\n')
  const before = await trustedGitState(f.repo)
  const branch = before.branch
  const authority = await createImplementationCheckpointAuthority({ repoPath: f.repo, sessionId: 's', taskId: 'T1',
    action: 'VERIFY', allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: before.repositoryIdentity,
    expectedBranch: branch, baselineCommit: before.headSha, before })
  assert.ok(authority)
  const observed = await trustedGitState(f.repo)
  const expected = { sessionId: 's', taskId: 'T1', action: 'VERIFY', before, observed }
  const clone = JSON.parse(JSON.stringify(authority)) as ImplementationCheckpointAuthority
  assert.equal(consumeImplementationCheckpoint(clone, expected).ok, false, 'a persisted copy is not authority')
  assert.equal(consumeImplementationCheckpoint({ ...clone }, expected).ok, false, 'a plain object is not authority')
  assert.equal(consumeImplementationCheckpoint(authority, expected).ok, true)
  const persistedRecord = { commitSha: observed.headSha, parentSha: before.headSha, treeHash: 'a'.repeat(40),
    action: 'VERIFY', changedFiles: before.changedFiles, beforeHeadSha: before.headSha, afterHeadSha: observed.headSha,
    acceptedAt: new Date().toISOString() }
  assert.equal(consumeImplementationCheckpoint(persistedRecord, expected).ok, false, 'a persisted audit record is not authority')
})

test('S4 a host checkpoint authority can be consumed only once', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'feature.js'), 'export const implemented = true\n')
  const before = await trustedGitState(f.repo)
  const authority = await createImplementationCheckpointAuthority({ repoPath: f.repo, sessionId: 's', taskId: 'T1',
    action: 'VERIFY', allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: before.repositoryIdentity,
    expectedBranch: before.branch, baselineCommit: before.headSha, before })
  assert.ok(authority)
  const observed = await trustedGitState(f.repo)
  assert.equal(observed.headSha === before.headSha, false)
  const expected = { sessionId: 's', taskId: 'T1', action: 'VERIFY', before, observed }
  assert.equal(consumeImplementationCheckpoint(authority, expected).ok, true)
  const second = consumeImplementationCheckpoint(authority, expected)
  assert.equal(second.ok, false)
  assert.match(second.ok === false ? second.reason : '', /not issued by this host process/u)

  // A mismatched binding is refused, and the attempt still burns the authority.
  const g = await fixture()
  await writeFile(join(g.repo, 'feature.js'), 'export const implemented = true\n')
  const beforeOther = await trustedGitState(g.repo)
  const other = await createImplementationCheckpointAuthority({ repoPath: g.repo, sessionId: 's', taskId: 'T1',
    action: 'VERIFY', allowedPaths: ['.'], forbiddenPaths: [], expectedRepositoryIdentity: beforeOther.repositoryIdentity,
    expectedBranch: beforeOther.branch, baselineCommit: beforeOther.headSha, before: beforeOther })
  assert.ok(other)
  const observedOther = await trustedGitState(g.repo)
  const expectedOther = { sessionId: 's', taskId: 'T1', action: 'VERIFY', before: beforeOther, observed: observedOther }
  const mismatch = consumeImplementationCheckpoint(other, { ...expectedOther, taskId: 'OTHER' })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.ok === false ? mismatch.reason : '', /different session, task, attempt, or action/u)
  assert.equal(consumeImplementationCheckpoint(other, expectedOther).ok, false, 'a refused binding still burns the authority')
})

test('S5 accepting a checkpoint invalidates old verification and completion evidence', async () => {
  const h = await deliveryHarness('dirty', 'blocked')
  await writeFile(join(h.repo, 'feature.js'), 'export const implemented = true\n')
  const before = await trustedGitState(h.repo)
  const seed: TaskStateV2 = { ...createTaskStateV2(h.definition, h.definition.tasks[0]!),
    status: 'PENDING', humanConstraints: { verifyOnly: true }, gitState: before,
    verificationState: { results: [{ name: 'stale verifier', stepId: 'stale verifier', status: 'passed' }] },
    completion: { ...createTaskStateV2(h.definition, h.definition.tasks[0]!).completion,
      review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
        reviewer: { agent: 'reviewer', provider: 'reviewer-provider', runtimeIdentity: 'runtime-reviewer' },
        implementer: { agent: 'executor', provider: 'executor-provider', runtimeIdentity: 'runtime-executor' },
        reviewedRepository: before.repositoryIdentity, reviewedBranch: before.branch, reviewedCommit: before.headSha,
        reviewedWorkspace: before.worktreeFingerprint, reviewedFiles: ['feature.js'], timestamp: new Date().toISOString() },
      approval: { approved: true, repositoryIdentity: before.repositoryIdentity, branch: before.branch,
        workspaceIdentity: before.worktreeFingerprint, reviewedCommit: before.headSha, risk: 'HIGH', timestamp: new Date().toISOString() } } }
  const loaded = loadTaskStateV2(seed)
  assert.ok(loaded.completion.review)
  assert.ok(loaded.completion.approval)
  const result = await h.runner.run(h.definition.tasks[0]!, undefined, undefined, { taskStateV2: loaded })
  const head = await git(h.repo, 'rev-parse', 'HEAD')
  assert.notEqual(head, before.headSha)
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  const final = loadTaskStateV2(result.taskStateV2)
  assert.equal(final.gitState.headSha, head)
  assert.deepEqual(final.verificationState.results, [], 'old deterministic evidence is void after the checkpoint')
  assert.equal(final.completion.review, undefined, 'a review bound to the previous HEAD cannot survive')
  assert.equal(final.completion.approval, undefined, 'an approval bound to the previous HEAD cannot survive')
  assert.equal(final.implementationCheckpoints?.[0]?.commitSha, head)
  assert.equal(final.implementationCheckpoints?.[0]?.beforeHeadSha, before.headSha)
})

test('S6 no-op and unowned descendant commits never fabricate an ownership transition', async () => {
  // S6a: an already-satisfied task has no checkpoint to transfer.
  const clean = await deliveryHarness('none', 'pass')
  const base = await trustedGitState(clean.repo)
  const initial: TaskStateV2 = { ...createTaskStateV2(clean.definition, clean.definition.tasks[0]!), gitState: base }
  const result = await clean.runner.run(clean.definition.tasks[0]!, undefined, undefined, { taskStateV2: initial })
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(result.taskStateV2?.gitState.headSha, base.headSha)
  assert.equal((result.taskStateV2?.implementationCheckpoints ?? []).length, 0)

  // S6b: the Executor commits on its own; without a host-verified handoff the new
  // descendant commit stays fail-closed drift and is never adopted.
  const unowned = await deliveryHarness('commit', 'pass')
  const before = await trustedGitState(unowned.repo)
  const seed: TaskStateV2 = { ...createTaskStateV2(unowned.definition, unowned.definition.tasks[0]!), gitState: before }
  const unownedResult = await unowned.runner.run(unowned.definition.tasks[0]!, undefined, undefined, { taskStateV2: seed })
  assert.equal(unownedResult.humanRequired?.category, 'REPO_DRIFT')
  assert.match(unownedResult.humanRequired?.reason ?? '', /no host-owned implementation checkpoint/u)
  assert.notEqual(await git(unowned.repo, 'rev-parse', 'HEAD'), before.headSha)
  assert.equal((unownedResult.taskStateV2?.implementationCheckpoints ?? []).length, 0)
})
