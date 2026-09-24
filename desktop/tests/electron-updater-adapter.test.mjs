import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  ADAPTER_REASON, candidateIdentity, createElectronUpdaterAdapter, UpdaterAdapterError,
} from '../main/electron-updater-adapter.mjs'

// The adapter against a fake electron-updater facade: every event shape, every failure and the
// completion contract are driven here, so the real network is never touched.

/** @param {string} code @returns {(error: unknown) => boolean} */
const codeIs = (code) => (error) => error instanceof UpdaterAdapterError && error.code === code

/** @param {string} code @param {RegExp} pattern @returns {(error: unknown) => boolean} */
const codeAndMessage = (code, pattern) => (error) =>
  error instanceof UpdaterAdapterError && error.code === code && pattern.test(error.message)

const VERSION = '0.4.2'
const SHA = 'sha512-of-the-real-artifact'
const IDENTITY = candidateIdentity({ version: VERSION, channel: 'latest', sha512: SHA })

/** A minimal stand-in for an electron-updater AppUpdater. */
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = true
  _channel = 'latest'
  feed = null
  quitCalls = []
  downloadCalls = 0
  checkResult = null
  checkError = null
  downloadError = null
  get channel() { return this._channel }
  // Match electron-updater: selecting a channel implicitly enables downgrade until the caller
  // explicitly disables it again.
  set channel(value) { this._channel = value; this.allowDowngrade = true }
  setFeedURL(feed) { this.feed = feed }
  async checkForUpdates() { if (this.checkError) throw this.checkError; return this.checkResult }
  async downloadUpdate() { this.downloadCalls += 1; if (this.downloadError) throw this.downloadError; return ['downloaded-artifact'] }
  quitAndInstall(...args) { this.quitCalls.push(args) }
}

function updateInfo(overrides = {}) {
  return {
    version: VERSION,
    files: [{ url: 'NovaWing-Setup-0.4.2-x64', sha512: SHA, size: 123 }],
    path: 'NovaWing-Setup-0.4.2-x64',
    sha512: SHA,
    ...overrides,
  }
}

function downloadAdapter(options = {}) {
  const fake = new FakeUpdater()
  const adapter = createElectronUpdaterAdapter({ autoUpdater: fake, ...options })
  return { fake, adapter }
}

test('the adapter configures the explicit policy instead of trusting defaults', () => {
  const { fake, adapter } = downloadAdapter({ channel: 'stable' })
  // electron-updater defaults autoDownload and autoInstallOnAppQuit to true; both are inverted here.
  assert.deepEqual(adapter.policy(), {
    autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false,
    allowPrerelease: false, channel: 'stable',
  })
  assert.equal(fake.autoDownload, false)
  assert.equal(fake.autoInstallOnAppQuit, false)
  assert.equal(fake.allowDowngrade, false)
  assert.equal(fake.allowPrerelease, false)
})

test('the explicit no-downgrade policy is applied after electron-updater changes channel', () => {
  const fake = new FakeUpdater()
  fake.allowDowngrade = false
  fake.channel = 'beta'
  assert.equal(fake.allowDowngrade, true, 'the facade reproduces electron-updater channel semantics')

  const adapter = createElectronUpdaterAdapter({ autoUpdater: fake, channel: 'latest' })
  assert.equal(fake.channel, 'latest')
  assert.equal(fake.allowDowngrade, false)
  assert.equal(adapter.policy().allowDowngrade, false)
})

test('an adapter requires an updater instance', () => {
  assert.throws(() => createElectronUpdaterAdapter({ autoUpdater: null }), codeIs(ADAPTER_REASON.INSTANCE_REQUIRED))
})

test('an injected feed is applied and the product leaves it unset', () => {
  const injected = downloadAdapter({ feed: { provider: 'generic', url: 'http://127.0.0.1:1' } })
  assert.deepEqual(injected.fake.feed, { provider: 'generic', url: 'http://127.0.0.1:1' })
  const product = downloadAdapter()
  assert.equal(product.fake.feed, null, 'the packaged app-update.yml decides the product feed')
})

test('check reports no update when the feed has nothing newer', async () => {
  const { fake, adapter } = downloadAdapter()
  fake.checkResult = { isUpdateAvailable: false, updateInfo: updateInfo({ version: '0.4.1' }) }
  assert.deepEqual(await adapter.check(), { available: false })
})

test('check binds the candidate to version, channel and artifact bytes', async () => {
  const { fake, adapter } = downloadAdapter()
  fake.checkResult = { isUpdateAvailable: true, updateInfo: updateInfo() }
  const result = await adapter.check()
  assert.equal(result.available, true)
  assert.equal(result.candidate.version, VERSION)
  assert.equal(result.candidate.identity, IDENTITY)
  // A version alone would not distinguish a re-published artifact.
  assert.notEqual(result.candidate.identity, candidateIdentity({ version: VERSION, channel: 'latest', sha512: 'other' }))
})

