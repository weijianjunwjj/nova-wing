import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveUserActivities } from '../packages/development-guardian/work-session/control-ui/activity-projection.js'
import type { ControlEvent } from '../packages/development-guardian/work-session/control-ui/events.js'
import type { ExecutionLedgerEvent, ExecutionLedgerEventInput } from '../packages/development-guardian/work-session/execution-ledger.js'
import type { TaskEventV2 } from '../packages/development-guardian/work-session/task-observability.js'
import type { NotificationChannelResult } from '../packages/development-guardian/work-session/notifier.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { makeDefinition, makeState } from './work-session-w005-a-helpers.js'

const definition = makeDefinition({ controlPlane: 'v2' })
const time = (seconds: number): string => new Date(Date.UTC(2026, 8, 17, 8, 0, 0) + seconds * 1000).toISOString()
type WithoutSession<T> = T extends { sessionId: string } ? Omit<T, 'sessionId'> : never
type LedgerInput = WithoutSession<ExecutionLedgerEventInput>
function ledger(eventId: number, data: LedgerInput): ExecutionLedgerEvent {
  return { schemaVersion: 6, sessionId: definition.id, eventId, ...data } as ExecutionLedgerEvent
}
function phase(eventId: number, phaseName: 'EXECUTING' | 'VERIFYING' | 'FINALIZING' | 'COMPLETED', status: 'active' | 'completed' | 'failed', seconds: number): ExecutionLedgerEvent {
  return ledger(eventId, { eventType: status === 'active' ? 'PHASE_STARTED' : status === 'failed' ? 'PHASE_FAILED' : 'PHASE_COMPLETED',
    timestamp: time(seconds), taskId: 'T1', phase: phaseName, status, iteration: 0, cumulativeElapsedMs: 0 } as LedgerInput)
}
function taskEvent(eventId: string, type: TaskEventV2['type'], seconds: number, action?: TaskEventV2['action']): TaskEventV2 {
  return { eventId, type, timestamp: time(seconds), sessionId: definition.id, taskId: 'T1', ...(action === undefined ? {} : { action }) }
}
function control(id: number, phaseName: string, status: string, seconds: number): ControlEvent {
  return { id, timestamp: time(seconds), type: 'TASK_PHASE', data: { taskId: 'T1', phase: phaseName, status, iteration: 0, elapsedMs: 0 } }
}

test('activity projection updates a phase in place and measures its actual start/end duration', () => {
  const start = phase(1, 'EXECUTING', 'active', 14)
  const running = deriveUserActivities({ definition, ledger: [start], recentEvents: [], executionActivities: [] })
  assert.equal(running.length, 1)
  assert.equal(running[0]?.status, 'running')
  const complete = deriveUserActivities({ definition, ledger: [start, phase(2, 'EXECUTING', 'completed', 388)], recentEvents: [], executionActivities: [] })
  assert.equal(complete.length, 1)
  assert.equal(complete[0]?.id, running[0]?.id)
  assert.equal(complete[0]?.durationMs, 374_000, 'a zero cumulative elapsed value must not erase wall-clock execution time')
  assert.equal(complete[0]?.timestamp, time(388))
  assert.equal(complete[0]?.label, 'Executor 完成')
})

test('internal finalization and Session completion collapse into the single Task completion', () => {
  const entries = [phase(1, 'VERIFYING', 'active', 388), phase(2, 'VERIFYING', 'completed', 390),
    phase(3, 'FINALIZING', 'active', 390), phase(4, 'COMPLETED', 'completed', 390),
    ledger(5, { eventType: 'TASK_COMPLETED', taskId: 'T1', timestamp: time(391), status: 'COMPLETED' }),
    ledger(6, { eventType: 'SESSION_COMPLETED', taskId: null, timestamp: time(391), status: 'COMPLETED', completionReason: 'ALL_TASKS_COMPLETED' } as LedgerInput)]
  const recentEvents: ControlEvent[] = [
    control(1, 'FINALIZING', 'active', 390), control(2, 'COMPLETED', 'completed', 390),
    { id: 3, type: 'SESSION_STATE_CHANGED', timestamp: time(391), data: { from: 'RUNNING', to: 'COMPLETED' } },
    { id: 4, type: 'SESSION_COMPLETED', timestamp: time(391), data: {} },
    { id: 5, type: 'TASK_COMPLETED', timestamp: time(391), data: { taskId: 'T1' } },
  ]
  const result = deriveUserActivities({ definition, ledger: entries, recentEvents, executionActivities: [] })
  assert.deepEqual(result.map((item) => item.kind), ['VERIFY', 'TASK_COMPLETED'])
  assert.equal(result[0]?.durationMs, 2_000)
  assert.equal(result[1]?.label, 'Task T1 已完成')
  assert.equal(entries.length, 6)
  assert.equal(recentEvents.length, 5)
})

