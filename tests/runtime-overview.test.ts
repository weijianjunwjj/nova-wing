import assert from 'node:assert/strict'
import test from 'node:test'
import type { GuardianProgressObserver } from '../packages/development-guardian/progress.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { deriveRuntimeOverview } from '../packages/development-guardian/work-session/control-ui/runtime-overview.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import type { TaskEventV2 } from '../packages/development-guardian/work-session/task-observability.js'
import type { ExecutionLedgerEvent } from '../packages/development-guardian/work-session/execution-ledger.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

const base = Date.parse('2026-09-17T08:00:00.000Z')
function setup() {
  const definition = makeDefinition({ controlPlane: 'v2', goldenPath: { enabled: true } })
  const task = { ...createTaskStateV2(definition, definition.tasks[0]!), execution: { path: 'GOLDEN' as const, escalated: false } }
  const runtime = new FakeRuntime(definition)
  runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1', startedAt: new Date(base), createdAt: new Date(base),
    updatedAt: new Date(base), taskStatesV2: { T1: task }, taskEventLogs: { T1: [] } })
  runtime.activeExecution = true
  let now = base
  let sink: GuardianProgressObserver
  const controller = new WorkSessionControlController({
    createRuntime: eventSink => { sink = eventSink; return runtime }, pollIntervalMs: 60_000, clock: { now: () => now },
    readCodingExecutions: () => [{ taskId: 'T1', mode: 'codex', activeExecutor: 'codex', model: 'gpt-test' }],
  })
  const append = (type: TaskEventV2['type'], action?: TaskEventV2['action']) => {
    const events = runtime.state!.taskEventLogs!.T1!
    runtime.state!.taskEventLogs!.T1 = [...events, {
      eventId: String(events.length + 1), sessionId: definition.id, taskId: 'T1', type,
      ...(action === undefined ? {} : { action }), timestamp: new Date(now).toISOString(), provider: 'codex',
    }]
  }
  return { controller, runtime, append, setTime: (elapsed: number) => { now = base + elapsed },
    progress: (phase: 'EXECUTING' | 'VERIFYING' | 'COMPLETED', status: 'active' | 'completed' | 'failed') => sink!({ phase, status, iteration: 0, elapsedMs: 0,
      activity: { kind: phase === 'EXECUTING' ? status === 'active' ? 'PROVIDER_DISPATCHED' : status === 'completed' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED' : 'CONTROLLER_PHASE_CHANGED', provider: 'codex' } }),
  }
}

test('overview counts the first Executor cycle as 1 / 2 without counting VERIFY or Controller decisions', () => {
  const fixture = setup()
  try {
    assert.deepEqual(fixture.controller.getSnapshot().runtimeOverview?.iteration, { current: 0, maximum: 2 })
    fixture.append('CONTROLLER_DECIDED', 'EXECUTE')
    fixture.append('VERIFICATION_STARTED', 'VERIFY')
    assert.equal(fixture.controller.getSnapshot().runtimeOverview?.iteration.current, 0)
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.progress('EXECUTING', 'active')
    const overview = fixture.controller.getSnapshot().runtimeOverview!
    assert.deepEqual(overview.iteration, { current: 1, maximum: 2 })
    assert.equal(overview.executor.status, 'RUNNING')
    assert.equal(overview.executor.provider, 'codex')
  } finally { fixture.controller.close() }
})

test('Golden retry shows 2 / 2 and hydration preserves it after completion', async () => {
  const fixture = setup()
  try {
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.setTime(30_000)
    fixture.append('AGENT_FAILED', 'EXECUTE')
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.setTime(60_000)
    fixture.append('AGENT_COMPLETED', 'EXECUTE')
    fixture.runtime.state = { ...fixture.runtime.state!, state: 'COMPLETED', currentTaskId: null, completedTaskIds: ['T1'], completedAt: new Date(base + 65_000) }
    fixture.runtime.activeExecution = false
    const reopened = new WorkSessionControlController({ createRuntime: () => fixture.runtime, pollIntervalMs: 60_000, clock: { now: () => base + 600_000 } })
    try {
      await reopened.loadPersistedState()
      const overview = reopened.getSnapshot().runtimeOverview!
      assert.deepEqual(overview.iteration, { current: 2, maximum: 2 })
      assert.equal(overview.executor.status, 'COMPLETED')
      assert.equal(overview.executor.provider, 'codex')
      assert.equal(overview.totalElapsedMs, 65_000)
      assert.equal(overview.lastActivityAt, undefined)
    } finally { reopened.close() }
  } finally { fixture.controller.close() }
})

test('completed overview and compatibility activity elapsed freeze while clock advances', () => {
  const fixture = setup()
  try {
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.progress('EXECUTING', 'active')
    fixture.setTime(374_000)
    fixture.append('AGENT_COMPLETED', 'EXECUTE')
    fixture.progress('EXECUTING', 'completed')
    fixture.runtime.state = { ...fixture.runtime.state!, state: 'COMPLETED', completedAt: new Date(base + 377_000) }
    fixture.runtime.activeExecution = false
    const before = fixture.controller.getSnapshot()
    fixture.setTime(900_000)
    const after = fixture.controller.getSnapshot()
    assert.equal(before.runtimeOverview?.totalElapsedMs, 377_000)
    assert.deepEqual(before.runtimeOverview, after.runtimeOverview)
    assert.equal(before.executionActivity?.elapsedMs, after.executionActivity?.elapsedMs)
    assert.equal(after.runtimeOverview?.executor.status, 'COMPLETED')
  } finally { fixture.controller.close() }
})

test('Advanced path retains third Executor round on interrupted resume without a made-up cap', async () => {
  const fixture = setup()
  try {
    fixture.runtime.state!.taskStatesV2!.T1!.execution = { path: 'CONTROLLER', escalated: true }
    for (let index = 0; index < 3; index++) {
      fixture.append('AGENT_DISPATCHED', 'EXECUTE')
      fixture.append('AGENT_COMPLETED', 'EXECUTE')
      fixture.append('VERIFICATION_STARTED', 'VERIFY')
    }
    fixture.runtime.activeExecution = false
    await fixture.controller.loadPersistedState()
    const overview = fixture.controller.getSnapshot().runtimeOverview!
    assert.deepEqual(overview.iteration, { current: 3 })
    assert.equal(overview.status, 'RECOVERABLE')
  } finally { fixture.controller.close() }
})

test('live zero-based progress counts Executor before durable dispatch is flushed', () => {
  const fixture = setup()
  try {
    fixture.progress('EXECUTING', 'active')
    assert.deepEqual(fixture.controller.getSnapshot().runtimeOverview?.iteration, { current: 1, maximum: 2 })
    fixture.setTime(5_000)
    fixture.progress('EXECUTING', 'failed')
    fixture.progress('EXECUTING', 'active')
    assert.deepEqual(fixture.controller.getSnapshot().runtimeOverview?.iteration, { current: 2, maximum: 2 })
    assert.equal(fixture.controller.getSnapshot().runtimeOverview?.executor.status, 'RUNNING')
  } finally { fixture.controller.close() }
})

test('V2 phase selection without a provider dispatch is not an Executor cycle', () => {
  const fixture = setup()
  try {
    Object.assign(fixture.runtime, { readExecutionLedger: () => [{
      schemaVersion: 6, eventId: 1, sessionId: fixture.runtime.definition.id,
      taskId: 'T1', timestamp: new Date(base).toISOString(), eventType: 'PHASE_STARTED',
      phase: 'EXECUTING', status: 'active', iteration: 0,
    }] })
    fixture.append('CONTROLLER_DECIDED', 'EXECUTE')
    fixture.runtime.state = { ...fixture.runtime.state!, state: 'SUSPENDED', humanRequired: { category: 'NO_AVAILABLE_AGENT', reason: 'No available Executor' } }
    const overview = fixture.controller.getSnapshot().runtimeOverview!
    assert.equal(overview.iteration.current, 0)
    assert.equal(overview.executor.status, 'NOT_STARTED')
  } finally { fixture.controller.close() }
})

test('a resumed Advanced Task adds the new live dispatch to its durable execution history', async () => {
  const fixture = setup()
  try {
    fixture.runtime.state!.taskStatesV2!.T1!.execution = { path: 'CONTROLLER', escalated: true }
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.setTime(30_000)
    fixture.append('AGENT_COMPLETED', 'EXECUTE')
    fixture.setTime(40_000)
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.setTime(70_000)
    fixture.append('AGENT_FAILED', 'EXECUTE')
    await fixture.controller.loadPersistedState()
    fixture.setTime(120_000)
    fixture.progress('EXECUTING', 'active')
    const overview = fixture.controller.getSnapshot().runtimeOverview!
    assert.deepEqual(overview.iteration, { current: 3 })
    assert.equal(overview.executor.status, 'RUNNING')
  } finally { fixture.controller.close() }
})

test('Debug keeps complete ledger and technical event structure without raw provider messages', () => {
  const fixture = setup()
  try {
    const ledger: ExecutionLedgerEvent[] = Array.from({ length: 65 }, (_, index) => ({
      schemaVersion: 6, eventId: index + 1, sessionId: fixture.runtime.definition.id,
      taskId: 'T1', timestamp: new Date(base + index).toISOString(), eventType: 'TASK_STARTED', status: 'RUNNING',
    }))
    Object.assign(fixture.runtime, { readExecutionLedger: () => ledger })
    fixture.append('AGENT_FAILED', 'EXECUTE')
    fixture.runtime.state!.taskEventLogs!.T1![0]!.metadata = { rawOutput: 'token=secret-content' }
    const before = JSON.stringify(fixture.runtime.state)
    const snapshot = fixture.controller.getSnapshot()
    assert.equal(snapshot.executionLedger?.length, 65)
    assert.equal(snapshot.debug?.taskEvents.T1?.[0]?.type, 'AGENT_FAILED')
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-content/u)
    assert.equal(JSON.stringify(fixture.runtime.state), before)
  } finally { fixture.controller.close() }
})

test('suspended Human Required outranks a stale executing phase while retaining the last Executor result', () => {
  const fixture = setup()
  try {
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.progress('EXECUTING', 'active')
    fixture.setTime(20_000)
    fixture.append('AGENT_COMPLETED', 'EXECUTE')
    fixture.append('AGENT_DISPATCHED', 'EXECUTE')
    fixture.setTime(40_000)
    fixture.append('AGENT_COMPLETED', 'EXECUTE')
    fixture.runtime.state = { ...fixture.runtime.state!, state: 'SUSPENDED',
      humanRequired: { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'no progress' } }
    fixture.runtime.activeExecution = false
    const overview = fixture.controller.getSnapshot().runtimeOverview!
    assert.equal(overview.status, 'SUSPENDED')
    assert.equal(overview.currentPhase, 'HUMAN_REQUIRED')
    assert.equal(overview.executor.status, 'COMPLETED')
    assert.equal(overview.executor.provider, 'codex')
    assert.deepEqual(overview.iteration, { current: 2, maximum: 2 })
  } finally { fixture.controller.close() }
})

test('terminal, paused and recoverable overview phases cannot inherit historical execution or verification', () => {
  const definition = makeDefinition({ controlPlane: 'v2' })
  for (const status of ['FAILED', 'COMPLETED', 'CANCELLED', 'SUSPENDED', 'PAUSED', 'RECOVERABLE', 'READY', 'SCHEDULED'] as const) {
    for (const phase of ['EXECUTING', 'VERIFYING']) {
      const state = makeState({ state: status === 'PAUSED' || status === 'RECOVERABLE' ? 'RUNNING' : status, currentTaskId: 'T1' })
      const overview = deriveRuntimeOverview({ definition, state, ledger: [], recentEvents: [], executionActivities: [],
        currentPhase: phase, currentPhaseTaskId: 'T1', hasActiveExecution: false, displayState: status, now: base })
      assert.equal(overview.currentPhase, status, `${status} must outrank historical ${phase}`)
      assert.notEqual(overview.executor.status, 'RUNNING')
    }
  }
})
