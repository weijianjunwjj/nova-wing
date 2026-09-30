import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { codexTestRepo } from './codex-test-fixture.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import type { DelegationPacket } from '../packages/development-guardian/model.js'

test('production V2 passes failed independent review findings to the next coding turn as untrusted observations', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-review-feedback-'))
  let dispatch: V2ActionDispatcher['dispatch'] | undefined
  let packet: DelegationPacket | undefined
  const finding = 'src/a.ts: returned object has createdAt and updatedAt; strict expected shape omits both fields'
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'v2-review-feedback', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Fix returned object test', executorMode: 'codex', guardian: { constraints: [], acceptanceCriteria: ['test passes'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: ['.env'] } }],
      executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false },
      codex: { enabled: true, model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    const app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: data },
      createRuntime(input) { return new FakeRuntime(input.definition) },
      createV2Dispatcher({ defaultDispatcher }) { dispatch = defaultDispatcher.dispatch; return defaultDispatcher },
      createCodexExecutor: () => ({ async execute(input) {
        packet = input.packet
        return { summary: 'captured repair prompt', changedFiles: [], commandsRun: [], verificationResults: [], blockers: [] }
      } }),
    })
    try {
      assert.ok(dispatch)
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const state = { ...createTaskStateV2(app.definition, app.definition.tasks[0]!),
        gitState: { repositoryIdentity: root, branch: 'main', headSha, changedFiles: [], worktreeFingerprint: 'fixture' },
        completion: { evidence: [], bindings: [], review: {
          passed: false, findings: [finding], blockingFindings: [finding], severity: 'HIGH' as const,
          reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'reviewer-runtime' },
          implementer: { agent: 'implementer', provider: 'codex', runtimeIdentity: 'implementer-runtime' },
          reviewedFiles: ['src/a.ts'], timestamp: new Date().toISOString(),
        } },
      }
      await dispatch({ action: 'EXECUTE', task: state, agent: {
        id: 'executor', identity: { agent: 'executor', provider: 'codex', runtimeIdentity: 'executor-runtime' },
        available: true, quotaExhausted: false, degraded: false,
        capabilities: { coding: true, reasoning: true, verification: true, review: false },
      } })
      assert.ok(packet)
      assert.ok(packet.instructions.some((instruction) => instruction.includes(finding)))
      assert.ok(packet.instructions.some((instruction) => instruction.includes('untrusted observations')))
      assert.ok(packet.instructions.some((instruction) => instruction.includes('Do not claim ALREADY_SATISFIED')))
    } finally { await app.close() }
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRuntimeData(data) }
})

test('production V2 composition root dispatches controller actions without Guardian orchestration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-production-v2-repo-'))
  const data = await mkdtemp(join(tmpdir(), 'novawing-production-v2-data-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  const actions: string[] = []
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'v2-production', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Fix controller', guardian: { constraints: ['small'], acceptanceCriteria: ['verified'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: ['.env'] }, acceptanceEvidenceBindings: [{ criterion: 'verified', requiredEvidence: ['test'] }] }],
      executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false }, gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    const app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createV2Dispatcher: () => ({
        inspectRepository: async () => ({ repositoryIdentity: root, branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
        dispatch: async ({ action }) => { actions.push(action); return action === 'VERIFY'
          ? { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
          : { status: 'SUCCESS', changedFiles: [] } },
      }),
    })
    assert.ok(runtime!.taskRunner instanceof V2ControllerTaskRunner)
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!)
    assert.equal(result.status, 'COMPLETED')
    assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])
    assert.deepEqual(app.definition.tasks[0]!.allowedPaths, ['src/**'])
    await app.close()
  } finally { await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})

