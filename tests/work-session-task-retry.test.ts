import { probeDeepSeekReviewer, type ReviewerHealthProbeResult } from '../packages/development-guardian/work-session/reviewer-health-refresh.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, type PlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { bindDeliveryTarget, compileRuntimePlan, workSessionDefinitionFor, inspectDeliveryTarget } from '../packages/development-guardian/delivery/runtime-plan.js'
import { DeliveryStore } from '../packages/development-guardian/delivery/service.js'
import { createDeliveryTaskRetryValidator } from '../packages/development-guardian/delivery/task-retry-binding.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import { CodingExecutionStore, defaultCodingExecutionStorePath } from '../packages/development-guardian/work-session/coding-execution-store.js'
import { DEFAULT_WORKSPACE_FORBIDDEN_PATHS } from '../packages/development-guardian/workspace-scope.js'
import { workspacePathKey } from '../packages/development-guardian/platform/paths.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import { TASK_RETRY_REASON, type TaskRetryRequest } from '../packages/development-guardian/work-session/task-retry.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import type { V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import { codexTestRepo } from './codex-test-fixture.js'

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
  const id = '11111111-1111-4111-8111-111111111111'
  const plan = createDevelopmentPlan(draft, { id, text: requirement, receivedAt: new Date().toISOString() }, id)
  plan.semanticReview = { verdict: 'PASS', issues: [] }
  plan.status = 'ready_for_approval'
  const approval = { planId: id, planVersion: 1, approvedAt: new Date().toISOString(), actor: 'customer' as const,
    source: 'customer_mode' as const, contentHash: planContentHash(canonicalPlanContent(plan)) }
  return createPlanSnapshot(plan, approval, null)
}


async function snapshotAccess(runtime: WorkSessionRuntime) {
  // Fixture-only inspection through the same Mastra/libsql driver, never node:sqlite on a WorkSession DB.
  const internal = runtime as unknown as { mastra: { getStorage(): { getStore(name: string): Promise<any> } }; workflowId: string }
  const workflows = await internal.mastra.getStorage().getStore('workflows')
  const key = { workflowName: internal.workflowId, runId: runtime.getDefinition().id }
  return { read: () => workflows.loadWorkflowSnapshot(key),
    failNextWrite: () => {
      const persist = workflows.persistWorkflowSnapshot.bind(workflows)
      workflows.persistWorkflowSnapshot = async () => {
        workflows.persistWorkflowSnapshot = persist
        throw new Error('fixture persistence failure')
      }
    },
    mutate: async (edit: (state: any, snapshot: any) => void) => {
      const snapshot = await workflows.loadWorkflowSnapshot(key)
      edit(snapshot.value, snapshot)
      await workflows.persistWorkflowSnapshot({ ...key, snapshot })
    } }
}

