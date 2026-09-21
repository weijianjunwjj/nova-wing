import { spawn } from 'node:child_process'

import type { RepairErrorCode } from '../work-session/launchpad/repair.js'

export interface RepairNotification {
  kind: 'SUCCESS' | 'FAILURE'
  targetRepo: string
  errorCode?: RepairErrorCode
  summary: string
}

/** Best-effort desktop notification seam; tests inject a recorder. */
export interface RepairNotifier {
  notify(notification: RepairNotification): Promise<void>
}

export interface ToastDelivery {
  exitCode: number | null
  stderr: string
}

export type ToastSpawner = (title: string, body: string, timeoutMs: number) => Promise<ToastDelivery>

export interface WindowsToastOptions {
  platform?: NodeJS.Platform
  spawnToast?: ToastSpawner
  /** Strict hosts retain the notification worker until its close event. */
  shutdownMode?: 'strict' | 'bounded'
  /** Low-level process adapter; a custom toast delivery still owns its own worker. */
  spawnProcess?: typeof spawn
  /** Delivery deadline; strict mode also waits for the timed-out worker to close. */
  timeoutMs?: number
}

/**
 * Windows 10/11 toast via the WinRT API. Strict delivery waits for the
 * PowerShell worker's close event even on failure; the legacy default bounds
 * its wait. The Launchpad still treats notification delivery as best-effort.
 */
export function createWindowsToastRepairNotifier(options: WindowsToastOptions = {}): RepairNotifier {
  const isWindows = (options.platform ?? process.platform) === 'win32'
  const spawnToast = options.spawnToast ?? ((title, body, timeout) => spawnWindowsToast(title, body, timeout, options))
  const timeoutMs = options.timeoutMs ?? 15_000
  return {
    async notify(notification) {
      if (!isWindows) return
      const title = notification.kind === 'SUCCESS' ? 'NovaWing 修复成功' : 'NovaWing 修复失败'
      const body = notification.errorCode === undefined
        ? notification.summary
        : `${notification.summary}（${notification.errorCode}）`
      const delivery = await spawnToast(title, body, timeoutMs)
      if (delivery.exitCode !== 0) {
        throw new Error(`Windows toast delivery failed: ${delivery.stderr.trim() || `exit ${String(delivery.exitCode)}`}`)
      }
    },
  }
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function spawnWindowsToast(title: string, body: string, timeoutMs: number, options: WindowsToastOptions): Promise<ToastDelivery> {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$template = '<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($template)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NovaWing Launchpad").Show($toast)',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise<ToastDelivery>((resolveToast) => {
    const child = (options.spawnProcess ?? spawn)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    let settled = false
    let failed = false
    let timer: NodeJS.Timeout | undefined
    const strict = options.shutdownMode === 'strict'
    const finish = (delivery: ToastDelivery): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveToast(delivery)
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', (error) => {
      failed = true
      stderr = `${stderr}${error.message}`
      if (!strict) finish({ exitCode: 1, stderr })
    })
    child.once('close', (code) => finish({ exitCode: failed && code === 0 ? 1 : code, stderr }))
    timer = setTimeout(() => {
      failed = true
      stderr = `${stderr}\nWindows toast host timed out after ${timeoutMs}ms`.trim()
      try { child.kill() } catch (error) {
        stderr = `${stderr}\n${error instanceof Error ? error.message : String(error)}`
      }
      // A kill request does not establish that the worker and its pipes exited.
      if (!strict) finish({ exitCode: null, stderr })
    }, timeoutMs)
    timer.unref()
  })
}
