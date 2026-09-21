import { spawn } from 'node:child_process'

import { formatDurationZh } from '../work-session/task-run-analytics.js'
import {
  deliverNotificationToChannels,
  NOTIFICATION_FAILURE_REASON,
  overallNotificationStatus,
  supportsNotificationKind,
  type HumanRequiredNotification,
  type NotificationChannelResult,
  type WorkSessionCompletedNotification,
  type WorkSessionFailedNotification,
  type WorkSessionNotificationKind,
  type WorkSessionNotificationPayload,
  type WorkSessionNotifier,
} from '../work-session/notifier.js'

export interface WindowsTaskRunToastOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  spawnToast?: (title: string, body: string, timeoutMs: number, localUrl?: string) => Promise<void>
  /** Strict hosts wait for worker and stdio closure, including after timeout. */
  shutdownMode?: 'strict' | 'bounded'
  spawnProcess?: typeof spawn
}

export function createWindowsTaskRunNotifier(options: WindowsTaskRunToastOptions = {}): WorkSessionNotifier {
  const platform = options.platform ?? process.platform
  const deliver = options.spawnToast ?? ((title, body, timeout, localUrl) => spawnTaskRunToast(title, body, timeout, localUrl, options))
  const timeoutMs = options.timeoutMs ?? 8_000
  const available = platform === 'win32'

  const completed = async (notification: WorkSessionCompletedNotification): Promise<void> => {
    const analytics = notification.analytics
    const taskId = analytics?.taskId ?? notification.completedTaskIds.at(-1) ?? notification.session.id
    const providers = analytics === undefined ? '' : `${analytics.implementerProviders.join('、') || '未知'} 执行 ×${analytics.executeCount} · ${analytics.reviewerProviders.join('、') || '无'} 审查 ×${analytics.reviewCount}`
    const body = analytics === undefined
      ? 'Task 已完成\n点击查看完整报告'
      : `${formatDurationZh(analytics.totalDurationMs)} · ${analytics.humanDecisionCount} 次人工决策\n${providers}\n点击查看完整报告`
    await deliver(`NovaWing · ${taskId} 已完成`, body, timeoutMs, notification.reportUrl)
  }
  const failed = async (notification: WorkSessionFailedNotification): Promise<void> => {
    const analytics = notification.analytics
    const body = `运行 ${formatDurationZh(analytics?.totalDurationMs ?? notification.activeElapsedMs ?? null)}\n失败原因：${notification.safeReason}\n人工决：${analytics?.humanDecisionCount ?? 0} 次\n点击查看详情`
    await deliver(`NovaWing · ${notification.currentTaskId ?? notification.session.id} 失败`, body, timeoutMs, notification.reportUrl ?? notification.control.localUrl)
  }
  const invoke = (
    kind: WorkSessionNotificationKind,
    notification: WorkSessionNotificationPayload,
  ): Promise<void> | undefined => {
    if (kind === 'COMPLETED') return completed(notification as WorkSessionCompletedNotification)
    if (kind === 'FAILED') return failed(notification as WorkSessionFailedNotification)
    return undefined
  }

  return {
    notificationChannel: 'DESKTOP',
    // The desktop channel is a completion/failure channel only; `notifyHumanRequired`
    // is a deliberate no-op, never a delivery.
    notificationKinds: ['COMPLETED', 'FAILED'],
    async notifyHumanRequired(_notification: HumanRequiredNotification): Promise<void> {},
    async notifyCompleted(notification: WorkSessionCompletedNotification): Promise<void> {
      if (!available) return
      await completed(notification)
    },
    async notifyFailed(notification: WorkSessionFailedNotification): Promise<void> {
      if (!available) return
      await failed(notification)
    },
    async notifyChannels(kind, notification): Promise<readonly NotificationChannelResult[]> {
      // A non-Windows host has no desktop channel; that is "not applicable",
      // never a delivery failure.
      if (!available) return [{ channel: 'DESKTOP', status: 'SKIPPED', reason: '当前平台未提供桌面通知渠道。' }]
      const pending = invoke(kind, notification)
      if (pending === undefined) return [{ channel: 'DESKTOP', status: 'SKIPPED', reason: '桌面通知不适用于此通知类型。' }]
      try {
        await pending
        return [{ channel: 'DESKTOP', status: 'SENT' }]
      } catch {
        return [{ channel: 'DESKTOP', status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON }]
      }
    },
  }
}

