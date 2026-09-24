import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { createDesktopPowerManager } from '../main/power.mjs'
import { createDesktopTray } from '../main/tray.mjs'
import { createShutdownCoordinator } from '../main/shutdown.mjs'
import { createDesktopUpdater, UPDATER_STATE } from '../main/updater.mjs'

const UPDATE_CANDIDATE = Object.freeze({ version: '0.4.4', identity: '0.4.4|latest|sha512-fixture' })
const idleBlockers = () => ({ readable: true, activeOperations: 0, pendingHumanDecisions: 0,
  pendingCheckpoints: 0, shutdownInFlight: false })
const settle = () => new Promise((resolve) => setImmediate(resolve))

function powerFixture() {
  const calls = []
  const ids = new Set()
  let sequence = 0
  const powerSaveBlocker = {
    start(type) { calls.push(['start', type]); ids.add(++sequence); return sequence },
    stop(id) { calls.push(['stop', id]); assert.equal(ids.delete(id), true); return true },
    isStarted(id) { return ids.has(id) },
  }
  const power = createDesktopPowerManager({ powerSaveBlocker })
  const start = (activityId, sessionId = 'A') => power.observe({ phase: 'started', activityId, sessionId, operation: 'execution' })
  const end = (activityId) => power.observe({ phase: 'ended', activityId })
  return { power, calls, start, end, powerSaveBlocker }
}

test('Power aggregates real activity across sessions 0→1→2→1→0 with stable id and duplicate releases', () => {
  const { power, calls, start, end } = powerFixture()
  assert.equal(power.snapshot().blockerActive, false)
  start('a', 'session-A')
  const id = power.snapshot().blockerId
  start('b', 'session-B')
  start('a', 'session-A')
  assert.equal(power.snapshot().activeCount, 2)
  assert.equal(power.snapshot().blockerId, id)
  end('a')
  end('a')
  assert.equal(power.snapshot().blockerActive, true)
  assert.equal(power.snapshot().activeCount, 1)
  end('b')
  end('b')
  assert.equal(power.snapshot().blockerActive, false)
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', id]])
  power.dispose()
  power.dispose()
  assert.equal(calls.length, 2)
})

test('Power ignores durable/session/window states and owns only explicit activity events', () => {
  const { power, calls } = powerFixture()
  for (const state of ['RUNNING', 'SCHEDULED', 'SUSPENDED', 'HUMAN_REQUIRED', 'USER_PAUSED', 'COMPLETED']) {
    power.observe({ phase: state, activityId: state })
  }
  assert.equal(power.snapshot().activeCount, 0)
  assert.deepEqual(calls, [])
})

test('Power isolates failed display observers and retries failed native resource release', () => {
  const { power, calls, start, end, powerSaveBlocker } = powerFixture()
  const unsubscribe = power.subscribe(() => { throw new Error('tray failed') })
  start('a')
  assert.equal(power.snapshot().blockerActive, true)
  const stop = powerSaveBlocker.stop
  powerSaveBlocker.stop = () => { throw new Error('native stop failed') }
  end('a')
  assert.equal(power.snapshot().activeCount, 0)
  assert.equal(power.snapshot().blockerActive, true, 'Keep id for final cleanup retry')
  powerSaveBlocker.stop = stop
  unsubscribe()
  power.dispose()
  assert.equal(power.snapshot().blockerActive, false)
  assert.equal(calls.length, 2)
  assert.ok(power.observations.errors.length > 0)
})

test('Power start failure cannot throw into operation and later activity retries', () => {
  const { power, calls, start, end, powerSaveBlocker } = powerFixture()
  const nativeStart = powerSaveBlocker.start
  powerSaveBlocker.start = () => { throw new Error('native start failed') }
  assert.doesNotThrow(() => start('a'))
  assert.equal(power.snapshot().activeCount, 1)
  powerSaveBlocker.start = nativeStart
  start('b')
  end('a')
  assert.equal(power.snapshot().blockerActive, true)
  end('b')
  assert.equal(calls.length, 2)
  assert.equal(power.observations.errors.length, 1)
})

function trayFixture(actions) {
  class Tray extends EventEmitter {
    destroyed = false
    menu
    tooltip
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
    setContextMenu(menu) { this.menu = menu }
    setToolTip(tooltip) { this.tooltip = tooltip }
  }
  const Menu = { buildFromTemplate(items) { return { items, getMenuItemById(id) { return items.find((item) => item.id === id) } } } }
  const nativeImage = { createFromPath(path) {
    assert.ok(isAbsolute(path))
    // The host decides which status-bar asset is correct; this fixture only proves the
    // shared lifecycle loads an asset from the packaged assets directory.
    assert.match(path, /[\\/]desktop[\\/]assets[\\/]tray(?:Template)?\.png$/u)
    return { isEmpty: () => false, getSize: () => ({ width: 18, height: 18 }), setTemplateImage() {}, isTemplateImage: () => true }
  } }
  return createDesktopTray({ Tray, Menu, nativeImage, ...actions })
}

