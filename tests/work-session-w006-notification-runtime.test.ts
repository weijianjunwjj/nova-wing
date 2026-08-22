import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  GuardianWorkSessionTaskRunner,
  RetryableGuardianBrainError,
  WorkSessionRuntime,
  type DelegationPacket,
  type ExecutionReport,
  type HumanRequiredNotification,
  type NotificationDeliveryResult,
  type WorkSessionDefinition,
  type WorkSessionNotifier,
  type WorkSessionTaskResult,
  type WorkSessionTaskRunner,
} from 'nova-wing/development-guardian'

function definition(id: string): WorkSessionDefinition {
  return {
    id,
    targetRepo: process.cwd(),
    branch: 'feat/work-session-mvp',
    tasks: [{ id: 'T1', goal: 'task one' }],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
  }
}

function proceedPacket(verdict: 'proceed' | 'done'): DelegationPacket {
  return {
    verdict,
    goal: 'task one',
    instructions: verdict === 'proceed' ? ['implement'] : [],
    constraints: [],
    verification: ['npm test'],
    doNotDo: [],
  }
}

function passedReport(): ExecutionReport {
  return {
    summary: 'done', changedFiles: [], commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status: 'passed' }], blockers: [],
  }
}

function runner(
  execute: (resumeData: unknown) => WorkSessionTaskResult | Promise<WorkSessionTaskResult>,
): WorkSessionTaskRunner {
  return {
    async run(_task, resumeData) {
      return execute(resumeData)
    },
  }
}

class RecordingNotifier implements WorkSessionNotifier {
  readonly notifications: HumanRequiredNotification[] = []
  attempts = 0
  fail = false
  onAttempt?: () => Promise<void>

  async notifyHumanRequired(notification: HumanRequiredNotification): Promise<void> {
    this.attempts++
    this.notifications.push(notification)
    await this.onAttempt?.()
    if (this.fail) throw new Error('535 auth failed password=SUPER_SECRET')
  }
}

async function withStorage(
  prefix: string,
  run: (storageUrl: string) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(pathToFileURL(join(temp, 'session.db')).href)
  } finally {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(temp, { recursive: true, force: true })
        break
      } catch {
        // Mastra/libSQL may release its Windows WAL handle just after close().
        // Cleanup is best-effort, matching the existing Work Session tests.
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
  }
}

await test('W006 NOTIFY-A/B/C: COMPLETED, FAILED, and USER_PAUSED never notify', async () => {
  await withStorage('w006-gates-', async (storageUrl) => {
    const completedNotifier = new RecordingNotifier()
    const completed = new WorkSessionRuntime({
      definition: definition('w006-completed'),
      storageUrl,
      taskRunner: runner(() => ({ status: 'COMPLETED' })),
      notifier: completedNotifier,
      notificationRetryDelayMs: 0,
    })
    assert.equal((await completed.start()).state, 'COMPLETED')
    assert.equal(completedNotifier.attempts, 0)
    await completed.close()
  })

  await withStorage('w006-gates-', async (storageUrl) => {
    const failedNotifier = new RecordingNotifier()
    const failed = new WorkSessionRuntime({
      definition: definition('w006-failed'),
      storageUrl,
      taskRunner: runner(() => ({ status: 'FAILED', error: 'typecheck failed' })),
      notifier: failedNotifier,
      notificationRetryDelayMs: 0,
    })
    await assert.rejects(failed.start(), /typecheck failed/)
    assert.equal(failed.getDurableState()?.state, 'FAILED')
    assert.equal(failedNotifier.attempts, 0)
    await failed.close()
  })

  await withStorage('w006-gates-', async (storageUrl) => {
    const pausedNotifier = new RecordingNotifier()
    const paused = new WorkSessionRuntime({
      definition: definition('w006-paused'),
      storageUrl,
      taskRunner: runner(() => ({ status: 'PAUSED' })),
      notifier: pausedNotifier,
      notificationRetryDelayMs: 0,
    })
    const state = await paused.start()
    assert.equal(state.state, 'SUSPENDED')
    assert.equal(state.suspensionReason, 'USER_PAUSED')
    assert.equal(pausedNotifier.attempts, 0)
    await paused.close()
  })
})

