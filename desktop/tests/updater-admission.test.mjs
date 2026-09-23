import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNovaWingLaunchpad } from 'nova-wing/development-guardian'
import { createDesktopHost } from '../main/host.mjs'
import { createShutdownCoordinator } from '../main/shutdown.mjs'
import {
  createFinalQuitAction, createInstallAuthorization, createUnconfiguredBackend, createUpdaterLifecycle,
  resolveUpdaterCapability,
} from '../main/updater-lifecycle.mjs'
import { UPDATER_BLOCK_REASON, UPDATER_STATE } from '../main/updater.mjs'

// Atomic install admission, driven end to end: the real updater, the real lifecycle assembly, the
// real Desktop Host, the real strict shutdown coordinator and a real Launchpad admission chain.
// Only the backend, the installer and the managed Work Session apps are stand-ins.

const CANDIDATE = { version: '0.4.2', identity: 'sha512-candidate-042' }
const CONFIRMATION = { version: '0.4.2', identity: 'sha512-candidate-042' }

const IDLE_SAFETY = () => ({
  readable: true, reasonCode: null, inFlightOperations: 0,
  pendingHumanDecision: false, pendingRecoveryCheckpoint: false,
})

function deferred() {
  /** @type {() => void} */
  let resolve = () => {}
  /** @type {(error: unknown) => void} */
  let reject = () => {}
  /** @type {Promise<void>} */
  const promise = new Promise((res, rej) => { resolve = () => res(); reject = rej })
  return { promise, resolve, reject }
}

