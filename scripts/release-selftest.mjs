/* global console, process */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  packRelease,
  prepareReleasePackage,
  run,
  runNpm,
} from './release-lib.mjs'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'nova-wing-release-consumer-'))
const packDirectory = resolve(temporaryRoot, 'pack')
const consumerDirectory = resolve(temporaryRoot, 'consumer')

try {
  const manifest = prepareReleasePackage()
  mkdirSync(packDirectory)
  mkdirSync(consumerDirectory)
  const packResult = packRelease(packDirectory)
  const tarballPath = resolve(packDirectory, packResult.filename)
  const tarballBytes = readFileSync(tarballPath)
  writeFileSync(resolve(consumerDirectory, 'package.json'), `${JSON.stringify({
    name: 'nova-wing-release-consumer-selftest',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`)

  const packageName = manifest.name
  const consumerSource = `
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { createNovaWingFacade } from '${packageName}/core'
import { createInjectedSqliteNovaWingStore } from '${packageName}/sqlite'
import { FakeOfferFlowHost } from '${packageName}/testing'
import {
  HOST_SNAPSHOT_V3_FORMAT,
  HostSnapshotRegistry,
  createNovaWingSnapshotComponent,
  createRegisteredHostSnapshotManifest,
} from '${packageName}/host-snapshot'

const database = new DatabaseSync(resolve('consumer.sqlite'))
const store = createInjectedSqliteNovaWingStore({ connection: database, migrationMode: 'apply' })
const facade = createNovaWingFacade(store, {
  generateId: (() => { let value = 0; return () => 'release-consumer-' + String(++value) })(),
})
const testingHost = new FakeOfferFlowHost(facade)
const proposal = testingHost.submitMainlineProposal({
  action: 'set',
  memoryKey: 'global.release_consumer',
  category: 'phase',
  assertionType: 'user_decision',
  scope: 'global',
  proposedStatement: 'scoped immutable package consumption works',
  rationale: 'release package acceptance',
  evidence: { summary: 'isolated local tarball self-test' },
})
assert.equal(proposal.status, 'pending')
facade.approveProposal({ proposalId: proposal.id })
const context = facade.getContext({ scopes: ['global'] })
assert.equal(context.coreRevision, 1)
assert.equal(context.entries.length, 1)

const component = createNovaWingSnapshotComponent()
const componentManifest = component.verifyBeforeExport(database)
assert.equal(componentManifest.component, 'novawing')
const registry = new HostSnapshotRegistry()
registry.register(component)
const hostManifest = createRegisteredHostSnapshotManifest({
  registry,
  contexts: new Map([['novawing', database]]),
  createdAt: '2026-08-05T00:00:00.000Z',
  host: { name: 'release-selftest-host', appVersion: '0.0.0', schemaVersion: 1 },
})
assert.equal(hostManifest.format, HOST_SNAPSHOT_V3_FORMAT)
assert.equal(hostManifest.components.length, 1)
store.close()
database.close()

try {
  await import('${packageName}/dist/core/index.js')
  throw new Error('deep import unexpectedly succeeded')
} catch (error) {
  assert.equal(error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
}
`
  writeFileSync(resolve(consumerDirectory, 'consumer.mjs'), consumerSource)
  runNpm([
    'install',
    tarballPath,
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--cache',
    resolve(temporaryRoot, 'npm-cache'),
  ], consumerDirectory)
  run(process.execPath, ['consumer.mjs'], { cwd: consumerDirectory })
  console.log(JSON.stringify({
    consumerChecks: 12,
    package: `${manifest.name}@${manifest.version}`,
    status: 'ok',
    tarball: packResult.filename,
    tarballSha256: createHash('sha256').update(tarballBytes).digest('hex'),
    tarballSize: tarballBytes.length,
  }, null, 2))
} finally {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(temporaryRoot))
  if (!relativeToTemp.startsWith('..') && !isAbsolute(relativeToTemp)) {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
