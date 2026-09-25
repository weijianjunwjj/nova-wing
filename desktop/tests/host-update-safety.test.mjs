import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeSafetySnapshot, createDesktopHost } from '../main/host.mjs'
import { createShutdownCoordinator } from '../main/shutdown.mjs'

/** @typedef {import('nova-wing/development-guardian').NovaWingLaunchpad} NovaWingLaunchpad
 * @typedef {{ getUpdateSafetyView?: () => unknown }} SafetyProjection */
const asLaunchpad = (value) => /** @type {NovaWingLaunchpad} */ (/** @type {unknown} */ (value))

// The Desktop Host safety snapshot: the real composition in host.mjs, driven with a fake
// Launchpad projection and a fake shutdown reader. Nothing here is a hand-written five-field
// object, and no real Window, Runtime or Task is involved.

function liveShutdown() {
  return { requested: false, completed: false }
}

function launchpadView(overrides = {}) {
  return {
    readable: true, reasonCode: null, activeOperations: 0, pendingHumanDecisions: 0,
    pendingCheckpoints: 0, ...overrides,
  }
}

function fakeLaunchpad(view) {
  const reads = { count: 0 }
  return {
    reads,
    getUpdateSafetyView() {
      reads.count++
      return typeof view === 'function' ? view() : view
    },
    async start() { return { url: 'http://127.0.0.1:1' } },
    async close() {},
  }
}

async function hostWith(view) {
  const launchpad = fakeLaunchpad(view)
  const host = await createDesktopHost({
    configDirectory: 'isolated-config-directory', env: {},
    dependencies: { createWorkSession: async () => { throw new Error('no session is created in this test') } },
    launchpadFactory: async () => asLaunchpad(launchpad),
  })
  return { host, launchpad }
}

test('an idle Host reads as readable with no blocking work', async () => {
  const { host } = await hostWith(launchpadView())
  assert.deepEqual(host.updateSafetySnapshot({ readShutdownState: liveShutdown }),
    { readable: true, reasonCode: null, activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0, shutdownInFlight: false })
})

test('the Host snapshot carries exactly the five gate fields', async () => {
  const { host } = await hostWith(launchpadView({ activeOperations: 2, pendingHumanDecisions: 1, pendingCheckpoints: 3 }))
  const snapshot = host.updateSafetySnapshot({ readShutdownState: liveShutdown })
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['activeOperations', 'pendingCheckpoints', 'pendingHumanDecisions', 'readable', 'reasonCode', 'shutdownInFlight'])
  assert.equal(snapshot.activeOperations, 2)
  assert.equal(snapshot.pendingHumanDecisions, 1)
  assert.equal(snapshot.pendingCheckpoints, 3)
})

test('a shutdown that was requested and never completed stays in flight', async () => {
  const { host } = await hostWith(launchpadView())
  // A failed drain keeps requested=true and completed=false for the life of the process.
  const failed = host.updateSafetySnapshot({ readShutdownState: () => ({ requested: true, completed: false }) })
  assert.equal(failed.readable, true)
  assert.equal(failed.shutdownInFlight, true, 'A failed shutdown is never idle')

  const completed = host.updateSafetySnapshot({ readShutdownState: () => ({ requested: true, completed: true }) })
  assert.equal(completed.shutdownInFlight, false)
})

test('the real coordinator supplies the shutdown flag the Host reports', async () => {
  const { host } = await hostWith(launchpadView())
  const readShutdownState = () => ({ requested: active.requested, completed: active.completed })
  const active = { requested: false, completed: false }
  assert.equal(host.updateSafetySnapshot({ readShutdownState }).shutdownInFlight, false)

  const coordinator = createShutdownCoordinator({
    getStartup: async () => {}, getHost: () => ({ close: async () => { throw new Error('host close failed') } }),
    afterDrain() {}, requestFinalQuit() { assert.fail('a failed drain cannot quit') }, reportFailure() {},
  })
  coordinator.beforeQuit({ preventDefault() {} })
  await coordinator.shutdown().catch(() => undefined)
  active.requested = coordinator.requested
  active.completed = coordinator.completed

  assert.equal(coordinator.completed, false)
  const snapshot = host.updateSafetySnapshot({ readShutdownState })
  assert.equal(snapshot.readable, true)
  assert.equal(snapshot.shutdownInFlight, true, 'The coordinator, not a constant, decides this')
})