await test('W006 reviewer rotation notifies only when the fresh session also times out', async () => {
  await withStorage('w006-rotation-success-', async (storageUrl) => {
    const notifier = new RecordingNotifier()
    let reviews = 0
    let rotations = 0
    const taskRunner = new GuardianWorkSessionTaskRunner({
      brain: {
        async review() {
          reviews += 1
          if (reviews <= 2) throw new RetryableGuardianBrainError('timeout')
          return reviews === 3 ? proceedPacket('proceed') : proceedPacket('done')
        },
        resetTaskReviewSession() { rotations += 1 },
      },
      createExecutor: () => ({ async execute() { return passedReport() } }),
    })
    const runtime = new WorkSessionRuntime({
      definition: definition('w006-rotation-success'), storageUrl, taskRunner, notifier,
      notificationRetryDelayMs: 0,
    })

    assert.equal((await runtime.start()).state, 'COMPLETED')
    assert.equal(rotations, 1)
    assert.equal(notifier.attempts, 0)
    await runtime.close()
  })

  await withStorage('w006-rotation-exhausted-', async (storageUrl) => {
    const notifier = new RecordingNotifier()
    let reviews = 0
    let rotations = 0
    const taskRunner = new GuardianWorkSessionTaskRunner({
      brain: {
        async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
        resetTaskReviewSession() { rotations += 1 },
      },
      createExecutor: () => ({ async execute() { throw new Error('must not execute') } }),
    })
    const runtime = new WorkSessionRuntime({
      definition: definition('w006-rotation-exhausted'), storageUrl, taskRunner, notifier,
      notificationRetryDelayMs: 0,
    })

    const state = await runtime.start()
    assert.equal(state.state, 'SUSPENDED')
    assert.equal(state.humanRequired?.category, 'STALLED')
    assert.equal(reviews, 3)
    assert.equal(rotations, 1)
    await runtime.getNotificationPromise()
    assert.equal(notifier.attempts, 1)
    await runtime.close()
  })
})

await test('W006 NOTIFY-D/E/G: notify only after durable suspend and never on hydrate/reconnect', async () => {
  await withStorage('w006-durable-', async (storageUrl) => {
    const notifier = new RecordingNotifier()
    let runtime1: WorkSessionRuntime
    notifier.onAttempt = async () => {
      const snapshot = await runtime1.verifySnapshot()
      assert.equal(snapshot.status, 'suspended')
      assert.equal(snapshot.hasSuspendedStep, true)
    }
    runtime1 = new WorkSessionRuntime({
      definition: definition('w006-durable'),
      storageUrl,
      taskRunner: runner(() => ({
        status: 'HUMAN_REQUIRED',
        humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
      })),
      notifier,
      notificationRetryDelayMs: 0,
      localControlUrl: () => 'http://127.0.0.1:4317/?token=URL_SECRET',
    })
    const suspended = await runtime1.start()
    assert.equal(suspended.state, 'SUSPENDED')
    await runtime1.getNotificationPromise()
    assert.equal(notifier.attempts, 1)
    assert.equal(notifier.notifications[0]?.control.localUrl, undefined)
    assert.doesNotMatch(JSON.stringify(notifier.notifications[0]), /URL_SECRET|token=/u)
    assert.equal(runtime1.getDurableState()?.humanRequiredGeneration, 1)
    assert.equal(runtime1.getDurableState()?.lastNotificationAttemptGeneration, 1)
    assert.equal(runtime1.getDurableState()?.lastNotifiedHumanRequiredGeneration, 1)
    await runtime1.close()

    const runtime2 = new WorkSessionRuntime({
      definition: definition('w006-durable'),
      storageUrl,
      taskRunner: runner(() => ({ status: 'COMPLETED' })),
      notifier,
      notificationRetryDelayMs: 0,
    })
    assert.equal((await runtime2.loadPersistedState())?.state, 'SUSPENDED')
    assert.equal(notifier.attempts, 1, 'hydrate must not resend')
    runtime2.getDurableState()
    runtime2.getDurableState()
    assert.equal(notifier.attempts, 1, 'polling/controller reads must not resend')
    await runtime2.close()
  })
})

