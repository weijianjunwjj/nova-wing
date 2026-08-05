import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createNovaWingFacade } from 'nova-wing/core'
import {
  HOST_SNAPSHOT_V3_FORMAT,
  HOST_SNAPSHOT_V3_VERSION,
  HostSnapshotError,
  HostSnapshotRegistry,
  createComponentSnapshotManifest,
  createHostSnapshotV3Manifest,
  createNovaWingSnapshotComponent,
  createRegisteredHostSnapshotManifest,
  validateHostSnapshotV3Manifest,
  validateRegisteredHostSnapshotManifest,
  verifyRegisteredComponentsAfterRestore,
  type ComponentSnapshotManifest,
  type SnapshotComponent,
} from 'nova-wing/host-snapshot'
import {
  createInjectedSqliteNovaWingStore,
  migrateNovaWing,
} from 'nova-wing/sqlite'

import {
  FakeHostSnapshotComponent,
  bootstrapFakeHost,
  readFixtureRows,
  restoreFixtureRows,
} from './host-snapshot-fixtures.js'
import { createTestWorkspace, manualSetInput } from './helpers.js'

function hasHostCode(code: HostSnapshotError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HostSnapshotError && error.code === code
}

function createRegistry(): HostSnapshotRegistry {
  const registry = new HostSnapshotRegistry()
  registry.register(new FakeHostSnapshotComponent())
  registry.register(createNovaWingSnapshotComponent())
  return registry
}

function setupDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  bootstrapFakeHost(database)
  migrateNovaWing(database)
  return database
}

function addApprovedProposal(database: DatabaseSync, prefix: string): void {
  const store = createInjectedSqliteNovaWingStore({
    connection: database,
    migrationMode: 'validate',
  })
  let sequence = 0
  const facade = createNovaWingFacade(store, {
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    generateId: () => `${prefix}-${String(++sequence)}`,
  })
  const proposal = facade.createPendingProposal(manualSetInput())
  facade.approveProposal({ proposalId: proposal.id })
  store.close()
}

function createManifest(database: DatabaseSync, registry = createRegistry()) {
  return createRegisteredHostSnapshotManifest({
    registry,
    contexts: new Map([
      ['fake-host', database],
      ['novawing', database],
    ]),
    createdAt: '2026-08-05T08:00:00.000Z',
    host: { name: 'fake-host-app', appVersion: '1.2.3', schemaVersion: 7 },
  })
}

function rebuiltManifestWith(
  manifest: ReturnType<typeof createManifest>,
  components: readonly ComponentSnapshotManifest[],
) {
  return createHostSnapshotV3Manifest({
    createdAt: manifest.createdAt,
    host: manifest.host,
    components,
  })
}

test('combines fake host and NovaWing manifests with order-independent digests', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  addApprovedProposal(database, 'combined')
  const registry = createRegistry()
  const manifest = createManifest(database, registry)
  assert.deepEqual(manifest.components.map((item) => item.component), ['fake-host', 'novawing'])
  assert.equal(manifest.format, HOST_SNAPSHOT_V3_FORMAT)
  assert.equal(manifest.snapshotVersion, HOST_SNAPSHOT_V3_VERSION)
  const reversed = createHostSnapshotV3Manifest({
    createdAt: manifest.createdAt,
    host: manifest.host,
    components: [...manifest.components].reverse().map((component) => ({
      ...component,
      tables: [...component.tables].reverse(),
    })),
  })
  assert.equal(reversed.manifestDigest, manifest.manifestDigest)
})

test('rejects table registration conflicts', () => {
  const registry = new HostSnapshotRegistry()
  const component = new FakeHostSnapshotComponent()
  registry.register(component)
  assert.throws(
    () => registry.register({
      component: 'other-host',
      owner: component.owner,
      format: component.format,
      snapshotVersion: component.snapshotVersion,
      authoritativeTables: component.authoritativeTables,
      verifyBeforeExport: (context) => component.verifyBeforeExport(context),
      verifyAfterRestore: (context, manifest) => component.verifyAfterRestore(context, manifest),
    }),
    hasHostCode('COMPONENT_CONFLICT'),
  )
})

