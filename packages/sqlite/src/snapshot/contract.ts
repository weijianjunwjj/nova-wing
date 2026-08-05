import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { isNovaWingError } from 'nova-wing/core'

import {
  NOVAWING_SCHEMA_VERSION,
  verifyNovaWingConsistency,
} from '../migrations/index.js'
import {
  NOVAWING_AUTHORITATIVE_TABLES,
  type NovaWingAuthoritativeTableName,
} from './registry.js'

export const NOVAWING_SNAPSHOT_VERSION = 3 as const
export const NOVAWING_SNAPSHOT_FORMAT = 'novawing.snapshot.v3' as const

export type NovaWingSnapshotErrorCode =
  | 'SNAPSHOT_MANIFEST_INVALID'
  | 'SNAPSHOT_TRANSACTION_CONFLICT'
  | 'SNAPSHOT_INVARIANT_VIOLATION'

export class NovaWingSnapshotError extends Error {
  readonly code: NovaWingSnapshotErrorCode
  override readonly cause?: unknown

  constructor(
    code: NovaWingSnapshotErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'NovaWingSnapshotError'
    this.code = code
    if (options !== undefined && 'cause' in options) {
      this.cause = options.cause
    }
  }
}

export interface NovaWingSnapshotTableManifest {
  name: NovaWingAuthoritativeTableName
  rowCount: number
  contentDigest: string
}

export interface NovaWingSnapshotManifest {
  format: typeof NOVAWING_SNAPSHOT_FORMAT
  snapshotVersion: typeof NOVAWING_SNAPSHOT_VERSION
  schemaVersion: number
  currentCoreRevision: number
  tables: NovaWingSnapshotTableManifest[]
}

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>

function hasActiveTransaction(database: DatabaseSync): boolean {
  return database.isTransaction
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function readCurrentCoreRevision(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT integer_value FROM nw_meta WHERE key = 'current_core_revision'")
    .get() as { integer_value?: unknown } | undefined
  if (typeof row?.integer_value !== 'number' || !Number.isSafeInteger(row.integer_value)) {
    throw new NovaWingSnapshotError(
      'SNAPSHOT_INVARIANT_VIOLATION',
      'current_core_revision is missing or invalid',
    )
  }
  return row.integer_value
}

function tableManifest(
  database: DatabaseSync,
  descriptor: (typeof NOVAWING_AUTHORITATIVE_TABLES)[number],
): NovaWingSnapshotTableManifest {
  const orderBy = descriptor.primaryKey.map(quoteIdentifier).join(', ')
  const rows = database
    .prepare(
      `SELECT * FROM ${quoteIdentifier(descriptor.name)} ORDER BY ${orderBy}`,
    )
    .all() as SqlRow[]
  return {
    name: descriptor.name,
    rowCount: rows.length,
    contentDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  }
}

function createManifestInsideReadTransaction(database: DatabaseSync): NovaWingSnapshotManifest {
  verifyNovaWingConsistency(database)
  return {
    format: NOVAWING_SNAPSHOT_FORMAT,
    snapshotVersion: NOVAWING_SNAPSHOT_VERSION,
    schemaVersion: NOVAWING_SCHEMA_VERSION,
    currentCoreRevision: readCurrentCoreRevision(database),
    tables: NOVAWING_AUTHORITATIVE_TABLES.map((descriptor) =>
      tableManifest(database, descriptor),
    ),
  }
}

function withSnapshotReadTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (hasActiveTransaction(database)) {
    throw new NovaWingSnapshotError(
      'SNAPSHOT_TRANSACTION_CONFLICT',
      'Snapshot validation requires an idle SQLite connection',
    )
  }
  try {
    database.exec('BEGIN')
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error: unknown) {
    if (hasActiveTransaction(database)) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the validation error that caused the rollback.
      }
    }
    if (error instanceof NovaWingSnapshotError) {
      throw error
    }
    throw new NovaWingSnapshotError(
      'SNAPSHOT_INVARIANT_VIOLATION',
      isNovaWingError(error)
        ? `NovaWing invariant failed before snapshot: ${error.message}`
        : 'NovaWing snapshot validation failed',
      { cause: error },
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function validateNovaWingSnapshotManifest(
  manifest: unknown,
): NovaWingSnapshotManifest {
  if (!isRecord(manifest)) {
    throw new NovaWingSnapshotError('SNAPSHOT_MANIFEST_INVALID', 'manifest must be an object')
  }
  if (
    manifest.format !== NOVAWING_SNAPSHOT_FORMAT ||
    manifest.snapshotVersion !== NOVAWING_SNAPSHOT_VERSION ||
    manifest.schemaVersion !== NOVAWING_SCHEMA_VERSION ||
    typeof manifest.currentCoreRevision !== 'number' ||
    !Number.isSafeInteger(manifest.currentCoreRevision) ||
    manifest.currentCoreRevision < 0 ||
    !Array.isArray(manifest.tables) ||
    manifest.tables.length !== NOVAWING_AUTHORITATIVE_TABLES.length
  ) {
    throw new NovaWingSnapshotError(
      'SNAPSHOT_MANIFEST_INVALID',
      'manifest header or table count is invalid',
    )
  }

  const manifestTables = manifest.tables as unknown[]
  for (const [index, descriptor] of NOVAWING_AUTHORITATIVE_TABLES.entries()) {
    const table = manifestTables[index]
    if (
      !isRecord(table) ||
      table.name !== descriptor.name ||
      typeof table.rowCount !== 'number' ||
      !Number.isSafeInteger(table.rowCount) ||
      table.rowCount < 0 ||
      typeof table.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(table.contentDigest)
    ) {
      throw new NovaWingSnapshotError(
        'SNAPSHOT_MANIFEST_INVALID',
        `manifest table descriptor ${descriptor.name} is invalid`,
      )
    }
  }
  return manifest as unknown as NovaWingSnapshotManifest
}

export function verifyNovaWingBeforeSnapshotExport(
  database: DatabaseSync,
): NovaWingSnapshotManifest {
  return withSnapshotReadTransaction(database, () =>
    createManifestInsideReadTransaction(database),
  )
}

export function verifyNovaWingAfterSnapshotRestore(
  database: DatabaseSync,
  manifest: unknown,
): void {
  const validatedManifest = validateNovaWingSnapshotManifest(manifest)
  const restoredManifest = withSnapshotReadTransaction(database, () =>
    createManifestInsideReadTransaction(database),
  )
  if (JSON.stringify(restoredManifest) !== JSON.stringify(validatedManifest)) {
    throw new NovaWingSnapshotError(
      'SNAPSHOT_INVARIANT_VIOLATION',
      'restored NovaWing data does not match its snapshot manifest',
    )
  }
}
