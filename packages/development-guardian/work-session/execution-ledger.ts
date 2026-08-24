import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import type { GuardianPhase, GuardianProgressStatus } from '../progress.js'
import type { WorkSessionCompletionReason } from './model.js'
import type {
  WorkSessionFailureCategory,
  WorkSessionFailureStage,
} from './failure-classification.js'
import { safeFailureMessage } from './failure-classification.js'

export const EXECUTION_LEDGER_SCHEMA_VERSION = 1 as const

export type ExecutionLedgerEventType =
  | 'SESSION_STARTED'
  | 'TASK_STARTED'
  | 'PHASE_STARTED'
  | 'PHASE_COMPLETED'
  | 'PHASE_FAILED'
  | 'TASK_COMPLETED'
  | 'GIT_COMMIT_COMPLETED'
  | 'GIT_PUSH_COMPLETED'
  | 'HUMAN_REQUIRED'
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'NOTIFICATION_SENT'
  | 'NOTIFICATION_FAILED'

export type ExecutionLedgerNotificationKind = 'HUMAN_REQUIRED' | 'COMPLETED' | 'FAILED'

interface ExecutionLedgerEventBase {
  sessionId: string
  taskId: string | null
  timestamp: string
  activeElapsedMs?: number
}

export type ExecutionLedgerEventInput = ExecutionLedgerEventBase & (
  | { eventType: 'SESSION_STARTED'; status: 'RUNNING' }
  | { eventType: 'TASK_STARTED'; taskId: string; status: 'RUNNING' }
  | {
      eventType: 'PHASE_STARTED' | 'PHASE_COMPLETED' | 'PHASE_FAILED'
      taskId: string
      phase: GuardianPhase
      status: GuardianProgressStatus
      iteration: number
      durationMs?: number
    }
  | { eventType: 'TASK_COMPLETED'; taskId: string; status: 'COMPLETED' }
  | { eventType: 'GIT_COMMIT_COMPLETED'; taskId: string; status: 'COMPLETED'; commitSha: string }
  | {
      eventType: 'GIT_PUSH_COMPLETED'
      taskId: string
      status: 'COMPLETED'
      commitSha: string
      pushSha: string
    }
  | { eventType: 'HUMAN_REQUIRED'; taskId: string; status: 'SUSPENDED'; safeMessage: string }
  | {
      eventType: 'SESSION_COMPLETED'
      status: 'COMPLETED'
      completionReason: WorkSessionCompletionReason
    }
  | {
      eventType: 'SESSION_FAILED'
      status: 'FAILED'
      failureStage: WorkSessionFailureStage
      failureCategory: WorkSessionFailureCategory
      safeMessage: string
      commitSha?: string
    }
  | {
      eventType: 'NOTIFICATION_SENT' | 'NOTIFICATION_FAILED'
      status: 'SENT' | 'FAILED'
      notificationKind: ExecutionLedgerNotificationKind
      notificationId: string
      safeMessage?: string
    }
)

export type ExecutionLedgerEvent = ExecutionLedgerEventInput & {
  eventId: number
  schemaVersion: typeof EXECUTION_LEDGER_SCHEMA_VERSION
}

type SqlValue = null | number | bigint | string | Uint8Array
type SqlRow = Record<string, SqlValue>

export function executionLedgerPathFromStorageUrl(storageUrl: string): string {
  if (!storageUrl.startsWith('file:')) {
    throw new Error('Execution Ledger requires a local file: storage URL')
  }
  return `${fileURLToPath(storageUrl)}.execution-ledger.sqlite`
}

