import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDesktopUpdater, UPDATER_BLOCK_REASON, UPDATER_FAILURE, UPDATER_STATE,
} from '../main/updater.mjs'

/**
 * @typedef {{ platform: string, installable: boolean, reasonCode?: string | null,
 *   signature: 'signed' | 'unsigned' | 'unknown', unsignedInstallApproved?: boolean }} TestCapability
 * @typedef {{ available: boolean, candidate?: { version: string, identity: string } }} CheckResponse
 * @typedef {{ check?: () => Promise<unknown>,
 *   download?: (candidate: { version: string, identity: string }) => Promise<unknown>,
 *   blockers?: () => unknown, capability?: TestCapability | null,
 *   installExit?: (request: { candidate: { version: string, identity: string } }) => Promise<unknown>,
 *   reportFailure?: () => void }} FixtureOverrides
 * @typedef {{ controller: ReturnType<typeof createDesktopUpdater>,
 *   calls: { check: number, download: number, exit: number, blockers: number },
 *   exitRequests: Array<{ candidate: { version: string, identity: string } }> }} Fixture
 */

const CANDIDATE = { version: '0.4.2', identity: 'sha512-candidate-042' }
const CONFIRMATION = { version: '0.4.2', identity: 'sha512-candidate-042' }
const IDLE_BLOCKERS = { readable: true, activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0, shutdownInFlight: false }
// A capability is an explicit decision, never a platform inference. Tests that install must say so.
/** @type {TestCapability} */
const SIGNED_CAPABILITY = { platform: 'win32', installable: true, signature: 'signed' }
// The shape a future adapter could hand over by mistake: no field at all, so nothing is granted.
const EMPTY_CAPABILITY = /** @type {TestCapability} */ ({})

function deferred() {
  const completion = Promise.withResolvers()
  return { promise: completion.promise, resolve: completion.resolve, reject: completion.reject }
}

/** @param {FixtureOverrides} [overrides] @returns {Fixture} */
function fixture(overrides = {}) {
  const calls = { check: 0, download: 0, exit: 0, blockers: 0 }
  /** @type {Fixture['exitRequests']} */
  const exitRequests = []
  const check = overrides.check ?? (async () => ({ available: true, candidate: { ...CANDIDATE } }))
  const download = overrides.download ?? (async () => ({ downloaded: true }))
  const blockers = overrides.blockers ?? (() => ({ ...IDLE_BLOCKERS }))
  const controller = createDesktopUpdater({
    backend: {
      check: async () => { calls.check++; return /** @type {CheckResponse} */ (await check()) },
      download: async (candidate) => { calls.download++; return download(candidate) },
    },
    capability: 'capability' in overrides ? overrides.capability : SIGNED_CAPABILITY,
    getBlockers: () => { calls.blockers++; return blockers() },
    requestInstallExit: async (request) => {
      calls.exit++
      exitRequests.push(request)
      if (overrides.installExit) await overrides.installExit(request)
    },
    ...(overrides.reportFailure === undefined ? {} : { reportFailure: overrides.reportFailure }),
  })
  return { controller, calls, exitRequests }
}

/** Reach READY through the real transitions, never by writing state directly.
 * @param {FixtureOverrides} [overrides] @returns {Promise<Fixture>} */
async function ready(overrides = {}) {
  const context = fixture(overrides)
  assert.equal((await context.controller.check()).ok, true)
  assert.equal((await context.controller.download()).ok, true)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.READY)
  return context
}

test('Creating a controller observes nothing and starts IDLE', () => {
  const context = fixture()
  const snapshot = context.controller.snapshot()
  assert.equal(snapshot.state, UPDATER_STATE.IDLE)
  assert.equal(snapshot.reasonCode, null)
  assert.equal(snapshot.candidate, null)
  assert.equal(snapshot.disposed, false)
  assert.equal(context.calls.check, 0, 'A controller never checks on construction')
  assert.equal(context.calls.download, 0)
  assert.equal(context.calls.exit, 0)
  assert.equal(context.calls.blockers, 0)
})

test('The published snapshot carries its exact reviewed fields', () => {
  const context = fixture()
  assert.deepEqual(Object.keys(context.controller.snapshot()).sort(),
    ['candidate', 'capability', 'disposed', 'lastError', 'observations', 'reasonCode', 'state'])
})