async function fixture() {
  const repo = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'nw-task-retry-'))
  const frozen = snapshotFixture()
  const target = await bindDeliveryTarget(frozen, repo, 'trusted_test')
  const plan = await compileRuntimePlan(frozen, target, { resolver: () => ({ capability: 'REQUIRES_EXTERNAL_ENVIRONMENT',
    capabilityId: 'fixture-external-v1', family: 'browser_ui', reason: 'Completion-only fixture.' }),
    runtimePolicyVersion: 'fixture-policy', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const store = new DeliveryStore(join(data, 'delivery'))
  await store.savePlan(plan)
  const id = `delivery-${'a'.repeat(64)}-000000000000-aaaaaa`
  await store.claimSession({ workSessionId: id, sourceSnapshotId: frozen.id, sourcePlanHash: frozen.planHash.value,
    runtimePlanId: plan.id, runtimePlanHash: plan.runtimePlanHash, targetBindingId: target.id,
    targetBaselineCommit: target.baselineCommit, compilerVersion: plan.compilerImplementationVersion,
    status: 'STARTED', createdAt: new Date().toISOString() })
  const compiled = workSessionDefinitionFor(plan, id)
  const definition = { ...compiled, tasks: compiled.tasks.map(task => ({ ...task, forbiddenPaths: [...DEFAULT_WORKSPACE_FORBIDDEN_PATHS] })) }
  const coding = new CodingExecutionStore(join(data, 'coding.sqlite'))
  const root = workspacePathKey(await realpath(repo))
  let snapshotSource = frozen
  const authority = {
    validate: createDeliveryTaskRetryValidator(store, async () => snapshotSource),
    acquireSession: () => coding.acquire(`task-retry-session:${id}`, 'retry-fixture'),
    acquireWorkspace: async () => coding.acquire(root, 'retry-fixture'),
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  let executions = 0
  const inspect = async () => {
    const now = await inspectDeliveryTarget(repo)
    const entries = parseGitStatus(git('status', '--porcelain', '-z', '--untracked-files=all'))
    return { repositoryIdentity: now.canonicalPath, branch: now.branch!, headSha: now.baselineCommit,
      changedFiles: entries.map(entry => entry.path), worktreeFingerprint: createHash('sha256')
        .update(await computeWorktreeFingerprint(repo, entries, { strict: true })).update(git('diff', '--cached', '--binary')).digest('hex') }
  }
  const agents = ['executor', 'reviewer'].map(name => ({ id: name, identity: { agent: name,
    provider: name === 'executor' ? 'codex' : 'deepseek', runtimeIdentity: name }, available: true, quotaExhausted: false,
    degraded: false, capabilities: { coding: name === 'executor', verification: true, reasoning: true, review: name === 'reviewer' } }))
  let healthProbe: (() => Promise<ReviewerHealthProbeResult>) | undefined
  const makeRuntime = () => new WorkSessionRuntime({ definition, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    taskRetry: authority, reviewerHealthProbe: async () => { if (!healthProbe) throw new Error('No fixture health probe'); return healthProbe() },
    taskRunner: new V2ControllerTaskRunner({ sessionId: id, branch: definition.branch, agents, dispatcher: {
      inspectRepository: inspect, dispatch: async ({ action }) => {
        if (action === 'EXECUTE') { executions++; return { status: 'SUCCESS', changedFiles: [] } }
        if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [
          { name: 'external fixture', stepId: 'NOVAWING_DEFERRED:A1:EXTERNAL_DEFERRED', status: 'skipped' }] }
        return { status: 'BLOCKED', providerFailure: { provider: 'deepseek', status: 'DEGRADED', reason: 'independent REVIEW_FAILURE' } }
      } } }) })
  let runtime = makeRuntime()
  const started = await runtime.start()
  assert.equal(started.state, 'SUSPENDED')
  assert.equal(started.taskStatesV2?.T1?.currentAction, 'REVIEW')
  const request: TaskRetryRequest = { sessionId: id, workflowRunId: id, taskId: 'T1',
    expectedGeneration: started.humanRequiredGeneration!, expectedWorkflowState: 'SUSPENDED', expectedTaskState: 'SUSPENDED',
    expectedCurrentAction: 'REVIEW', sourceSnapshotId: frozen.id, sourcePlanHash: frozen.planHash.value,
    runtimePlanHash: plan.runtimePlanHash, targetBindingId: target.id, targetBaselineCommit: target.baselineCommit,
    reasonCode: TASK_RETRY_REASON }
  return { repo, data, definition, store, coding, root, frozen, plan, request, git,
    setHealthProbe: (probe: () => Promise<ReviewerHealthProbeResult>) => { healthProbe = probe },
    runtime: () => runtime, additionalRuntime: makeRuntime, executions: () => executions, setSnapshot: (value: PlanSnapshot) => { snapshotSource = value },
    access: () => snapshotAccess(runtime),
    recreate: async () => { await runtime.close(); runtime = makeRuntime(); await runtime.loadPersistedState(); return runtime },
    close: async () => { await runtime.close(); await rm(repo, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) } }
}

test('suspended REVIEW reconciliation is durable, does not execute, and preserves histories, identity and budget', async () => {
  const f = await fixture()
  try {
    const access = await f.access()
    await access.mutate(state => {
      state.currentTaskCheckpoint = { task: { lastReport: { commandsRun: ['read_file', 'write_file rejected'], blockers: ['mutation rejected'] } }, provider: { sessionId: 'old-continuation' } }
      state.verificationResults = [{ name: 'old result', status: 'skipped' }]
      state.pendingVerificationApproval = { sessionId: f.definition.id, taskId: 'T1', command: 'npm test', commandFingerprint: 'old', generation: 1, status: 'APPROVED' }
      state.taskStatesV2.T1.progress.completedWork = ['old execution claim']
      state.taskStatesV2.T1.artifacts = ['old artifact claim']
      state.taskStatesV2.T1.blockers = ['stale blocker']
      const actor = { agent: 'old', provider: 'old', runtimeIdentity: 'old' }
      state.taskStatesV2.T1.completion.review = { passed: false, findings: [], severity: 'HIGH', blockingFindings: [],
        reviewer: actor, implementer: actor, reviewedFiles: [], timestamp: new Date().toISOString() }
      state.taskStatesV2.T1.completion.approval = { approved: true, workspaceIdentity: 'old', risk: 'HIGH', timestamp: new Date().toISOString() }
      state.taskStatesV2.T1.completion.evidence = [{ type: 'old', status: 'PASSED', source: 'fixture', timestamp: new Date().toISOString() }]
      state.taskEventLogs.T1.push({ eventId: '10000', type: 'AGENT_FAILED', sessionId: f.definition.id, taskId: 'T1', timestamp: new Date().toISOString(), metadata: { mutationFailureCount: 12 } })
    })
    const before = await access.read()
    const ledger = f.runtime().readExecutionLedger()
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    assert.equal(f.executions(), 1)
    assert.equal(receipt.nextDecision, 'EXECUTE')
    const after = await access.read()
    const task = after.value.taskStatesV2.T1
    assert.equal(after.status, 'suspended')
    assert.equal(after.value.sessionId, before.value.sessionId)
    assert.equal(f.runtime().getRunId(), f.request.workflowRunId)
    assert.equal(task.status, 'PENDING')
    assert.equal(new TaskController().decide(task).action, 'EXECUTE')
    assert.deepEqual(task.actionBudget, before.value.taskStatesV2.T1.actionBudget)
    assert.deepEqual(task.completion.bindings, before.value.taskStatesV2.T1.completion.bindings)
    assert.deepEqual(task.permissions, before.value.taskStatesV2.T1.permissions)
    assert.deepEqual(task.verificationState.results, [])
    assert.deepEqual(task.completion.evidence, [])
    assert.equal(task.completion.review, undefined)
    assert.equal(task.completion.approval, undefined)
    assert.deepEqual(task.blockers, [])
    assert.deepEqual(task.artifacts, [])
    assert.deepEqual(task.progress.completedWork, [])
    assert.equal(after.value.currentTaskCheckpoint, undefined)
    assert.equal(after.value.pendingVerificationApproval, undefined)
    assert.equal(after.value.verificationResults, undefined)
    assert.deepEqual(after.value.taskRetryHistory[0].previousTaskState, before.value.taskStatesV2.T1)
    assert.deepEqual(after.value.taskRetryHistory[0].previousProjection.currentTaskCheckpoint, before.value.currentTaskCheckpoint)
    assert.deepEqual(after.value.taskEventLogs.T1.slice(0, -1), before.value.taskEventLogs.T1)
    assert.deepEqual(f.runtime().readExecutionLedger(), ledger)
    assert.equal(after.value.taskEventLogs.T1.at(-1).type, 'TASK_RETRY_RECONCILED')
    assert.equal(after.value.taskEventLogs.T1.at(-1).metadata.previousAttemptId, receipt.previousAttemptId)
    assert.equal(JSON.stringify(after.value.taskEventLogs.T1.at(-1)).includes('old-continuation'), false)
    await f.recreate()
    assert.equal(new TaskController().decide(f.runtime().getDurableState()!.taskStatesV2!.T1!).action, 'EXECUTE')
    assert.equal(f.git('status', '--porcelain'), '')
    assert.equal(f.git('rev-parse', 'HEAD'), f.request.targetBaselineCommit)
  } finally { await f.close() }
})

for (const mode of ['running', 'wrong-task', 'wrong-session', 'wrong-run', 'generation', 'action', 'active-executor',
  'baseline-drift', 'dirty', 'snapshot-mismatch', 'runtime-mismatch', 'binding-mismatch', 'snapshot-tamper', 'plan-tamper', 'policy-drift', 'forbidden-policy-drift', 'budget', 'verify-only'] as const) {
  test(`task retry rejects ${mode} without mutation`, async () => {
    const f = await fixture()
    let release: (() => void) | undefined
    try {
      const request = { ...f.request }
      const access = await f.access()
      if (mode === 'running') await access.mutate((state, snapshot) => { state.state = 'RUNNING'; snapshot.status = 'running' })
      if (mode === 'wrong-task') request.taskId = 'T2'
      if (mode === 'wrong-session') request.sessionId = 'another-session'
      if (mode === 'wrong-run') request.workflowRunId = 'another-run'
      if (mode === 'generation') request.expectedGeneration++
      if (mode === 'action') request.expectedCurrentAction = 'EXECUTE'
      if (mode === 'active-executor') release = f.coding.acquire(f.root, 'active-executor')
      if (mode === 'baseline-drift') f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'drift')
      if (mode === 'dirty') await writeFile(join(f.repo, 'dirty.txt'), 'fixture drift')
      if (mode === 'snapshot-mismatch') request.sourceSnapshotId = '22222222-2222-4222-8222-222222222222'
      if (mode === 'runtime-mismatch') request.runtimePlanHash = 'b'.repeat(64)
      if (mode === 'binding-mismatch') request.targetBindingId = 'b'.repeat(64)
      if (mode === 'snapshot-tamper') f.setSnapshot({ ...f.frozen, planHash: { ...f.frozen.planHash, value: 'b'.repeat(64) } })
      if (mode === 'plan-tamper') await writeFile(join(f.data, 'delivery', `plan-${f.plan.id}.json`), JSON.stringify({ ...f.plan, sourcePlanHash: 'b'.repeat(64) }))
      if (mode === 'policy-drift') await access.mutate(state => { state.taskStatesV2.T1.permissions.allowedPaths = ['outside'] })
      if (mode === 'forbidden-policy-drift') f.definition.tasks[0]!.forbiddenPaths = []
      if (mode === 'budget') await access.mutate(state => { state.taskStatesV2.T1.actionBudget.originalConsumed = 20 })
      if (mode === 'verify-only') await access.mutate(state => { state.taskStatesV2.T1.humanConstraints.verifyOnly = true })
      const before = await access.read()
      const status = f.git('status', '--porcelain')
      await assert.rejects(f.runtime().reconcileTaskRetry(request))
      assert.deepEqual(await access.read(), before)
      assert.equal(f.executions(), 1)
      assert.equal(f.git('status', '--porcelain'), status)
    } finally { release?.(); await f.close() }
  })
}

