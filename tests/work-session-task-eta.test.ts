import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import type { WorkSessionDefinition, WorkSessionDurableState } from '../packages/development-guardian/work-session/model.js'
import type { TaskEventV2 } from '../packages/development-guardian/work-session/task-observability.js'
import type { ExecutionLedgerEvent } from '../packages/development-guardian/work-session/execution-ledger.js'
import { projectTaskRun } from '../packages/development-guardian/work-session/task-run-analytics.js'
import {
  FileTaskEtaCache, TaskEtaService, createRuntimeTaskEtaService, projectTaskEta,
  type TaskEtaCache, type TaskEtaEstimate, type TaskEtaInput,
} from '../packages/development-guardian/work-session/control-ui/task-eta.js'

const origin = Date.parse('2026-09-17T08:00:00.000Z')
const at = (seconds: number): string => new Date(origin + seconds * 1_000).toISOString()
const definition: WorkSessionDefinition = {
  id: 'eta-session', targetRepo: 'D:/repo', branch: 'eta', controlPlane: 'v2', goldenPath: { enabled: true },
  tasks: [{ id: 'T1', goal: 'Improve runtime UI', risk: 'LOW', allowedPaths: ['ui/'], acceptanceEvidenceBindings: [{ criterion: 'UI works', requiredEvidence: ['npm test'] }] }],
  limits: { softMinutes: 30, hardMinutes: 60, maxTasks: 1 }, createdAt: at(0),
}

function event(id: number, seconds: number, type: TaskEventV2['type'], action?: TaskEventV2['action']): TaskEventV2 {
  return { eventId: String(id), sessionId: definition.id, taskId: 'T1', timestamp: at(seconds), type, ...(action === undefined ? {} : { action }) }
}

function input(events = [event(1, 0, 'TASK_CREATED'), event(2, 1, 'VERIFICATION_PLANNED')]): TaskEtaInput {
  const state: WorkSessionDurableState = {
    sessionId: definition.id, state: 'RUNNING', currentTaskIndex: 0, currentTaskId: 'T1', completedTaskIds: [],
    createdAt: new Date(at(0)), startedAt: new Date(at(0)), updatedAt: new Date(at(1)),
    taskStatesV2: { T1: createTaskStateV2(definition, definition.tasks[0]!) }, taskEventLogs: { T1: events },
  }
  return { definition, state, codingExecutions: [{ taskId: 'T1', mode: 'codex', activeExecutor: 'codex', model: 'test-model' }] }
}

function memoryCache(): TaskEtaCache {
  const values = new Map<string, TaskEtaEstimate>()
  return {
    read: (key) => values.get(key),
    claim: (key, value) => { if (values.has(key)) return false; values.set(key, value); return true },
    update: (key, value) => { values.set(key, value) },
  }
}

test('ETA planning fallback is structured, non-empty and stable across polling/restart', () => {
  const initial = projectTaskEta(input())!
  assert.equal(initial.taskId, 'T1')
  assert.equal(initial.confidence, 'low')
  assert.equal(initial.basis, 'planning')
  assert.equal(initial.adjusted, false)
  assert.equal(initial.updatedAt, at(1))
  assert.ok(initial.estimatedDurationMs > 0)
  assert.ok(initial.uncertaintyMs > 0)
  assert.ok(Date.parse(initial.estimatedCompletionAt) > origin)
  const resumed = input()
  resumed.state!.updatedAt = new Date(at(200))
  assert.deepEqual(projectTaskEta(resumed), initial)
  assert.deepEqual(projectTaskEta({ definition }), projectTaskEta({ definition }))
})

test('ETA selects the next task during the inter-task gap and retains the final task only after completion', () => {
  const current = input()
  current.definition = { ...definition, tasks: [...definition.tasks, { id: 'T2', goal: 'Follow-up UI task' }] }
  current.state!.currentTaskId = null
  current.state!.currentTaskIndex = 1
  current.state!.completedTaskIds = ['T1']
  assert.equal(projectTaskEta(current)?.taskId, 'T2')
  current.state!.state = 'COMPLETED'
  assert.equal(projectTaskEta(current)?.taskId, 'T1')
})