test('A check with an update reaches AVAILABLE and retains the candidate identity', async () => {
  const context = fixture()
  const result = await context.controller.check()
  assert.equal(result.ok, true)
  assert.equal(result.state, UPDATER_STATE.AVAILABLE)
  assert.deepEqual(result.candidate, CANDIDATE)
  assert.deepEqual(context.controller.snapshot().candidate, CANDIDATE)
})

test('A check without an update returns to IDLE', async () => {
  const context = fixture({ check: async () => ({ available: false }) })
  const result = await context.controller.check()
  assert.equal(result.ok, true)
  assert.equal(result.state, UPDATER_STATE.IDLE)
  assert.equal(result.candidate, null)
  assert.equal(context.controller.snapshot().reasonCode, null)
})

test('A check failure is diagnosable and an explicit retry can still succeed', async () => {
  let fail = true
  const context = fixture({ check: async () => { if (fail) throw new Error('feed unavailable'); return { available: true, candidate: { ...CANDIDATE } } } })
  const failure = await context.controller.check()
  assert.equal(failure.ok, false)
  assert.equal(failure.reasonCode, UPDATER_FAILURE.CHECK_FAILED)
  const snapshot = context.controller.snapshot()
  assert.equal(snapshot.state, UPDATER_STATE.ERROR)
  assert.equal(snapshot.lastError.message, 'feed unavailable')
  assert.equal(snapshot.candidate, null)
  fail = false
  assert.equal((await context.controller.check()).state, UPDATER_STATE.AVAILABLE)
  assert.equal(context.controller.snapshot().lastError, null)
})

test('A backend contract violation fails closed instead of reaching AVAILABLE', async () => {
  /** @type {Array<[string, () => Promise<unknown>]>} */
  const responses = [
    ['no response at all', async () => undefined],
    ['a non-boolean availability flag', async () => ({ available: 'yes' })],
    ['an update with no candidate', async () => ({ available: true })],
    ['a candidate without an identity', async () => ({ available: true, candidate: { version: '0.4.2' } })],
  ]
  for (const [label, check] of responses) {
    const context = fixture({ check })
    const result = await context.controller.check()
    assert.equal(result.ok, false, label)
    assert.equal(context.controller.snapshot().state, UPDATER_STATE.ERROR, label)
    assert.equal(context.controller.snapshot().candidate, null, label)
    assert.ok([UPDATER_FAILURE.BACKEND_CONTRACT, UPDATER_FAILURE.CANDIDATE_MISSING].some((code) => code === result.reasonCode), label)
  }
})

test('A download is accepted only from AVAILABLE', async () => {
  const context = fixture()
  const result = await context.controller.download()
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.NOT_AVAILABLE)
  assert.equal(context.calls.download, 0, 'A refused download never reaches the backend')
})

test('A download reaches READY and keeps the checked candidate, not the download response', async () => {
  const context = fixture({ download: async () => ({ version: '9.9.9', identity: 'substituted' }) })
  await context.controller.check()
  const result = await context.controller.download()
  assert.equal(result.state, UPDATER_STATE.READY)
  assert.deepEqual(result.candidate, CANDIDATE)
  assert.deepEqual(context.controller.snapshot().candidate, CANDIDATE)
})

test('A download failure is diagnosable and an explicit retry can still succeed', async () => {
  let fail = true
  const context = fixture({ download: async () => { if (fail) throw new Error('transfer interrupted') } })
  await context.controller.check()
  const failure = await context.controller.download()
  assert.equal(failure.reasonCode, UPDATER_FAILURE.DOWNLOAD_FAILED)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.ERROR)
  assert.equal(context.controller.snapshot().lastError.message, 'transfer interrupted')
  assert.equal(context.controller.snapshot().candidate, null, 'A failed download is not a ready candidate')
  fail = false
  await context.controller.check()
  assert.equal((await context.controller.download()).state, UPDATER_STATE.READY)
})

test('A repeated check while checking is refused and the backend is asked once', async () => {
  const gate = deferred()
  const context = fixture({ check: async () => { await gate.promise; return { available: true, candidate: { ...CANDIDATE } } } })
  const first = context.controller.check()
  const second = await context.controller.check()
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.CHECK_IN_PROGRESS)
  gate.resolve()
  assert.equal((await first).state, UPDATER_STATE.AVAILABLE)
  assert.equal(context.calls.check, 1)
})

