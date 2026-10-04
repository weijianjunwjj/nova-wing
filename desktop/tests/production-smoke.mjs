import { sessionFetch as fetch, mintSession } from './operator-session.mjs'
import assert from 'node:assert/strict'
import { app } from 'electron'
import { desktopReady, desktopInstance, shutdownDesktop } from '../main/index.mjs'

void desktopReady.then(async (desktop) => {
  let report
  try {
    assert.ok(app.isPackaged)
    assert.equal(desktop.fixture, undefined)
    assert.equal(desktopInstance.fixtureCreateCount, 0)
    assert.equal(desktopInstance.hostCreateCount, 1)
    assert.equal(desktop.window.isVisible(), true)
    assert.equal(desktop.tray.tray.isDestroyed(), false)
    await mintSession(desktop.host.bootstrapUrl(desktop.host.launchpadUrl))
    const response = await fetch(desktop.host.launchpadUrl)
    assert.equal(response.status, 200)
    await response.text()
    await shutdownDesktop()
    assert.equal(desktop.host.observations.closeCalls, 1)
    report = { result: 'PASS', environment: { electron: process.versions.electron },
      checks: { production_start: { status: 'PASS' }, production_strict_quit: { status: 'PASS' } },
      childPids: app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid) }
  } catch (error) {
    report = { result: 'FAIL', error: String(error.stack ?? error) }
  }
  console.log(`DESKTOP_PACKAGED_PRODUCTION ${JSON.stringify(report)}`)
  app.quit()
})