test('first Executor completion adjusts once using actual elapsed plus remaining work; VERIFY does not trigger adjustment', () => {
  const events = [event(1, 0, 'TASK_CREATED'), event(2, 1, 'VERIFICATION_PLANNED'), event(3, 2, 'AGENT_DISPATCHED', 'EXECUTE')]
  assert.equal(projectTaskEta(input([...events, event(4, 5, 'AGENT_COMPLETED', 'VERIFY')]))!.adjusted, false)
  const completed = [...events, event(4, 362, 'AGENT_COMPLETED', 'EXECUTE')]
  const adjusted = projectTaskEta(input(completed))!
  assert.equal(adjusted.adjusted, true)
  assert.equal(adjusted.basis, 'executor_completed')
  assert.equal(adjusted.updatedAt, at(362))
  assert.ok(adjusted.estimatedDurationMs > 360_000)
  assert.ok(Date.parse(adjusted.estimatedCompletionAt) > Date.parse(at(362)))
  assert.deepEqual(projectTaskEta(input([...completed, event(5, 364, 'AGENT_DISPATCHED', 'EXECUTE'), event(6, 600, 'AGENT_COMPLETED', 'EXECUTE')])), adjusted)
})

test('legacy ledger supplies planning and execution timestamps without mutable UI progress', () => {
  const ledger: ExecutionLedgerEvent[] = [
    { eventId: 1, schemaVersion: 6, sessionId: definition.id, taskId: 'T1', timestamp: at(0), eventType: 'TASK_STARTED', status: 'RUNNING' },
    { eventId: 2, schemaVersion: 6, sessionId: definition.id, taskId: 'T1', timestamp: at(1), eventType: 'PHASE_COMPLETED', phase: 'PLANNING', status: 'completed', iteration: 0 },
    { eventId: 3, schemaVersion: 6, sessionId: definition.id, taskId: 'T1', timestamp: at(2), eventType: 'PHASE_STARTED', phase: 'EXECUTING', status: 'active', iteration: 0 },
    { eventId: 4, schemaVersion: 6, sessionId: definition.id, taskId: 'T1', timestamp: at(120), eventType: 'PHASE_COMPLETED', phase: 'EXECUTING', status: 'completed', iteration: 0 },
  ]
  const result = projectTaskEta({ ...input([]), ledger })!
  assert.equal(result.adjusted, true)
  assert.equal(result.updatedAt, at(120))
  assert.ok(result.estimatedDurationMs > 120_000)
})

test('history fallback uses only earlier completed runs from the same repository/provider without human waiting', () => {
  const current = input()
  const base = projectTaskRun({ definition, state: current.state!, task: current.state!.taskStatesV2!.T1!, events: [] }).summary
  const sample = (id: string, executeDurationMs: number) => ({
    ...base, sessionId: id, finalStatus: 'COMPLETED' as const, finishedAt: at(-10),
    executeDurationMs, executeCount: 1, humanRequiredCount: 0, implementerProviders: ['codex'],
  })
  const history = [sample('prior-1', 200_000), sample('prior-2', 400_000),
    { ...sample('future', 9_000_000), finishedAt: at(20) },
    { ...sample('human-wait', 9_000_000), humanRequiredCount: 1 },
    { ...sample('different-repo', 9_000_000), projectPath: 'D:/other' },
    { ...sample('different-provider', 9_000_000), implementerProviders: ['deepseek'] },
    { ...sample('failure', 9_000_000), finalStatus: 'FAILED' as const },
  ]
  const estimate = projectTaskEta({ ...current, history })!
  assert.equal(estimate.source, 'history')
  assert.equal(estimate.confidence, 'medium')
  assert.equal(estimate.estimatedCompletionAt, at(336))
  assert.match(estimate.reason, /同仓库、同 Provider/u)
})