test('A repeated download while downloading is refused: there are never two parallel downloads', async () => {
  const gate = deferred()
  const context = fixture({ download: async () => { await gate.promise } })
  await context.controller.check()
  const first = context.controller.download()
  const second = await context.controller.download()
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.DOWNLOAD_IN_PROGRESS)
  gate.resolve()
  assert.equal((await first).state, UPDATER_STATE.READY)
  assert.equal(context.calls.download, 1)
})

test('A repeated check cannot replace the READY candidate', async () => {
  const context = await ready()
  const retained = context.controller.snapshot().candidate
  const result = await context.controller.check()
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.UPDATE_ALREADY_READY)
  assert.deepEqual(context.controller.snapshot().candidate, retained)
  assert.equal(context.calls.check, 1)
})

test('An explicit re-check from AVAILABLE is allowed and a lost update returns to IDLE', async () => {
  let available = true
  const context = fixture({ check: async () => available ? { available: true, candidate: { ...CANDIDATE } } : { available: false } })
  await context.controller.check()
  available = false
  const result = await context.controller.check()
  assert.equal(result.state, UPDATER_STATE.IDLE)
  assert.equal(context.controller.snapshot().candidate, null)
})

test('An install is refused unless the update is READY', async () => {
  const context = fixture()
  assert.equal((await context.controller.requestRestartAndInstall(CONFIRMATION)).reasonCode, UPDATER_BLOCK_REASON.NOT_READY)
  await context.controller.check()
  const available = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(available.reasonCode, UPDATER_BLOCK_REASON.NOT_READY)
  assert.equal(context.calls.exit, 0)
})

test('An install requires a confirmation that matches the retained candidate', async () => {
  const context = await ready()
  /** @type {Array<[unknown, string]>} */
  const attempts = [
    [undefined, UPDATER_BLOCK_REASON.CONFIRMATION_REQUIRED],
    [null, UPDATER_BLOCK_REASON.CONFIRMATION_REQUIRED],
    [{}, UPDATER_BLOCK_REASON.CONFIRMATION_REQUIRED],
    [{ version: CANDIDATE.version }, UPDATER_BLOCK_REASON.CONFIRMATION_REQUIRED],
    [{ version: '0.4.3', identity: CANDIDATE.identity }, UPDATER_BLOCK_REASON.CANDIDATE_MISMATCH],
    [{ version: CANDIDATE.version, identity: 'sha512-other' }, UPDATER_BLOCK_REASON.CANDIDATE_MISMATCH],
  ]
  for (const [confirmation, expected] of attempts) {
    const result = await context.controller.requestRestartAndInstall(/** @type {{ version?: unknown, identity?: unknown } | null} */ (confirmation))
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, expected)
  }
  assert.equal(context.calls.exit, 0)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.READY)
})

/** @type {Array<[string, Record<string, unknown>, string]>} */
const BUSY_HOSTS = [
  ['an active operation', { activeOperations: 2 }, UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS],
  ['a pending human decision', { pendingHumanDecisions: 1 }, UPDATER_BLOCK_REASON.PENDING_HUMAN_DECISION],
  ['a pending checkpoint', { pendingCheckpoints: 3 }, UPDATER_BLOCK_REASON.PENDING_CHECKPOINT],
  ['a shutdown already in flight', { shutdownInFlight: true }, UPDATER_BLOCK_REASON.SHUTDOWN_IN_FLIGHT],
]
for (const [label, override, expected] of BUSY_HOSTS) {
  test(`The install is blocked while the managed scope reports ${label}`, async () => {
    const context = await ready({ blockers: () => ({ ...IDLE_BLOCKERS, ...override }) })
    const result = await context.controller.requestRestartAndInstall(CONFIRMATION)
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, expected)
    assert.ok(result.reasons.includes(expected))
    assert.equal(context.calls.exit, 0, 'A blocked install never requests the exit')
    assert.deepEqual(context.controller.snapshot().candidate, CANDIDATE, 'The READY candidate survives the block')
  })
}