test('real activities in the same second keep independent task/checkpoint identities', () => {
  const result = deriveUserActivities({ definition, ledger: [
    phase(1, 'VERIFYING', 'active', 1), phase(2, 'VERIFYING', 'completed', 1.1),
    ledger(3, { eventType: 'GIT_COMMIT_COMPLETED', timestamp: time(1.2), taskId: 'T1', status: 'COMPLETED', commitSha: 'abcdef0' } as LedgerInput),
    ledger(4, { eventType: 'GIT_COMMIT_COMPLETED', timestamp: time(1.3), taskId: 'T1', status: 'COMPLETED', commitSha: '123abcd' } as LedgerInput),
    ledger(5, { eventType: 'TASK_COMPLETED', timestamp: time(1.4), taskId: 'T1', status: 'COMPLETED' }),
    { ...phase(6, 'EXECUTING', 'active', 1.5), taskId: 'T2' },
  ], recentEvents: [], executionActivities: [] })
  assert.deepEqual(result.map((item) => item.kind), ['VERIFY', 'CHECKPOINT', 'CHECKPOINT', 'TASK_COMPLETED', 'EXECUTE'])
  assert.equal(new Set(result.map((item) => item.id)).size, 5)
})

test('poll/SSE and restart keep the same phase identity when durable Task events replace live activity', () => {
  const recentEvents = [control(1, 'EXECUTING', 'active', 1), control(2, 'EXECUTING', 'completed', 12)]
  const executionActivities = [
    { id: 1, timestamp: time(1), kind: 'PROVIDER_DISPATCHED' as const, phase: 'EXECUTING', provider: 'codex', taskId: 'T1' },
    { id: 2, timestamp: time(12), kind: 'PROVIDER_COMPLETED' as const, phase: 'EXECUTING', provider: 'codex', outcome: 'COMPLETED' as const, taskId: 'T1' },
  ]
  const live = deriveUserActivities({ definition, ledger: [], recentEvents, executionActivities })
  const taskEvents = [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), { ...taskEvent('2', 'AGENT_COMPLETED', 12, 'EXECUTE'), provider: 'codex' }]
  const state = makeState({ taskEventLogs: { T1: taskEvents } })
  const saved = deriveUserActivities({ definition, state, ledger: [], recentEvents, executionActivities })
  const reopened = deriveUserActivities({ definition, state, ledger: [], recentEvents: [], executionActivities: [] })
  assert.equal(live.length, 1)
  assert.equal(saved.length, 1)
  assert.equal(reopened.length, 1)
  assert.equal(live[0]?.id, saved[0]?.id)
  assert.deepEqual(saved, reopened)
  assert.equal(reopened[0]?.durationMs, 11_000)
  assert.equal(reopened[0]?.provider, 'codex')
})

test('Golden retries survive iteration=0 ledger dedupe and preserve independent same-second dispatches', () => {
  const events = [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), taskEvent('2', 'AGENT_DISPATCHED', 1.4, 'EXECUTE'), taskEvent('3', 'AGENT_COMPLETED', 2, 'EXECUTE')]
  const state = makeState({ taskEventLogs: { T1: events } })
  const result = deriveUserActivities({ definition, state,
    ledger: [phase(1, 'EXECUTING', 'active', 1), phase(2, 'EXECUTING', 'failed', 1.4), phase(3, 'EXECUTING', 'completed', 2)],
    recentEvents: [control(1, 'EXECUTING', 'active', 1), control(2, 'EXECUTING', 'failed', 1.4), control(3, 'EXECUTING', 'active', 1.4), control(4, 'EXECUTING', 'completed', 2)],
    executionActivities: [],
  })
  assert.equal(result.filter((item) => item.kind === 'EXECUTE').length, 2)
  assert.deepEqual(result.map((item) => item.status), ['failed', 'completed'])
  assert.deepEqual(result.map((item) => item.durationMs), [400, 600])
  assert.ok(result[0]?.id.endsWith(':1'))
  assert.ok(result[1]?.id.endsWith(':2'))
})

