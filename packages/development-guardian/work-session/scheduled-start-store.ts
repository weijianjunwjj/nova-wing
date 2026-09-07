import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { ScheduleSource } from './schedule-policy.js'

interface ScheduleRow {
  session_id: string
  scheduled_start_at: string
  schedule_source: ScheduleSource
  created_at: string
  status: 'SCHEDULED' | 'CLAIMED' | 'CANCELLED'
  owner_pid: number | null
}

/** One-time execution gate in the existing session DB, not a second task runtime. */
export class ScheduledStartStore {
  private readonly db: DatabaseSync

  constructor(storageUrl: string) {
    const path = fileURLToPath(storageUrl)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS work_session_scheduled_start (
        session_id TEXT PRIMARY KEY,
        scheduled_start_at TEXT NOT NULL,
        schedule_source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'CLAIMED', 'CANCELLED')),
        owner_pid INTEGER
      )`)
  }

  ensure(id: string, at: string, source: ScheduleSource, createdAt: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO work_session_scheduled_start
      (session_id, scheduled_start_at, schedule_source, created_at, status)
      VALUES (?, ?, ?, ?, 'SCHEDULED')`).run(id, at, source, createdAt)
  }

  read(id: string): ScheduleRow | undefined {
    return this.db.prepare('SELECT * FROM work_session_scheduled_start WHERE session_id = ?')
      .get(id) as unknown as ScheduleRow | undefined
  }

  /** Caller must first check that no durable workflow exists. No time-based lease stealing. */
  claim(id: string, now: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.read(id)
      if (row?.status === 'CLAIMED' && row.owner_pid !== null && !isProcessAlive(row.owner_pid)) {
        this.db.prepare(`UPDATE work_session_scheduled_start SET status = 'SCHEDULED', owner_pid = NULL
          WHERE session_id = ? AND status = 'CLAIMED'`).run(id)
      }
      const result = this.db.prepare(`UPDATE work_session_scheduled_start SET status = 'CLAIMED', owner_pid = ?
        WHERE session_id = ? AND status = 'SCHEDULED' AND scheduled_start_at <= ?`).run(process.pid, id, now)
      this.db.exec('COMMIT')
      return result.changes === 1
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  releaseUnstarted(id: string): void {
    this.db.prepare(`UPDATE work_session_scheduled_start SET status = 'SCHEDULED', owner_pid = NULL
      WHERE session_id = ? AND status = 'CLAIMED' AND owner_pid = ?`).run(id, process.pid)
  }

  cancel(id: string): boolean {
    return this.db.prepare(`UPDATE work_session_scheduled_start SET status = 'CANCELLED'
      WHERE session_id = ? AND status = 'SCHEDULED'`).run(id).changes === 1
  }

  close(): void { this.db.close() }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    // Permission errors are not proof that the owner is dead.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
