import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { codexTestRepo } from './codex-test-fixture.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'

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
      env: { ...process.env, LOCALAPPDATA: data },
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
      env: { ...process.env, LOCALAPPDATA: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createCodexExecutor: () => ({ async execute() {
        await writeFile(join(root, 'src', 'a.ts'), 'export const partial = true\n')
        const error = classifyCodexError({ code: 'quota_exhausted' })
        return { summary: 'partial', changedFiles: ['src/a.ts'], commandsRun: [], verificationResults: [], blockers: [error.message] }
      }, lastError: classifyCodexError({ code: 'quota_exhausted' }) }),
      createExecutor: () => ({ async execute() { deepSeekCalls++; return { summary: 'continued', changedFiles: ['src/a.ts'], commandsRun: ['npm test'], verificationResults: [{ name: 'test', status: 'passed' as const }], blockers: [] } } }),
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
    assert.deepEqual(recovered.completedTaskIds, ['T1'], 'legacy field remains a non-authoritative compatibility projection')
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