function configuration(index) {
  return {
    session: {
      id: `admission-${index}`, targetRepo: process.cwd(), branch: 'main',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
    },
    tasks: [{ id: 'ADM-001', goal: 'Verify atomic install admission.', guardian: {
      constraints: ['keep scope narrow'], acceptanceCriteria: ['tests pass'],
      doNotDo: ['do not access credentials'], allowedPaths: ['packages/**'], forbiddenPaths: ['secrets/**'],
    } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
    notification: { email: { enabled: false } },
  }
}

async function configDirectory(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-admission-'))
  for (let index = 0; index < count; index++) {
    await writeFile(join(directory, `session-${index}.json`), JSON.stringify(configuration(index)), 'utf8')
  }
  return directory
}

/**
 * @typedef {{ readable: boolean, reasonCode: string | null, inFlightOperations: number,
 *   pendingHumanDecision: boolean, pendingRecoveryCheckpoint: boolean }} SafetyView
 * @typedef {{ createGate?: ReturnType<typeof deferred>, startGate?: ReturnType<typeof deferred>,
 *   closeGate?: ReturnType<typeof deferred>, safety?: () => SafetyView }} ManagedAppOptions
 * @typedef {{ platform?: string, packaged?: boolean,
 *   backend?: { check: () => Promise<{ available: boolean }>,
 *     download: (candidate: unknown) => Promise<unknown> } | null,
 *   installer?: ((intent: { version: string, identity: string }) => unknown) | null }} LifecycleOverrides
 * @typedef {{ apps?: ReturnType<typeof managedApps>, hostClose?: () => Promise<unknown>,
 *   afterDrain?: () => void, lifecycle?: LifecycleOverrides }} HarnessOptions
 */

/** Managed apps with controllable create/start/close gates and a controllable safety reading.
 * @param {ManagedAppOptions} [options] */
function managedApps({ createGate, startGate, closeGate, safety } = {}) {
  const state = { created: 0, started: 0, closed: 0 }
  const entered = { create: deferred(), start: deferred(), close: deferred() }
  const create = async () => {
    const index = state.created++
    entered.create.resolve()
    if (createGate) await createGate.promise
    let closed = false
    return {
      controller: { start() { return { started: true } }, getUpdateSafetyView: safety ?? IDLE_SAFETY },
      async start() {
        state.started++
        entered.start.resolve()
        if (startGate) await startGate.promise
        return { url: `http://127.0.0.1:${56000 + index}` }
      },
      isLive() { return !closed },
      hasActiveSession() { return false },
      async close() { state.closed++; entered.close.resolve(); if (closeGate) await closeGate.promise; closed = true },
    }
  }
  return { state, entered, create }
}

/** True while the Launchpad still accepts new work. */
const admissionOpen = (launchpad) => !/** @type {{ closed: boolean }} */ (/** @type {unknown} */ (launchpad)).closed

/** @param {HarnessOptions} [options] */
async function admissionHarness({ apps = managedApps(), hostClose, afterDrain, lifecycle = {} } = {}) {
  const directory = await configDirectory(1)
  const order = []
  const failures = []
  const installs = []
  const appQuit = { count: 0 }
  const coordinatorRef = { current: undefined }
  let launchpad

  const backend = { check: async () => ({ available: true, candidate: { ...CANDIDATE } }), download: async () => ({ downloaded: true }) }
  const update = createUpdaterLifecycle({
    // A packaged Windows host is the only configuration where an install is permitted today.
    platform: 'win32', packaged: true, backend,
    ...lifecycle,
    installer: 'installer' in lifecycle
      ? lifecycle.installer
      : (intent) => { installs.push({ intent, completed: coordinatorRef.current.completed }); order.push('install') },
    reportFailure: (error) => { failures.push(error) },
  })

  const launchpadFactory = async (options) => {
    launchpad = await createNovaWingLaunchpad({
      configDirectory: options.configDirectory, shutdownMode: 'strict',
      dependencies: {
        readSessionStatus: async () => 'READY',
        readCodexAvailability: () => ({ state: 'available' }),
        resolveEnvironment: async () => ({}),
        gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
        repairAudit: { async record() {} },
        repairNotifier: { async notify() {} },
        ...options.dependencies,
      },
    })
    return launchpad
  }

  const host = await createDesktopHost({
    configDirectory: directory, env: {},
    dependencies: { createWorkSession: apps.create },
    launchpadFactory,
  })
  await host.start()

  coordinatorRef.current = createShutdownCoordinator({
    getStartup: async () => { order.push('startup') },
    getHost: () => ({
      // host.close() is called synchronously, exactly as the product does, so the admission stop
      // is not deferred by this harness. The optional hook only delays or fails the drain.
      close() {
        order.push('close')
        const closing = host.close()
        return hostClose ? hostClose().then(() => closing) : closing
      },
    }),
    afterDrain() { order.push('afterDrain'); if (afterDrain) afterDrain() },
    requestFinalQuit: update.finalQuit({ quit: () => { order.push('quit'); appQuit.count++ } }),
    reportFailure: (error) => { failures.push(error) },
  })

  const updater = update.createUpdater({
    host,
    requestQuit: () => coordinatorRef.current.requestQuit(),
    readShutdownState: () => coordinatorRef.current,
  })

  return {
    directory, host, apps, order, failures, installs, appQuit, update, updater,
    get launchpad() { return launchpad },
    get coordinator() { return coordinatorRef.current },
    async cleanup() {
      await coordinatorRef.current.shutdown().catch(() => undefined)
      // A failed drain may never have reached the Host, so close it directly as well.
      await host.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function reachReady(harness) {
  const checked = await harness.updater.check()
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const downloaded = await harness.updater.download()
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded))
  assert.equal(harness.updater.snapshot().state, UPDATER_STATE.READY)
}

async function startSession(harness) {
  const launchpad = harness.launchpad
  const address = launchpad.getAddress()
  return fetch(`${address.url}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: address.url, 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest() },
    body: JSON.stringify({ configId: launchpad.getConfigs()[0].configId }),
  })
}

test('a snapshot that read idle does not authorize an install once work has been admitted', async () => {
  const createGate = deferred()
  const apps = managedApps({ createGate })
  const harness = await admissionHarness({ apps })
  try {
    await reachReady(harness)
    const before = harness.host.updateSafetySnapshot({ readShutdownState: () => harness.coordinator })
    assert.equal(before.readable, true)
    assert.equal(before.activeOperations, 0, 'the earlier reading really was idle')

    const pending = startSession(harness)
    await apps.entered.create.promise

    const blocked = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(blocked.ok, false)
    assert.ok(blocked.reasons.includes(UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS), JSON.stringify(blocked))
    assert.equal(harness.coordinator.requested, false, 'a refused install never starts a shutdown')
    assert.equal(admissionOpen(harness.launchpad), true, 'the Host is still accepting work')
    assert.equal(harness.installs.length, 0)

    createGate.resolve()
    await pending
  } finally {
    createGate.resolve()
    await harness.cleanup()
  }
})

test('the install request stops real admission synchronously, before the caller first awaits', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    assert.equal(admissionOpen(harness.launchpad), true)

    const operation = harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    // No await has happened yet: the gate, the authorization and the admission stop must already
    // be done, or work could be admitted into a shutdown the user never agreed to.
    assert.equal(harness.coordinator.requested, true, 'the shared coordinator is already draining')
    assert.equal(admissionOpen(harness.launchpad), false, 'real admission is already closed')

    assert.equal((await operation).ok, true)
    assert.equal(harness.installs.length, 1)
    assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'install'], 'an authorized install replaces the ordinary quit')
  } finally {
    await harness.cleanup()
  }
})

/** A closed Host may answer 503 while the drain runs, or already refuse the connection. */
async function startRefusal(harness) {
  try {
    const response = await startSession(harness)
    await response.arrayBuffer()
    return response.status
  } catch (error) {
    if (error instanceof TypeError) return 'connection-refused'
    throw error
  }
}

test('once admission is closed a real session start is refused and creates nothing', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    const operation = harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    const refusal = await startRefusal(harness)
    assert.ok(refusal === 503 || refusal === 'connection-refused', `expected a refusal, got ${refusal}`)
    assert.equal(harness.apps.state.created, 0, 'no new session was created during the drain')
    assert.equal(harness.apps.state.started, 0)
    assert.equal((await operation).ok, true)
  } finally {
    await harness.cleanup()
  }
})

/** @type {Array<[string, () => SafetyView, string]>} */
const BLOCKERS = [
  ['a session holding a recovery checkpoint', () => ({ readable: true, reasonCode: null, inFlightOperations: 0, pendingHumanDecision: false, pendingRecoveryCheckpoint: true }), UPDATER_BLOCK_REASON.PENDING_CHECKPOINT],
  ['a session waiting for a human', () => ({ readable: true, reasonCode: null, inFlightOperations: 0, pendingHumanDecision: true, pendingRecoveryCheckpoint: false }), UPDATER_BLOCK_REASON.PENDING_HUMAN_DECISION],
  ['unsettled lifecycle work', () => ({ readable: true, reasonCode: null, inFlightOperations: 1, pendingHumanDecision: false, pendingRecoveryCheckpoint: false }), UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS],
  ['an owner whose state cannot be read', () => ({ readable: false, reasonCode: 'STATE_NOT_HYDRATED', inFlightOperations: 0, pendingHumanDecision: false, pendingRecoveryCheckpoint: false }), UPDATER_BLOCK_REASON.STATE_UNKNOWN],
]
for (const [label, safety, expected] of BLOCKERS) {
  test(`the install is refused before any shutdown for ${label}`, async () => {
    const apps = managedApps({ safety })
    const harness = await admissionHarness({ apps })
    try {
      await reachReady(harness)
      assert.equal((await startSession(harness)).status, 202)
      const blocked = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
      assert.equal(blocked.ok, false)
      assert.ok(blocked.reasons.includes(expected), `${label}: ${JSON.stringify(blocked)}`)
      assert.equal(harness.coordinator.requested, false)
      assert.equal(admissionOpen(harness.launchpad), true, 'a blocked install never closes the Host')
      assert.equal(harness.installs.length, 0)
    } finally {
      await harness.cleanup()
    }
  })
}

test('an unreadable owner is reported as unreadable by the Host, never as idle', async () => {
  const apps = managedApps({ safety: () => ({ readable: false, reasonCode: 'STATE_NOT_HYDRATED', inFlightOperations: 0, pendingHumanDecision: false, pendingRecoveryCheckpoint: false }) })
  const harness = await admissionHarness({ apps })
  try {
    await reachReady(harness)
    assert.equal((await startSession(harness)).status, 202)
    const snapshot = harness.host.updateSafetySnapshot({ readShutdownState: () => harness.coordinator })
    assert.equal(snapshot.readable, false)
    assert.equal(snapshot.reasonCode, 'STATE_NOT_HYDRATED')
    assert.equal(snapshot.shutdownInFlight, true, 'an unreadable snapshot is never installable')
  } finally {
    await harness.cleanup()
  }
})

test('a delayed drain keeps the installer at zero and then installs exactly once', async () => {
  const gate = deferred()
  const harness = await admissionHarness({ hostClose: () => gate.promise })
  try {
    await reachReady(harness)
    const operation = harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.coordinator.requested, true)
    assert.equal(harness.installs.length, 0, 'a drain still running never installs')
    assert.equal(harness.coordinator.completed, false)

    gate.resolve()
    assert.equal((await operation).ok, true)
    assert.equal(harness.installs.length, 1, 'exactly one install after the drain settles')
    assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'install'])
  } finally {
    gate.resolve()
    await harness.cleanup()
  }
})

test('a failed host close installs nothing and cannot be revived by a retry', async () => {
  const harness = await admissionHarness({ hostClose: async () => { throw new Error('host close failed') } })
  try {
    await reachReady(harness)
    const first = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(first.ok, false)
    assert.equal(harness.installs.length, 0)
    assert.equal(harness.coordinator.completed, false)
    assert.equal(harness.coordinator.requested, true)

    const second = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(second.ok, false)
    assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.SHUTDOWN_IN_FLIGHT)
    assert.equal(harness.installs.length, 0)
    assert.equal(harness.coordinator.observations.shutdownOperations, 1, 'no second drain is started')
    assert.equal(harness.coordinator.observations.finalQuitRequests, 0)
  } finally {
    await harness.cleanup()
  }
})

test('a failed afterDrain installs nothing', async () => {
  const harness = await admissionHarness({ afterDrain() { throw new Error('cleanup failed') } })
  try {
    await reachReady(harness)
    const result = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(result.ok, false)
    assert.equal(harness.coordinator.completed, false)
    assert.equal(harness.installs.length, 0)
    assert.equal(harness.appQuit.count, 0, 'a failed drain never falls back to an ordinary quit')
  } finally {
    await harness.cleanup()
  }
})

test('a double click, a re-entrant quit and repeated requests install once', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    const first = harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    const second = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(second.ok, false)
    assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS)

    // A re-entrant quit request while the drain is settling must not produce a second install.
    harness.coordinator.requestQuit()
    assert.equal((await first).ok, true)
    assert.equal(harness.installs.length, 1)
    assert.equal(harness.coordinator.observations.shutdownOperations, 1)
    assert.equal(harness.coordinator.observations.finalQuitRequests, 1)
  } finally {
    await harness.cleanup()
  }
})

test('an ordinary quit never installs, even while an update is READY', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    harness.coordinator.beforeQuit({ preventDefault() {} })
    await harness.coordinator.shutdown()
    assert.equal(harness.installs.length, 0)
    assert.equal(harness.appQuit.count, 1, 'the ordinary quit is unchanged')
    assert.deepEqual(harness.order, ['close', 'startup', 'afterDrain', 'quit'])
  } finally {
    await harness.cleanup()
  }
})

test('the installer runs after completed, with exactly the candidate the user confirmed', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(harness.installs.length, 1)
    assert.equal(harness.installs[0].completed, true, 'the installer sees a completed drain')
    assert.deepEqual(harness.installs[0].intent, CANDIDATE, 'the bound candidate is the confirmed one')
    assert.equal(harness.update.authorization.snapshot().consumed, true)
  } finally {
    await harness.cleanup()
  }
})

test('a late request after dispose is refused and never reaches the exit', async () => {
  const harness = await admissionHarness()
  try {
    await reachReady(harness)
    harness.updater.dispose()
    const late = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(late.ok, false)
    assert.equal(late.reasonCode, UPDATER_BLOCK_REASON.DISPOSED)
    assert.equal(harness.coordinator.requested, false)
    assert.equal(harness.installs.length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('cleanup during the drain does not erase an already authorized intent', async () => {
  const gate = deferred()
  const harness = await admissionHarness({ hostClose: () => gate.promise })
  try {
    await reachReady(harness)
    const operation = harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    // The authorization is held by the exit assembly, so tearing the updater down mid-drain
    // cannot lose what the final quit still has to consume.
    harness.updater.dispose()
    assert.equal(harness.update.authorization.snapshot().bound, true)
    assert.equal(harness.update.authorization.snapshot().consumed, false)

    gate.resolve()
    await operation
    assert.equal(harness.installs.length, 1)
  } finally {
    gate.resolve()
    await harness.cleanup()
  }
})

test('a throwing installer fails loudly and is never retried or hidden as a quit', async () => {
  const harness = await admissionHarness({ lifecycle: { installer: () => { throw new Error('installer exploded') } } })
  try {
    await reachReady(harness)
    const operation = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(operation.ok, true, 'admission itself succeeded; the failure is in the install action')
    assert.equal(harness.appQuit.count, 0, 'a broken install is never disguised as an ordinary quit')
    assert.equal(harness.failures.some((error) => String(error?.message ?? '').includes('installer exploded')), true)
    assert.equal(harness.coordinator.observations.finalQuitRequests, 1)
    assert.equal(harness.update.authorization.snapshot().consumed, true, 'never retried')
  } finally {
    await harness.cleanup()
  }
})

test('the production assembly is not installable and says why, without closing anything', async () => {
  const harness = await admissionHarness({ lifecycle: { backend: null, installer: null } })
  try {
    const snapshot = harness.updater.snapshot()
    assert.equal(snapshot.state, UPDATER_STATE.UNSUPPORTED)
    assert.equal(snapshot.reasonCode, 'UPDATER_NOT_CONFIGURED')
    assert.equal(snapshot.capability.installable, false)

    const refused = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
    assert.equal(refused.ok, false)
    assert.equal(refused.reasonCode, 'UPDATER_NOT_CONFIGURED')
    assert.equal((await harness.updater.check()).ok, false, 'a not-configured product never checks')
    assert.equal(harness.coordinator.requested, false, 'nothing was closed to discover the gap')
    assert.equal(admissionOpen(harness.launchpad), true)
    assert.equal(harness.installs.length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('the capability policy grants an install only to a packaged Windows host', () => {
  // Windows from a packaged app: TECHNICALLY POSSIBLE, explicitly unsigned, never trusted.
  assert.deepEqual(resolveUpdaterCapability({ platform: 'win32', packaged: true, configured: true }), {
    platform: 'win32', installable: true, reasonCode: null, signature: 'unsigned', unsignedInstallApproved: true,
  })
  // macOS stays blocked by signing even though the adapter could read a feed.
  assert.deepEqual(resolveUpdaterCapability({ platform: 'darwin', packaged: true, configured: true }), {
    platform: 'darwin', installable: false, reasonCode: 'BLOCKED_BY_SIGNING', signature: 'unsigned',
  })
  // An unpackaged run is never installable, whatever the host.
  assert.equal(resolveUpdaterCapability({ platform: 'win32', packaged: false, configured: true }).reasonCode, 'UPDATER_REQUIRES_PACKAGED_APP')
  // No adapter means nothing is configured.
  assert.equal(resolveUpdaterCapability({ platform: 'win32', packaged: true, configured: false }).reasonCode, 'UPDATER_NOT_CONFIGURED')
  assert.equal(resolveUpdaterCapability({ platform: 'linux', packaged: true, configured: true }).reasonCode, 'UPDATER_PLATFORM_UNSUPPORTED')
})

test('a configured macOS or unpackaged host still refuses the install before closing anything', async () => {
  /** @type {Array<[string, LifecycleOverrides, string]>} */
  const cases = [
    ['macOS', { platform: 'darwin', packaged: true }, 'BLOCKED_BY_SIGNING'],
    ['an unpackaged run', { platform: 'win32', packaged: false }, 'UPDATER_REQUIRES_PACKAGED_APP'],
  ]
  for (const [label, lifecycle, expected] of cases) {
    const harness = await admissionHarness({ lifecycle })
    try {
      const snapshot = harness.updater.snapshot()
      assert.equal(snapshot.state, UPDATER_STATE.UNSUPPORTED, label)
      assert.equal(snapshot.reasonCode, expected, label)
      const refused = await harness.updater.requestRestartAndInstall({ ...CONFIRMATION })
      assert.equal(refused.ok, false, label)
      assert.equal(refused.reasonCode, expected, label)
      assert.equal(harness.coordinator.requested, false, `${label}: nothing was closed`)
      assert.equal(admissionOpen(harness.launchpad), true, label)
      assert.equal(harness.installs.length, 0, label)
    } finally {
      await harness.cleanup()
    }
  }
})

test('an authorized intent without a callable installer fails loudly instead of quitting', () => {
  const failures = []
  let quit = 0
  const authorization = createInstallAuthorization()
  authorization.bind(CANDIDATE)
  const action = createFinalQuitAction({
    authorization, installer: null, quit: () => { quit++ }, reportFailure: (error) => failures.push(error),
  })
  action()
  assert.equal(quit, 0, 'a broken install never becomes an ordinary quit')
  assert.equal(failures.length, 1)
  assert.match(String(failures[0].message), /UPDATER_INSTALL_NOT_CONFIGURED/u)
  assert.equal(authorization.snapshot().consumed, true, 'the intent is consumed once, not left to retry')
})

test('the final quit action installs once and only for a bound authorization', () => {
  const installs = []
  let quit = 0
  const authorization = createInstallAuthorization()
  const action = createFinalQuitAction({ authorization, installer: (intent) => installs.push(intent), quit: () => { quit++ } })
  action()
  assert.equal(quit, 1, 'no authorization means the ordinary quit')
  assert.deepEqual(installs, [])

  authorization.bind({ version: '9.9.9', identity: 'bound-first' })
  authorization.bind({ version: '1.1.1', identity: 'a-later-event' })
  action()
  action()
  assert.deepEqual(installs, [{ version: '9.9.9', identity: 'bound-first' }], 'bound once, consumed once')
  // The third call finds the intent consumed, so it takes the ordinary quit path.
  assert.equal(quit, 2)
})

test('the unconfigured backend refuses instead of pretending a check happened', async () => {
  const backend = createUnconfiguredBackend()
  await assert.rejects(backend.check(), /not configured/u)
  await assert.rejects(backend.download(CANDIDATE), /not configured/u)
})
