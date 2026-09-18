import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildWindowsToastCommand,
  combineWorkSessionNotifiers,
  createWindowsTaskRunNotifier,
  deliverNotificationToChannels,
  NOTIFICATION_FAILURE_REASON,
  overallNotificationStatus,
  readExecutionLedger,
  SmtpWorkSessionNotifier,
  WINDOWS_TOAST_HOST,
  WorkSessionRuntime,
  type NotificationChannelResult,
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

async function withStorage(run: (storageUrl: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'novawing-notify-channel-'))
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

interface RecordingMail {
  attempts: number
}

function emailNotifier(recorded: RecordingMail, fails: boolean): WorkSessionNotifier {
  return new SmtpWorkSessionNotifier({
    transport: {
      async sendMail() {
        recorded.attempts += 1
        if (fails) throw new Error('smtp password=SUPER_SECRET 550 refused')
        return { accepted: true }
      },
    },
    from: 'nova@example.invalid',
    to: 'operator@example.invalid',
  })
}

function desktopNotifier(spawned: { attempts: number }, fails: boolean): WorkSessionNotifier {
  return createWindowsTaskRunNotifier({
    platform: 'win32',
    timeoutMs: 1_000,
    spawnToast: async () => {
      spawned.attempts += 1
      if (fails) throw new Error('toast exited 1')
    },
  })
}

/** Deliver a COMPLETED notification through both real notifiers and return the observed truth. */
async function deliverCompleted(
  storageUrl: string,
  sessionId: string,
  delivery: { email: boolean; desktop: boolean },
): Promise<{ channels?: readonly NotificationChannelResult[]; overallStatus?: string; status?: string; emailAttempts: number; desktopAttempts: number }> {
  const mail: RecordingMail = { attempts: 0 }
  const spawned = { attempts: 0 }
  const runtime = new WorkSessionRuntime({
    definition: definition(sessionId),
    storageUrl,
    taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
    notificationChannels: [
      { channel: 'EMAIL', notifier: emailNotifier(mail, !delivery.email) },
      { channel: 'DESKTOP', notifier: desktopNotifier(spawned, !delivery.desktop) },
    ],
    notifyOnCompleted: true,
    notificationRetryDelayMs: 0,
  })
  try {
    await runtime.start()
    await runtime.getNotificationPromise()
    const result = runtime.getLastNotificationDelivery()
    return {
      ...(result?.channels === undefined ? {} : { channels: result.channels }),
      ...(result?.overallStatus === undefined ? {} : { overallStatus: result.overallStatus }),
      ...(result?.status === undefined ? {} : { status: result.status }),
      emailAttempts: mail.attempts,
      desktopAttempts: spawned.attempts,
    }
  } finally {
    await runtime.close()
  }
}

test('per-channel status never collapses: ALL_SUCCEEDED, PARTIAL_SUCCESS, ALL_FAILED', async () => {
  await withStorage(async (storageUrl) => {
    const both = await deliverCompleted(storageUrl, 'notify-both-sent', { email: true, desktop: true })
    assert.equal(both.overallStatus, 'ALL_SUCCEEDED')
    assert.equal(both.status, 'SENT')
    assert.deepEqual(both.channels, [{ channel: 'EMAIL', status: 'SENT' }, { channel: 'DESKTOP', status: 'SENT' }])
    assert.equal(both.emailAttempts, 1)
    assert.equal(both.desktopAttempts, 1)

    const partial = await deliverCompleted(storageUrl, 'notify-partial', { email: true, desktop: false })
    assert.equal(partial.overallStatus, 'PARTIAL_SUCCESS')
    assert.equal(partial.status, 'SENT', 'a delivered channel keeps the overall event out of NOTIFICATION_FAILED')
    assert.deepEqual(partial.channels, [
      { channel: 'EMAIL', status: 'SENT' },
      { channel: 'DESKTOP', status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON },
    ])
    assert.equal(partial.emailAttempts, 1, 'the desktop retry never re-sends the accepted email')
    assert.equal(partial.desktopAttempts, 2, 'only the failing channel is retried')

    const failed = await deliverCompleted(storageUrl, 'notify-all-failed', { email: false, desktop: false })
    assert.equal(failed.overallStatus, 'ALL_FAILED')
    assert.equal(failed.status, 'FAILED')
    assert.equal(failed.emailAttempts, 2)
    assert.equal(failed.desktopAttempts, 2)
  })
})

