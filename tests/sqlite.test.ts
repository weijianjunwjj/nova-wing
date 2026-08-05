import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createNovaWingFacade, NovaWingError } from 'nova-wing/core'
import {
  createInjectedSqliteNovaWingStore,
  inspectNovaWingMigration,
  migrateNovaWing,
  openSqliteNovaWingStore,
} from 'nova-wing/sqlite'
import { createHarness, createPending, createTestWorkspace, manualSetInput } from './helpers.js'

function hasCode(code: NovaWingError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof NovaWingError && error.code === code
}

test('migration is repeatable and has a deterministic schema fingerprint', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(new DatabaseSync(workspace.databasePath))

  migrateNovaWing(database)
  const firstMigration = inspectNovaWingMigration(database)
  migrateNovaWing(database)
  const secondMigration = inspectNovaWingMigration(database)

  assert.equal(secondMigration.fingerprint, firstMigration.fingerprint)
  const tables = database
    .prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'nw_%'
      ORDER BY name
    `)
    .all()
  assert.deepEqual(
    tables.map((row) => row.name),
    ['nw_mainline_entries', 'nw_meta', 'nw_proposals'],
  )
})

test('first approved proposal creates the first mainline and revision', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'first')
  const proposalId = createPending(facade)

  assert.deepEqual(facade.getContext({ scopes: ['global', 'career'] }), {
    coreRevision: 0,
    entries: [],
  })
  const approval = facade.approveProposal({ proposalId })
  const mainline = facade.listCurrentMainline()

  assert.equal(approval.coreRevision, 1)
  assert.equal(mainline.coreRevision, 1)
  assert.equal(mainline.entries.length, 1)
  assert.equal(mainline.entries[0]?.sourceProposalId, proposalId)
  assert.equal(facade.getEntrySource(approval.entryId)?.proposal.id, proposalId)
})

test('revision increases monotonically once per committed approval', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'revision')
  const revisions = [
    manualSetInput(),
    manualSetInput({
      memoryKey: 'global.product_priority',
      category: 'priority',
      proposedStatement: '优先完成可验证的独立内核。',
    }),
    manualSetInput({
      memoryKey: 'career.job_selection_priority',
      category: 'priority',
      scope: 'career',
      proposedStatement: '岗位选择遵循长期可持续原则。',
    }),
  ].map((input) => {
    const proposalId = createPending(facade, input)
    return facade.approveProposal({ proposalId }).coreRevision
  })

  assert.deepEqual(revisions, [1, 2, 3])
  assert.equal(facade.getCurrentCoreRevision(), 3)
})

test('approval failure after entry insert rolls back entry, proposal, and revision', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(new DatabaseSync(workspace.databasePath))
  const store = workspace.track(
    createInjectedSqliteNovaWingStore({ connection: database, migrationMode: 'apply' }),
  )
  let sequence = 0
  const facade = createNovaWingFacade(store, {
    clock: () => '2026-01-01T00:00:00.000Z',
    generateId: () => `rollback-${String(++sequence)}`,
  })
  const proposalId = createPending(facade)
  database.exec(`
    CREATE TEMP TRIGGER nw_test_fail_revision
    BEFORE UPDATE OF integer_value ON nw_meta
    WHEN OLD.key = 'current_core_revision'
    BEGIN
      SELECT RAISE(ABORT, 'injected revision failure');
    END;
  `)

  assert.throws(
    () => facade.approveProposal({ proposalId }),
    hasCode('TRANSACTION_FAILED'),
  )
  assert.equal(facade.getProposal(proposalId)?.status, 'pending')
  assert.deepEqual(facade.listCurrentMainline(), { coreRevision: 0, entries: [] })
  const entryCount = database
    .prepare('SELECT COUNT(*) AS count FROM nw_mainline_entries')
    .get() as { count: number }
  assert.equal(entryCount.count, 0)

  database.exec('DROP TRIGGER nw_test_fail_revision')
  assert.equal(facade.approveProposal({ proposalId }).coreRevision, 1)
})

test('append-only mainline entries reject direct update and delete', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'immutable')
  const proposalId = createPending(facade)
  const { entryId } = facade.approveProposal({ proposalId })
  const inspector = workspace.track(new DatabaseSync(workspace.databasePath))

  assert.throws(() =>
    inspector
      .prepare('UPDATE nw_mainline_entries SET statement = $statement WHERE id = $entryId')
      .run({ statement: 'mutated', entryId }),
  )
  assert.throws(() =>
    inspector.prepare('DELETE FROM nw_mainline_entries WHERE id = $entryId').run({ entryId }),
  )
})

test('deprecate is append-only and removes the key from current projection', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'deprecate')
  const setId = createPending(facade)
  facade.approveProposal({ proposalId: setId })
  const deprecateId = createPending(
    facade,
    manualSetInput({ action: 'deprecate', proposedStatement: null }),
  )
  facade.approveProposal({ proposalId: deprecateId })

  assert.deepEqual(facade.listCurrentMainline(), { coreRevision: 2, entries: [] })
})

test('stale proposal cannot overwrite a key changed after submission', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'stale')
  const firstId = createPending(facade)
  const staleId = createPending(
    facade,
    manualSetInput({ proposedStatement: '另一条同时提交的建议。' }),
  )
  facade.approveProposal({ proposalId: firstId })

  assert.throws(
    () => facade.approveProposal({ proposalId: staleId }),
    hasCode('STALE_PROPOSAL'),
  )
  assert.equal(facade.getCurrentCoreRevision(), 1)
})

test('state is recovered after closing and reopening the database', (t) => {
  const workspace = createTestWorkspace(t)
  const first = createHarness(workspace, 'restart-a')
  const proposalId = createPending(first.facade)
  first.facade.approveProposal({ proposalId })
  first.store.close()

  const reopened = createHarness(workspace, 'restart-b')
  assert.equal(reopened.facade.getCurrentCoreRevision(), 1)
  assert.equal(reopened.facade.getProposal(proposalId)?.status, 'approved')
  assert.equal(reopened.facade.listCurrentMainline().entries.length, 1)
})

test('independent stores applying the same request produce exactly one entry', async (t) => {
  const workspace = createTestWorkspace(t)
  const first = createHarness(workspace, 'race-a')
  const second = createHarness(workspace, 'race-b')
  const proposalId = createPending(first.facade)

  const results = await Promise.allSettled([
    Promise.resolve().then(() => first.facade.approveProposal({ proposalId })),
    Promise.resolve().then(() => second.facade.approveProposal({ proposalId })),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(first.facade.getCurrentCoreRevision(), 1)
  const inspector = workspace.track(new DatabaseSync(workspace.databasePath))
  const entryCount = inspector
    .prepare('SELECT COUNT(*) AS count FROM nw_mainline_entries')
    .get() as { count: number }
  assert.equal(entryCount.count, 1)
})

test('write lock exhaustion is reported as STORE_BUSY without partial data', (t) => {
  const workspace = createTestWorkspace(t)
  const first = createHarness(workspace, 'busy-a')
  const second = createHarness(workspace, 'busy-b', {
    busyTimeoutMs: 1,
    busyRetries: 1,
    busyRetryDelayMs: 1,
  })
  const locker = workspace.track(new DatabaseSync(workspace.databasePath))
  locker.exec('BEGIN IMMEDIATE')

  assert.throws(
    () => second.facade.createProposal(manualSetInput()),
    hasCode('STORE_BUSY'),
  )
  locker.exec('ROLLBACK')
  assert.equal(first.facade.listProposals().length, 0)
})

test('NovaWing ignores unrelated host tables and has no foreign key to them', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(new DatabaseSync(workspace.databasePath))
  database.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, strategy_window TEXT NOT NULL);
    INSERT INTO jobs VALUES ('job-1', 'host-owned-decoy');
  `)
  const store = workspace.track(
    createInjectedSqliteNovaWingStore({ connection: database, migrationMode: 'apply' }),
  )
  const facade = createNovaWingFacade(store)
  assert.deepEqual(facade.listCurrentMainline(), { coreRevision: 0, entries: [] })

  const foreignTargets = ['nw_meta', 'nw_proposals', 'nw_mainline_entries'].flatMap((table) =>
    (database.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string }[]).map(
      (row) => row.table,
    ),
  )
  assert.ok(foreignTargets.every((table) => table.startsWith('nw_')))
  const jobs = database.prepare('SELECT * FROM jobs').all()
  assert.deepEqual(
    jobs.map((row) => ({ id: row.id, strategy_window: row.strategy_window })),
    [{ id: 'job-1', strategy_window: 'host-owned-decoy' }],
  )
})

test('opening rejects an unregistered nw_ table instead of silently accepting it', (t) => {
  const workspace = createTestWorkspace(t)
  const first = workspace.track(openSqliteNovaWingStore({ databasePath: workspace.databasePath }))
  first.close()
  const database = workspace.track(new DatabaseSync(workspace.databasePath))
  database.exec('CREATE TABLE nw_unregistered (id TEXT PRIMARY KEY)')

  assert.throws(() => inspectNovaWingMigration(database), hasCode('STORE_NOT_INITIALIZED'))
})