/** @type {Array<[string, () => unknown]>} */
const UNREADABLE_HOSTS = [
  ['an unreadable snapshot', () => ({ ...IDLE_BLOCKERS, readable: false })],
  ['a null snapshot', () => null],
  ['an undefined snapshot', () => undefined],
  ['a missing active-operation count', () => { const value = { ...IDLE_BLOCKERS }; delete value.activeOperations; return value }],
  ['an undefined active-operation count', () => ({ ...IDLE_BLOCKERS, activeOperations: undefined })],
  ['a negative pending count', () => ({ ...IDLE_BLOCKERS, pendingCheckpoints: -1 })],
  ['a non-numeric pending count', () => ({ ...IDLE_BLOCKERS, pendingHumanDecisions: 'none' })],
  ['a missing shutdown flag', () => { const value = { ...IDLE_BLOCKERS }; delete value.shutdownInFlight; return value }],
  ['a snapshot reader that throws', () => { throw new Error('host scope unavailable') }],
]
for (const [label, blockers] of UNREADABLE_HOSTS) {
  test(`The install fails closed given ${label}`, async () => {
    const context = await ready({ blockers })
    const result = await context.controller.requestRestartAndInstall(CONFIRMATION)
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.STATE_UNKNOWN, 'An unread state is never treated as idle')
    assert.equal(context.calls.exit, 0)
    assert.equal(context.controller.snapshot().state, UPDATER_STATE.READY)
  })
}

test('The host blocker snapshot is read only by the install gate', async () => {
  const context = await ready()
  assert.equal(context.calls.blockers, 0, 'Check and download never consult the host scope')
  await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(context.calls.blockers, 1)
})

test('An install is authorized exactly once', async () => {
  const context = await ready()
  const first = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(first.ok, true)
  assert.deepEqual(context.exitRequests, [{ candidate: CANDIDATE }])
  const second = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.INSTALL_ALREADY_AUTHORIZED)
  assert.equal(context.calls.exit, 1, 'At most one exit-and-install request per controller')
})

test('Two install clicks while one is in flight produce one exit request', async () => {
  const gate = deferred()
  const context = await ready({ installExit: async () => { await gate.promise } })
  const first = context.controller.requestRestartAndInstall(CONFIRMATION)
  const second = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(second.ok, false)
  assert.equal(second.reasonCode, UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS)
  gate.resolve()
  assert.equal((await first).ok, true)
  assert.equal(context.calls.exit, 1)
})

test('A failed exit keeps the READY candidate and can be retried', async () => {
  let fail = true
  const context = await ready({ installExit: async () => { if (fail) throw new Error('strict shutdown failed') } })
  const first = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(first.ok, false)
  assert.equal(first.reasonCode, UPDATER_FAILURE.INSTALL_EXIT_FAILED)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.READY)
  assert.deepEqual(context.controller.snapshot().candidate, CANDIDATE)
  fail = false
  assert.equal((await context.controller.requestRestartAndInstall(CONFIRMATION)).ok, true)
  assert.equal(context.calls.exit, 2)
})

test('The current macOS condition is UNSUPPORTED with BLOCKED_BY_SIGNING and refuses every operation', async () => {
  const capability = /** @type {TestCapability} */ ({ platform: 'darwin', installable: false, reasonCode: 'BLOCKED_BY_SIGNING', signature: 'unsigned' })
  const context = fixture({ capability })
  const snapshot = context.controller.snapshot()
  assert.equal(snapshot.state, UPDATER_STATE.UNSUPPORTED)
  assert.equal(snapshot.reasonCode, 'BLOCKED_BY_SIGNING')
  assert.equal(snapshot.capability.installable, false)
  const results = [
    await context.controller.check(),
    await context.controller.download(),
    await context.controller.requestRestartAndInstall(CONFIRMATION),
  ]
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(result.reasonCode, 'BLOCKED_BY_SIGNING')
    assert.equal(result.state, UPDATER_STATE.UNSUPPORTED)
  }
  assert.equal(context.calls.check, 0)
  assert.equal(context.calls.download, 0)
  assert.equal(context.calls.exit, 0)
})

test('An installable Windows capability still refuses an unsigned install without explicit approval', async () => {
  const capability = /** @type {TestCapability} */ ({ platform: 'win32', installable: true, signature: 'unsigned' })
  const context = await ready({ capability })
  const result = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.UNSIGNED_INSTALL_NOT_APPROVED)
  assert.equal(context.calls.exit, 0)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.READY)
})

test('An unsigned install proceeds only when the capability approves it explicitly', async () => {
  const capability = /** @type {TestCapability} */ ({ platform: 'win32', installable: true, signature: 'unsigned', unsignedInstallApproved: true })
  const context = await ready({ capability })
  assert.equal((await context.controller.requestRestartAndInstall(CONFIRMATION)).ok, true)
  assert.equal(context.calls.exit, 1)
})