test('production V2 routes a quota-exhausted Codex task to DeepSeek with one TaskStateV2', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-production-v2-router-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  let deepSeekCalls = 0
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'v2-router', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Fix controller', executorMode: 'auto', guardian: { constraints: ['small'], acceptanceCriteria: ['verified'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: ['.env'] }, acceptanceEvidenceBindings: [{ criterion: 'verified', requiredEvidence: ['test'] }] }],
      executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false }, gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    const app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createCodexExecutor: () => ({ async execute() {
        await writeFile(join(root, 'src', 'a.ts'), 'export const partial = true\n')
        const error = classifyCodexError({ code: 'quota_exhausted' })
        return { summary: 'partial', changedFiles: ['src/a.ts'], commandsRun: [], verificationResults: [], blockers: [error.message] }
      }, lastError: classifyCodexError({ code: 'quota_exhausted' }) }),
      createExecutor: () => ({ async execute() { deepSeekCalls++; return { summary: 'continued', changedFiles: ['src/a.ts'], commandsRun: ['npm test'], verificationResults: [{ name: 'test', status: 'passed' as const }], blockers: [] } }, async retryVerification({ report }) { return { ...report, verificationResults: report.verificationResults.map((r) => ({ ...r, status: 'passed' as const })) } } }),
    })
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!)
    assert.equal(result.status, 'COMPLETED')
    assert.equal(result.taskStateV2?.identity.taskId, 'T1')
    assert.deepEqual(result.taskStateV2?.providerHistory, ['codex', 'deepseek'])
    assert.equal(deepSeekCalls, 1)
    await app.close()
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRuntimeData(data) }
})

async function mutateRuntimeSnapshot(runtime: WorkSessionRuntime, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const internal = runtime as unknown as { mastra: { getStorage(): { getStore(name: string): Promise<any> } | undefined }; workflowId: string }
  const workflows = await internal.mastra.getStorage()?.getStore('workflows')
  assert.ok(workflows)
  const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: internal.workflowId, runId: runtime.getDefinition().id })
  assert.ok(snapshot)
  mutate(snapshot.value as Record<string, unknown>)
  await workflows.persistWorkflowSnapshot({ workflowName: internal.workflowId, runId: runtime.getDefinition().id, snapshot })
}

async function cleanupRuntimeData(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
}

test('production runtime lets V2 state override a conflicting legacy completion projection', async () => {
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-legacy-conflict-'))
  const definition = { id: 'v2-legacy-conflict', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
    tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }], limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }
  const state = { ...createTaskStateV2(definition, definition.tasks[0]!), status: 'SUSPENDED' as const, blockers: ['repository blocker'] }
  let calls = 0
  const runner = { async run() { calls++; return { status: 'HUMAN_REQUIRED' as const, humanRequired: { category: 'DECISION_REQUIRED', reason: 'repository blocker' }, taskStateV2: state } } }
  const storageUrl = pathToFileURL(join(data, 'session.db')).href
  const first = new WorkSessionRuntime({ definition, taskRunner: runner, storageUrl })
  try {
    await first.start()
    await mutateRuntimeSnapshot(first, (value) => { value.completedTaskIds = ['T1'] })
  } finally { await first.close() }
  const restarted = new WorkSessionRuntime({ definition, taskRunner: runner, storageUrl })
  try {
    const recovered = await restarted.resume({ approval: true })
    assert.equal(calls, 2, 'V2 task must not be skipped because legacy projected completion')
    assert.deepEqual(recovered.completedTaskIds, [], 'legacy completion must project canonical blocked state')
    assert.notEqual(recovered.taskStatesV2?.T1?.status, 'COMPLETED')
  } finally { await restarted.close(); await cleanupRuntimeData(data) }
})

