/**
 * NovaWing v0.2.4 — real dogfood harness: Runtime AI Repair & Resume with a real
 * independent reviewer.
 *
 * It reopens a real, already-suspended NovaWing session, runs the single user
 * action (AI 修复并继续), and reports exactly what happened. It is the operator
 * instrument for the GOLDEN-003 class of failure ("no available agent for REVIEW").
 *
 * Safety:
 *   - the trusted config and the session database are COPIED into .tmp/dogfood; the
 *     operator's real artifacts are never opened for writing;
 *   - no evidence is fabricated: the session continues from its own durable
 *     TaskStateV2 and its own real repository inspection;
 *   - the reviewer is read-only, and this script never pushes, merges or tags.
 *
 * Usage:
 *   npm run build
 *   node scripts/dogfood-runtime-repair-review.mjs [sessionId]
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProductionWorkSessionUi } from '../dist/packages/development-guardian/work-session/production.js'
import { createWindowsToastRuntimeRepairNotifier } from '../dist/packages/development-guardian/work-session/runtime-repair-notifier.js'
import { loadTaskStateV2 } from '../dist/packages/development-guardian/work-session/task-state-v2.js'

const DEFAULT_SESSION_ID = 'fly-weave-202609101531-c2cebb'
const sessionId = (process.argv[2] ?? process.env.NOVAWING_DOGFOOD_SESSION ?? DEFAULT_SESSION_ID).trim()
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const srcConfig = join(localAppData, 'NovaWing', 'canary-configs', `${sessionId}.json`)
const srcDbDir = join(localAppData, 'NovaWing', 'work-sessions')

if (!existsSync(srcConfig)) {
  console.error(`No trusted config for session ${sessionId} at ${srcConfig}`)
  process.exit(2)
}

const work = resolve('.tmp', 'dogfood', `run-${Date.now()}`)
const dbDir = join(work, 'NovaWing', 'work-sessions')
await mkdir(dbDir, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  const from = join(srcDbDir, `${sessionId}.db${suffix}`)
  if (existsSync(from)) await copyFile(from, join(dbDir, `${sessionId}.db${suffix}`))
}
for (const suffix of ['', '-shm', '-wal']) {
  const from = join(srcDbDir, `${sessionId}.db.execution-ledger.sqlite${suffix}`)
  if (existsSync(from)) await copyFile(from, join(dbDir, `${sessionId}.db.execution-ledger.sqlite${suffix}`))
}

const config = JSON.parse(await readFile(srcConfig, 'utf8'))
// Email delivery is not part of this instrument; the desktop toast path is exercised.
config.notification = { email: { enabled: false, notifyOnCompleted: false } }
// Capability profiles. Which profile fills which role stays a Controller decision.
config.agents = [
  { id: 'codex-executor', provider: 'codex', runtimeIdentity: `session:${sessionId}:codex-executor`,
    capabilities: { coding: true, reasoning: true, verification: true } },
  { id: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: `session:${sessionId}:deepseek-reviewer`,
    capabilities: { review: true, reasoning: true } },
]

const auditEntries = []
const toasts = []
const realNotifier = createWindowsToastRuntimeRepairNotifier()
const app = await createProductionWorkSessionUi(config, {
  env: { ...process.env, LOCALAPPDATA: work },
  runtimeRepair: {
    auditSink: {
      record: async (entry) => {
        auditEntries.push(entry)
        await writeFile(join(work, 'runtime-repair-audit.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' })
      },
    },
    notifier: {
      async notify(notification) {
        const record = { kind: notification.kind, summary: notification.summary, delivered: false }
        toasts.push(record)
        try {
          await realNotifier.notify(notification)
          record.delivered = true
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error)
        }
      },
    },
  },
})

const report = { sessionId, work, before: {}, after: {}, audit: [], toasts: [] }
try {
  const before = await app.runtime.loadPersistedState()
  const beforeTaskId = before?.currentTaskId ?? Object.keys(before?.taskStatesV2 ?? {})[0] ?? ''
  const beforeTask = before?.taskStatesV2?.[beforeTaskId]
  const beforeLog = before?.taskEventLogs?.[beforeTaskId] ?? []
  report.before = {
    state: before?.state,
    humanRequired: before?.humanRequired ?? null,
    taskStatus: beforeTask?.status,
    currentAction: beforeTask?.currentAction,
    implementer: beforeTask?.implementer ?? null,
    providerHistory: beforeTask?.providerHistory ?? [],
    headSha: beforeTask?.gitState.headSha,
    worktreeFingerprint: beforeTask?.gitState.worktreeFingerprint,
    review: beforeTask?.completion.review ?? null,
    executeDispatches: beforeLog.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE').length,
  }
  // The repair path requires a strictly valid persisted TaskStateV2.
  if (beforeTask === undefined) throw new Error('no persisted TaskStateV2 for the current task')
  loadTaskStateV2(beforeTask)

  const resumed = await app.runtime.repairRuntimeAndResume()
  const taskId = resumed.currentTaskId ?? Object.keys(resumed.taskStatesV2 ?? {})[0] ?? ''
  const finalTask = resumed.taskStatesV2?.[taskId]
  const finalLog = resumed.taskEventLogs?.[taskId] ?? []
  report.after = {
    state: resumed.state,
    completionReason: resumed.completionReason ?? null,
    humanRequired: resumed.humanRequired ?? null,
    taskStatus: finalTask?.status,
    currentAction: finalTask?.currentAction,
    review: finalTask?.completion.review ?? null,
    providerHistory: finalTask?.providerHistory ?? [],
    checkpointCommits: resumed.checkpointCommits ?? {},
    executeDispatches: finalLog.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE').length,
    reviewDispatches: finalLog.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'REVIEW').length,
    eventTail: finalLog.slice(-8).map((event) => `${event.type}${event.action === undefined ? '' : `:${event.action}`}${event.reasonCode === undefined ? '' : `:${event.reasonCode}`}`),
    repairOutcome: app.runtime.getRuntimeRepairOutcome() ?? null,
  }
  report.audit = auditEntries.map((entry) => `${entry.event}:${entry.classification ?? entry.mechanism ?? ''}:executorReran=${String(entry.executorReran)}`)
  report.toasts = toasts
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.close().catch(() => undefined)
  await writeFile(join(work, 'dogfood-report.json'), `${JSON.stringify(report, null, 2)}\n`)
}