test('a live retry gets the same identity once its delayed Task history is durable', () => {
  const first = [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), taskEvent('2', 'AGENT_FAILED', 5, 'EXECUTE')]
  const recentEvents = [control(1, 'EXECUTING', 'active', 1), control(2, 'EXECUTING', 'failed', 5), control(3, 'EXECUTING', 'active', 6)]
  const executionActivities = [{ id: 4, taskId: 'T1', timestamp: time(6), phase: 'EXECUTING', kind: 'PROVIDER_DISPATCHED' as const }]
  const live = deriveUserActivities({ definition, state: makeState({ taskEventLogs: { T1: first } }), ledger: [], recentEvents, executionActivities })
  const saved = deriveUserActivities({ definition, state: makeState({ taskEventLogs: { T1: [...first, taskEvent('3', 'AGENT_DISPATCHED', 6, 'EXECUTE')] } }), ledger: [], recentEvents, executionActivities })
  assert.deepEqual(live, saved)
  assert.equal(live.length, 2)
  assert.equal(live[1]?.status, 'running')
})

test('verifier outcomes share one verification row while provider/model/checkpoint facts remain useful', () => {
  const result = deriveUserActivities({ definition, ledger: [
    phase(1, 'EXECUTING', 'active', 1), phase(2, 'EXECUTING', 'completed', 5),
    phase(3, 'VERIFYING', 'active', 5),
    ledger(4, { eventType: 'PHASE_STARTED', timestamp: time(5), taskId: 'T1', phase: 'VERIFYING', status: 'active', iteration: 0, verificationCommand: 'typecheck', verificationStatus: 'running', verificationIndex: 0 } as LedgerInput),
    ledger(5, { eventType: 'PHASE_COMPLETED', timestamp: time(5.2), taskId: 'T1', phase: 'VERIFYING', status: 'completed', iteration: 0, verificationCommand: 'typecheck', verificationStatus: 'passed', verificationIndex: 0, durationMs: 200 } as LedgerInput),
    ledger(6, { eventType: 'PHASE_COMPLETED', timestamp: time(5.4), taskId: 'T1', phase: 'VERIFYING', status: 'completed', iteration: 0, verificationCommand: 'targeted tests', verificationStatus: 'passed', verificationIndex: 1, durationMs: 200 } as LedgerInput),
    phase(7, 'VERIFYING', 'completed', 6),
  ], recentEvents: [], executionActivities: [], codingExecutions: [{ taskId: 'T1', mode: 'codex', activeExecutor: 'codex', model: 'gpt-5.4' }] })
  assert.equal(result.length, 2)
  assert.equal(result[0]?.provider, 'codex')
  assert.equal(result[0]?.model, 'gpt-5.4')
  assert.deepEqual(result[1]?.verifiers, [{ name: 'typecheck', outcome: 'PASSED', durationMs: 200 }, { name: 'targeted tests', outcome: 'PASSED', durationMs: 200 }])
  assert.equal(result[1]?.durationMs, 1_000)
})

test('presentation never mutates evidence or exposes Task metadata and raw provider detail', () => {
  const state = makeState({ taskEventLogs: { T1: [
    { ...taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), provider: 'codex; token=secret', metadata: { rawError: 'password=hunter2' } },
    taskEvent('2', 'AGENT_COMPLETED', 5, 'EXECUTE'),
  ] } })
  const evidence = [phase(1, 'EXECUTING', 'active', 1), phase(2, 'EXECUTING', 'completed', 5)]
  const before = JSON.stringify({ state, evidence })
  const result = deriveUserActivities({ definition, state, ledger: evidence, recentEvents: [], executionActivities: [] })
  assert.equal(JSON.stringify({ state, evidence }), before)
  assert.doesNotMatch(JSON.stringify(result), /secret|hunter2|rawError/u)
  assert.equal(result.filter((item) => item.kind === 'EXECUTE').length, 1)
})

