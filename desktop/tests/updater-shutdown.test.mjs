import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShutdownCoordinator } from '../main/shutdown.mjs'
import { createDesktopUpdater, UPDATER_BLOCK_REASON, UPDATER_FAILURE, UPDATER_STATE } from '../main/updater.mjs'

// The exit contract between the updater and the existing strict shutdown. The coordinator is the
// real one; only the Host, the app quit and the installer are fakes. This proves the offline
// ordering. It is not evidence that a real Electron/NSIS install works.
const CANDIDATE = { version: '0.4.2', identity: 'sha512-candidate-042' }

/**
 * @param {{ hostClose?: () => Promise<unknown>, afterDrain?: () => void,
 *   scope?: { activeOperations?: number, pendingHumanDecisions?: number, pendingCheckpoints?: number },
 *   truthfulShutdownFlag?: boolean }} [options]
 */
function exitHarness({ hostClose, afterDrain, scope = {}, truthfulShutdownFlag = true } = {}) {
  const order = []
  const failures = []
  const exitRequests = []
  /** Once set, the single final exit action installs instead of quitting. */
  const authorization = { candidate: null }
  const appQuit = { count: 0 }
  /** The mutable current managed-scope reading. Only the shutdown flag comes from elsewhere. */
  const hostState = { activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0 }
  Object.assign(hostState, scope)
  const installer = {
    calls: [],
    completedAtCall: [],
    install(candidate) {
      installer.calls.push(candidate)
      installer.completedAtCall.push(coordinator.completed)
      order.push('install')
    },
  }
  let coordinatorCreations = 0
  /** @type {ReturnType<typeof createShutdownCoordinator> | undefined} */
  let coordinator
  // Exactly one coordinator per process. A replacement would fake a recovery that never happened.
  coordinatorCreations++
  coordinator = createShutdownCoordinator({
    getStartup: async () => { order.push('startup') },
    getHost: () => ({ close: async () => { order.push('close'); if (hostClose) await hostClose() } }),
    afterDrain() { order.push('afterDrain'); if (afterDrain) afterDrain() },
    requestFinalQuit() {
      order.push('finalQuit')
      if (authorization.candidate === null) { appQuit.count++; return }
      installer.install(authorization.candidate)
    },
    reportFailure(error) { failures.push(error) },
  })
  const updater = createDesktopUpdater({
    backend: { check: async () => ({ available: true, candidate: { ...CANDIDATE } }), download: async () => ({ downloaded: true }) },
    capability: { platform: 'win32', installable: true, signature: 'signed' },
    // The process-level blocker fields are read live. `shutdownInFlight` is derived from the real
    // coordinator, which is what makes a failed drain permanently visible instead of being
    // papered over by a constant. A test may pass truthfulShutdownFlag: false to model a broken
    // provider and prove the install guarantee does not depend on the provider being correct.
    getBlockers: () => ({
      readable: true,
      activeOperations: hostState.activeOperations,
      pendingHumanDecisions: hostState.pendingHumanDecisions,
      pendingCheckpoints: hostState.pendingCheckpoints,
      shutdownInFlight: truthfulShutdownFlag ? coordinator.requested && !coordinator.completed : false,
    }),
    // The authorized exit is expressed only through the existing strict shutdown: this never
    // drains the Host itself and never calls an installer.
    requestInstallExit: async (request) => {
      exitRequests.push(request)
      authorization.candidate = request.candidate
      coordinator.beforeQuit({ preventDefault() {} })
      await coordinator.shutdown()
    },
  })
  return {
    order, failures, installer, appQuit, authorization, updater, exitRequests, hostState,
    get coordinator() { return coordinator },
    get coordinatorCreations() { return coordinatorCreations },
    async reachReady() { await updater.check(); await updater.download() },
    quitRequest() { coordinator.beforeQuit({ preventDefault() {} }) },
    async finish() { await coordinator.shutdown() },
  }
}

test('A normal quit never installs, even while an update is READY', async () => {
  const harness = exitHarness()
  await harness.reachReady()
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY)
  harness.quitRequest()
  await harness.finish()
  assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'finalQuit'])
  assert.equal(harness.coordinator.completed, true)
  assert.equal(harness.installer.calls.length, 0, 'A READY update is never installed by an ordinary quit')
  assert.equal(harness.appQuit.count, 1)
})

test('Without an install intent the existing quit behaviour is unchanged', async () => {
  const harness = exitHarness()
  harness.quitRequest()
  await harness.finish()
  assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'finalQuit'])
  assert.equal(harness.appQuit.count, 1)
  assert.equal(harness.installer.calls.length, 0)
  assert.equal(harness.coordinator.completed, true)
  assert.equal(harness.failures.length, 0)
})

test('An authorized install runs once, only after the whole strict drain completes', async () => {
  const harness = exitHarness()
  await harness.reachReady()
  const result = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(result.ok, true)
  assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'finalQuit', 'install'])
  assert.equal(harness.coordinator.completed, true)
  assert.deepEqual(harness.installer.completedAtCall, [true], 'The installer runs only after completed is true')
  assert.deepEqual(harness.installer.calls, [CANDIDATE])
  assert.deepEqual(harness.exitRequests, [{ candidate: CANDIDATE }])
  assert.equal(harness.appQuit.count, 0)
  assert.equal(harness.failures.length, 0)
})

test('A failed host drain installs nothing and keeps the update READY', async () => {
  const failure = new Error('host close failed')
  const harness = exitHarness({ hostClose: async () => { throw failure } })
  await harness.reachReady()
  const result = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_FAILURE.INSTALL_EXIT_FAILED)
  assert.equal(harness.coordinator.completed, false)
  assert.equal(harness.installer.calls.length, 0, 'A failed drain never reaches an install')
  assert.equal(harness.appQuit.count, 0)
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY)
  assert.equal(harness.failures.length, 1)
})