test('production runtime fails closed when a persisted V2 task state is missing despite a Guardian checkpoint', async () => {
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-missing-state-'))
  const definition = { id: 'v2-missing-state', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
    tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'] }], limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }
  const initial = createTaskStateV2(definition, definition.tasks[0]!)
  let calls = 0
  const runner = { async run() { calls++; return { status: 'HUMAN_REQUIRED' as const, humanRequired: { category: 'DECISION_REQUIRED', reason: 'pause' }, taskStateV2: { ...initial, status: 'SUSPENDED' as const } } } }
  const storageUrl = pathToFileURL(join(data, 'session.db')).href
  const first = new WorkSessionRuntime({ definition, taskRunner: runner, storageUrl })
  try {
    await first.start()
    await mutateRuntimeSnapshot(first, (value) => { delete (value.taskStatesV2 as Record<string, unknown>).T1; value.currentTaskCheckpoint = { task: { state: 'REVIEW' } } })
  } finally { await first.close() }
  const restarted = new WorkSessionRuntime({ definition, taskRunner: runner, storageUrl })
  try {
    const recovered = await restarted.resume({ approval: true })
    assert.equal(calls, 1, 'Guardian checkpoint must not seed a V2 semantic task')
    assert.equal(recovered.state, 'SUSPENDED')
    assert.equal(recovered.humanRequired?.category, 'RECOVERY_BLOCKED')
  } finally { await restarted.close(); await cleanupRuntimeData(data) }
})

test('real runtime restart reloads persisted TaskStateV2 and re-decides without resetting to PENDING', async () => {
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-restart-'))
  const storageUrl = pathToFileURL(join(data, 'session.db')).href
  const definition = { id: 'v2-restart', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
    tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }],
    limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }

  const makeRunner = () => {
    const dispatchCalls: string[] = []
    const runner = new V2ControllerTaskRunner({
      sessionId: definition.id, branch: definition.branch,
      agents: [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }],
      dispatcher: {
        inspectRepository: async () => ({ repositoryIdentity: data, branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
        dispatch: async ({ action }) => {
          dispatchCalls.push(action)
          if (action === 'EXECUTE') return { status: 'BLOCKED' as const, blockers: ['external-blocker'], providerHistory: ['codex', 'deepseek'] }
          return { status: 'SUCCESS' as const, verificationResults: [{ name: 'test', status: 'passed' as const }] }
        },
      },
    })
    return { runner, dispatchCalls }
  }

  const first = makeRunner()
  const runtimeA = new WorkSessionRuntime({ definition, taskRunner: first.runner, storageUrl })
  try {
    const started = await runtimeA.start()
    assert.equal(started.state, 'SUSPENDED')
    assert.deepEqual(started.taskStatesV2?.T1?.providerHistory, ['codex', 'deepseek'])
    assert.deepEqual(started.taskStatesV2?.T1?.blockers, ['external-blocker'])
    assert.ok(!('checkpoint' in (started.taskStatesV2?.T1 as unknown as Record<string, unknown>)),
      'removed TaskStateV2.checkpoint projection must not reappear')
  } finally { await runtimeA.close() }

  // 进程重启：重建 runtime 与 runner，共享同一个持久化 storageUrl。
  const second = makeRunner()
  const runtimeB = new WorkSessionRuntime({ definition, taskRunner: second.runner, storageUrl })
  try {
    const resumed = await runtimeB.resume({ approval: true })
    assert.equal(resumed.state, 'SUSPENDED')
    assert.deepEqual(second.dispatchCalls, [], 'restart must re-decide from persisted SUSPENDED, not re-dispatch EXECUTE')
    assert.deepEqual(resumed.taskStatesV2?.T1?.providerHistory, ['codex', 'deepseek'])
    assert.ok((resumed.taskStatesV2?.T1?.blockers ?? []).length > 0, 'persisted blocker must still block on restart')
    assert.notEqual(resumed.taskStatesV2?.T1?.status, 'PENDING')
  } finally { await runtimeB.close(); await cleanupRuntimeData(data) }
})

