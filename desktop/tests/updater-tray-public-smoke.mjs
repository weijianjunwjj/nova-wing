import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import { DESKTOP_IDENTITY } from '../main/identity.mjs'
import { desktopReady, shutdownDesktop } from '../main/index.mjs'

async function eventually(description, condition, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = condition()
    if (value) return value
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}`)
}

void desktopReady.then(async (desktop) => {
  let report
  try {
    assert.ok(app.isPackaged, 'the public updater Tray smoke only runs in a packaged app')
    assert.equal(DESKTOP_IDENTITY.version, '0.4.4')
    const before = desktop.updater.snapshot()
    assert.equal(before.state, 'IDLE')
    assert.equal(before.candidate, null)
    assert.equal(before.capability.installable, true)
    const item = desktop.tray.menu.getMenuItemById('update')
    assert.equal(item.label, '检查更新')
    assert.notEqual(item.enabled, false)
    assert.equal(typeof item.click, 'function')

    Reflect.apply(item.click, item, [item, desktop.window, {}])
    const checking = desktop.updater.snapshot()
    assert.equal(checking.state, 'CHECKING')
    assert.equal(desktop.tray.menu.getMenuItemById('update').label, '正在检查更新…')
    assert.equal(desktop.tray.menu.getMenuItemById('update').enabled, false)

    const after = await eventually('public v0.4.3 feed to resolve as no update', () => {
      const snapshot = desktop.updater.snapshot()
      return snapshot.state !== 'CHECKING' ? snapshot : null
    })
    assert.equal(after.state, 'IDLE', JSON.stringify(after))
    assert.equal(after.candidate, null)
    assert.equal(after.observations.checkCalls, 1)
    assert.equal(after.observations.downloadCalls, 0)
    assert.equal(after.observations.installRequests, 0)
    assert.equal(after.observations.installAuthorizations, 0)
    assert.equal(desktop.tray.menu.getMenuItemById('update').label, '检查更新')

    report = {
      result: 'PASS', environment: { electron: process.versions.electron },
      checks: {
        tray_action: { status: 'PASS', detail: { before: before.state, during: checking.state, after: after.state } },
        no_downgrade: { status: 'PASS', detail: { currentVersion: DESKTOP_IDENTITY.version,
          publicLatestVersion: '0.4.3', candidate: after.candidate } },
        no_download_or_install: { status: 'PASS', detail: after.observations },
      },
    }
    await shutdownDesktop()
  } catch (error) {
    report = { result: 'FAIL', environment: { electron: process.versions.electron }, error: String(error?.stack ?? error) }
  }
  console.log(`DESKTOP_PUBLIC_UPDATE_TRAY ${JSON.stringify(report)}`)
  app.quit()
})
