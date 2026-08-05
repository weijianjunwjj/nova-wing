import { DatabaseSync } from 'node:sqlite'

import {
  createComponentSnapshotManifest,
  digestSnapshotValue,
  type ComponentSnapshotManifest,
  type JsonValue,
  type SnapshotComponent,
} from 'nova-wing/host-snapshot'
import { NOVAWING_AUTHORITATIVE_TABLES } from 'nova-wing/sqlite'

type SqlValue = null | number | bigint | string | Uint8Array
export type FixtureRows = Readonly<Record<string, readonly Record<string, SqlValue>[]>>

export const FAKE_HOST_TABLES = ['host_meta', 'host_items'] as const
export const ALL_FIXTURE_TABLES = [
  ...FAKE_HOST_TABLES,
  ...NOVAWING_AUTHORITATIVE_TABLES.map((table) => table.name),
] as const

function requireDatabase(context: unknown): DatabaseSync {
  if (!(context instanceof DatabaseSync)) {
    throw new TypeError('fake host fixture requires DatabaseSync')
  }
  return context
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function normalizedRows(database: DatabaseSync, table: string): JsonValue[] {
  const rows = database
    .prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY 1`)
    .all() as Record<string, SqlValue>[]
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint'
          ? value.toString()
          : value instanceof Uint8Array
            ? Buffer.from(value).toString('base64')
            : value,
      ]),
    ),
  ) as JsonValue[]
}

export function bootstrapFakeHost(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE host_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE host_items (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  database.prepare('INSERT INTO host_meta (key, value) VALUES (?, ?)').run('schema', '1')
  database.prepare('INSERT INTO host_items (id, value) VALUES (?, ?)').run('item-1', 'alpha')
  database.prepare('INSERT INTO host_items (id, value) VALUES (?, ?)').run('item-2', 'beta')
}

export class FakeHostSnapshotComponent implements SnapshotComponent {
  readonly component = 'fake-host'
  readonly owner = 'host'
  readonly format = 'fake-host.snapshot.v1'
  readonly snapshotVersion = 1
  readonly authoritativeTables = FAKE_HOST_TABLES

  verifyBeforeExport(context: unknown): ComponentSnapshotManifest {
    const database = requireDatabase(context)
    return createComponentSnapshotManifest({
      component: this.component,
      format: this.format,
      snapshotVersion: this.snapshotVersion,
      schemaVersion: 1,
      metadata: {},
      tables: this.authoritativeTables.map((name) => {
        const rows = normalizedRows(database, name)
        return {
          name,
          rowCount: rows.length,
          contentDigest: digestSnapshotValue(rows),
        }
      }),
    })
  }

  verifyAfterRestore(context: unknown, manifest: ComponentSnapshotManifest): void {
    const actual = this.verifyBeforeExport(context)
    if (actual.manifestDigest !== manifest.manifestDigest) {
      throw new Error('restored fake host data differs from its manifest')
    }
  }
}

export function readFixtureRows(database: DatabaseSync): FixtureRows {
  return Object.fromEntries(
    ALL_FIXTURE_TABLES.map((table) => [
      table,
      database.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY 1`).all(),
    ]),
  ) as FixtureRows
}

export function restoreFixtureRows(database: DatabaseSync, rows: FixtureRows): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('PRAGMA defer_foreign_keys = ON')
    for (const table of ALL_FIXTURE_TABLES) {
      for (const row of rows[table] ?? []) {
        const columns = Object.keys(row)
        database
          .prepare(
            `INSERT INTO ${quoteIdentifier(table)} (${columns
              .map(quoteIdentifier)
              .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...columns.map((column) => row[column] ?? null))
      }
    }
    database.exec('COMMIT')
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec('ROLLBACK')
    }
    throw error
  }
}