test('A failed afterDrain installs nothing and keeps the update READY', async () => {
  const harness = exitHarness({ afterDrain() { throw new Error('native cleanup failed') } })
  await harness.reachReady()
  const result = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_FAILURE.INSTALL_EXIT_FAILED)
  assert.equal(harness.coordinator.completed, false)
  assert.equal(harness.installer.calls.length, 0)
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY)
})

// Contract A: the request never entered shutdown, so the process is untouched and a retry is real.
test('A gate rejection before any shutdown closes nothing and the same process can retry', async () => {
  const harness = exitHarness({ scope: { activeOperations: 1 } })
  await harness.reachReady()
  const blocked = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reasonCode, UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS)
  assert.deepEqual(harness.order, [], 'A gate rejection never begins a shutdown')
  assert.equal(harness.exitRequests.length, 0)
  assert.equal(harness.coordinator.requested, false, 'Nothing was closed')
  assert.equal(harness.coordinator.completed, false)
  assert.equal(harness.installer.calls.length, 0)

  // The operator clears the blocking condition. Same process, same coordinator, same candidate.
  harness.hostState.activeOperations = 0
  const retried = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(retried.ok, true)
  assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'finalQuit', 'install'])
  assert.equal(harness.installer.calls.length, 1)
  assert.equal(harness.coordinator.observations.shutdownOperations, 1)
  assert.equal(harness.coordinatorCreations, 1)
})

// Contract B: the drain was entered and failed. The coordinator caches its rejected operation and
// never resets requested/completed, so the process cannot drain again and must not install.
test('A drain that already failed is not a recovery: a second confirmation cannot install', async () => {
  const failure = new Error('host close failed')
  const harness = exitHarness({ hostClose: async () => { throw failure } })
  await harness.reachReady()
  const first = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(first.ok, false)
  assert.equal(first.reasonCode, UPDATER_FAILURE.INSTALL_EXIT_FAILED)
  assert.equal(harness.installer.calls.length, 0)
  assert.equal(harness.coordinator.requested, true)
  assert.equal(harness.coordinator.completed, false, 'A failed drain never completes')
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY, 'The candidate is retained, not installable')

  // The updater released its own install latch, but the shutdown flag comes from the real
  // coordinator: requested, never completed, for the rest of the process lifetime.
  const second = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.SHUTDOWN_IN_FLIGHT)
  assert.equal(harness.exitRequests.length, 1, 'The failed attempt is never repeated')
  assert.equal(harness.coordinator.observations.shutdownOperations, 1, 'No second drain is started')
  assert.equal(harness.coordinator.observations.finalQuitRequests, 0)
  assert.equal(harness.installer.calls.length, 0)
  assert.equal(harness.coordinatorCreations, 1, 'No replacement coordinator pretends the process recovered')
  assert.equal(harness.failures.length, 1, 'The failure is reported once, not re-run')
})

test('Even a permissive blocker reading cannot install after a failed drain', async () => {
  const failure = new Error('host close failed')
  // truthfulShutdownFlag: false models a provider that wrongly reports an idle shutdown.
  const harness = exitHarness({ hostClose: async () => { throw failure }, truthfulShutdownFlag: false })
  await harness.reachReady()
  await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  const second = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_FAILURE.INSTALL_EXIT_FAILED)
  // The install guarantee is structural, not provider-dependent: requestFinalQuit is only ever
  // reached after a completed drain, and a failed drain never completes. A wrong reading can
  // waste one attempt; it cannot install.
  assert.equal(harness.installer.calls.length, 0)
  assert.equal(harness.coordinator.completed, false)
  assert.equal(harness.coordinator.observations.shutdownOperations, 1, 'The memoized rejection is reused')
  assert.equal(harness.coordinator.observations.finalQuitRequests, 0)
  assert.equal(harness.failures.length, 1, 'The single attached continuation reports the failure once')
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY)
})

test('Two install clicks produce one exit request and one install', async () => {
  const harness = exitHarness()
  await harness.reachReady()
  const first = harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  const second = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS)
  assert.equal((await first).ok, true)
  assert.equal(harness.exitRequests.length, 1)
  assert.equal(harness.installer.calls.length, 1)
})

test('Repeated quit requests still install exactly once', async () => {
  const harness = exitHarness()
  await harness.reachReady()
  harness.authorization.candidate = { ...CANDIDATE }
  harness.quitRequest()
  harness.quitRequest()
  await harness.finish()
  assert.equal(harness.coordinator.observations.quitRequests, 2)
  assert.equal(harness.coordinator.observations.finalQuitRequests, 1)
  assert.equal(harness.installer.calls.length, 1, 'The single final exit installs once')
})

test('An install request before the update is READY never reaches the exit', async () => {
  const harness = exitHarness()
  const result = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.NOT_READY)
  assert.deepEqual(harness.order, [], 'A refused install does not start any shutdown')
  assert.equal(harness.exitRequests.length, 0)
  assert.equal(harness.installer.calls.length, 0)
})

test('A busy managed scope never reaches the exit', async () => {
  const harness = exitHarness({ scope: { activeOperations: 1, pendingCheckpoints: 1 } })
  await harness.reachReady()
  const result = await harness.updater.requestRestartAndInstall({ ...CANDIDATE })
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS)
  assert.ok(result.reasons.includes(UPDATER_BLOCK_REASON.PENDING_CHECKPOINT))
  assert.deepEqual(harness.order, [], 'A blocked install never stops admission')
  assert.equal(harness.installer.calls.length, 0)
})
