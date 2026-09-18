/**
 * NovaWing v0.2.4 — Runtime Repair desktop notification seam.
 *
 * Best-effort；测试注入 recorder。成功/失败都给出明确原因。
 */

import { spawn } from 'node:child_process'

import type { RuntimeRepairOutcome } from '../work-session/runtime-repair.js'

export interface RuntimeRepairNotification {
  kind: 'SUCCESS' | 'FAILURE' | 'COMPLETED'
  sessionId: string
  summary: string
}

export interface RuntimeRepairNotifier {
  notify(notification: RuntimeRepairNotification): Promise<void>
}

/** 将 repair outcome 投影为面向用户的 safe notification。 */
export function runtimeRepairNotificationFrom(
  sessionId: string,
  outcome: RuntimeRepairOutcome,
): RuntimeRepairNotification {
  if (outcome.classification === 'REPAIRED') {
    return {
      kind: 'SUCCESS',
      sessionId,
      summary: `NovaWing 已自动修复 ${sessionId}\n已找到可用独立 Reviewer，任务继续执行。`,
    }
  }
  return {
    kind: 'FAILURE',
    sessionId,
    summary: `NovaWing 无法安全自动修复\n原因：${outcome.reason ?? '没有可用的独立 Reviewer。'}`,
  }
}

/** 最终完成通知（会话完成后单独发送）。 */
export function runtimeRepairCompletionNotification(sessionId: string): RuntimeRepairNotification {
  return { kind: 'COMPLETED', sessionId, summary: `NovaWing ${sessionId} 已完成。` }
}

export interface RecordingRuntimeRepairNotifier {
  notifier: RuntimeRepairNotifier
  notifications: RuntimeRepairNotification[]
}

export function createRecordingRuntimeRepairNotifier(): RecordingRuntimeRepairNotifier {
  const notifications: RuntimeRepairNotification[] = []
  return {
    notifications,
    notifier: { async notify(notification) { notifications.push(notification) } },
  }
}

export interface WindowsToastRuntimeRepairOptions {
  platform?: NodeJS.Platform
  spawnToast?: (title: string, body: string, timeoutMs: number) => Promise<{ exitCode: number | null; stderr: string }>
  timeoutMs?: number
}

/** Windows 10/11 toast；notify 在 toast host 退出后才 resolve。 */
export function createWindowsToastRuntimeRepairNotifier(options: WindowsToastRuntimeRepairOptions = {}): RuntimeRepairNotifier {
  const isWindows = (options.platform ?? process.platform) === 'win32'
  const spawnToast = options.spawnToast ?? spawnRuntimeRepairToast
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    async notify(notification) {
      if (!isWindows) return
      const title = notification.kind === 'FAILURE'
        ? 'NovaWing 无法自动修复'
        : notification.kind === 'COMPLETED' ? 'NovaWing 已完成' : 'NovaWing 修复成功'
      const delivery = await spawnToast(title, notification.summary, timeoutMs)
      if (delivery.exitCode !== 0) {
        throw new Error(`Windows toast delivery failed: ${delivery.stderr.trim() || `exit ${String(delivery.exitCode)}`}`)
      }
    },
  }
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function spawnRuntimeRepairToast(title: string, body: string, timeoutMs: number): Promise<{ exitCode: number | null; stderr: string }> {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NovaWing").Show($toast)',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolveToast) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    let settled = false
    const finish = (delivery: { exitCode: number | null; stderr: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveToast(delivery)
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', (error) => finish({ exitCode: 1, stderr: `${stderr}${error.message}` }))
    child.once('close', (code) => finish({ exitCode: code ?? 1, stderr }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: null, stderr: `${stderr}\nWindows toast host timed out after ${timeoutMs}ms`.trim() })
    }, timeoutMs)
    timer.unref()
  })
}