test('A missing or unknown capability fails closed', async () => {
  for (const capability of [undefined, null, EMPTY_CAPABILITY]) {
    const context = fixture({ capability })
    const snapshot = context.controller.snapshot()
    assert.equal(snapshot.state, UPDATER_STATE.UNSUPPORTED)
    assert.equal(snapshot.reasonCode, UPDATER_BLOCK_REASON.CAPABILITY_UNKNOWN)
    assert.equal((await context.controller.check()).ok, false)
    assert.equal((await context.controller.download()).ok, false)
    assert.equal((await context.controller.requestRestartAndInstall(CONFIRMATION)).ok, false)
    assert.equal(context.calls.check, 0)
    assert.equal(context.calls.exit, 0)
  }
})

test('State changes are published as snapshots and unsubscribing stops them', async () => {
  const context = fixture()
  const seen = []
  const unsubscribe = context.controller.subscribe((snapshot) => seen.push(snapshot.state))
  await context.controller.check()
  await context.controller.download()
  unsubscribe()
  await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.deepEqual(seen, ['IDLE', 'CHECKING', 'AVAILABLE', 'DOWNLOADING', 'READY'])
})

test('Dispose is idempotent, refuses later work and ignores a late backend result', async () => {
  const gate = deferred()
  const context = fixture({ check: async () => { await gate.promise; return { available: true, candidate: { ...CANDIDATE } } } })
  const pending = context.controller.check()
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.CHECKING)
  context.controller.dispose()
  context.controller.dispose()
  const snapshot = context.controller.snapshot()
  assert.equal(snapshot.disposed, true)
  assert.equal(snapshot.observations.disposes, 1)
  gate.resolve()
  const late = await pending
  assert.equal(late.ok, false)
  assert.equal(late.reasonCode, UPDATER_BLOCK_REASON.DISPOSED)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.CHECKING, 'A late result cannot move a disposed controller')
  for (const result of [
    await context.controller.check(),
    await context.controller.download(),
    await context.controller.requestRestartAndInstall(CONFIRMATION),
  ]) assert.equal(result.reasonCode, UPDATER_BLOCK_REASON.DISPOSED)
  assert.equal(context.calls.exit, 0)
})

test('A late download result cannot reach READY or authorize an install', async () => {
  const gate = deferred()
  const context = fixture({ download: async () => { await gate.promise } })
  await context.controller.check()
  const pending = context.controller.download()
  context.controller.dispose()
  gate.resolve()
  const late = await pending
  assert.equal(late.reasonCode, UPDATER_BLOCK_REASON.DISPOSED)
  const snapshot = context.controller.snapshot()
  assert.equal(snapshot.state, UPDATER_STATE.DOWNLOADING, 'A late download result is dropped, never promoted to READY')
  assert.notEqual(snapshot.state, UPDATER_STATE.READY)
  const install = await context.controller.requestRestartAndInstall(CONFIRMATION)
  assert.equal(install.reasonCode, UPDATER_BLOCK_REASON.DISPOSED)
  assert.equal(context.calls.exit, 0)
})

test('Diagnostics never retain credentials', async () => {
  const leak = 'check failed at //user:hunter2@feed.invalid/latest.yml?token=ghp_ABCDEFGHIJKLMNOP authorization: Bearer sekret-123'
  const context = fixture({ check: async () => { throw new Error(leak) } })
  await context.controller.check()
  const retained = JSON.stringify(context.controller.snapshot())
  for (const secret of ['ghp_ABCDEFGHIJKLMNOP', 'hunter2', 'sekret-123']) {
    assert.equal(retained.includes(secret), false, `Diagnostics must not retain ${secret}`)
  }
  assert.ok(retained.includes('[redacted]'))
  assert.equal('env' in context.controller.snapshot(), false)
})

test('A failing subscriber or failure reporter cannot change an update decision', async () => {
  const context = fixture({ reportFailure() { throw new Error('reporter failed') } })
  context.controller.subscribe(() => { throw new Error('subscriber failed') })
  const result = await context.controller.check()
  assert.equal(result.ok, true)
  assert.equal(context.controller.snapshot().state, UPDATER_STATE.AVAILABLE)
  assert.ok(context.controller.snapshot().observations.errorCount > 0, 'Subscriber failures are counted, not thrown')
})