test('durable verification names and outcomes remain available after runtime restart', () => {
  const state = makeState({ taskEventLogs: { T1: [
    { ...taskEvent('1', 'VERIFICATION_STARTED', 1, 'VERIFY'), evidenceRefs: ['typecheck', 'targeted tests'] },
    { ...taskEvent('2', 'VERIFICATION_PASSED', 3, 'VERIFY'), evidenceRefs: ['typecheck', 'targeted tests'] },
  ] } })
  const result = deriveUserActivities({ definition, state, ledger: [], recentEvents: [], executionActivities: [] })
  assert.equal(result.length, 1)
  assert.deepEqual(result[0]?.verifiers, [{ name: 'typecheck', outcome: 'PASSED' }, { name: 'targeted tests', outcome: 'PASSED' }])
  assert.equal(result[0]?.durationMs, 2_000)
})

test('notification projection preserves per-channel truth and collapses duplicate durable/live delivery', () => {
  const channels: NotificationChannelResult[] = [{ channel: 'EMAIL', status: 'SENT' }, { channel: 'DESKTOP', status: 'FAILED', reason: 'password=secret' }]
  const result = deriveUserActivities({ definition, ledger: [ledger(1, {
    eventType: 'NOTIFICATION_FAILED', taskId: 'T1', timestamp: time(1), status: 'FAILED', notificationId: 'n1', notificationKind: 'COMPLETED',
    notificationOverall: 'PARTIAL_SUCCESS', notificationChannels: channels,
  } as LedgerInput)], recentEvents: [{ id: 1, type: 'NOTIFICATION_FAILED', timestamp: time(1), data: {
    taskId: 'T1', notificationId: 'n1', kind: 'COMPLETED', overallStatus: 'PARTIAL_SUCCESS', channels,
  } }], executionActivities: [] })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.status, 'completed')
  assert.equal(result[0]?.label, '完成通知 · 邮件：已发送 · 桌面通知：发送失败 · 总体：部分成功')
  assert.doesNotMatch(JSON.stringify(result), /password|secret/u)
})

test('independent pause/resume requests remain visible even when both occur in the same second', () => {
  const recentEvents: ControlEvent[] = [
    { id: 1, type: 'SESSION_RESUMED', timestamp: time(1), data: {} },
    { id: 2, type: 'SESSION_PAUSED', timestamp: time(1.1), data: {} },
    { id: 3, type: 'SESSION_RESUMED', timestamp: time(1.2), data: {} },
  ]
  const result = deriveUserActivities({ definition, ledger: [], recentEvents, executionActivities: [] })
  assert.deepEqual(result.map((item) => item.kind), ['SESSION_RESUMED', 'SESSION_PAUSED', 'SESSION_RESUMED'])
  assert.equal(new Set(result.map((item) => item.id)).size, 3)
})

test('a failed verification run preserves successful individual verifiers rather than marking all failed', () => {
  const task = createTaskStateV2(definition, definition.tasks[0]!)
  task.verificationState.results = [{ name: 'typecheck', status: 'passed', durationMs: 500 }, { name: 'targeted tests', status: 'failed', durationMs: 1500 }]
  const state = makeState({ taskStatesV2: { T1: task }, taskEventLogs: { T1: [
    { ...taskEvent('1', 'VERIFICATION_STARTED', 1, 'VERIFY'), evidenceRefs: ['typecheck', 'targeted tests'] },
    { ...taskEvent('2', 'VERIFICATION_FAILED', 3, 'VERIFY'), evidenceRefs: ['typecheck', 'targeted tests'] },
  ] } })
  const result = deriveUserActivities({ definition, state, ledger: [], recentEvents: [], executionActivities: [] })
  assert.equal(result[0]?.status, 'failed')
  assert.deepEqual(result[0]?.verifiers, [{ name: 'typecheck', outcome: 'PASSED', durationMs: 500 }, { name: 'targeted tests', outcome: 'FAILED', durationMs: 1500 }])
})