test('the durable record keeps per-channel truth and no transport secret', async () => {
  await withStorage(async (storageUrl) => {
    await deliverCompleted(storageUrl, 'notify-ledger', { email: true, desktop: false })
    const events = readExecutionLedger(storageUrl, 'notify-ledger')
    const event = events.find((candidate) => candidate.eventType === 'NOTIFICATION_SENT' || candidate.eventType === 'NOTIFICATION_FAILED')
    assert.equal(event?.eventType, 'NOTIFICATION_SENT')
    assert.equal(event?.notificationOverall, 'PARTIAL_SUCCESS')
    assert.deepEqual(event?.notificationChannels, [
      { channel: 'EMAIL', status: 'SENT' },
      { channel: 'DESKTOP', status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON },
    ])
    assert.doesNotMatch(JSON.stringify(events), /SUPER_SECRET|550 refused/u, 'the accepted-channel truth never carries transport text')
  })
})

test('a single-channel notifier that fails still reports one failed channel', async () => {
  await withStorage(async (storageUrl) => {
    const failing: WorkSessionNotifier = { async notifyHumanRequired() {}, async notifyCompleted() { throw new Error('transport down') } }
    const runtime = new WorkSessionRuntime({
      definition: definition('notify-single-legacy'),
      storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
      notifier: failing,
      notifyOnCompleted: true,
      notificationRetryDelayMs: 0,
    })
    try {
      await runtime.start()
      await runtime.getNotificationPromise()
      const result = runtime.getLastNotificationDelivery()
      assert.equal(result?.status, 'FAILED')
      assert.equal(result?.overallStatus, 'ALL_FAILED')
      assert.deepEqual(result?.channels, [{ channel: 'DESKTOP', status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON }])
    } finally {
      await runtime.close()
    }
  })
})

