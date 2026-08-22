import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  WorkSessionRuntime,
  type WorkSessionCompletedNotification,
  type WorkSessionDefinition,
  type WorkSessionNotifier,
} from 'nova-wing/development-guardian'

function definition(id: string): WorkSessionDefinition {
  return {
    id, targetRepo: process.cwd(), branch: 'feat/work-session-mvp',
    tasks: [{ id: 'T1', goal: 'complete one task' }],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
  }
}

class CompletedNotifier implements WorkSessionNotifier {
  attempts = 0
  failuresRemaining = 0
  readonly notifications: WorkSessionCompletedNotification[] = []
  onAttempt?: () => void | Promise<void>
  async notifyHumanRequired(): Promise<void> {}
  async notifyCompleted(notification: WorkSessionCompletedNotification): Promise<void> {
    this.attempts++
    this.notifications.push(notification)
    await this.onAttempt?.()
    if (this.failuresRemaining-- > 0) throw new Error('SMTP password=SECRET')
  }
}

async function withStorage(run: (storageUrl: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'w006-completed-'))
  try {
    await run(pathToFileURL(join(temp, 'session.db')).href)
  } finally {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(temp, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
  }
}

await test('completion email follows durable ALL_TASKS_COMPLETED and is restart-deduped', async () => {
  await withStorage(async (storageUrl) => {
    const notifier = new CompletedNotifier()
    let runtime: WorkSessionRuntime
    notifier.onAttempt = () => {
      const state = runtime.getDurableState()
      assert.equal(state?.state, 'COMPLETED')
      assert.equal(state?.completionReason, 'ALL_TASKS_COMPLETED')
      assert.deepEqual(state?.completedTaskIds, ['T1'])
      assert.equal(state?.completionNotificationAttempted, true)
    }
    runtime = new WorkSessionRuntime({
      definition: definition('completed-dedupe'), storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
      notifier, notifyOnCompleted: true, notificationRetryDelayMs: 0,
    })
    const state = await runtime.start()
    assert.equal(state.completionReason, 'ALL_TASKS_COMPLETED')
    await runtime.getNotificationPromise()
    assert.equal(notifier.attempts, 1)
    assert.equal(notifier.notifications[0]?.notificationId, 'completed-dedupe:completed')
    assert.equal(runtime.getDurableState()?.completionNotified, true)
    await runtime.close()

    const resumed = new WorkSessionRuntime({
      definition: definition('completed-dedupe'), storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
      notifier, notifyOnCompleted: true, notificationRetryDelayMs: 0,
    })
    assert.equal((await resumed.loadPersistedState())?.state, 'COMPLETED')
    assert.equal(notifier.attempts, 1, 'hydrate must not send historical completion mail')
    await resumed.close()
  })
})

await test('completion notification retries once without mutating completed state', async () => {
  await withStorage(async (storageUrl) => {
    const notifier = new CompletedNotifier()
    notifier.failuresRemaining = 2
    const runtime = new WorkSessionRuntime({
      definition: definition('completed-retry'), storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
      notifier, notifyOnCompleted: true, notificationRetryDelayMs: 0,
    })
    await runtime.start()
    await runtime.getNotificationPromise()
    assert.equal(notifier.attempts, 2)
    assert.equal(runtime.getDurableState()?.state, 'COMPLETED')
    assert.equal(runtime.getDurableState()?.completionNotificationAttempted, true)
    assert.equal(runtime.getDurableState()?.completionNotified, undefined)
    await runtime.close()
  })
})

await test('completion email remains opt-in and excludes non-all-tasks completion reasons', async () => {
  await withStorage(async (storageUrl) => {
    const omitted = new CompletedNotifier()
    const runtime = new WorkSessionRuntime({
      definition: definition('completed-default-off'), storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
      notifier: omitted, notificationRetryDelayMs: 0,
    })
    await runtime.start()
    assert.equal(omitted.attempts, 0)
    await runtime.close()
  })
  await withStorage(async (storageUrl) => {
    const notifier = new CompletedNotifier()
    const runtime = new WorkSessionRuntime({
      definition: { ...definition('completed-soft-limit'), limits: { softMinutes: 0, hardMinutes: 60, maxTasks: 5 } },
      taskRunner: { async run() { throw new Error('must not run') } }, storageUrl,
      notifier, notifyOnCompleted: true, notificationRetryDelayMs: 0,
    })
    assert.equal((await runtime.start()).completionReason, 'SOFT_LIMIT')
    assert.equal(notifier.attempts, 0)
    await runtime.close()
  })
})
