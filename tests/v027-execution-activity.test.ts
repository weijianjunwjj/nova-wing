import assert from 'node:assert/strict'
import test from 'node:test'

import type { GuardianProgressObserver } from '../packages/development-guardian/progress.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

test('V2 activity feed projects phases, provider, elapsed time and an ephemeral heartbeat without mutating Task state', () => {
  const definition = makeDefinition({ controlPlane: 'v2' })
  const runtime = new FakeRuntime(definition)
  const canonicalTask = { version: 2 as const, identity: { taskId: 'T1', sessionId: definition.id }, marker: 'unchanged' }
  runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1', taskStatesV2: { T1: canonicalTask as never }, activeElapsedMs: 0, activeSegmentStartedAt: 1_000 })
  runtime.activeExecution = true
  let now = 1_000
  let sink: GuardianProgressObserver | undefined
  const controller = new WorkSessionControlController({
    createRuntime: (eventSink) => { sink = eventSink; return runtime },
    clock: { now: () => now }, pollIntervalMs: 60_000,
  })
  try {
    sink!({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'PROVIDER_DISPATCHED', provider: 'codex' } })
    now += 30_000
    sink!({ phase: 'VERIFYING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'VERIFIER_STARTED', provider: 'codex', verifier: 'targeted tests' } })
    const active = controller.getSnapshot().executionActivity!
    assert.equal(active.running, true)
    assert.equal(active.currentPhase, 'VERIFYING')
    assert.equal(active.provider, 'codex')
    assert.equal(active.items.length, 2)
    assert.equal(active.lastActivityAt, new Date(now).toISOString())

    const durableBefore = JSON.stringify(runtime.state)
    const eventsBefore = controller.getRecentEvents().length
    now += 180_000
    const heartbeat = controller.getSnapshot().executionActivity!
    assert.equal(heartbeat.elapsedMs, 210_000)
    assert.equal(heartbeat.idleMs, 180_000)
    assert.equal(heartbeat.idleStatus, 'QUIET')
    assert.equal(heartbeat.lastActivityAt, active.lastActivityAt, 'heartbeat must not fabricate durable activity')
    assert.equal(controller.getRecentEvents().length, eventsBefore, 'heartbeat must not append events')
    assert.equal(JSON.stringify(runtime.state), durableBefore, 'heartbeat must not change TaskState or analytics inputs')
  } finally {
    controller.close()
  }
})

test('activity feed exposes allowlisted runtime facts and drops raw detail, secrets and hidden reasoning', () => {
  const definition = makeDefinition({ controlPlane: 'v2' })
  const runtime = new FakeRuntime(definition)
  runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1' })
  runtime.activeExecution = true
  let sink: GuardianProgressObserver | undefined
  const controller = new WorkSessionControlController({ createRuntime: (eventSink) => { sink = eventSink; return runtime }, pollIntervalMs: 60_000 })
  try {
    sink!({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0,
      detail: 'hidden reasoning password=hunter2 token=secret-value',
      activity: { kind: 'PROVIDER_DISPATCHED', provider: 'codex; token=secret-value', verifier: 'npm test && echo password' } })
    const serialized = JSON.stringify(controller.getSnapshot().executionActivity)
    assert.doesNotMatch(serialized, /hunter2|secret-value|hidden reasoning|password/iu)
    assert.doesNotMatch(serialized, /codex;|npm test &&/u)
    assert.match(serialized, /PROVIDER_DISPATCHED/u)
  } finally {
    controller.close()
  }
})