test('duplicate reconciliation is rejected across reopen, and explicit resume reruns the same task exactly once', async () => {
  const f = await fixture()
  try {
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    const before = await (await f.access()).read()
    await assert.rejects(f.runtime().reconcileTaskRetry(f.request), /ALREADY_RECONCILED/u)
    assert.deepEqual(await (await f.access()).read(), before)
    await f.recreate()
    await assert.rejects(f.runtime().reconcileTaskRetry(f.request), /ALREADY_RECONCILED/u)
    await assert.rejects(f.runtime().resume({}), /EXPLICIT_RESUME_REQUIRED/u)
    assert.equal(f.executions(), 1)
    const input = { taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }
    const results = await Promise.allSettled([f.runtime().resume(input), f.runtime().resume(input)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(f.executions(), 2)
    assert.equal(f.runtime().getDefinition().id, f.request.sessionId)
    assert.equal((await f.runtime().verifySnapshot()).status, 'suspended')
    assert.equal(f.runtime().getDurableState()!.taskStatesV2!.T1!.attemptId, receipt.attemptId)
    assert.equal(f.runtime().getDurableState()!.taskStatesV2!.T1!.actionBudget!.originalConsumed, 6)
    await assert.rejects(f.runtime().resume(input))
    assert.equal(f.executions(), 2)
    assert.equal((await (await f.access()).read()).value.taskRetryHistory.length, 1)
    assert.equal(f.git('status', '--porcelain'), '')
  } finally { await f.close() }
})

test('ordinary resume without reconciliation still does not rerun EXECUTE', async () => {
  const f = await fixture()
  try {
    await f.runtime().resume({ decision: 'ALLOW REEXECUTE' })
    assert.equal(f.executions(), 1)
    assert.equal((await (await f.access()).read()).value.taskRetry, undefined)
  } finally { await f.close() }
})

test('reconciliation preserves other completed task projections byte-for-byte', async () => {
  const f = await fixture()
  try {
    const access = await f.access()
    await access.mutate(state => {
      state.completedTaskIds = ['earlier-task']
      state.taskStatesV2['earlier-task'] = { ...createTaskStateV2(f.definition,
        { ...f.definition.tasks[0]!, id: 'earlier-task' }), status: 'COMPLETED' }
      state.checkpointCommits = { 'earlier-task': f.request.targetBaselineCommit }
    })
    const before = await access.read()
    await f.runtime().reconcileTaskRetry(f.request)
    const after = await access.read()
    assert.deepEqual(after.value.completedTaskIds, before.value.completedTaskIds)
    assert.deepEqual(after.value.taskStatesV2['earlier-task'], before.value.taskStatesV2['earlier-task'])
    assert.deepEqual(after.value.checkpointCommits, before.value.checkpointCommits)
  } finally { await f.close() }
})

test('receipt-bound resume revalidates repository after reconciliation', async () => {
  const f = await fixture()
  try {
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'late drift')
    await assert.rejects(f.runtime().resume({ taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }), /BASELINE_DRIFT/u)
    assert.equal(f.executions(), 1)
    assert.equal((await (await f.access()).read()).value.taskRetry.phase, 'PENDING')
  } finally { await f.close() }
})


test('two runtime owners cannot reconcile or consume one receipt twice', async () => {
  const f = await fixture()
  const second = f.additionalRuntime()
  try {
    await second.loadPersistedState()
    const results = await Promise.allSettled([f.runtime().reconcileTaskRetry(f.request), second.reconcileTaskRetry(f.request)])
    const accepted = results.filter(result => result.status === 'fulfilled')
    assert.equal(accepted.length, 1)
    const receipt = accepted[0]!.value
    const input = { taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }
    const resumed = await Promise.allSettled([f.runtime().resume(input), second.resume(input)])
    assert.equal(resumed.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(f.executions(), 2)
    assert.equal((await (await f.access()).read()).value.taskRetryHistory.length, 1)
  } finally { await second.close(); await f.close() }
})

test('a corrupted durable receipt cannot redirect resume to another workflow run', async () => {
  const f = await fixture()
  try {
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    const access = await f.access()
    await access.mutate(state => { state.taskRetry.receipt.workflowRunId = 'another-run' })
    const before = await access.read()
    await assert.rejects(f.runtime().resume({ taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }))
    assert.deepEqual(await access.read(), before)
    assert.equal(f.executions(), 1)
  } finally { await f.close() }
})


test('protected reconciliation API is explicit and receipt-bound resume executes exactly once', async () => {
  const f = await fixture()
  const controller = new WorkSessionControlController({ createRuntime: () => f.runtime() })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  try {
    const address = await server.start()
    const headers = { 'X-NovaWing-Control-Token': server.getTokenForTest(), Origin: address.url, 'Content-Type': 'application/json' }
    const post = (path: string, body: unknown, customHeaders = headers) => fetch(address.url + path,
      { method: 'POST', headers: customHeaders, body: JSON.stringify(body) })
    const path = '/api/session/reconcile-task-retry'
    const before = await (await f.access()).read()
    assert.equal((await post(path, f.request, { ...headers, 'X-NovaWing-Control-Token': '' })).status, 403)
    assert.equal((await post(path, f.request, { ...headers, Origin: 'http://evil.example' })).status, 403)
    assert.equal((await post(path, { ...f.request, reasonCode: 'MANUAL_OVERRIDE' })).status, 400)
    assert.equal((await post(path, { ...f.request, expectedGeneration: 999 })).status, 409)
    assert.deepEqual(await (await f.access()).read(), before)
    const response = await post(path, f.request)
    assert.equal(response.status, 200)
    const receipt = await response.json() as { receiptId: string; taskId: string; generation: number; nextDecision: string }
    assert.equal(receipt.nextDecision, 'EXECUTE')
    assert.equal(f.executions(), 1)
    const view = await (await fetch(address.url + '/api/status')).json() as { runtime: { taskRetryReceipt: unknown } }
    assert.deepEqual(view.runtime.taskRetryReceipt, receipt)
    assert.equal((await post(path, f.request)).status, 409)
    assert.equal((await post('/api/session/resume', {})).status, 409)
    const input = { taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }
    assert.equal((await post('/api/session/resume', input)).status, 202)
    await controller.getResumePromise()
    assert.equal(f.executions(), 2)
    assert.equal((await post('/api/session/resume', input)).status, 409)
    assert.equal(f.runtime().getRunId(), f.request.workflowRunId)
    assert.equal(f.git('status', '--porcelain'), '')
  } finally { await server.close(); await f.close() }
})

test('production retry uses a new Executor continuation namespace and preserves the old attempt', async () => {
  const f = await fixture()
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    const env = { ...process.env, NOVAWING_DATA_DIR: f.data }
    const coding = new CodingExecutionStore(defaultCodingExecutionStorePath(env))
    const oldKey = JSON.stringify([f.definition.id, 'T1'])
    const newKey = JSON.stringify([f.definition.id, 'T1', receipt.attemptId])
    coding.save(oldKey, { mode: 'codex', activeExecutor: 'codex', history: ['codex'], codexThreadId: 'legacy-thread' },
      { type: 'codex_thread_started', timestamp: new Date().toISOString(), codexThreadId: 'legacy-thread' })
    const oldMetadata = coding.read(oldKey)
    const oldEvents = coding.events(oldKey)
    const restored: unknown[] = []
    let dispatcher: V2ActionDispatcher | undefined
    const config = await validateTrustedWorkSessionConfig({
      session: { id: f.definition.id, targetRepo: f.definition.targetRepo, branch: f.definition.branch,
        controlPlane: 'v2', directPath: { enabled: false }, goldenPath: { enabled: false }, limits: f.definition.limits },
      tasks: f.definition.tasks.map(task => ({ id: task.id, goal: task.goal, risk: task.risk, executorMode: 'codex',
        guardian: { constraints: task.constraints, acceptanceCriteria: task.acceptanceCriteria,
          allowedPaths: task.allowedPaths, forbiddenPaths: task.forbiddenPaths, doNotDo: [] }, acceptanceEvidenceBindings: task.acceptanceEvidenceBindings })),
      executor: { model: 'fixture', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(f.data, 'session.db')).href,
    })
    app = await createProductionWorkSessionUi(config, { env,
      createRuntime: input => new FakeRuntime(input.definition),
      createV2Dispatcher: ({ defaultDispatcher }) => { dispatcher = defaultDispatcher; return defaultDispatcher },
      createCodexExecutor: options => ({
        restoreProviderState: state => { restored.push(structuredClone(state)) },
        execute: async () => {
          options.onThread?.('new-attempt-thread', false)
          return { summary: 'fixture stopped', changedFiles: [], commandsRun: [], verificationResults: [], blockers: ['fixture stop'] }
        },
      }),
    })
    const task = f.runtime().getDurableState()!.taskStatesV2!.T1!
    await dispatcher!.dispatch({ action: 'EXECUTE', task, agent: { id: 'executor',
      identity: { agent: 'executor', provider: 'codex', runtimeIdentity: 'fixture-codex' }, available: true,
      quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true, reasoning: true, review: false } } })
    assert.equal(JSON.stringify(restored).includes('legacy-thread'), false)
    assert.equal(coding.read(newKey)?.codexThreadId, 'new-attempt-thread')
    assert.deepEqual(coding.read(oldKey), oldMetadata)
    assert.deepEqual(coding.events(oldKey), oldEvents)
    assert.equal(f.git('status', '--porcelain'), '')
  } finally { await app?.close(); await f.close() }
})