test('completed Session closes a missing phase end at a durable boundary and never leaves it running', () => {
  const state = makeState({ state: 'COMPLETED', completedAt: new Date(time(12)), completedTaskIds: ['T1'],
    taskEventLogs: { T1: [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE')] } })
  const input = { definition, state, ledger: [], recentEvents: [], executionActivities: [] }
  const result = deriveUserActivities(input)
  const execution = result.find((item) => item.kind === 'EXECUTE')!
  assert.equal(execution.status, 'completed')
  assert.equal(execution.durationMs, 11_000)
  assert.deepEqual(deriveUserActivities(input), result)
  assert.ok(result.every((item) => item.status !== 'running'))
})

test('suspended progress retains human-required semantics instead of becoming completed', () => {
  const recentEvents = [control(1, 'EXECUTING', 'active', 1), control(2, 'EXECUTING', 'suspended', 5)]
  const result = deriveUserActivities({ definition, ledger: [], recentEvents, executionActivities: [] })
  assert.equal(result.length, 1)
  assert.equal(result[0]?.status, 'human_required')
  assert.match(result[0]?.label ?? '', /人工处理/u)
  assert.equal(result[0]?.durationMs, 4_000)
})

test('a truncated live ring matches the durable completion endpoint without changing retry identities', () => {
  const events = [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), taskEvent('2', 'AGENT_FAILED', 5, 'EXECUTE'),
    taskEvent('3', 'AGENT_DISPATCHED', 5, 'EXECUTE'), taskEvent('4', 'AGENT_COMPLETED', 20, 'EXECUTE')]
  const input = { definition, state: makeState({ taskEventLogs: { T1: events } }), ledger: [], executionActivities: [] }
  const durable = deriveUserActivities({ ...input, recentEvents: [] })
  const truncated = deriveUserActivities({ ...input, recentEvents: [control(2, 'EXECUTING', 'failed', 5), control(3, 'EXECUTING', 'active', 5), control(4, 'EXECUTING', 'completed', 20)] })
  assert.deepEqual(truncated, durable)
  assert.deepEqual(truncated.map((item) => item.durationMs), [4_000, 15_000])
})

test('evicting the first pause/resume cycle never renumbers surviving process-local activities', () => {
  const recentEvents: ControlEvent[] = [
    { id: 11, type: 'PAUSE_REQUESTED', timestamp: time(1), data: {} },
    { id: 12, type: 'SESSION_PAUSED', timestamp: time(2), data: {} },
    { id: 13, type: 'SESSION_RESUMED', timestamp: time(3), data: {} },
    { id: 31, type: 'PAUSE_REQUESTED', timestamp: time(11), data: {} },
    { id: 32, type: 'SESSION_PAUSED', timestamp: time(12), data: {} },
    { id: 33, type: 'SESSION_RESUMED', timestamp: time(13), data: {} },
  ]
  const input = { definition, ledger: [], executionActivities: [] }
  const before = deriveUserActivities({ ...input, recentEvents })
  const after = deriveUserActivities({ ...input, recentEvents: recentEvents.slice(3) })
  assert.deepEqual(after, before.slice(3))
  assert.ok(after[0]?.id.endsWith(':control:31'))
})

test('an evicted human-required event cannot alias a newer control event to an older durable generation', () => {
  const input = { definition, ledger: [ledger(11, { eventType: 'HUMAN_REQUIRED', taskId: 'T1', timestamp: time(1), status: 'SUSPENDED', safeMessage: 'environment is unavailable' })],
    state: makeState({ currentTaskId: 'T1', taskEventLogs: { T1: [{ ...taskEvent('21', 'HUMAN_REQUIRED', 1), metadata: { category: 'ENVIRONMENT_REQUIRED' } }, taskEvent('22', 'TASK_RESUMED', 1.3)] } }), executionActivities: [] }
  const first: ControlEvent = { id: 31, type: 'HUMAN_REQUIRED', timestamp: time(1.1), data: { taskId: 'T1', category: 'ENVIRONMENT_REQUIRED', reason: 'environment is unavailable' } }
  const resumed: ControlEvent = { id: 41, type: 'SESSION_RESUMED', timestamp: time(1.3), data: {} }
  const second: ControlEvent = { id: 51, type: 'HUMAN_REQUIRED', timestamp: time(1.5), data: { taskId: 'T1', category: 'ENVIRONMENT_REQUIRED', reason: 'environment is unavailable' } }
  const before = deriveUserActivities({ ...input, recentEvents: [first, resumed, second] })
  const after = deriveUserActivities({ ...input, recentEvents: [resumed, second] })
  assert.deepEqual(after, before)
  const human = after.filter((item) => item.kind === 'HUMAN_REQUIRED')
  assert.equal(human.length, 2, 'a resumed Task entering a new human-required interval is a real independent activity')
  assert.ok(human[0]?.id.endsWith(':task:21'))
  assert.ok(human[1]?.id.endsWith(':control:51'))
  const fullyEvicted = deriveUserActivities({ ...input, recentEvents: [second] })
  assert.deepEqual(fullyEvicted.filter((item) => item.kind === 'HUMAN_REQUIRED'), human, 'durable resume boundary survives loss of its control event')
})

test('checkpoint recovery matches durable actions by interval and keeps identity after ring eviction', () => {
  const entries = [ledger(11, { eventType: 'CHECKPOINT_RECOVERY_COMPLETED', taskId: 'T1', timestamp: time(1), status: 'COMPLETED', recoveryKind: 'GIT_PUSH', recoveryAction: 'RETRY_PUSH' }),
    ledger(21, { eventType: 'CHECKPOINT_RECOVERY_COMPLETED', taskId: 'T1', timestamp: time(11), status: 'COMPLETED', recoveryKind: 'GIT_PUSH', recoveryAction: 'RETRY_PUSH' })]
  const recentEvents: ControlEvent[] = [{ id: 31, type: 'CHECKPOINT_RECOVERY_COMPLETED', timestamp: time(1.1), data: { taskId: 'T1' } },
    { id: 51, type: 'CHECKPOINT_RECOVERY_COMPLETED', timestamp: time(11.1), data: { taskId: 'T1' } }]
  const input = { definition, ledger: entries, executionActivities: [] }
  const before = deriveUserActivities({ ...input, recentEvents })
  const after = deriveUserActivities({ ...input, recentEvents: recentEvents.slice(1) })
  assert.deepEqual(after, before)
  assert.equal(after.length, 2)
})

test('a Controller entering EXECUTING without selecting an agent does not claim an Executor dispatch', () => {
  const state = makeState({ state: 'SUSPENDED', currentTaskId: 'T1', updatedAt: new Date(time(3)) })
  const result = deriveUserActivities({ definition, state, ledger: [], recentEvents: [control(1, 'EXECUTING', 'active', 1)], executionActivities: [] })
  const execution = result.find((item) => item.kind === 'EXECUTE')!
  assert.equal(execution.executorDispatched, undefined)
  assert.equal(execution.status, 'human_required')
  assert.equal(execution.label, '等待 Executor · 需要人工处理')
})

test('a new live dispatch after two durable cycles marks the third execution before its history is persisted', () => {
  const events = [taskEvent('1', 'AGENT_DISPATCHED', 1, 'EXECUTE'), taskEvent('2', 'AGENT_FAILED', 5, 'EXECUTE'),
    taskEvent('3', 'AGENT_DISPATCHED', 6, 'EXECUTE'), taskEvent('4', 'AGENT_FAILED', 10, 'EXECUTE')]
  const state = makeState({ state: 'RUNNING', currentTaskId: 'T1', taskEventLogs: { T1: events } })
  const recentEvents = [control(11, 'EXECUTING', 'active', 20)]
  const executionActivities = [{ id: 12, taskId: 'T1', timestamp: time(20), phase: 'EXECUTING', kind: 'PROVIDER_DISPATCHED' as const, provider: 'codex' }]
  const result = deriveUserActivities({ definition, state, ledger: [], recentEvents, executionActivities })
  const executions = result.filter((item) => item.kind === 'EXECUTE' && item.executorDispatched === true)
  assert.equal(executions.length, 3)
  assert.equal(executions[2]?.status, 'running')
  assert.ok(executions[2]?.id.endsWith(':3'))
  const saved = deriveUserActivities({ definition, state: makeState({ ...state, taskEventLogs: { T1: [...events, { ...taskEvent('5', 'AGENT_DISPATCHED', 20, 'EXECUTE'), provider: 'codex' }] } }), ledger: [], recentEvents, executionActivities })
  assert.deepEqual(saved, result)
})
