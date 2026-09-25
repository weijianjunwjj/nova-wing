import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { candidateIdentity, createElectronUpdaterAdapter } from '../main/electron-updater-adapter.mjs'
import { desktopReady, shutdownDesktop } from '../main/index.mjs'

// The update metadata pipeline inside the packaged app, against a feed served from this machine.
// Nothing here may reach GitHub: the local server answers every feed request, and the download
// stage uses a facade because a real download would need a real artifact — and on macOS it would
// hand control to Squirrel. Install is never exercised.

const UPDATE_VERSION = '9.9.9'

/** A facade for the download stage only; the check stage uses the real electron-updater. */
class FacadeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = true
  channel = 'latest'
  async downloadUpdate() { return [] }
  quitAndInstall() { throw new Error('the packaged feed smoke must never install') }
}

function metadataDocument({ artifactName, sha512, size }) {
  return [
    `version: ${UPDATE_VERSION}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
}

void desktopReady.then(async (desktop) => {
  let report
  let server
  try {
    assert.ok(app.isPackaged, 'the feed smoke only runs in the packaged app')

    // 1. The product's own capability for this host, as the packaged app resolved it. The
    //    reason for a refusal lives on the snapshot root; the capability carries the grant.
    const product = desktop.updater.snapshot()
    const capability = product.capability
    const windowsLike = capability.platform === 'win32'
    if (windowsLike) {
      assert.equal(capability.installable, true, JSON.stringify(product))
      assert.equal(capability.signature, 'unsigned', 'the Windows bootstrap is explicitly unsigned')
      assert.equal(product.state, 'IDLE', 'an installable host is idle until something asks it to check')
    } else {
      assert.equal(capability.installable, false, JSON.stringify(product))
      assert.equal(product.state, 'UNSUPPORTED')
      assert.equal(product.reasonCode, 'BLOCKED_BY_SIGNING', 'macOS stays blocked by signing')
    }
    // Nothing has installed anything, and the packaged app never installed on quit.
    assert.equal(product.observations.installAuthorizations, 0)
    assert.equal(electronUpdater.autoUpdater.autoDownload, false)
    assert.equal(electronUpdater.autoUpdater.autoInstallOnAppQuit, false, 'an ordinary quit must never install')

    // 2. A local feed serving this host's channel file and the artifact it names.
    const artifact = Buffer.from(`packaged feed smoke artifact ${UPDATE_VERSION}`)
    const sha512 = createHash('sha512').update(artifact).digest('base64')
    // Deliberately platform-neutral: this smoke proves the local feed is read, and the real
    // installer and container names are gated against the artifacts by verify-update-metadata.
    const artifactName = `NovaWing-update-${UPDATE_VERSION}`
    const yaml = metadataDocument({ artifactName, sha512, size: artifact.length })
    const served = []
    server = createServer((request, response) => {
      // electron-updater appends a cache-busting query, so route on the path alone.
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      served.push(pathname)
      if (pathname === '/latest.yml' || pathname === '/latest-mac.yml') {
        response.writeHead(200, { 'content-type': 'text/yaml' })
        response.end(yaml)
        return
      }
      if (pathname === `/${artifactName}`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(artifact)
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object', 'the local feed has no address')
    const baseUrl = `http://127.0.0.1:${address.port}`

    // 3. The real electron-updater reads that feed. autoDownload is off, so this only fetches and
    //    parses the metadata.
    const checking = createElectronUpdaterAdapter({
      autoUpdater: electronUpdater.autoUpdater, feed: { provider: 'generic', url: baseUrl },
    })
    const checked = await checking.check()
    assert.equal(checked.available, true, JSON.stringify(checked))
    assert.equal(checked.candidate.version, UPDATE_VERSION)
    const expectedIdentity = candidateIdentity({ version: UPDATE_VERSION, channel: 'latest', sha512 })
    assert.equal(checked.candidate.identity, expectedIdentity, 'the identity binds version, channel and artifact bytes')
    assert.ok(served.length > 0, 'the feed was served locally')
    checking.dispose()

    // 4. The download stage against a facade: a start, a progress event and the matching
    //    completion. A mismatched event must not complete the same promise.
    const facade = new FacadeUpdater()
    const downloading = createElectronUpdaterAdapter({ autoUpdater: facade })
    assert.deepEqual(downloading.policy(), {
      autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false,
      allowPrerelease: false, channel: 'latest',
    })
    const pending = downloading.download(checked.candidate)
    facade.emit('download-progress', { percent: 50 })
    facade.emit('update-downloaded', {
      version: UPDATE_VERSION, files: [{ url: artifactName, sha512, size: artifact.length }], path: artifactName, sha512,
    })
    assert.deepEqual(await pending, { version: UPDATE_VERSION, identity: expectedIdentity })
    assert.equal(downloading.lastError(), null)
    downloading.dispose()

    // 5. The product's updater still never installed anything.
    assert.equal(desktop.updater.snapshot().observations.installAuthorizations, 0)
    await shutdownDesktop()
    report = {
      result: 'PASS',
      environment: { electron: process.versions.electron },
      host: capability.platform,
      checks: {
        packaged_capability: { status: 'PASS', detail: capability },
        explicit_policy: { status: 'PASS', detail: { autoDownload: false, autoInstallOnAppQuit: false } },
        local_feed_check: { status: 'PASS', detail: { version: UPDATE_VERSION, identity: expectedIdentity, requests: served } },
        download_contract: { status: 'PASS' },
        no_install: { status: 'PASS' },
      },
    }
  } catch (error) {
    report = { result: 'FAIL', environment: { electron: process.versions.electron }, error: String(error?.stack ?? error) }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
  }
  console.log(`DESKTOP_PACKAGED_UPDATE_FEED ${JSON.stringify(report)}`)
  app.quit()
})