test('Tray actions use shared window and quit callbacks and event-only status', () => {
  const calls = []
  const tray = trayFixture({ showWindow: () => calls.push('show'), hideWindow: () => calls.push('hide'), requestQuit: () => calls.push('quit') })
  assert.equal(tray.menu.getMenuItemById('status').label, '当前状态：空闲')
  tray.tray.emit('click')
  tray.menu.getMenuItemById('show').click()
  tray.menu.getMenuItemById('hide').click()
  assert.equal(tray.tray.isDestroyed(), false)
  tray.setActivity(2)
  assert.equal(tray.menu.getMenuItemById('status').label, '当前状态：运行中')
  assert.equal(tray.menu.getMenuItemById('status').enabled, false)
  assert.equal(tray.menu.getMenuItemById('update').label, '更新：当前环境不支持')
  assert.equal(tray.menu.getMenuItemById('update').enabled, false)
  const menu = tray.menu
  tray.setActivity(1)
  assert.equal(tray.menu, menu)
  tray.setActivity(0)
  tray.menu.getMenuItemById('quit').click()
  assert.deepEqual(calls, ['show', 'show', 'hide', 'quit'])
  assert.equal(tray.tray.isDestroyed(), false, 'Quit callback delegates cleanup to strict coordinator')
  tray.destroy()
  tray.destroy()
  assert.equal(tray.tray.isDestroyed(), true)
})

test('Tray updater returns from CHECKING to IDLE when no update is available', async () => {
  const gate = Promise.withResolvers()
  let checks = 0
  const updater = createDesktopUpdater({
    backend: { async check() { checks++; return gate.promise }, async download() { assert.fail('no update cannot download') } },
    capability: { platform: 'win32', installable: true, signature: 'unsigned', unsignedInstallApproved: true },
    getBlockers: idleBlockers, async requestInstallExit() { assert.fail('no update cannot install') },
  })
  const tray = trayFixture({ showWindow() {}, hideWindow() {}, requestQuit() {}, updater })
  const unsubscribe = updater.subscribe(tray.setUpdaterSnapshot)
  assert.equal(tray.menu.getMenuItemById('update').label, '检查更新')
  tray.menu.getMenuItemById('update').click()
  assert.equal(tray.menu.getMenuItemById('update').label, '正在检查更新…')
  assert.equal(tray.menu.getMenuItemById('update').enabled, false)
  gate.resolve({ available: false })
  await settle()
  assert.equal(checks, 1)
  assert.equal(updater.snapshot().state, UPDATER_STATE.IDLE)
  assert.equal(tray.menu.getMenuItemById('update').label, '检查更新')
  unsubscribe()
  tray.destroy()
  updater.dispose()
})

test('Tray updater follows AVAILABLE through READY and binds install to the exact candidate', async () => {
  const checkGate = Promise.withResolvers()
  const downloadGate = Promise.withResolvers()
  let downloads = 0
  let blockers = idleBlockers()
  const installs = []
  const updater = createDesktopUpdater({
    backend: {
      async check() { return checkGate.promise },
      async download(candidate) { downloads++; assert.deepEqual(candidate, UPDATE_CANDIDATE); return downloadGate.promise },
    },
    capability: { platform: 'win32', installable: true, signature: 'unsigned', unsignedInstallApproved: true },
    getBlockers: () => blockers,
    async requestInstallExit({ candidate }) { installs.push(candidate) },
  })
  const tray = trayFixture({ showWindow() {}, hideWindow() {}, requestQuit() {}, updater })
  const unsubscribe = updater.subscribe(tray.setUpdaterSnapshot)
  tray.menu.getMenuItemById('update').click()
  checkGate.resolve({ available: true, candidate: UPDATE_CANDIDATE })
  await settle()
  assert.equal(tray.menu.getMenuItemById('update').label, '下载 v0.4.4')
  assert.equal(installs.length, 0, 'AVAILABLE offers download, never install')

  const availableItem = tray.menu.getMenuItemById('update')
  availableItem.click()
  availableItem.click()
  assert.equal(tray.menu.getMenuItemById('update').label, '正在下载 v0.4.4…')
  assert.equal(tray.menu.getMenuItemById('update').enabled, false)
  assert.equal(downloads, 1, 'DOWNLOADING rejects a duplicate user intent')
  tray.setActivity(1)
  assert.equal(tray.menu.getMenuItemById('status').label, '当前状态：运行中')
  assert.equal(tray.menu.getMenuItemById('update').label, '正在下载 v0.4.4…',
    'activity rebuild preserves updater presentation')

  downloadGate.resolve(undefined)
  await settle()
  assert.equal(tray.menu.getMenuItemById('update').label, '重启并安装 v0.4.4')
  for (const blocked of [
    { activeOperations: 1 }, { pendingHumanDecisions: 1 }, { pendingCheckpoints: 1 }, { shutdownInFlight: true },
  ]) {
    blockers = { ...idleBlockers(), ...blocked }
    tray.menu.getMenuItemById('update').click()
    await settle()
    assert.equal(installs.length, 0)
    assert.equal(updater.snapshot().state, UPDATER_STATE.READY)
  }
  blockers = idleBlockers()
  tray.menu.getMenuItemById('update').click()
  await settle()
  assert.deepEqual(installs, [{ ...UPDATE_CANDIDATE }])
  assert.equal(updater.snapshot().observations.installAuthorizations, 1)
  unsubscribe()
  tray.destroy()
  updater.dispose()
})

