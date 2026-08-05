import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { NovaWingError } from 'nova-wing/core'
import {
  INITIAL_SCHEMA_SQL,
  NOVAWING_SCHEMA_VERSION,
} from './001-initial.js'
import { NOVAWING_AUTHORITATIVE_TABLE_NAMES } from '../snapshot/registry.js'

interface IntegerRow {
  integer_value: number
}

function hasActiveTransaction(database: DatabaseSync): boolean {
  return database.isTransaction
}

function readIntegerValue(database: DatabaseSync, key: string): number | null {
  const row = database
    .prepare('SELECT integer_value FROM nw_meta WHERE key = $key')
    .get({ key }) as IntegerRow | undefined
  return row?.integer_value ?? null
}

export function migrateNovaWing(database: DatabaseSync): void {
  if (hasActiveTransaction(database)) {
    throw new NovaWingError(
      'TRANSACTION_OWNERSHIP_CONFLICT',
      'NovaWing migration requires an idle SQLite connection',
    )
  }
  database.exec('PRAGMA foreign_keys = ON')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(INITIAL_SCHEMA_SQL)
    const now = '1970-01-01T00:00:00.000Z'
    database
      .prepare(`
        INSERT OR IGNORE INTO nw_meta (key, integer_value, text_value, updated_at)
        VALUES ($key, $value, NULL, $updatedAt)
      `)
      .run({ key: 'current_core_revision', value: 0, updatedAt: now })
    database
      .prepare(`
        INSERT OR IGNORE INTO nw_meta (key, integer_value, text_value, updated_at)
        VALUES ($key, $value, NULL, $updatedAt)
      `)
      .run({ key: 'schema_version', value: NOVAWING_SCHEMA_VERSION, updatedAt: now })

    const schemaVersion = readIntegerValue(database, 'schema_version')
    if (schemaVersion !== NOVAWING_SCHEMA_VERSION) {
      throw new NovaWingError(
        'STORE_NOT_INITIALIZED',
        `unsupported NovaWing schema version ${String(schemaVersion)}`,
      )
    }
    database.exec('COMMIT')
  } catch (error: unknown) {
    if (hasActiveTransaction(database)) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The original migration error is more useful than a rollback error.
      }
    }
    if (
      error instanceof NovaWingError &&
      error.code === 'TRANSACTION_OWNERSHIP_CONFLICT'
    ) {
      throw error
    }
    throw new NovaWingError('MIGRATION_FAILED', 'NovaWing migration failed', { cause: error })
  }
}

export function verifyNovaWingConsistency(database: DatabaseSync): void {
  const tableRows = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'nw_%'
      ORDER BY name
    `)
    .all() as { name: string }[]
  const actualTables = tableRows.map((row) => row.name)
  const expectedTables = [...NOVAWING_AUTHORITATIVE_TABLE_NAMES].sort()
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new NovaWingError(
      'STORE_NOT_INITIALIZED',
      `unexpected NovaWing table set: ${actualTables.join(', ')}`,
    )
  }

  const schemaVersion = readIntegerValue(database, 'schema_version')
  const currentRevision = readIntegerValue(database, 'current_core_revision')
  const revisionRow = database
    .prepare(`
      SELECT COUNT(*) AS entry_count, COALESCE(MAX(core_revision), 0) AS maximum_revision
      FROM nw_mainline_entries
    `)
    .get() as { entry_count: number; maximum_revision: number }

  if (schemaVersion !== NOVAWING_SCHEMA_VERSION) {
    throw new NovaWingError('STORE_NOT_INITIALIZED', 'NovaWing schema version is invalid')
  }
  if (
    currentRevision === null ||
    currentRevision !== revisionRow.maximum_revision ||
    currentRevision !== revisionRow.entry_count
  ) {
    throw new NovaWingError(
      'STORE_NOT_INITIALIZED',
      'current_core_revision is inconsistent with append-only entries',
    )
  }

  const orphan = database
    .prepare(`
      SELECT 1 AS invalid
      FROM nw_mainline_entries AS entry
      WHERE NOT EXISTS (
        SELECT 1
        FROM nw_proposals AS proposal
        WHERE proposal.id = entry.source_proposal_id
          AND proposal.status = 'approved'
          AND proposal.applied_core_revision = entry.core_revision
      )
      LIMIT 1
    `)
    .get()
  if (orphan !== undefined) {
    throw new NovaWingError(
      'STORE_NOT_INITIALIZED',
      'a mainline entry has no matching approved proposal',
    )
  }
}

export function getNovaWingSchemaFingerprint(database: DatabaseSync): string {
  const rows = database
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE name LIKE 'nw_%'
      ORDER BY type, name
    `)
    .all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

export interface NovaWingMigrationDescriptor {
  authoritativeTables: readonly string[]
  fingerprint: string
  schemaVersion: number
}

export function inspectNovaWingMigration(database: DatabaseSync): NovaWingMigrationDescriptor {
  verifyNovaWingConsistency(database)
  return {
    authoritativeTables: [...NOVAWING_AUTHORITATIVE_TABLE_NAMES],
    fingerprint: getNovaWingSchemaFingerprint(database),
    schemaVersion: NOVAWING_SCHEMA_VERSION,
  }
}

export { NOVAWING_SCHEMA_VERSION } from './001-initial.js'
