import { spawn } from 'node:child_process'

import { formatDurationZh } from './task-run-analytics.js'
import type { HumanRequiredNotification, WorkSessionCompletedNotification, WorkSessionFailedNotification, WorkSessionNotifier } from './notifier.js'

export interface WindowsTaskRunToastOptions {
  platform?: NodeJS.Platform
  timeoutMs?: number
  spawnToast?: (title: string, body: string, timeoutMs: number, localUrl?: string) => Promise<void>
}

export function createWindowsTaskRunNotifier(options: WindowsTaskRunToastOptions = {}): WorkSessionNotifier {
  const platform = options.platform ?? process.platform
  const deliver = options.spawnToast ?? spawnTaskRunToast
  return {
    async notifyHumanRequired(_notification: HumanRequiredNotification): Promise<void> {},
    async notifyCompleted(notification: WorkSessionCompletedNotification): Promise<void> {
      if (platform !== 'win32') return
      const analytics = notification.analytics
      const taskId = analytics?.taskId ?? notification.completedTaskIds.at(-1) ?? notification.session.id
      const providers = analytics === undefined ? '' : `${analytics.implementerProviders.join('、') || '未知'} 执行 ×${analytics.executeCount} · ${analytics.reviewerProviders.join('、') || '无'} 审查 ×${analytics.reviewCount}`
      const body = analytics === undefined
        ? 'Task 已完成\n点击查看完整报告'
        : `${formatDurationZh(analytics.totalDurationMs)} · ${analytics.humanDecisionCount} 次人工决策\n${providers}\n点击查看完整报告`
      await deliver(`NovaWing · ${taskId} 已完成`, body, options.timeoutMs ?? 8_000, notification.reportUrl)
    },
    async notifyFailed(notification: WorkSessionFailedNotification): Promise<void> {
      if (platform !== 'win32') return
      const analytics = notification.analytics
      const body = `运行 ${formatDurationZh(analytics?.totalDurationMs ?? notification.activeElapsedMs ?? null)}\n失败原因：${notification.safeReason}\n人工决：${analytics?.humanDecisionCount ?? 0} 次\n点击查看详情`
      await deliver(`NovaWing · ${notification.currentTaskId ?? notification.session.id} 失败`, body, options.timeoutMs ?? 8_000, notification.reportUrl ?? notification.control.localUrl)
    },
  }
}

export function combineWorkSessionNotifiers(notifiers: readonly WorkSessionNotifier[]): WorkSessionNotifier {
  return {
    async notifyHumanRequired(value) { await Promise.all(notifiers.map((notifier) => notifier.notifyHumanRequired(value))) },
    async notifyCompleted(value) { await Promise.all(notifiers.map((notifier) => notifier.notifyCompleted?.(value))) },
    async notifyFailed(value) { await Promise.all(notifiers.map((notifier) => notifier.notifyFailed?.(value))) },
    async notifyRecoveryRequired(value) { await Promise.all(notifiers.map((notifier) => notifier.notifyRecoveryRequired?.(value))) },
  }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function spawnTaskRunToast(title: string, body: string, timeoutMs: number, localUrl?: string): Promise<void> {
  const launch = localUrl === undefined ? '' : `<actions><action content="查看报告" arguments="${xml(localUrl)}" activationType="protocol"/></actions>`
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual>${launch}</toast>'`,
    '$document = New-Object Windows.Data.Xml.Dom.XmlDocument', '$document.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $document',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NovaWing").Show($toast)',
  ].join('; ')
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('toast timed out')) }, timeoutMs); timer.unref()
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`toast exited ${String(code)}`)) })
  })
}