test('a failed reconciliation snapshot write leaves no partial projection or audit event', async () => {
  const f = await fixture()
  try {
    const access = await f.access()
    const before = await access.read()
    access.failNextWrite()
    await assert.rejects(f.runtime().reconcileTaskRetry(f.request), /fixture persistence failure/u)
    assert.deepEqual(await access.read(), before)
    assert.equal(f.executions(), 1)
    assert.equal((await f.runtime().reconcileTaskRetry(f.request)).nextDecision, 'EXECUTE')
    assert.equal((await access.read()).value.taskRetryHistory.length, 1)
  } finally { await f.close() }
})

test('interrupted receipt consumption fails closed across reopen without a second dispatch', async () => {
  const f = await fixture()
  try {
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    await (await f.access()).mutate(state => { state.taskRetry.phase = 'RESUME_CLAIMED' })
    await f.recreate()
    await assert.rejects(f.runtime().resume({ taskRetryReceiptId: receipt.receiptId, taskId: receipt.taskId, generation: receipt.generation }), /ALREADY_CONSUMED/u)
    await assert.rejects(f.runtime().resume({}), /ALREADY_CONSUMED/u)
    await assert.rejects(f.runtime().reconcileTaskRetry(f.request), /ALREADY_RECONCILED/u)
    assert.equal(f.executions(), 1)
  } finally { await f.close() }
})


