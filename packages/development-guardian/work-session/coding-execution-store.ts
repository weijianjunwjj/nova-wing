import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { CodingExecutionMetadata } from '../coding-executor-config.js'
import type { ClassifiedCodexError } from '../codex-error.js'
import type { ExecutorHandoffContext } from '../executor-router.js'

export interface CodexAvailability {
  state: 'available' | 'quota_exhausted' | 'unknown'
  lastQuotaErrorAt?: string
  blockedUntil?: string
  nextProbeAt?: string
}

export interface CodingExecutorEvent {
  type: 'executor_started' | 'codex_thread_started' | 'codex_thread_resumed' |
    'codex_thread_replaced' | 'executor_failed_over' | 'executor_completed' | 'executor_error'
    | 'executor_ownership_recovered'
  timestamp: string
  executor?: 'codex' | 'deepseek'
  from?: 'codex'
  to?: 'deepseek'
  reason?: string
  codexThreadId?: string
}

/** Local metadata/ownership only; Task lifecycle stays in WorkSessionRuntime. */
export class CodingExecutionStore {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.withDb((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS coding_execution (
        task_key TEXT PRIMARY KEY, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coding_executor_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT NOT NULL, event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coding_executor_handoff (
        task_key TEXT PRIMARY KEY, context TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coding_workspace_lease (
        workspace TEXT PRIMARY KEY, task_key TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_availability (
        id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL
      );
    `))
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path)
    try { db.exec('PRAGMA busy_timeout = 5000'); return operation(db) } finally { db.close() }
  }

  read(key: string): CodingExecutionMetadata | undefined {
    return this.withDb((db) => {
      const row = db.prepare('SELECT metadata FROM coding_execution WHERE task_key=?').get(key)
      return row === undefined ? undefined : JSON.parse(String(row.metadata)) as CodingExecutionMetadata
    })
  }

  save(key: string, metadata: CodingExecutionMetadata, event?: CodingExecutorEvent, handoff?: ExecutorHandoffContext): void {
    this.withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('INSERT INTO coding_execution VALUES (?,?) ON CONFLICT(task_key) DO UPDATE SET metadata=excluded.metadata')
          .run(key, JSON.stringify(metadata))
        if (event !== undefined) db.prepare('INSERT INTO coding_executor_event(task_key,event) VALUES (?,?)')
          .run(key, JSON.stringify(event))
        if (handoff !== undefined) db.prepare('INSERT INTO coding_executor_handoff VALUES (?,?) ON CONFLICT(task_key) DO UPDATE SET context=excluded.context')
          .run(key, JSON.stringify(handoff))
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
  }

  handoff(key: string): ExecutorHandoffContext | undefined {
    return this.withDb((db) => {
      const row = db.prepare('SELECT context FROM coding_executor_handoff WHERE task_key=?').get(key)
      return row === undefined ? undefined : JSON.parse(String(row.context)) as ExecutorHandoffContext
    })
  }

  events(key: string): CodingExecutorEvent[] {
    return this.withDb((db) => db.prepare('SELECT event FROM coding_executor_event WHERE task_key=? ORDER BY id').all(key)
      .map((r) => JSON.parse(String(r.event)) as CodingExecutorEvent))
  }

  availability(): CodexAvailability {
    return this.withDb((db) => {
      const row = db.prepare('SELECT state FROM codex_availability WHERE id=1').get()
      return row === undefined ? { state: 'unknown' } : JSON.parse(String(row.state)) as CodexAvailability
    })
  }

  markAvailable(): void { this.saveAvailability({ state: 'available' }) }

  markQuota(error: ClassifiedCodexError, now: number, cooldownMs: number): void {
    this.saveAvailability({ state: 'quota_exhausted', lastQuotaErrorAt: new Date(now).toISOString(),
      ...(error.blockedUntil === undefined
        ? { nextProbeAt: new Date(now + cooldownMs).toISOString() }
        : { blockedUntil: error.blockedUntil }) })
  }

  private saveAvailability(state: CodexAvailability): void {
    this.withDb((db) => db.prepare('INSERT INTO codex_availability VALUES (1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state')
      .run(JSON.stringify(state)))
  }

  /** No expiry/PID-based theft: a dead parent is not proof that its CLI child stopped writing. */
  acquire(workspace: string, taskKey: string): () => void {
    const owner = randomUUID()
    const acquired = this.withDb((db) => db.prepare('INSERT OR IGNORE INTO coding_workspace_lease VALUES (?,?,?,?)')
      .run(workspace, taskKey, owner, process.pid).changes === 1)
    if (!acquired) throw new Error('Executor ownership unavailable; confirm the previous local writer has stopped before recovery')
    return () => this.withDb((db) => {
      db.prepare('DELETE FROM coding_workspace_lease WHERE workspace=? AND owner=?').run(workspace, owner)
    })
  }

  /** Explicit operator recovery only: release the exact Task's retained workspace lease. */
  recoverOwnership(workspace: string, taskKey: string): boolean {
    return this.withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const removed = db.prepare(
          'DELETE FROM coding_workspace_lease WHERE workspace=? AND task_key=?',
        ).run(workspace, taskKey).changes === 1
        if (removed) {
          db.prepare('INSERT INTO coding_executor_event(task_key,event) VALUES (?,?)').run(
            taskKey,
            JSON.stringify({
              type: 'executor_ownership_recovered',
              timestamp: new Date().toISOString(),
              reason: 'verified_transient_provider_recovery',
            } satisfies CodingExecutorEvent),
          )
        }
        db.exec('COMMIT')
        return removed
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    })
  }
}