test('production VERIFY uses router deterministic retry without starting a coding turn', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-verify-only-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  let executions = 0
  let verifications = 0
  const config = await validateTrustedWorkSessionConfig({
    session: { id: 'v2-verify', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'verify', executorMode: 'deepseek', guardian: { constraints: [], acceptanceCriteria: ['tests'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: ['.env'] }, acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['npm test'] }] }],
    executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false }, gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
  })
  const app = await createProductionWorkSessionUi(config, {
    env: { ...process.env, NOVAWING_DATA_DIR: data },
    createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
    createExecutor: () => ({
      async execute() { executions++; throw new Error('VERIFY must not execute coding') },
      async retryVerification({ report }) { verifications++; return { ...report, verificationResults: report.verificationResults.map((r) => ({ ...r, status: 'passed' as const })) } },
    }),
  })
  try {
    const initial = { ...createTaskStateV2(app.definition, app.definition.tasks[0]!), status: 'ACTIVE' as const }
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!, undefined, undefined, { taskStateV2: initial })
    assert.equal(result.status, 'COMPLETED')
    assert.equal(executions, 0)
    assert.equal(verifications, 1)
    // providerHistory is implementation provenance: a VERIFY-only task never
    // executes, so no implementer provider is recorded even though the router
    // deterministically retries verification through the configured executor.
    assert.deepEqual(result.taskStateV2?.providerHistory, [])
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); await cleanupRuntimeData(data) }
})

for (const mutation of ['invalid state', 'advanced legacy index'] as const) {
  test(`runtime recovery fails closed for ${mutation}`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'novawing-v2-invalid-recovery-'))
    const definition = { id: 'v2-invalid', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
      tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'] }], limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }
    const storageUrl = pathToFileURL(join(data, 'session.db')).href
    let calls = 0
    const runner = { async run() { calls++; return { status: 'HUMAN_REQUIRED' as const, humanRequired: { category: 'DECISION_REQUIRED', reason: 'blocked' }, taskStateV2: createTaskStateV2(definition, definition.tasks[0]!) } } }
    const first = new WorkSessionRuntime({ definition, storageUrl, taskRunner: runner })
    try {
      await first.start()
      await mutateRuntimeSnapshot(first, (value) => {
        if (mutation === 'invalid state') (value.taskStatesV2 as Record<string, unknown>).T1 = { version: 2, identity: { taskId: 'T1', sessionId: definition.id } }
        else { value.currentTaskIndex = 99; value.currentTaskId = null; delete (value.taskStatesV2 as Record<string, unknown>).T1 }
      })
    } finally { await first.close() }
    const second = new WorkSessionRuntime({ definition, storageUrl, taskRunner: runner })
    try {
      const result = await second.resume({ approval: true })
      assert.equal(result.humanRequired?.category, 'RECOVERY_BLOCKED')
      assert.equal(calls, 1)
    } finally { await second.close(); await cleanupRuntimeData(data) }
  })
}

test('real V2 runtime persists CRITICAL approval request across restart without legacy blocker pollution', async () => {
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-human-approval-'))
  const storageUrl = pathToFileURL(join(data, 'session.db')).href
  const definition = { id: 'v2-approval', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
    tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }],
    limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }
  let files: readonly string[] = []
  let executions = 0
  const runner = () => new V2ControllerTaskRunner({ sessionId: definition.id, branch: 'main',
    agents: [{ id: 'coder', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }], dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: data, branch: 'main', headSha: 'h', changedFiles: files, worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => { if (action === 'EXECUTE') { executions++; files = ['auth/security.ts', 'database/schema.ts'] }
        return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] } },
    } })
  const first = new WorkSessionRuntime({ definition, storageUrl, taskRunner: runner() })
  try {
    const request = await first.start()
    assert.equal(request.state, 'SUSPENDED')
    assert.equal(request.taskStatesV2?.T1?.currentAction, 'REQUEST_APPROVAL')
    assert.equal(request.taskStatesV2?.T1?.status, 'SUSPENDED')
    assert.deepEqual(request.taskStatesV2?.T1?.blockers, [])
  } finally { await first.close() }
  const second = new WorkSessionRuntime({ definition, storageUrl, taskRunner: runner() })
  try {
    const result = await second.resume({ approval: true })
    assert.equal(result.state, 'COMPLETED')
    assert.equal(result.taskStatesV2?.T1?.completion.approval?.approved, true)
    assert.equal(executions, 1)
  } finally { await second.close(); await cleanupRuntimeData(data) }
})