test('rejects host ownership of nw_* tables', () => {
  const component = new FakeHostSnapshotComponent()
  assert.throws(
    () => new HostSnapshotRegistry().register({
      component: component.component,
      owner: component.owner,
      format: component.format,
      snapshotVersion: component.snapshotVersion,
      authoritativeTables: ['nw_meta'],
      verifyBeforeExport: (context) => component.verifyBeforeExport(context),
      verifyAfterRestore: (context, manifest) => component.verifyAfterRestore(context, manifest),
    }),
    hasHostCode('OWNERSHIP_VIOLATION'),
  )
})

test('rejects NovaWing ownership of host tables', () => {
  const component = createNovaWingSnapshotComponent()
  assert.throws(
    () => new HostSnapshotRegistry().register({ ...component, authoritativeTables: ['host_meta'] }),
    hasHostCode('OWNERSHIP_VIOLATION'),
  )
})

test('rejects unknown host format and version', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const manifest = createManifest(database)
  assert.throws(
    () => validateHostSnapshotV3Manifest({ ...manifest, format: 'host.snapshot.v4' }),
    hasHostCode('HOST_MANIFEST_INVALID'),
  )
  assert.throws(
    () => validateHostSnapshotV3Manifest({ ...manifest, snapshotVersion: 4 }),
    hasHostCode('HOST_MANIFEST_INVALID'),
  )
})

test('rejects a tampered host manifest', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const manifest = createManifest(database)
  assert.throws(
    () => validateHostSnapshotV3Manifest({ ...manifest, createdAt: '2026-08-06T00:00:00.000Z' }),
    hasHostCode('HOST_MANIFEST_INVALID'),
  )
})

test('rejects a changed component table row count', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const manifest = createManifest(database)
  const component = manifest.components[0]
  assert.ok(component)
  const table = component.tables[0]
  assert.ok(table)
  assert.throws(
    () => validateHostSnapshotV3Manifest({
      ...manifest,
      components: [{
        ...component,
        tables: [{ ...table, rowCount: table.rowCount + 1 }, ...component.tables.slice(1)],
      }, ...manifest.components.slice(1)],
    }),
    hasHostCode('COMPONENT_MANIFEST_INVALID'),
  )
})

test('rejects changed restored table contents', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const registry = createRegistry()
  const manifest = createManifest(database, registry)
  database.prepare("UPDATE host_items SET value = 'changed' WHERE id = 'item-1'").run()
  assert.throws(
    () => verifyRegisteredComponentsAfterRestore({
      manifest,
      registry,
      contexts: new Map([['fake-host', database], ['novawing', database]]),
    }),
    hasHostCode('COMPONENT_VALIDATION_FAILED'),
  )
})

test('rejects a missing registered component', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const manifest = createManifest(database)
  const registry = new HostSnapshotRegistry()
  registry.register(createNovaWingSnapshotComponent())
  assert.throws(
    () => validateRegisteredHostSnapshotManifest(manifest, registry),
    hasHostCode('UNKNOWN_COMPONENT'),
  )
})

test('rejects an unknown component and registered format revision', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const registry = createRegistry()
  const manifest = createManifest(database, registry)
  const fake = manifest.components.find((component) => component.component === 'fake-host')
  assert.ok(fake)
  const unknown = createComponentSnapshotManifest({ ...fake, component: 'unknown-host' })
  assert.throws(
    () => validateRegisteredHostSnapshotManifest(
      rebuiltManifestWith(manifest, [unknown, ...manifest.components.filter((item) => item !== fake)]),
      registry,
    ),
    hasHostCode('UNKNOWN_COMPONENT'),
  )
  const wrongVersion = createComponentSnapshotManifest({ ...fake, snapshotVersion: 2 })
  assert.throws(
    () => validateRegisteredHostSnapshotManifest(
      rebuiltManifestWith(manifest, [wrongVersion, ...manifest.components.filter((item) => item !== fake)]),
      registry,
    ),
    hasHostCode('COMPONENT_MANIFEST_INVALID'),
  )
})

test('rejects a NovaWing revision mismatch after restore', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  addApprovedProposal(database, 'revision')
  const registry = createRegistry()
  const manifest = createManifest(database, registry)
  database.prepare("UPDATE nw_meta SET integer_value = 0 WHERE key = 'current_core_revision'").run()
  assert.throws(
    () => verifyRegisteredComponentsAfterRestore({
      manifest,
      registry,
      contexts: new Map([['fake-host', database], ['novawing', database]]),
    }),
    hasHostCode('COMPONENT_VALIDATION_FAILED'),
  )
})

