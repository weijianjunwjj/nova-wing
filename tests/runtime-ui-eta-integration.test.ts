import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { TaskEtaService, createRuntimeTaskEtaService, type TaskEtaEstimate } from '../packages/development-guardian/work-session/control-ui/task-eta.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { FakeRuntime, makeState } from './work-session-w005-a-helpers.js'

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'novawing-eta-production-repo-'))
  const data = await mkdtemp(join(tmpdir(), 'novawing-eta-production-data-'))
  await mkdir(join(repo, 'src'))
  await mkdir(join(repo, 'tests'))
  await writeFile(join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:ui': 'node --test tests/ui.test.js' } }))
  await writeFile(join(repo, 'src', 'ui.js'), 'export const status = "old"\n')
  await writeFile(join(repo, 'tests', 'ui.test.js'), 'export {}\n')
  const config = await validateTrustedWorkSessionConfig({
    session: { id: 'eta-production', targetRepo: repo, branch: 'main', controlPlane: 'v2', goldenPath: { enabled: true }, limits: { softMinutes: 5, hardMinutes: 10, maxTasks: 1 } },
    tasks: [{ id: 'UI', goal: 'Improve UI status display', risk: 'LOW', guardian: { constraints: [], acceptanceCriteria: ['UI status test passes'], doNotDo: [], allowedPaths: ['src'], forbiddenPaths: ['.env'] } }],
    executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false },
    gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
  })
  return { repo, data, config }
}

test('production Controller start/resume complete independently while ETA provider is pending or unavailable', async () => {
  const { repo, data, config } = await fixture()
  let runtime: FakeRuntime | undefined
  let release: () => void = () => {}
  let modelResolved = false
  let calls = 0
  const providerGate = new Promise<void>((resolve) => { release = resolve })
  const eta = createRuntimeTaskEtaService({ directory: join(data, 'eta'), runner: async () => {
    calls++
    await providerGate
    modelResolved = true
    throw new Error('provider unavailable')
  } })
  const app = await createProductionWorkSessionUi(config, {
    env: { LOCALAPPDATA: data }, taskEta: eta,
    createRuntime(input) { runtime = new FakeRuntime(input.definition); return runtime },
    preflight: async () => ({ overall: 'READY', canStart: true, checkedAt: new Date().toISOString(), dependencies: [] }),
  })
  try {
    const timestamp = new Date().toISOString()
    runtime!.state = makeState({ sessionId: app.definition.id, state: 'RUNNING', currentTaskId: 'UI',
      startedAt: new Date(timestamp), taskStatesV2: { UI: createTaskStateV2(app.definition, app.definition.tasks[0]!) },
      taskEventLogs: { UI: [{ eventId: '1', sessionId: app.definition.id, taskId: 'UI', type: 'VERIFICATION_PLANNED', timestamp }] },
    })
    const fallback = app.controller.getSnapshot().eta!
    assert.equal(fallback.source, 'deterministic')
    assert.deepEqual(app.controller.start(), { started: true })
    await app.controller.getStartPromise()
    assert.equal(runtime!.startCalls, 1)
    assert.equal(modelResolved, false, 'runtime start must not await the ETA provider')
    runtime!.state = { ...runtime!.state!, state: 'SUSPENDED', suspensionReason: 'USER_PAUSED' }
    assert.equal(app.controller.resume({}).accepted, true)
    await app.controller.getResumePromise()
    assert.equal(runtime!.resumeCalls, 1)
    assert.equal(modelResolved, false, 'runtime resume must not await the ETA provider')
    release()
    await eta.settled()
    assert.equal(calls, 1)
    assert.deepEqual(app.controller.getSnapshot().eta, fallback)
    assert.equal(app.controller.getSnapshot().runtime.state, 'SUSPENDED')
  } finally {
    release(); await eta.settled(); await app.close()
    await rm(repo, { recursive: true, force: true }); await rm(data, { recursive: true, force: true })
  }
})

test('real Golden runtime exposes first ETA before EXECUTE and one adjusted ETA before VERIFY without changing its execution cap', async () => {
  const { repo, data, config } = await fixture()
  const estimates = new Map<string, TaskEtaEstimate>()
  let llmCalls = 0
  const eta = new TaskEtaService({ cache: {
    read: (key) => estimates.get(key),
    claim: (key, value) => { if (estimates.has(key)) return false; estimates.set(key, value); return true },
    update: (key, value) => { estimates.set(key, value) },
  }, runner: async () => { llmCalls++; throw new Error('offline') } })
  let changed = false
  let executes = 0
  let verifies = 0
  const phases: Array<{ action: string; basis: string | undefined; adjusted: boolean | undefined }> = []
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    app = await createProductionWorkSessionUi(config, {
      env: { LOCALAPPDATA: data }, taskEta: eta,
      createV2Dispatcher: () => ({
        inspectRepository: async () => ({ repositoryIdentity: repo, branch: 'main', headSha: 'head', worktreeFingerprint: changed ? 'changed' : 'clean', changedFiles: changed ? ['src/ui.js'] : [] }),
        dispatch: async ({ action, task }) => {
          const snapshot = app!.controller.getSnapshot()
          phases.push({ action, basis: snapshot.eta?.basis, adjusted: snapshot.eta?.adjusted })
          if (action === 'EXECUTE') {
            executes++
            assert.equal(snapshot.debug?.taskEvents.UI?.some((event) => event.type === 'VERIFICATION_PLANNED'), true)
            assert.equal(snapshot.eta?.basis, 'planning')
            changed = true
            return { status: 'SUCCESS', changedFiles: ['src/ui.js'], providerHistory: ['codex'] }
          }
          assert.equal(action, 'VERIFY')
          verifies++
          assert.equal(snapshot.debug?.taskEvents.UI?.some((event) => event.type === 'AGENT_COMPLETED' && event.action === 'EXECUTE'), true)
          assert.equal(snapshot.eta?.basis, 'executor_completed')
          return { status: 'SUCCESS', verificationResults: task.verificationPlan!.steps.map((step) => ({
            name: step.command, command: step.command, cwd: step.cwd, stepId: step.id, status: 'passed' as const, durationMs: 10,
          })) }
        },
      }),
    })
    assert.equal(app.controller.start().started, true)
    await app.controller.getStartPromise()
    await eta.settled()
    const snapshot = app.controller.getSnapshot()
    assert.equal(snapshot.runtime.state, 'COMPLETED', JSON.stringify(snapshot.runtime))
    assert.deepEqual(phases, [{ action: 'EXECUTE', basis: 'planning', adjusted: false }, { action: 'VERIFY', basis: 'executor_completed', adjusted: true }])
    assert.equal(executes, 1)
    assert.equal(verifies, 1)
    assert.equal(llmCalls, 2)
    assert.equal(snapshot.eta?.adjusted, true)
    assert.equal(snapshot.runtimeOverview?.iteration.maximum, 2)
  } finally {
    await app?.close(); eta.close()
    await rm(repo, { recursive: true, force: true })
    // The existing libsql driver can hold its Windows file handle until this
    // isolated test process exits, as in the runtime integration fixtures.
    await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EBUSY') throw error
    })
  }
})
