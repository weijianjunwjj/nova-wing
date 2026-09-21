import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { createDesktopPowerManager } from '../main/power.mjs'
import { createDesktopTray } from '../main/tray.mjs'
import { createShutdownCoordinator } from '../main/shutdown.mjs'

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
  const nativeImage = { createFromPath(path) { assert.ok(isAbsolute(path)); assert.match(path, /[\\/]desktop[\\/]assets[\\/]tray\.png$/u); return { isEmpty: () => false } } }
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