test('legacy absolute scope and Launchpad forbidden paths are preserved by retry', async () => {
  const f = await fixture()
  try {
    f.definition.tasks[0]!.allowedPaths = [f.root]
    await (await f.access()).mutate(state => { state.taskStatesV2.T1.permissions.allowedPaths = [f.root] })
    const receipt = await f.runtime().reconcileTaskRetry(f.request)
    assert.equal(receipt.nextDecision, 'EXECUTE')
    const permissions = f.runtime().getDurableState()!.taskStatesV2!.T1!.permissions
    assert.deepEqual(permissions.allowedPaths, [f.root])
    assert.deepEqual(permissions.forbiddenPaths, [...DEFAULT_WORKSPACE_FORBIDDEN_PATHS])
  } finally { await f.close() }
})


function healthRequest(request: TaskRetryRequest) {
  const { reasonCode: _reason, ...binding } = request
  return { ...binding, provider: 'deepseek' as const }
}
function healthResult(status: 'AVAILABLE' | 'DEGRADED' = 'AVAILABLE'): ReviewerHealthProbeResult {
  return { probeId: '33333333-3333-4333-8333-333333333333', provider: 'deepseek', status,
    reasonCode: status === 'AVAILABLE' ? 'REVIEWER_PROBE_PASSED' : 'REVIEWER_PROBE_FAILED',
    requestedModel: 'sonnet', resolvedModel: 'deepseek-flash', observedAt: new Date().toISOString() }
}
for (const status of ['AVAILABLE', 'DEGRADED'] as const) {
  test(`reviewer refresh-only persists ${status} with audit, no dispatch and no task/generation/budget change`, async () => {
    const f = await fixture()
    try {
      let calls = 0
      f.setHealthProbe(async () => { calls++; return healthResult(status) })
      const before = await (await f.access()).read()
      const result = await f.runtime().refreshReviewerHealth(healthRequest(f.request))
      assert.equal(result.status, status)
      const after = await (await f.access()).read()
      const { providerHealth: oldHealth, taskEventLogs: oldEvents, reviewerHealthHistory: _oldHistory, ...oldState } = before.value
      const { providerHealth: health, taskEventLogs: events, reviewerHealthHistory: history, ...state } = after.value
      assert.deepEqual(state, oldState)
      assert.deepEqual(events.T1.slice(0, -1), oldEvents.T1)
      assert.equal(events.T1.at(-1).type, 'REVIEWER_HEALTH_REFRESHED')
      assert.deepEqual(history[0].previousObservation, oldHealth.deepseek)
      assert.equal(health.deepseek.status, status)
      assert.equal(calls, 1); assert.equal(f.executions(), 1)
      assert.equal(f.git('status', '--porcelain'), '')
      await f.recreate()
      assert.equal((await (await f.access()).read()).value.providerHealth.deepseek.status, status)
      if (status === 'AVAILABLE') {
        await f.runtime().reconcileTaskRetry(f.request)
        const reconciled = await (await f.access()).read()
        assert.equal(reconciled.value.providerHealth.deepseek.status, 'AVAILABLE')
        assert.equal(reconciled.value.taskRetry.phase, 'PENDING')
        assert.equal(f.executions(), 1)
      }
    } finally { await f.close() }
  })
}
for (const mode of ['running', 'wrong-generation', 'wrong-task', 'active-executor', 'baseline-drift', 'runtime-drift'] as const) {
  test(`refresh-only rejects ${mode} before probe or state mutation`, async () => {
    const f = await fixture(); let release: (() => void) | undefined
    try {
      let calls=0; f.setHealthProbe(async () => { calls++; return healthResult() })
      const request=healthRequest(f.request), access=await f.access()
      if(mode==='running') await access.mutate((state,snapshot)=>{state.state='RUNNING';snapshot.status='running'})
      if(mode==='wrong-generation') request.expectedGeneration++
      if(mode==='wrong-task') request.taskId='T2'
      if(mode==='active-executor') release=f.coding.acquire(f.root,'busy')
      if(mode==='baseline-drift') await writeFile(join(f.repo,'dirty.txt'),'drift')
      if(mode==='runtime-drift') request.runtimePlanHash='b'.repeat(64)
      const before=await access.read()
      await assert.rejects(f.runtime().refreshReviewerHealth(request))
      assert.deepEqual(await access.read(),before);assert.equal(calls,0)
    } finally { release?.(); await f.close() }
  })
}
test('refresh-only owns session/workspace locks until probe settles; no concurrent resume/reconcile/probe', async () => {
  const f=await fixture(), second=f.additionalRuntime()
  try {
    let resolve!: (value: ReviewerHealthProbeResult) => void
    let started!: () => void
    const ready=new Promise<void>(r=>{started=r})
    f.setHealthProbe(()=>{started();return new Promise(r=>{resolve=r})})
    const refresh=f.runtime().refreshReviewerHealth(healthRequest(f.request))
    await ready
    await assert.rejects(second.refreshReviewerHealth(healthRequest(f.request)))
    await assert.rejects(second.resume({}))
    await assert.rejects(f.runtime().reconcileTaskRetry(f.request))
    resolve(healthResult());await refresh
    assert.equal(f.executions(),1)
  } finally {await second.close();await f.close()}
})
test('refresh-only protected HTTP endpoint does not call resume', async () => {
  const f=await fixture()
  const controller=new WorkSessionControlController({createRuntime:()=>f.runtime()})
  const server=new WorkSessionControlServer({controller,port:0})
  try {
    f.setHealthProbe(async()=>healthResult())
    const address=await server.start(),url=address.url+'/api/session/refresh-reviewer-health'
    const body=JSON.stringify(healthRequest(f.request))
    assert.equal((await fetch(url,{method:'POST',body})).status,403)
    const response=await fetch(url,{method:'POST',body,headers:{Origin:address.url,'Content-Type':'application/json','X-NovaWing-Control-Token':server.getTokenForTest()}})
    assert.equal(response.status,200)
    assert.equal((await response.json() as ReviewerHealthProbeResult).status,'AVAILABLE')
    assert.equal(controller.getSnapshot().runtime.reviewerHealth?.status,'AVAILABLE')
    assert.equal(controller.getSnapshot().runtime.reviewerHealth?.resolvedModel,'deepseek-flash')
    assert.equal(f.executions(),1);assert.equal(f.runtime().getDurableState()!.humanRequiredGeneration,f.request.expectedGeneration)
  } finally {await server.close();await f.close()}
})
test('health probe uses an isolated fixture and never trusts an unproved verdict', async () => {
  const f=await fixture()
  try {
    for(const pass of [true,false]) {
      const result=await probeDeepSeekReviewer({cwd:f.repo,model:'sonnet',env:{CLAUDE_CONFIG_DIR:join(f.data,'empty')},
        createReviewer:({cwd,env})=>({provider:'deepseek',review:async ()=>{
          assert.notEqual(cwd,f.repo);assert.notEqual(env.CLAUDE_CONFIG_DIR,process.env.CLAUDE_CONFIG_DIR)
          const content=await import('node:fs/promises').then(fs=>fs.readFile(join(cwd,'health.txt'),'utf8'))
          return {kind:'VERDICT',provider:'deepseek',passed:true,findings:[],blockingFindings:[],summary:'fixture',
            assertionVerdicts:[{assertionId:'HEALTH_PROBE',verdict:'PASS',evidence:pass?content:'unproved'}]}
        }})})
      assert.equal(result.status,pass?'AVAILABLE':'DEGRADED')
      assert.equal(f.git('status','--porcelain'),'')
    }
  } finally {await f.close()}
})
