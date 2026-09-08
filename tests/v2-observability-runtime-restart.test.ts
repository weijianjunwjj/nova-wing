import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { codexTestRepo } from './codex-test-fixture.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import {
  createProductionWorkSessionUi,
  validateTrustedWorkSessionConfig,
} from '../packages/development-guardian/work-session/production.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import {
  ProviderHealthRegistry,
  TaskEventLogV2,
} from '../packages/development-guardian/work-session/task-observability.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import type { TaskEventV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'

function typesOf(events: readonly TaskEventV2[] | undefined): string[] {
  return (events ?? []).map((event) => event.type)
}

async function cleanupRuntimeData(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
}

test('Task Event Log and Provider Health persist across restart and append new events without id collisions', async () => {
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-observability-restart-'))
  const storageUrl = pathToFileURL(join(data, 'session.db')).href
  const definition = { id: 'v2-obs-restart', targetRepo: data, branch: 'main', controlPlane: 'v2' as const,
    tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }],
    limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }

  const makeRunner = (worktreeFiles: readonly string[]) => {
    let files: readonly string[] = [...worktreeFiles]
    const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: 'main', agents: [
      { id: 'coder', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } },
    ], dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: data, branch: 'main', headSha: 'h', changedFiles: files, worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => {
        if (action === 'EXECUTE') { files = ['auth/security.ts', 'database/schema.ts']; return { status: 'SUCCESS' as const } }
        return { status: 'SUCCESS' as const, verificationResults: [{ name: 'test', status: 'passed' as const }] }
      },
    } })
    return runner
  }

  const first = new WorkSessionRuntime({ definition, storageUrl, taskRunner: makeRunner([]) })
  try {
    const suspended = await first.start()
    assert.equal(suspended.state, 'SUSPENDED')
    assert.equal(suspended.taskStatesV2?.T1?.currentAction, 'REQUEST_APPROVAL')
    const firstEvents = suspended.taskEventLogs?.T1
    assert.ok(firstEvents !== undefined, 'durable Task Event Log must exist after a run')
    const firstTypes = typesOf(firstEvents)
    assert.ok(firstTypes.includes('TASK_CREATED'))
    assert.ok(firstTypes.includes('CONTROLLER_DECIDED'))
    assert.ok(firstTypes.includes('AGENT_DISPATCHED'))
    assert.ok(firstTypes.includes('APPROVAL_REQUIRED'))
    assert.ok(!firstTypes.includes('TASK_COMPLETED'))
    assert.ok(suspended.providerHealth !== undefined, 'Provider Health projection must be durable')
  } finally { await first.close() }

  // After the first run's EXECUTE, the worktree keeps its changes; repository reality is stable.
  const second = new WorkSessionRuntime({ definition, storageUrl, taskRunner: makeRunner(['auth/security.ts', 'database/schema.ts']) })
  try {
    const resumed = await second.resume({ approval: true })
    assert.equal(resumed.state, 'COMPLETED')
    const secondEvents = resumed.taskEventLogs?.T1
    assert.ok(secondEvents !== undefined)
    const allTypes = typesOf(secondEvents)
    assert.ok(allTypes.includes('TASK_RESUMED'), 'restart of an existing task records TASK_RESUMED')
    assert.ok(allTypes.includes('APPROVAL_GRANTED'), 'human approval after restart records APPROVAL_GRANTED')
    assert.ok(allTypes.includes('TASK_COMPLETED'), 'completion after restart appends TASK_COMPLETED')
    assert.equal(allTypes.filter((type) => type === 'TASK_CREATED').length, 1, 'TASK_CREATED must never be duplicated across restart')
    // event ids are monotonic and unique across restart boundaries.
    const ids = secondEvents.map((event) => Number.parseInt(event.eventId, 10))
    assert.ok(ids.every((id) => Number.isSafeInteger(id)))
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]!), 'event ids must increase monotonically')
    // provider history on the canonical state survives restart.
    assert.deepEqual(resumed.taskStatesV2?.T1?.providerHistory, ['coder'])
    // history never becomes semantic authority: canonical completion is what finished the task.
    assert.equal(resumed.taskStatesV2?.T1?.status, 'COMPLETED')
  } finally { await second.close(); await cleanupRuntimeData(data) }
})

test('production Codex-to-DeepSeek failover records health change, provider switch and reason telemetry', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-obs-router-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'v2-obs-router', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
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
      createExecutor: () => ({ async execute() { return { summary: 'continued', changedFiles: ['src/a.ts'], commandsRun: ['npm test'], verificationResults: [{ name: 'test', status: 'passed' as const }], blockers: [] } }, async retryVerification({ report }) { return { ...report, verificationResults: report.verificationResults.map((r) => ({ ...r, status: 'passed' as const })) } } }),
    })
    const eventLog = new TaskEventLogV2()
    const providerHealth = new ProviderHealthRegistry()
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!, undefined, undefined, { taskEventLog: eventLog, providerHealth })
    assert.equal(result.status, 'COMPLETED')
    assert.deepEqual(result.taskStateV2?.providerHistory, ['codex', 'deepseek'])
    assert.ok(eventLog.has('PROVIDER_HEALTH_CHANGED'), 'Codex quota exhaustion must be recorded as a Provider Health change')
    assert.ok(eventLog.has('PROVIDER_SWITCHED'), 'Codex to DeepSeek failover must record a provider switch')
    const switchEvent = eventLog.events.find((event) => event.type === 'PROVIDER_SWITCHED')
    assert.equal(switchEvent?.previousProvider, 'codex')
    assert.equal(switchEvent?.provider, 'deepseek')
    assert.equal(switchEvent?.reasonCode, 'PROVIDER_QUOTA_EXHAUSTED')
    const healthChange = eventLog.events.find((event) => event.type === 'PROVIDER_HEALTH_CHANGED')
    assert.equal(healthChange?.provider, 'codex')
    assert.equal(healthChange?.metadata?.status, 'QUOTA_EXHAUSTED')
    const switchedAway = eventLog.events.find((event) => event.type === 'PROVIDER_SWITCHED' && event.previousProvider === 'codex')
    assert.equal(switchedAway?.explanation?.reasonCode, 'PROVIDER_QUOTA_EXHAUSTED')
    assert.equal(providerHealth.get('codex')?.status, 'QUOTA_EXHAUSTED')
    await app.close()
  } finally { await rm(root, { recursive: true, force: true }); await cleanupRuntimeData(data) }
})