test('LLM runs asynchronously only at the two semantic milestones; repeated polls never call it again', async () => {
  const requests: Array<{ user: string; targetRepo: string; timeoutMs: number }> = []
  const service = new TaskEtaService({ cache: memoryCache(), now: () => origin + 4_000,
    runner: async (request) => { requests.push(request); return { text: '{"remainingDurationMs":600000,"confidence":"medium","reason":"task scope"}' } },
  })
  const initial = input()
  assert.equal(service.project(initial)!.source, 'deterministic')
  assert.equal(requests.length, 0)
  for (let count = 0; count < 20; count++) service.project(initial)
  await service.settled()
  assert.equal(requests.length, 1)
  const estimate = service.project(initial)!
  assert.equal(estimate.source, 'llm')
  assert.equal(estimate.confidence, 'medium')
  assert.equal(estimate.estimatedCompletionAt, at(601))
  assert.equal(requests[0]!.timeoutMs, 10_000)
  assert.equal(requests[0]!.targetRepo, definition.targetRepo)
  const completed = input([...initial.state!.taskEventLogs!.T1!, event(3, 2, 'AGENT_DISPATCHED', 'EXECUTE'), event(4, 100, 'AGENT_COMPLETED', 'EXECUTE')])
  assert.equal(service.project(completed)!.adjusted, true)
  await service.settled()
  for (let count = 0; count < 20; count++) service.project(completed)
  assert.equal(requests.length, 2)
  assert.equal(JSON.parse(requests[1]!.user).executorDurationMs, 98_000)
  service.close()
})

test('planning has no extra LLM call until completed; terminal historical sessions do not invoke it', async () => {
  let calls = 0
  const service = new TaskEtaService({ cache: memoryCache(), runner: async () => { calls++; throw new Error('unavailable') } })
  assert.ok(service.project(input([])))
  await service.settled()
  assert.equal(calls, 0)
  const completed = input()
  completed.state!.state = 'COMPLETED'
  completed.state!.currentTaskId = null
  completed.state!.completedTaskIds = ['T1']
  assert.ok(service.project(completed))
  await service.settled()
  assert.equal(calls, 0)
})

test('provider failure, malformed JSON, unavailable runtime and storage failure keep immediate fallback', async () => {
  for (const failure of ['reject', 'bad-json', 'unavailable', 'storage'] as const) {
    let calls = 0
    const cache = failure === 'storage' ? { read: () => { throw new Error('disk') }, claim: () => { throw new Error('disk') }, update: () => { throw new Error('disk') } } : memoryCache()
    const service = new TaskEtaService({ cache, isRuntimeAvailable: () => failure !== 'unavailable',
      runner: async () => { calls++; if (failure === 'reject') throw new Error('provider unavailable'); return { text: 'malformed' } },
    })
    const before = service.project(input())!
    assert.equal(before.source, 'deterministic')
    await service.settled()
    assert.deepEqual(service.project(input()), before)
    assert.equal(calls, failure === 'storage' || failure === 'unavailable' ? 0 : 1)
  }
})

test('hung LLM has a bounded deadline while Task/UI projection remains synchronous', async () => {
  const service = new TaskEtaService({ cache: memoryCache(), timeoutMs: 10, runner: async () => new Promise(() => {}) })
  assert.ok(service.project(input()))
  const keepAlive = setTimeout(() => {}, 100)
  try { await service.settled() } finally { clearTimeout(keepAlive) }
  assert.equal(service.project(input())!.source, 'deterministic')
})

test('strict ETA drain outlives the presentation timeout and waits for the underlying runner', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: (response: { text: string }) => void
  const runner = new Promise<{ text: string }>((resolve) => { release = resolve })
  let calls = 0
  const service = new TaskEtaService({ cache: memoryCache(), timeoutMs: 10,
    runner: () => { calls++; return runner } })
  service.project(input())
  await Promise.resolve()
  assert.equal(calls, 1)
  context.mock.timers.tick(10)
  await service.settled()
  assert.equal(service.project(input())!.source, 'deterministic')
  let drained = false
  const closing = service.drain().then(() => { drained = true })
  const later = input([event(1, 0, 'VERIFICATION_PLANNED'), event(2, 1, 'AGENT_DISPATCHED', 'EXECUTE'), event(3, 2, 'AGENT_COMPLETED', 'EXECUTE')])
  service.project(later)
  await Promise.resolve()
  assert.equal(calls, 1, 'closing must not admit the later ETA milestone')
  assert.equal(drained, false, 'UI timeout must not become successful host cleanup')
  release({ text: '{"remainingDurationMs":300000,"confidence":"low","reason":"late"}' })
  await closing
  assert.equal(drained, true)
})

