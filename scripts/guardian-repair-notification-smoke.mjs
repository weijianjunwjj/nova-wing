/* global console, process */
/**
 * Real local smoke for the Launchpad Repair desktop notification.
 *
 * This intentionally exercises the production notifier — the actual WinRT toast
 * host — instead of a mock, so a broken notification path is caught on the
 * machine the operator uses. It resolves only after the toast host exits.
 *
 * Usage:
 *   npm run guardian:repair-notification:smoke
 */
import { createWindowsToastRepairNotifier } from 'nova-wing/development-guardian'

const notifier = createWindowsToastRepairNotifier()

const cases = [
  { kind: 'SUCCESS', errorCode: 'MISSING_EVIDENCE_BINDING', summary: '已修复并重新创建 Work Session：novawing-golden' },
  { kind: 'FAILURE', errorCode: 'APPROVAL_PREFLIGHT_REQUIRED', summary: '修复未通过，保留原始 Task：novawing-golden' },
]

if (process.platform !== 'win32') {
  console.log('Skipped: Windows desktop notifications are only available on win32.')
  process.exitCode = 0
} else {
  let failures = 0
  for (const notification of cases) {
    const started = Date.now()
    try {
      await notifier.notify({ ...notification, targetRepo: process.cwd() })
      console.log(`toast delivered: ${notification.kind} (${Date.now() - started}ms)`)
    } catch (error) {
      failures += 1
      console.error(`toast failed: ${notification.kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures > 0) {
    console.error(`Repair notification smoke FAILED (${failures}/${cases.length} deliveries failed).`)
    process.exitCode = 1
  } else {
    console.log(`Repair notification smoke PASSED: ${cases.length}/${cases.length} real toasts delivered.`)
  }
}