test('check refuses metadata that names no usable artifact', async () => {
  const { fake, adapter } = downloadAdapter()
  fake.checkResult = { isUpdateAvailable: true, updateInfo: updateInfo({ files: [], path: 'missing-artifact' }) }
  await assert.rejects(adapter.check(), codeIs(ADAPTER_REASON.FEED_INCOMPLETE))
})

test('a feed error is reported as a check failure', async () => {
  const { fake, adapter } = downloadAdapter()
  fake.checkError = new Error('feed unreachable')
  await assert.rejects(adapter.check(), codeAndMessage(ADAPTER_REASON.CHECK_FAILED, /feed unreachable/u))
})

test('progress events do not settle a download early', async () => {
  const { fake, adapter } = downloadAdapter()
  const candidate = { version: VERSION, identity: IDENTITY }
  const pending = adapter.download(candidate)
  fake.emit('download-progress', { percent: 50 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.downloadCalls, 1)
  fake.emit('update-downloaded', updateInfo())
  assert.deepEqual(await pending, { version: VERSION, identity: IDENTITY })
})

test('a download resolves only for the confirmed candidate', async () => {
  const { fake, adapter } = downloadAdapter()
  const pending = adapter.download({ version: VERSION, identity: IDENTITY })
  fake.emit('update-downloaded', updateInfo())
  assert.deepEqual(await pending, { version: VERSION, identity: IDENTITY })
})

test('an event for another candidate fails instead of completing the download', async () => {
  const { fake, adapter } = downloadAdapter()
  const pending = adapter.download({ version: VERSION, identity: IDENTITY })
  // The feed swapped the package after the user confirmed: same version, different bytes.
  fake.emit('update-downloaded', updateInfo({ files: [{ url: 'x', sha512: 'different-bytes', size: 1 }] }))
  await assert.rejects(pending, codeIs(ADAPTER_REASON.CANDIDATE_MISMATCH))
})

test('a download error is reported and duplicate events settle once', async () => {
  const failed = downloadAdapter()
  const rejected = failed.adapter.download({ version: VERSION, identity: IDENTITY })
  failed.fake.emit('error', new Error('transfer interrupted'))
  await assert.rejects(rejected, codeIs(ADAPTER_REASON.DOWNLOAD_FAILED))

  const duplicated = downloadAdapter()
  const pending = duplicated.adapter.download({ version: VERSION, identity: IDENTITY })
  const seen = []
  void pending.then((value) => seen.push(value))
  duplicated.fake.emit('update-downloaded', updateInfo())
  duplicated.fake.emit('update-downloaded', updateInfo())
  duplicated.fake.emit('error', new Error('late failure'))
  await pending
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 1, 'a duplicate or late event cannot settle the download twice')
})

test('a downloadUpdate rejection is reported as a download failure', async () => {
  const { fake, adapter } = downloadAdapter()
  fake.downloadError = new Error('disk full')
  await assert.rejects(adapter.download({ version: VERSION, identity: IDENTITY }), codeAndMessage(ADAPTER_REASON.DOWNLOAD_FAILED, /disk full/u))
})

test('install refuses a candidate that was never downloaded here', () => {
  const { fake, adapter } = downloadAdapter()
  assert.throws(() => adapter.install({ version: VERSION, identity: IDENTITY }), codeIs(ADAPTER_REASON.NOT_DOWNLOADED))
  assert.deepEqual(fake.quitCalls, [])
})

test('install refuses an intent that does not match the staged download', async () => {
  const { fake, adapter } = downloadAdapter()
  const pending = adapter.download({ version: VERSION, identity: IDENTITY })
  fake.emit('update-downloaded', updateInfo())
  await pending
  assert.throws(() => adapter.install({ version: VERSION, identity: 'a-different-candidate' }), codeIs(ADAPTER_REASON.CANDIDATE_MISMATCH))
  assert.deepEqual(fake.quitCalls, [], 'nothing is installed for an unauthorized candidate')
})

test('install hands electron-updater the staged update only after a matching download', async () => {
  const { fake, adapter } = downloadAdapter()
  const pending = adapter.download({ version: VERSION, identity: IDENTITY })
  fake.emit('update-downloaded', updateInfo())
  await pending
  adapter.install({ version: VERSION, identity: IDENTITY })
  assert.deepEqual(fake.quitCalls, [[true, true]], 'electron-updater applies its own staged download')
})

test('dispose unbinds listeners and refuses later work', async () => {
  const { fake, adapter } = downloadAdapter()
  const pending = adapter.download({ version: VERSION, identity: IDENTITY })
  adapter.dispose()
  adapter.dispose()
  await assert.rejects(pending, codeIs(ADAPTER_REASON.DOWNLOAD_FAILED))
  assert.equal(fake.listenerCount('update-downloaded'), 0, 'no listener outlives dispose')
  assert.equal(fake.listenerCount('error'), 0)
  assert.deepEqual(await adapter.check(), { available: false })
})