test('sidecar claims survive restart and prevent duplicate LLM calls for failed and successful attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-eta-'))
  try {
    let calls = 0
    const runner = async () => { calls++; return { text: '{"remainingDurationMs":300000,"confidence":"high","reason":"small scope"}' } }
    const first = createRuntimeTaskEtaService({ directory, runner })
    first.project(input())
    await first.settled()
    const estimated = first.project(input())!
    first.close()
    const second = createRuntimeTaskEtaService({ directory, runner })
    assert.deepEqual(second.project(input()), estimated)
    await second.settled()
    assert.equal(calls, 1)
    const afterExecute = input([event(1, 0, 'VERIFICATION_PLANNED'), event(2, 1, 'AGENT_DISPATCHED', 'EXECUTE'), event(3, 60, 'AGENT_COMPLETED', 'EXECUTE')])
    const failed = new TaskEtaService({ cache: new FileTaskEtaCache(directory), runner: async () => { calls++; throw new Error('provider offline') } })
    const fallback = failed.project(afterExecute)
    await failed.settled()
    failed.close()
    const third = createRuntimeTaskEtaService({ directory, runner })
    assert.deepEqual(third.project(afterExecute), fallback)
    await third.settled()
    assert.equal(calls, 2)
    second.close(); third.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('late initial answer cannot overwrite adjusted milestone or change completed session estimate', async () => {
  let resolveFirst: (response: { text: string }) => void = () => {}
  const service = new TaskEtaService({ cache: memoryCache(), runner: async () => new Promise((resolve) => { resolveFirst = resolve }) })
  const snapshot = input()
  const first = service.project(snapshot)
  await Promise.resolve()
  snapshot.state!.state = 'COMPLETED'
  service.project(snapshot)
  resolveFirst({ text: '{"remainingDurationMs":900000,"confidence":"high","reason":"late"}' })
  await service.settled()
  assert.deepEqual(service.project(snapshot), first)
})

test('simultaneous controllers share one durable claim while different sessions retain independent ETA identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-eta-identity-'))
  try {
    let calls = 0
    const runner = async () => { calls++; throw new Error('offline') }
    const first = createRuntimeTaskEtaService({ directory, runner })
    const duplicate = createRuntimeTaskEtaService({ directory, runner })
    first.project(input())
    duplicate.project(input())
    await Promise.all([first.settled(), duplicate.settled()])
    assert.equal(calls, 1)
    const other = input()
    other.definition = { ...definition, id: 'another-session' }
    other.state!.sessionId = 'another-session'
    other.state!.taskEventLogs = { T1: other.state!.taskEventLogs!.T1!.map((item) => ({ ...item, sessionId: 'another-session' })) }
    duplicate.project(other)
    await duplicate.settled()
    assert.equal(calls, 2)
    first.close(); duplicate.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a second controller adopts the claim owner model result without issuing another request', async () => {
  const cache = memoryCache()
  let now = origin
  let calls = 0
  const runner = async () => { calls++; return { text: '{"remainingDurationMs":480000,"confidence":"medium","reason":"task scope"}' } }
  const owner = new TaskEtaService({ cache, runner, now: () => now })
  const follower = new TaskEtaService({ cache, runner, now: () => now })
  owner.project(input())
  assert.equal(follower.project(input())!.source, 'deterministic')
  await owner.settled()
  now += 1_001
  assert.equal(follower.project(input())!.source, 'llm')
  assert.deepEqual(follower.project(input()), owner.project(input()))
  assert.equal(calls, 1)
  owner.close(); follower.close()
})