/**
 * Fan one notification out to several channels and report every channel's own
 * truth. A channel that fails is reported as failed and can never make a
 * channel that was accepted look like a failure.
 *
 * The legacy per-kind methods keep their original contract — they reject when
 * every attempted channel failed — so existing callers stay correct.
 */
export function combineWorkSessionNotifiers(notifiers: readonly WorkSessionNotifier[]): WorkSessionNotifier {
  const notifyChannels = async (
    kind: WorkSessionNotificationKind,
    notification: WorkSessionNotificationPayload,
  ): Promise<readonly NotificationChannelResult[]> => {
    const results = await Promise.all(notifiers.map(async (notifier) => {
      if (!supportsNotificationKind(notifier, kind)) return [] as NotificationChannelResult[]
      try {
        return await deliverNotificationToChannels(notifier, kind, notification)
      } catch {
        return [{ channel: notifier.notificationChannel ?? 'DESKTOP', status: 'FAILED' as const, reason: NOTIFICATION_FAILURE_REASON }]
      }
    }))
    return results.flat()
  }
  const legacy = async (kind: WorkSessionNotificationKind, notification: WorkSessionNotificationPayload): Promise<void> => {
    const channels = await notifyChannels(kind, notification)
    if (overallNotificationStatus(channels) === 'ALL_FAILED') throw new Error('every notification channel failed')
  }
  return {
    notifyChannels,
    notificationKinds: NOTIFICATION_KINDS.filter((kind) => notifiers.some((notifier) => supportsNotificationKind(notifier, kind))),
    async notifyHumanRequired(value) { await legacy('HUMAN_REQUIRED', value) },
    async notifyCompleted(value) { await legacy('COMPLETED', value) },
    async notifyFailed(value) { await legacy('FAILED', value) },
    async notifyRecoveryRequired(value) { await legacy('RECOVERY_REQUIRED', value) },
  }
}

/** Every kind the runtime can schedule. */
export const NOTIFICATION_KINDS: readonly WorkSessionNotificationKind[] = ['HUMAN_REQUIRED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED']

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/**
 * The Windows toast host.
 *
 * Windows PowerShell 5.1 (`powershell.exe`) is required: PowerShell 7 (`pwsh`)
 * cannot project the WinRT types `[Windows.UI.Notifications...]` without an
 * extra SDK, so every toast failed with "Unable to find type
 * [Windows.UI.Notifications.ToastNotificationManager]". The script travels as a
 * UTF-16LE `-EncodedCommand`, which keeps Chinese text intact.
 */
export const WINDOWS_TOAST_HOST = 'powershell.exe'

/** The exact host invocation for one toast; exported so the regression stays locked. */
export function buildWindowsToastCommand(title: string, body: string, localUrl?: string): { command: string; args: readonly string[] } {
  const launch = localUrl === undefined ? '' : `<actions><action content="查看报告" arguments="${xml(localUrl)}" activationType="protocol"/></actions>`
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual>${launch}</toast>'`,
    '$document = New-Object Windows.Data.Xml.Dom.XmlDocument', '$document.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $document',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NovaWing").Show($toast)',
  ].join('; ')
  return {
    command: WINDOWS_TOAST_HOST,
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  }
}

function spawnTaskRunToast(title: string, body: string, timeoutMs: number, localUrl: string | undefined, options: WindowsTaskRunToastOptions): Promise<void> {
  const { command, args } = buildWindowsToastCommand(title, body, localUrl)
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(command, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let failure: Error | undefined
    const strict = options.shutdownMode === 'strict'
    const timer = setTimeout(() => {
      failure = new Error('toast timed out')
      try { child.kill() } catch (error) {
        failure = new AggregateError([failure, error], 'toast timeout and termination failed')
      }
      if (!strict) reject(failure)
    }, timeoutMs)
    timer.unref()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    child.once('error', (error) => {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'toast worker failed')
      clearTimeout(timer)
      if (!strict) reject(failure)
    })
    child.once(strict ? 'close' : 'exit', (code: number | null) => {
      clearTimeout(timer)
      if (failure !== undefined) reject(failure)
      else if (code === 0) resolve()
      else reject(new Error(`toast exited ${String(code)}${stderr.trim().length === 0 ? '' : `: ${stderr.trim()}`}`))
    })
  })
}