await test('W006 delivery is background-owned and does not block durable SUSPENDED result', async () => {
  await withStorage('w006-background-', async (storageUrl) => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked })
    const notifier = new RecordingNotifier()
    notifier.onAttempt = () => blocked
    const runtime = new WorkSessionRuntime({
      definition: definition('w006-background'),
      storageUrl,
      taskRunner: runner(() => ({
        status: 'HUMAN_REQUIRED',
        humanRequired: { category: 'STALLED', reason: 'choose next action' },
      })),
      notifier,
      notificationRetryDelayMs: 0,
    })
    const outcome = await Promise.race([
      runtime.start().then((state) => state.state),
      new Promise<'BLOCKED'>((resolveBlocked) => {
        setTimeout(() => resolveBlocked('BLOCKED'), 500)
      }),
    ])
    assert.equal(outcome, 'SUSPENDED')
    while (notifier.attempts === 0) {
      await new Promise((resolveTurn) => setImmediate(resolveTurn))
    }
    assert.ok(runtime.getNotificationPromise(), 'production owner holds delivery promise')
    release?.()
    await runtime.getNotificationPromise()
    await runtime.close()
  })
})

await test('W006 NOTIFY-F/J: same Task second incident sends generation 2 without resume secret', async () => {
  await withStorage('w006-generation-', async (storageUrl) => {
    const notifier = new RecordingNotifier()
    const runtime1 = new WorkSessionRuntime({
      definition: definition('w006-generation'),
      storageUrl,
      taskRunner: runner((resumeData) => resumeData === undefined
        ? {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose first mode' },
          }
        : { status: 'COMPLETED' }),
      notifier,
      notificationRetryDelayMs: 0,
    })
    await runtime1.start()
    await runtime1.getNotificationPromise()
    await runtime1.close()

    const runtime2 = new WorkSessionRuntime({
      definition: definition('w006-generation'),
      storageUrl,
      taskRunner: runner(() => ({
        status: 'HUMAN_REQUIRED',
        humanRequired: {
          category: 'ENVIRONMENT_REQUIRED',
          reason: 'Authorization: Bearer DECISION_SECRET',
        },
      })),
      notifier,
      notificationRetryDelayMs: 0,
    })
    await runtime2.loadPersistedState()
    const second = await runtime2.resume({ decision: 'Authorization: Bearer DECISION_SECRET' })
    assert.equal(second.state, 'SUSPENDED')
    assert.equal(second.humanRequiredGeneration, 2)
    await runtime2.getNotificationPromise()
    assert.equal(notifier.attempts, 2)
    assert.equal(notifier.notifications[0]?.notificationId, 'w006-generation:T1:1')
    assert.equal(notifier.notifications[1]?.notificationId, 'w006-generation:T1:2')
    const secondMail = JSON.stringify(notifier.notifications[1])
    assert.doesNotMatch(secondMail, /DECISION_SECRET|Bearer/u)
    await runtime2.close()
  })
})

await test('W006 NOTIFY-H/I: two failures keep SUSPENDED, expose only safe result, and do not retry on restart', async () => {
  await withStorage('w006-failure-', async (storageUrl) => {
    const notifier = new RecordingNotifier()
    notifier.fail = true
    const deliveries: NotificationDeliveryResult[] = []
    const runtime1 = new WorkSessionRuntime({
      definition: definition('w006-failure'),
      storageUrl,
      taskRunner: runner(() => ({
        status: 'HUMAN_REQUIRED',
        humanRequired: { category: 'CREDENTIAL_REQUIRED', reason: 'login is required' },
      })),
      notifier,
      notificationObserver: (result) => deliveries.push(result),
      notificationRetryDelayMs: 0,
    })
    assert.equal((await runtime1.start()).state, 'SUSPENDED')
    await runtime1.getNotificationPromise()
    assert.equal(notifier.attempts, 2)
    assert.equal(runtime1.getDurableState()?.state, 'SUSPENDED')
    assert.equal(runtime1.getDurableState()?.lastNotificationAttemptGeneration, 1)
    assert.equal(runtime1.getDurableState()?.lastNotifiedHumanRequiredGeneration, undefined)
    assert.deepEqual(deliveries, [{
      status: 'FAILED',
      notificationId: 'w006-failure:T1:1',
      taskId: 'T1',
      category: 'CREDENTIAL_REQUIRED',
    }])
    assert.doesNotMatch(JSON.stringify(deliveries), /SUPER_SECRET|535 auth failed password/u)
    await runtime1.close()

    const runtime2 = new WorkSessionRuntime({
      definition: definition('w006-failure'),
      storageUrl,
      taskRunner: runner(() => ({ status: 'COMPLETED' })),
      notifier,
      notificationRetryDelayMs: 0,
    })
    await runtime2.loadPersistedState()
    assert.equal(notifier.attempts, 2, 'failed generation must not retry on restart')
    await runtime2.close()
  })
})
