import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createNovaWingFacade, NovaWingError } from 'nova-wing/core'
import {
  createInjectedSqliteNovaWingStore,
  migrateNovaWing,
  openSqliteNovaWingStore,
} from 'nova-wing/sqlite'

import { createTestWorkspace, manualSetInput } from './helpers.js'

function hasCode(code: NovaWingError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof NovaWingError && error.code === code
}

test('owned connection is closed exactly once and repeated close is stable', (t) => {
  const workspace = createTestWorkspace(t)
  const store = workspace.track(
    openSqliteNovaWingStore({ databasePath: workspace.databasePath }),
  )
  assert.equal(store.connectionOwnership, 'owned')

  store.close()
  assert.doesNotThrow(() => store.close())
  assert.throws(() => store.getCurrentCoreRevision(), hasCode('STORE_NOT_INITIALIZED'))

  const movedPath = `${workspace.databasePath}.moved`
  renameSync(workspace.databasePath, movedPath)
  renameSync(movedPath, workspace.databasePath)
})

test('injected connection remains open after its NovaWing wrapper closes', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))
  const store = workspace.track(
    createInjectedSqliteNovaWingStore({ connection, migrationMode: 'apply' }),
  )
  assert.equal(store.connectionOwnership, 'injected')

  store.close()
  store.close()

  assert.equal(connection.isOpen, true)
  assert.equal(
    (
      connection
        .prepare("SELECT integer_value FROM nw_meta WHERE key = 'schema_version'")
        .get() as { integer_value: number }
    ).integer_value,
    1,
  )
  assert.throws(() => store.getCurrentCoreRevision(), hasCode('STORE_NOT_INITIALIZED'))
})

test('injected connection requires an explicit migration policy', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))

  assert.throws(
    () => createInjectedSqliteNovaWingStore({ connection, migrationMode: 'validate' }),
    hasCode('STORE_NOT_INITIALIZED'),
  )

  const migrated = workspace.track(
    createInjectedSqliteNovaWingStore({ connection, migrationMode: 'apply' }),
  )
  migrated.close()
  const validated = workspace.track(
    createInjectedSqliteNovaWingStore({ connection, migrationMode: 'validate' }),
  )
  assert.equal(validated.getCurrentCoreRevision(), 0)
})

test('NovaWing refuses an external transaction without committing or rolling it back', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))
  const store = workspace.track(
    createInjectedSqliteNovaWingStore({ connection, migrationMode: 'apply' }),
  )
  const facade = createNovaWingFacade(store)
  connection.exec('CREATE TABLE host_fixture (id TEXT PRIMARY KEY)')
  connection.exec('BEGIN IMMEDIATE')
  connection.prepare('INSERT INTO host_fixture (id) VALUES (?)').run('host-row')

  assert.throws(
    () => facade.createProposal(manualSetInput()),
    hasCode('TRANSACTION_OWNERSHIP_CONFLICT'),
  )
  assert.equal(connection.isTransaction, true)
  assert.equal(
    (connection.prepare('SELECT COUNT(*) AS count FROM host_fixture').get() as { count: number })
      .count,
    1,
  )

  connection.exec('ROLLBACK')
  assert.equal(
    (connection.prepare('SELECT COUNT(*) AS count FROM host_fixture').get() as { count: number })
      .count,
    0,
  )
  assert.equal(facade.createProposal(manualSetInput()).status, 'draft')
})

test('migration refuses an external transaction and preserves host-owned work', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))
  connection.exec('CREATE TABLE host_fixture (id TEXT PRIMARY KEY)')
  connection.exec('BEGIN IMMEDIATE')
  connection.prepare('INSERT INTO host_fixture (id) VALUES (?)').run('host-row')

  assert.throws(() => migrateNovaWing(connection), hasCode('TRANSACTION_OWNERSHIP_CONFLICT'))
  assert.equal(connection.isTransaction, true)
  assert.equal(
    (
      connection
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'nw_%'")
        .get() as { count: number }
    ).count,
    0,
  )

  connection.exec('ROLLBACK')
  assert.equal(
    (connection.prepare('SELECT COUNT(*) AS count FROM host_fixture').get() as { count: number })
      .count,
    0,
  )
})

test('migration failure has a stable error and rolls back partial NovaWing schema', (t) => {
  const workspace = createTestWorkspace(t)
  const connection = workspace.track(new DatabaseSync(workspace.databasePath))
  connection.exec('CREATE TABLE nw_meta (key TEXT PRIMARY KEY)')

  assert.throws(
    () => createInjectedSqliteNovaWingStore({ connection, migrationMode: 'apply' }),
    hasCode('MIGRATION_FAILED'),
  )
  assert.equal(connection.isTransaction, false)
  const tables = connection
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'nw_%'")
    .all()
    .map((row) => row.name)
  assert.deepEqual(tables, ['nw_meta'])
})