test('a missing or malformed Host projection fails closed with a conservative shutdown flag', async () => {
  /** @type {Array<[string, SafetyProjection]>} */
  const broken = [
    ['a Launchpad without the projection', {}],
    ['a Launchpad whose projection throws', { getUpdateSafetyView() { throw new Error('host unavailable') } }],
    ['a projection without readable', { getUpdateSafetyView: () => ({ activeOperations: 0 }) }],
    ['a projection with a negative count', { getUpdateSafetyView: () => launchpadView({ activeOperations: -1 }) }],
    ['a projection with a non-numeric count', { getUpdateSafetyView: () => launchpadView({ pendingCheckpoints: 'none' }) }],
  ]
  for (const [label, launchpad] of broken) {
    const snapshot = composeSafetySnapshot(launchpad, { readShutdownState: liveShutdown })
    assert.equal(snapshot.readable, false, label)
    assert.equal(snapshot.reasonCode, 'HOST_SAFETY_VIEW_UNAVAILABLE', label)
    assert.equal(snapshot.shutdownInFlight, true, `${label}: an unreadable snapshot must not look idle`)
  }
})

test('an unreadable owner keeps its own reason and an unusable shutdown reader is reported', async () => {
  const owner = composeSafetySnapshot(fakeLaunchpad(launchpadView({ readable: false, reasonCode: 'STATE_NOT_HYDRATED', activeOperations: 4 })),
    { readShutdownState: liveShutdown })
  assert.equal(owner.readable, false)
  assert.equal(owner.reasonCode, 'STATE_NOT_HYDRATED', 'The owner reason is preserved')
  assert.equal(owner.activeOperations, 4, 'What was known is still reported, under readable=false')
  assert.equal(owner.shutdownInFlight, true)

  /** @type {Array<[string, (() => unknown) | undefined]>} */
  const unusableReaders = [
    ['no reader at all', undefined],
    ['a reader that throws', () => { throw new Error('coordinator unavailable') }],
    ['a reader with no shape', () => ({})],
  ]
  for (const [label, readShutdownState] of unusableReaders) {
    const snapshot = composeSafetySnapshot(fakeLaunchpad(launchpadView()), { readShutdownState })
    assert.equal(snapshot.readable, false, label)
    assert.equal(snapshot.reasonCode, 'SHUTDOWN_STATE_UNAVAILABLE', label)
    assert.equal(snapshot.shutdownInFlight, true, label)
  }
})

test('the Host never caches a reading, and reading registers no work of its own', async () => {
  let view = launchpadView()
  const { host, launchpad } = await hostWith(() => view)
  assert.equal(host.updateSafetySnapshot({ readShutdownState: liveShutdown }).activeOperations, 0)
  view = launchpadView({ activeOperations: 3 })
  // A later, busier Host must never be described by an earlier reading.
  assert.equal(host.updateSafetySnapshot({ readShutdownState: liveShutdown }).activeOperations, 3)
  assert.equal(launchpad.reads.count, 2, 'Exactly one projection read per snapshot, never cached')
})

test('the Host snapshot leaks no owner detail', async () => {
  const { host } = await hostWith(launchpadView({ readable: false, reasonCode: 'STATE_NOT_HYDRATED', activeOperations: 1 }))
  const snapshot = host.updateSafetySnapshot({ readShutdownState: liveShutdown })
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['activeOperations', 'pendingCheckpoints', 'pendingHumanDecisions', 'readable', 'reasonCode', 'shutdownInFlight'])
  assert.equal(typeof snapshot.readable, 'boolean')
  assert.equal(typeof snapshot.shutdownInFlight, 'boolean')
})
