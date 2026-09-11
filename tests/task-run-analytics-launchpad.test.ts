import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import {
  TaskRunAnalyticsProjector,
  TaskRunAnalyticsStore,
  createNovaWingLaunchpad,
  createWindowsTaskRunNotifier,
  type WorkSessionCompletedNotification,
  type WorkSessionDefinition,
  type WorkSessionDurableState,
} from '../packages/development-guardian/index.js'

test('Launchpad exposes stable task/session/recent/reasons Analytics APIs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-analytics-api-'))
  const analyticsPath = join(directory, 'analytics.db')
  const definition: WorkSessionDefinition = { id: 'S-api', targetRepo: 'D:\\repo', branch: 'main', controlPlane: 'v2', tasks: [{ id: 'T-api', goal: 'api' }], limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } }
  const task = { ...createTaskStateV2(definition, definition.tasks[0]!), status: 'COMPLETED' as const, currentAction: 'COMPLETE' }
  const state: WorkSessionDurableState = { sessionId: 'S-api', state: 'COMPLETED', currentTaskIndex: 1, currentTaskId: null, completedTaskIds: ['T-api'], taskStatesV2: { 'T-api': task }, createdAt: new Date(0), updatedAt: new Date(1000), completedAt: new Date(1000), completionReason: 'ALL_TASKS_COMPLETED' }
  const store = new TaskRunAnalyticsStore(analyticsPath)
  new TaskRunAnalyticsProjector(store).project({ definition, state, task, events: [{ eventId: '1', sessionId: 'S-api', taskId: 'T-api', type: 'TASK_CREATED', timestamp: new Date(0).toISOString(), reasonCode: 'PROVIDER_UNAVAILABLE' }, { eventId: '2', sessionId: 'S-api', taskId: 'T-api', type: 'TASK_COMPLETED', timestamp: new Date(1000).toISOString() }] })
  store.close()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: { analyticsPath, readCodexAvailability: () => ({ state: 'available' }) } })
  try {
    const address = await launchpad.start()
    const recent = await fetch(`${address.url}/api/analytics/recent?limit=5`).then((response) => response.json()) as { aggregate: { taskCount: number } }
    const session = await fetch(`${address.url}/api/analytics/sessions/S-api`).then((response) => response.json()) as unknown[]
    const taskRows = await fetch(`${address.url}/api/analytics/tasks/T-api`).then((response) => response.json()) as unknown[]
    const reasons = await fetch(`${address.url}/api/analytics/reasons?limit=20`).then((response) => response.json()) as Array<{ reasonCode: string; count: number }>
    assert.equal(recent.aggregate.taskCount, 1); assert.equal(session.length, 1); assert.equal(taskRows.length, 1)
    assert.deepEqual(reasons, [{ reasonCode: 'PROVIDER_UNAVAILABLE', count: 1 }])
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Windows completion toast uses compact Chinese Analytics summary', async () => {
  const calls: Array<{ title: string; body: string }> = []
  const notifier = createWindowsTaskRunNotifier({ platform: 'win32', spawnToast: async (title, body) => { calls.push({ title, body }) } })
  const notification: WorkSessionCompletedNotification = { notificationId: 'S:completed', session: { id: 'S', targetRepo: 'D:\\repo', branch: 'main' }, completedTaskIds: ['T1'], completionReason: 'ALL_TASKS_COMPLETED', analytics: {
    sessionId:'S',taskId:'T1',projectPath:'D:\\repo',branch:'main',startedAt:null,finishedAt:null,finalStatus:'COMPLETED',completionReason:'TASK_COMPLETED',totalDurationMs:60_000,
    executeCount:1,executeDurationMs:10_000,verifyCount:1,verifyDurationMs:2_000,verificationFailureCount:0,reviewCount:1,reviewDurationMs:3_000,reviewFailureCount:0,
    aiRepairCount:0,aiRepairDurationMs:0,runtimeRepairCount:0,runtimeRepairDurationMs:0,humanRequiredCount:0,humanInterventionCount:0,humanActionCount:0,humanDecisionCount:0,repairTriggeredByUser:0,humanWaitDurationMs:0,
    providerSwitchCount:0,implementerProviders:['Codex'],reviewerProviders:['DeepSeek'],restartCount:0,reconciliationCount:0,commitResult:'COMMITTED',commitHash:'abcdef',changedFileCount:1,evidenceCount:1,firstPassSuccess:true,zeroHumanCompletion:true,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString() } }
  await notifier.notifyCompleted?.(notification)
  assert.equal(calls[0]?.title, 'NovaWing · T1 已完成'); assert.match(calls[0]?.body ?? '', /0 次人工决策/u); assert.match(calls[0]?.body ?? '', /Codex 执行 ×1 · DeepSeek 审查 ×1/u)
})
