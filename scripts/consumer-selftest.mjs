/* global console, process */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'nova-wing-consumer-'))
const packageDirectory = resolve(temporaryRoot, 'package')

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
  return npmCli === undefined
    ? run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd)
    : run(process.execPath, [npmCli, ...args], cwd)
}

try {
  runNpm(['run', 'build'], repositoryRoot)
  const packResult = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', temporaryRoot], repositoryRoot),
  )[0]
  if (packResult === undefined || typeof packResult.filename !== 'string') {
    throw new Error('npm pack did not return a tarball filename')
  }
  const tarballPath = resolve(temporaryRoot, packResult.filename)
  const tarballBytes = readFileSync(tarballPath)
  writeFileSync(resolve(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'nova-wing-fresh-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2))
  const consumerSource = String.raw`
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createNovaWingFacade } from 'nova-wing/core'
import { openSqliteNovaWingStore } from 'nova-wing/sqlite'
import { FakeOfferFlowHost } from 'nova-wing/testing'
import {
  HOST_SNAPSHOT_V3_FORMAT,
  HOST_SNAPSHOT_V3_VERSION,
  HostSnapshotRegistry,
} from 'nova-wing/host-snapshot'

const store = openSqliteNovaWingStore({
  databasePath: join(tmpdir(), 'nova-wing-consumer-' + randomUUID() + '.sqlite'),
})
const facade = createNovaWingFacade(store, {
  generateId: (() => { let value = 0; return () => 'consumer-' + String(++value) })(),
})
const host = new FakeOfferFlowHost(facade)
const proposal = host.submitMainlineProposal({
  action: 'set',
  memoryKey: 'global.consumer_check',
  category: 'phase',
  assertionType: 'user_decision',
  scope: 'global',
  proposedStatement: 'fresh tarball consumer works',
  rationale: 'package acceptance',
  evidence: { summary: 'local isolated self-test' },
})
facade.approveProposal({ proposalId: proposal.id })
assert.equal(facade.getContext({ scopes: ['global'] }).coreRevision, 1)
assert.equal(host.readLatestMainline(['global']).entries.length, 1)
assert.equal(HOST_SNAPSHOT_V3_FORMAT, 'host.snapshot.v3')
assert.equal(HOST_SNAPSHOT_V3_VERSION, 3)
assert.equal(new HostSnapshotRegistry().list().length, 0)
store.close()

try {
  const forbiddenDeepImport = 'nova-wing/' + 'packages/core/src/index.js'
  await import(forbiddenDeepImport)
  throw new Error('deep import unexpectedly succeeded')
} catch (error) {
  assert.equal(error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
}
`
  writeFileSync(resolve(temporaryRoot, 'consumer.mjs'), consumerSource)
  runNpm([
    'install',
    tarballPath,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ], temporaryRoot)
  run(process.execPath, ['consumer.mjs'], temporaryRoot)
  console.log(JSON.stringify({
    consumer: 'migration/proposal/approval/context/snapshot-import/deep-import-rejection',
    tarball: packResult.filename,
    size: tarballBytes.length,
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    status: 'ok',
  }, null, 2))
} finally {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(temporaryRoot))
  if (!relativeToTemp.startsWith('..') && !isAbsolute(relativeToTemp)) {
    rmSync(packageDirectory, { recursive: true, force: true })
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
