import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createNovaWingFacade } from 'nova-wing/core'
import {
  NOVAWING_AUTHORITATIVE_TABLES,
  NovaWingSnapshotError,
  createInjectedSqliteNovaWingStore,
  migrateNovaWing,
  validateNovaWingSnapshotManifest,
  verifyNovaWingAfterSnapshotRestore,
  verifyNovaWingBeforeSnapshotExport,
} from 'nova-wing/sqlite'

import { createHarness, createTestWorkspace, manualSetInput } from './helpers.js'

type SqlValue = null | number | bigint | string | Uint8Array
type SnapshotRows = Readonly<Record<string, readonly Record<string, SqlValue>[]>>

function hasSnapshotCode(
  code: NovaWingSnapshotError['code'],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof NovaWingSnapshotError && error.code === code
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function readSnapshotRows(database: DatabaseSync): SnapshotRows {
  return Object.fromEntries(
    NOVAWING_AUTHORITATIVE_TABLES.map((descriptor) => {
      const orderBy = descriptor.restoreOrderBy.map(quoteIdentifier).join(', ')
      const rows = database
        .prepare(
          `SELECT * FROM ${quoteIdentifier(descriptor.name)} ORDER BY ${orderBy}`,
        )
        .all() as Record<string, SqlValue>[]
      return [descriptor.name, rows]
    }),
  )
}

function restoreSnapshotRows(database: DatabaseSync, snapshotRows: SnapshotRows): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('PRAGMA defer_foreign_keys = ON')
    for (const descriptor of [...NOVAWING_AUTHORITATIVE_TABLES].reverse()) {
      database.exec(`DELETE FROM ${quoteIdentifier(descriptor.name)}`)
    }
    for (const descriptor of NOVAWING_AUTHORITATIVE_TABLES) {
      for (const row of snapshotRows[descriptor.name] ?? []) {
        const columns = Object.keys(row)
        const columnList = columns.map(quoteIdentifier).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        database
          .prepare(
            `INSERT INTO ${quoteIdentifier(descriptor.name)} (${columnList}) VALUES (${placeholders})`,
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

test('Snapshot V3 host fixture restores authoritative data and continues revisions', (t) => {
  const workspace = createTestWorkspace(t)
  const sourceSetup = createHarness(workspace, 'snapshot-source')
  const approved = sourceSetup.facade.createPendingProposal(manualSetInput())
  sourceSetup.facade.approveProposal({ proposalId: approved.id })
  sourceSetup.facade.createPendingProposal(
    manualSetInput({
      memoryKey: 'global.pending_memory',
      proposedStatement: '仍在等待用户审核。',
    }),
  )
  const rejected = sourceSetup.facade.createPendingProposal(
    manualSetInput({
      memoryKey: 'career.rejected_memory',
      scope: 'career',
      proposedStatement: '不会进入正式主线。',
    }),
  )
  sourceSetup.facade.rejectProposal({ proposalId: rejected.id, reviewNote: '用户拒绝' })
  sourceSetup.facade.createProposal(
    manualSetInput({
      memoryKey: 'global.draft_memory',
      proposedStatement: '尚未提交的草稿。',
    }),
  )
  sourceSetup.store.close()

  const sourceConnection = workspace.track(new DatabaseSync(workspace.databasePath))
  const manifest = verifyNovaWingBeforeSnapshotExport(sourceConnection)
  const snapshotRows = readSnapshotRows(sourceConnection)

  const restoredPath = `${workspace.databasePath}.restored`
  const restoredConnection = workspace.track(new DatabaseSync(restoredPath))
  migrateNovaWing(restoredConnection)
  restoreSnapshotRows(restoredConnection, snapshotRows)
  verifyNovaWingAfterSnapshotRestore(restoredConnection, manifest)

  const sourceStore = workspace.track(
    createInjectedSqliteNovaWingStore({
      connection: sourceConnection,
      migrationMode: 'validate',
    }),
  )
  const restoredStore = workspace.track(
    createInjectedSqliteNovaWingStore({
      connection: restoredConnection,
      migrationMode: 'validate',
    }),
  )
  const sourceFacade = createNovaWingFacade(sourceStore)
  const restoredFacade = createNovaWingFacade(restoredStore)

  assert.deepEqual(restoredFacade.listCurrentMainline(), sourceFacade.listCurrentMainline())
  assert.deepEqual(restoredFacade.listProposals(), sourceFacade.listProposals())
  assert.equal(restoredFacade.getCurrentCoreRevision(), 1)

  const nextProposal = restoredFacade.createPendingProposal(
    manualSetInput({
      memoryKey: 'global.after_restore',
      proposedStatement: '恢复后继续推进。',
    }),
  )
  assert.equal(
    restoredFacade.approveProposal({ proposalId: nextProposal.id }).coreRevision,
    2,
  )
  assert.equal(restoredFacade.getCurrentCoreRevision(), 2)
})

test('Snapshot manifest rejects unknown versions and corrupted source invariants', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))
  migrateNovaWing(connection)
  const manifest = verifyNovaWingBeforeSnapshotExport(connection)

  assert.throws(
    () => validateNovaWingSnapshotManifest({ ...manifest, snapshotVersion: 2 }),
    hasSnapshotCode('SNAPSHOT_MANIFEST_INVALID'),
  )

  connection
    .prepare("UPDATE nw_meta SET integer_value = 7 WHERE key = 'current_core_revision'")
    .run()
  assert.throws(
    () => verifyNovaWingBeforeSnapshotExport(connection),
    hasSnapshotCode('SNAPSHOT_INVARIANT_VIOLATION'),
  )
})

test('post-restore validation rejects a missing authoritative table', (t) => {
  const workspace = createTestWorkspace(t)
  const source = workspace.track(new DatabaseSync(workspace.databasePath))
  migrateNovaWing(source)
  const manifest = verifyNovaWingBeforeSnapshotExport(source)
  const incomplete = workspace.track(new DatabaseSync(`${workspace.databasePath}.incomplete`))
  migrateNovaWing(incomplete)
  incomplete.exec('DROP TABLE nw_mainline_entries')

  assert.throws(
    () => verifyNovaWingAfterSnapshotRestore(incomplete, manifest),
    hasSnapshotCode('SNAPSHOT_INVARIANT_VIOLATION'),
  )
})