test('Tray updater reports a safe failure and ERROR remains retryable', async () => {
  let attempt = 0
  const failures = []
  const updater = createDesktopUpdater({
    backend: {
      async check() {
        attempt++
        if (attempt === 1) throw new Error('Authorization: Bearer should-never-leak')
        return { available: false }
      },
      async download() { assert.fail('no download') },
    },
    capability: { platform: 'win32', installable: true, signature: 'unsigned', unsignedInstallApproved: true },
    getBlockers: idleBlockers, async requestInstallExit() { assert.fail('no install') },
  })
  const tray = trayFixture({ showWindow() {}, hideWindow() {}, requestQuit() {}, updater,
    reportFailure: (error) => failures.push(String(error.message ?? error)) })
  const unsubscribe = updater.subscribe(tray.setUpdaterSnapshot)
  tray.menu.getMenuItemById('update').click()
  await settle()
  assert.equal(tray.menu.getMenuItemById('update').label, '检查更新失败 / 重试')
  assert.deepEqual(failures, ['Updater check failed: CHECK_FAILED'])
  assert.doesNotMatch(JSON.stringify(updater.snapshot()), /should-never-leak/u)
  tray.menu.getMenuItemById('update').click()
  await settle()
  assert.equal(updater.snapshot().state, UPDATER_STATE.IDLE)
  assert.equal(tray.menu.getMenuItemById('update').label, '检查更新')
  unsubscribe()
  tray.destroy()
  updater.dispose()
})

test('Strict quit keeps Tray and blocker while drain is pending, then cleans before final quit', async () => {
  const { power, start, end } = powerFixture()
  const gate = Promise.withResolvers()
  const order = []
  const tray = trayFixture({ showWindow() {}, hideWindow() {}, requestQuit() {} })
  start('a')
  const coordinator = createShutdownCoordinator({
    getStartup: async () => {},
    getHost: () => ({ async close() { await gate.promise; end('a'); order.push('drained') } }),
    afterDrain() { power.dispose(); tray.destroy(); order.push('cleanup') },
    requestFinalQuit() { order.push('quit') }, reportFailure(error) { throw error },
  })
  coordinator.beforeQuit({ preventDefault() {} })
  coordinator.beforeQuit({ preventDefault() {} })
  assert.equal(power.snapshot().blockerActive, true)
  assert.equal(tray.tray.isDestroyed(), false)
  gate.resolve(undefined)
  await coordinator.shutdown()
  assert.equal(power.snapshot().blockerActive, false)
  assert.equal(tray.tray.isDestroyed(), true)
  assert.deepEqual(order, ['drained', 'cleanup', 'quit'])
})

test('Strict shutdown failure retains native controls and skips power fail-safe', async () => {
  const { power, start, end } = powerFixture()
  const failure = new Error('host cleanup failure')
  const tray = trayFixture({ showWindow() {}, hideWindow() {}, requestQuit() {} })
  start('a')
  const coordinator = createShutdownCoordinator({
    getStartup: async () => {}, getHost: () => ({ close: async () => { throw failure } }),
    afterDrain() { power.dispose(); tray.destroy() },
    requestFinalQuit() { assert.fail('failed shutdown cannot quit') }, reportFailure() {},
  })
  coordinator.beforeQuit({ preventDefault() {} })
  await assert.rejects(coordinator.shutdown(), (error) => error instanceof AggregateError && error.errors.includes(failure))
  assert.equal(coordinator.completed, false)
  assert.equal(power.snapshot().blockerActive, true)
  assert.equal(tray.tray.isDestroyed(), false)
  end('a')
  power.dispose()
  tray.destroy()
})

test('Native cleanup failure remains a failed shutdown and does not authorize final quit', async () => {
  const error = new Error('native cleanup failure')
  const coordinator = createShutdownCoordinator({
    getStartup: async () => {}, getHost: () => ({ close: async () => {} }),
    afterDrain() { throw error }, requestFinalQuit() { assert.fail('cannot quit') }, reportFailure() {},
  })
  coordinator.beforeQuit({ preventDefault() {} })
  await assert.rejects(coordinator.shutdown(), (actual) => actual === error)
  assert.equal(coordinator.completed, false)
})