test('one component post-restore failure fails the entire validation', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  const fakeHost = new FakeHostSnapshotComponent()
  const failing: SnapshotComponent = {
    component: fakeHost.component,
    owner: fakeHost.owner,
    format: fakeHost.format,
    snapshotVersion: fakeHost.snapshotVersion,
    authoritativeTables: fakeHost.authoritativeTables,
    verifyBeforeExport: (context) => fakeHost.verifyBeforeExport(context),
    verifyAfterRestore: () => { throw new Error('fixture failure') },
  }
  const registry = new HostSnapshotRegistry()
  registry.register(failing)
  registry.register(createNovaWingSnapshotComponent())
  const manifest = createManifest(database, registry)
  assert.throws(
    () => verifyRegisteredComponentsAfterRestore({
      manifest,
      registry,
      contexts: new Map([['fake-host', database], ['novawing', database]]),
    }),
    hasHostCode('COMPONENT_VALIDATION_FAILED'),
  )
})

test('successful restore preserves both components and NovaWing can approve again', (t) => {
  const workspace = createTestWorkspace(t)
  const source = workspace.track(setupDatabase(workspace.databasePath))
  addApprovedProposal(source, 'before')
  const registry = createRegistry()
  const manifest = createManifest(source, registry)
  const rows = readFixtureRows(source)

  const restored = workspace.track(setupDatabase(`${workspace.databasePath}.restored`))
  restored.exec('DELETE FROM host_items; DELETE FROM host_meta; DELETE FROM nw_mainline_entries; DELETE FROM nw_proposals; DELETE FROM nw_meta;')
  restoreFixtureRows(restored, rows)
  verifyRegisteredComponentsAfterRestore({
    manifest,
    registry,
    contexts: new Map([['fake-host', restored], ['novawing', restored]]),
  })
  assert.deepEqual(
    restored.prepare('SELECT * FROM host_items ORDER BY id').all(),
    source.prepare('SELECT * FROM host_items ORDER BY id').all(),
  )
  const store = createInjectedSqliteNovaWingStore({ connection: restored, migrationMode: 'validate' })
  const facade = createNovaWingFacade(store, { generateId: () => 'after-restore' })
  const proposal = facade.createPendingProposal(manualSetInput({ memoryKey: 'global.after_restore' }))
  assert.equal(facade.approveProposal({ proposalId: proposal.id }).coreRevision, 2)
  assert.equal(facade.getContext({ scopes: ['global'] }).coreRevision, 2)
  store.close()
})

test('temporary database can be renamed after every connection closes', (t) => {
  const workspace = createTestWorkspace(t)
  const database = workspace.track(setupDatabase(workspace.databasePath))
  database.close()
  const renamed = `${workspace.databasePath}.renamed`
  renameSync(workspace.databasePath, renamed)
  const reopened = workspace.track(new DatabaseSync(renamed, { readOnly: true }))
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM host_items').get()?.count, 2)
})

test('failed candidate restore leaves the original database file unchanged', (t) => {
  const workspace = createTestWorkspace(t)
  const source = setupDatabase(workspace.databasePath)
  addApprovedProposal(source, 'original')
  const registry = createRegistry()
  const manifest = createManifest(source, registry)
  const rows = readFixtureRows(source)
  source.close()
  const before = createHash('sha256').update(readFileSync(workspace.databasePath)).digest('hex')

  const candidate = workspace.track(setupDatabase(`${workspace.databasePath}.candidate`))
  candidate.exec('DELETE FROM host_items; DELETE FROM host_meta; DELETE FROM nw_mainline_entries; DELETE FROM nw_proposals; DELETE FROM nw_meta;')
  restoreFixtureRows(candidate, rows)
  candidate.prepare("UPDATE host_items SET value = 'corrupt' WHERE id = 'item-1'").run()
  assert.throws(
    () => verifyRegisteredComponentsAfterRestore({
      manifest,
      registry,
      contexts: new Map([['fake-host', candidate], ['novawing', candidate]]),
    }),
    hasHostCode('COMPONENT_VALIDATION_FAILED'),
  )
  const after = createHash('sha256').update(readFileSync(workspace.databasePath)).digest('hex')
  assert.equal(after, before)
})