export class ExecutionLedgerStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(storageUrl: string) {
    const databasePath = executionLedgerPathFromStorageUrl(storageUrl)
    mkdirSync(dirname(databasePath), { recursive: true })
    this.#database = new DatabaseSync(databasePath)
    this.#database.exec('PRAGMA journal_mode = WAL')
    this.#database.exec('PRAGMA synchronous = FULL')
    this.#database.exec('PRAGMA busy_timeout = 250')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS execution_ledger_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        task_id TEXT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT,
        phase TEXT,
        iteration INTEGER,
        duration_ms INTEGER,
        active_elapsed_ms INTEGER,
        commit_sha TEXT,
        push_sha TEXT,
        completion_reason TEXT,
        failure_stage TEXT,
        failure_category TEXT,
        safe_message TEXT,
        notification_kind TEXT,
        notification_id TEXT,
        UNIQUE(session_id, dedupe_key)
      ) STRICT
    `)
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS execution_ledger_session_order
      ON execution_ledger_events(session_id, event_id)
    `)
  }

  append(input: ExecutionLedgerEventInput, dedupeKey: string): ExecutionLedgerEvent {
    this.#assertOpen()
    this.#database.prepare(`
      INSERT OR IGNORE INTO execution_ledger_events (
        schema_version, session_id, dedupe_key, task_id, timestamp, event_type,
        status, phase, iteration, duration_ms, active_elapsed_ms, commit_sha,
        push_sha, completion_reason, failure_stage, failure_category, safe_message,
        notification_kind, notification_id
      ) VALUES (
        $schemaVersion, $sessionId, $dedupeKey, $taskId, $timestamp, $eventType,
        $status, $phase, $iteration, $durationMs, $activeElapsedMs, $commitSha,
        $pushSha, $completionReason, $failureStage, $failureCategory, $safeMessage,
        $notificationKind, $notificationId
      )
    `).run({
      schemaVersion: EXECUTION_LEDGER_SCHEMA_VERSION,
      sessionId: input.sessionId,
      dedupeKey,
      taskId: input.taskId,
      timestamp: input.timestamp,
      eventType: input.eventType,
      status: 'status' in input ? input.status : null,
      phase: 'phase' in input ? input.phase : null,
      iteration: 'iteration' in input ? input.iteration : null,
      durationMs: 'durationMs' in input ? input.durationMs ?? null : null,
      activeElapsedMs: input.activeElapsedMs ?? null,
      commitSha: 'commitSha' in input ? input.commitSha ?? null : null,
      pushSha: 'pushSha' in input ? input.pushSha : null,
      completionReason: 'completionReason' in input ? input.completionReason : null,
      failureStage: 'failureStage' in input ? input.failureStage : null,
      failureCategory: 'failureCategory' in input ? input.failureCategory : null,
      safeMessage: 'safeMessage' in input && input.safeMessage !== undefined
        ? safeFailureMessage(input.safeMessage)
        : null,
      notificationKind: 'notificationKind' in input ? input.notificationKind : null,
      notificationId: 'notificationId' in input ? input.notificationId : null,
    })
    const row = this.#database.prepare(`
      SELECT * FROM execution_ledger_events
      WHERE session_id = ? AND dedupe_key = ?
    `).get(input.sessionId, dedupeKey) as SqlRow | undefined
    if (row === undefined) throw new Error('Execution Ledger append did not persist an event')
    return rowToExecutionLedgerEvent(row)
  }

  read(sessionId: string): readonly ExecutionLedgerEvent[] {
    this.#assertOpen()
    const rows = this.#database.prepare(`
      SELECT * FROM execution_ledger_events
      WHERE session_id = ?
      ORDER BY event_id ASC
    `).all(sessionId) as SqlRow[]
    return rows.map(rowToExecutionLedgerEvent)
  }

  close(): void {
    if (!this.#closed) this.#database.close()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Execution Ledger store is closed')
  }
}

export function readExecutionLedger(
  storageUrl: string,
  sessionId: string,
): readonly ExecutionLedgerEvent[] {
  const store = new ExecutionLedgerStore(storageUrl)
  try {
    return store.read(sessionId)
  } finally {
    store.close()
  }
}

function rowToExecutionLedgerEvent(row: SqlRow): ExecutionLedgerEvent {
  const base = {
    eventId: requiredNumber(row, 'event_id'),
    schemaVersion: requiredNumber(row, 'schema_version') as typeof EXECUTION_LEDGER_SCHEMA_VERSION,
    sessionId: requiredString(row, 'session_id'),
    taskId: optionalString(row, 'task_id'),
    timestamp: requiredString(row, 'timestamp'),
    eventType: requiredString(row, 'event_type') as ExecutionLedgerEventType,
    ...(optionalNumber(row, 'active_elapsed_ms') === null
      ? {}
      : { activeElapsedMs: optionalNumber(row, 'active_elapsed_ms')! }),
  }
  const optional = {
    ...(optionalString(row, 'status') === null ? {} : { status: optionalString(row, 'status')! }),
    ...(optionalString(row, 'phase') === null ? {} : { phase: optionalString(row, 'phase')! }),
    ...(optionalNumber(row, 'iteration') === null ? {} : { iteration: optionalNumber(row, 'iteration')! }),
    ...(optionalNumber(row, 'duration_ms') === null ? {} : { durationMs: optionalNumber(row, 'duration_ms')! }),
    ...(optionalString(row, 'commit_sha') === null ? {} : { commitSha: optionalString(row, 'commit_sha')! }),
    ...(optionalString(row, 'push_sha') === null ? {} : { pushSha: optionalString(row, 'push_sha')! }),
    ...(optionalString(row, 'completion_reason') === null ? {} : { completionReason: optionalString(row, 'completion_reason')! }),
    ...(optionalString(row, 'failure_stage') === null ? {} : { failureStage: optionalString(row, 'failure_stage')! }),
    ...(optionalString(row, 'failure_category') === null ? {} : { failureCategory: optionalString(row, 'failure_category')! }),
    ...(optionalString(row, 'safe_message') === null ? {} : { safeMessage: optionalString(row, 'safe_message')! }),
    ...(optionalString(row, 'notification_kind') === null ? {} : { notificationKind: optionalString(row, 'notification_kind')! }),
    ...(optionalString(row, 'notification_id') === null ? {} : { notificationId: optionalString(row, 'notification_id')! }),
  }
  return { ...base, ...optional } as ExecutionLedgerEvent
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`invalid Execution Ledger string column ${key}`)
  return value
}

function optionalString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`invalid Execution Ledger nullable string column ${key}`)
  return value
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`invalid Execution Ledger integer column ${key}`)
  }
  return value
}

function optionalNumber(row: SqlRow, key: string): number | null {
  const value = row[key]
  if (value === null) return null
  return requiredNumber(row, key)
}
