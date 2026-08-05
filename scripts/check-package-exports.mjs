/* global console */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
)
const expectedSubpaths = ['./core', './sqlite', './testing']
if (JSON.stringify(Object.keys(packageJson.exports).sort()) !== JSON.stringify(expectedSubpaths)) {
  throw new Error('package exports must contain only core, sqlite, and testing subpaths')
}

const expectedRuntimeExports = {
  'nova-wing/core': ['NovaWingError', 'createNovaWingFacade', 'isNovaWingError'],
  'nova-wing/sqlite': [
    'NOVAWING_AUTHORITATIVE_TABLE_NAMES',
    'NOVAWING_AUTHORITATIVE_TABLES',
    'NOVAWING_SCHEMA_VERSION',
    'NOVAWING_SNAPSHOT_FORMAT',
    'NOVAWING_SNAPSHOT_VERSION',
    'NovaWingSnapshotError',
    'createInjectedSqliteNovaWingStore',
    'inspectNovaWingMigration',
    'migrateNovaWing',
    'openSqliteNovaWingStore',
    'validateNovaWingSnapshotManifest',
    'verifyNovaWingAfterSnapshotRestore',
    'verifyNovaWingBeforeSnapshotExport',
  ],
  'nova-wing/testing': ['FakeOfferFlowHost'],
}

for (const [specifier, expected] of Object.entries(expectedRuntimeExports)) {
  const module = await import(specifier)
  const actual = Object.keys(module).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${specifier} exposed unexpected runtime keys: ${actual.join(', ')}`)
  }
}

for (const forbidden of [
  'nova-wing/packages/core/src/index.js',
  'nova-wing/core/domain/errors',
  'nova-wing/packages/sqlite/src/sqlite-nova-wing-store.js',
  'nova-wing/sqlite/migrations/index',
]) {
  try {
    await import(forbidden)
    throw new Error(`deep package import unexpectedly succeeded: ${forbidden}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error
    }
  }
}

console.log(
  JSON.stringify({
    publicSubpaths: expectedSubpaths,
    rejectedDeepImports: 4,
    status: 'ok',
  }),
)