test('the desktop channel never claims a human-required notification it does not deliver', async () => {
  await withStorage(async (storageUrl) => {
    const spawned = { attempts: 0 }
    const runtime = new WorkSessionRuntime({
      definition: definition('notify-kind-gate'),
      storageUrl,
      taskRunner: {
        async run() {
          return { status: 'HUMAN_REQUIRED' as const, humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose' } }
        },
      },
      // Email disabled: only the desktop completion/failure channel is wired.
      terminalNotifier: desktopNotifier(spawned, false),
      notificationRetryDelayMs: 0,
    })
    try {
      const state = await runtime.start()
      assert.equal(state.state, 'SUSPENDED')
      await runtime.getNotificationPromise()
      assert.equal(runtime.getLastNotificationDelivery(), undefined, 'no channel can deliver this kind, so nothing is reported')
      assert.equal(spawned.attempts, 0, 'the desktop channel is never invoked for a human-required alert')
      const events = readExecutionLedger(storageUrl, 'notify-kind-gate')
      assert.equal(events.some((event) => event.eventType === 'NOTIFICATION_SENT'), false)
      assert.equal(events.some((event) => event.eventType === 'NOTIFICATION_FAILED'), false)
    } finally {
      await runtime.close()
    }
  })
})

test('a non-Windows host reports the desktop channel as SKIPPED, never FAILED', async () => {
  const skipped: WorkSessionCompletedNotification = {
    notificationId: 'x:completed',
    session: { id: 'x', targetRepo: process.cwd(), branch: 'main' },
    completedTaskIds: ['T1'],
    completionReason: 'ALL_TASKS_COMPLETED',
  }
  const notifier = createWindowsTaskRunNotifier({ platform: 'linux' })
  const results = await deliverNotificationToChannels(notifier, 'COMPLETED', skipped)
  assert.deepEqual(results, [{ channel: 'DESKTOP', status: 'SKIPPED', reason: '当前平台未提供桌面通知渠道。' }])
  assert.equal(overallNotificationStatus(results), 'ALL_SUCCEEDED', 'an inapplicable channel is never a failure')
})

test('the composite reports every channel independently instead of collapsing on Promise.all', async () => {
  const completed: WorkSessionCompletedNotification = {
    notificationId: 'x:completed',
    session: { id: 'x', targetRepo: process.cwd(), branch: 'main' },
    completedTaskIds: ['T1'],
    completionReason: 'ALL_TASKS_COMPLETED',
  }
  const composite = combineWorkSessionNotifiers([
    { notificationChannel: 'EMAIL', async notifyHumanRequired() {}, async notifyCompleted() {} },
    { notificationChannel: 'DESKTOP', async notifyHumanRequired() {}, async notifyCompleted() { throw new Error('toast exited 1') } },
  ])
  const results = await composite.notifyChannels!('COMPLETED', completed)
  assert.deepEqual(results, [
    { channel: 'EMAIL', status: 'SENT' },
    { channel: 'DESKTOP', status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON },
  ])
  // The legacy per-kind method still rejects only when nothing was delivered.
  await assert.doesNotReject(async () => await composite.notifyCompleted!(completed))
  const allFailing = combineWorkSessionNotifiers([
    { notificationChannel: 'EMAIL', async notifyHumanRequired() {}, async notifyCompleted() { throw new Error('x') } },
    { notificationChannel: 'DESKTOP', async notifyHumanRequired() {}, async notifyCompleted() { throw new Error('y') } },
  ])
  await assert.rejects(async () => await allFailing.notifyCompleted!(completed), /every notification channel failed/u)
})

test('overallNotificationStatus is derived from per-channel truth', () => {
  assert.equal(overallNotificationStatus([]), 'ALL_SUCCEEDED')
  assert.equal(overallNotificationStatus([{ channel: 'EMAIL', status: 'SENT' }, { channel: 'DESKTOP', status: 'SENT' }]), 'ALL_SUCCEEDED')
  assert.equal(overallNotificationStatus([{ channel: 'EMAIL', status: 'SENT' }, { channel: 'DESKTOP', status: 'FAILED' }]), 'PARTIAL_SUCCESS')
  assert.equal(overallNotificationStatus([{ channel: 'EMAIL', status: 'FAILED' }, { channel: 'DESKTOP', status: 'FAILED' }]), 'ALL_FAILED')
  assert.equal(overallNotificationStatus([{ channel: 'EMAIL', status: 'FAILED' }, { channel: 'DESKTOP', status: 'SKIPPED' }]), 'ALL_FAILED')
  assert.equal(overallNotificationStatus([{ channel: 'DESKTOP', status: 'SKIPPED' }]), 'ALL_SUCCEEDED')
})

test('the Windows toast host is Windows PowerShell 5.1 and carries the toast as UTF-16LE', () => {
  // Regression lock: PowerShell 7 cannot project the WinRT toast types, so every
  // toast failed with "Unable to find type [Windows.UI.Notifications...]".
  assert.equal(WINDOWS_TOAST_HOST, 'powershell.exe')
  const { command, args } = buildWindowsToastCommand('NovaWing · T1 已完成', '完成 · 中文正文', 'http://127.0.0.1:1')
  assert.equal(command, 'powershell.exe')
  const encodedIndex = args.indexOf('-EncodedCommand')
  assert.ok(encodedIndex >= 0, 'the script travels as -EncodedCommand so Unicode survives')
  const script = Buffer.from(args[encodedIndex + 1]!, 'base64').toString('utf16le')
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/u)
  assert.match(script, /NovaWing · T1 已完成/u)
  assert.match(script, /完成 · 中文正文/u)
  assert.match(script, /127\.0\.0\.1:1/u)
})
