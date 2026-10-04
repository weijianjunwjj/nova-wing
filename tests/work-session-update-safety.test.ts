import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createNovaWingLaunchpad,
  type NovaWingLaunchpad,
  type NovaWingLaunchpadDependencies,
} from '../packages/development-guardian/work-session/launchpad/server.js'
import { WorkSessionControlController, type WorkSessionUpdateSafetyView } from '../packages/development-guardian/work-session/control-ui/controller.js'
import type { WorkSessionDurableState } from '../packages/development-guardian/work-session/model.js'
import type { GuardianTaskRecoveryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

// The Host update-safety snapshot: a real controller projection, a real Launchpad aggregation
// and a real Desktop Host composition. Nothing here is fed a hand-written five-field object.

const BUSINESS_REASON = '需要选择部署环境。'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function checkpoint(): GuardianTaskRecoveryCheckpoint {
  return {
    version: 1,
    task: { id: 'T1', goal: 'g', stopReason: 'unknown' },
    provider: { chatgptConversationUrl: 'https://conversation.invalid/SECRET-URL' },
    capturedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as GuardianTaskRecoveryCheckpoint
}

function businessDecision(): NonNullable<WorkSessionDurableState['pendingHumanAction']> {
  return {
    type: 'BUSINESS_DECISION', sessionId: 'w005a-session', taskId: 'T1', generation: 2,
    prompt: 'SECRET-TASK-TEXT',
  }
}

function approval(status: 'REQUESTED' | 'APPROVED'): NonNullable<WorkSessionDurableState['pendingVerificationApproval']> {
  return { sessionId: 'w005a-session', taskId: 'T1', command: 'npm test', commandFingerprint: 'fp-1', generation: 1, status }
}

/** A real controller over a fake runtime, hydrated the way production hydrates it. */
async function controllerWith(state: WorkSessionDurableState | undefined) {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = state
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, pollIntervalMs: 10 })
  await controller.loadPersistedState()
  return { runtime, controller }
}

// ---------------------------------------------------------------- controller projection

test('an unhydrated controller is unreadable instead of reporting a reassuring zero', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({ state: 'SUSPENDED', humanRequired: { category: 'PERMISSION_REQUIRED', reason: BUSINESS_REASON } })
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, pollIntervalMs: 10 })
  const view = controller.getUpdateSafetyView()
  assert.equal(view.readable, false)
  assert.equal(view.reasonCode, 'STATE_NOT_HYDRATED')
  assert.equal(view.pendingHumanDecision, false, 'An unread state must not claim there is nothing pending')
})

test('a durable state that cannot be read stays unreadable', async () => {
  const { runtime, controller } = await controllerWith(makeState({ state: 'RUNNING' }))
  // Patch and restore inside one synchronous read: the controller polls, and a throw left in
  // place would surface as an uncaught exception from that timer instead of a projection.
  const read = runtime.getDurableState.bind(runtime)
  runtime.getDurableState = () => { throw new Error('storage unavailable') }
  const view = controller.getUpdateSafetyView()
  runtime.getDurableState = read
  assert.equal(view.readable, false)
  assert.equal(view.reasonCode, 'STATE_READ_FAILED')
})

test('a hydrated session with no durable state or a terminal state is readable and idle', async () => {
  const empty = await controllerWith(undefined)
  assert.deepEqual(empty.controller.getUpdateSafetyView(), {
    readable: true, reasonCode: null, inFlightOperations: 0,
    pendingHumanDecision: false, pendingRecoveryCheckpoint: false,
  })
  const completed = await controllerWith(makeState({ state: 'COMPLETED', checkpointCommits: { T1: 'deadbeef' } }))
  assert.equal(completed.controller.getUpdateSafetyView().pendingRecoveryCheckpoint, false)
  assert.equal(completed.controller.getUpdateSafetyView().pendingHumanDecision, false)
})

test('a task-bound business decision blocks, and a stale generation does not', async () => {
  const current = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: businessDecision(),
  }))
  assert.equal(current.controller.getUpdateSafetyView().pendingHumanDecision, true)

  // Same card, but the durable generation has moved on: existing identity rules make it stale.
  const stale = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 3,
    pendingHumanAction: businessDecision(),
  }))
  assert.equal(stale.controller.getUpdateSafetyView().pendingHumanDecision, false)
})

test('HUMAN_REQUIRED without a structured card is still a pending human decision', async () => {
  for (const category of ['PERMISSION_REQUIRED', 'ENVIRONMENT_REQUIRED', 'CREDENTIAL_REQUIRED']) {
    const { controller } = await controllerWith(makeState({
      state: 'SUSPENDED', currentTaskId: 'T1',
      humanRequired: { category, reason: BUSINESS_REASON },
    }))
    const view = controller.getUpdateSafetyView()
    assert.equal(view.pendingHumanDecision, true, `${category} must not be treated as no human need`)
    assert.equal(view.readable, true)
  }
})

test('an unresolved verification approval blocks and an approved one does not', async () => {
  const requested = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1',
    pendingVerificationApproval: approval('REQUESTED'),
  }))
  assert.equal(requested.controller.getUpdateSafetyView().pendingHumanDecision, true)

  const approved = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1',
    pendingVerificationApproval: approval('APPROVED'),
  }))
  assert.equal(approved.controller.getUpdateSafetyView().pendingHumanDecision, false)
})

test('a recovery checkpoint is reported separately from an in-flight Git operation', async () => {
  const holding = await controllerWith(makeState({ state: 'SUSPENDED', currentTaskId: 'T1', currentTaskCheckpoint: checkpoint() }))
  const view = holding.controller.getUpdateSafetyView()
  assert.equal(view.pendingRecoveryCheckpoint, true)
  assert.equal(view.inFlightOperations, 0, 'A resting checkpoint is not an operation')
  assert.equal(view.pendingHumanDecision, false)

  // History is not a blocker: recorded completed commits must not stop an update on their own.
  const historical = await controllerWith(makeState({
    state: 'RUNNING', currentTaskId: 'T2',
    checkpointCommits: { T1: 'aaaaaaa' }, checkpointPushes: { T1: 'aaaaaaa' },
  }))
  const historicalView = historical.controller.getUpdateSafetyView()
  assert.equal(historicalView.pendingRecoveryCheckpoint, false)
  assert.equal(historicalView.pendingHumanDecision, false)
})

test('unsettled lifecycle work is counted, and reading the view creates none of its own', async () => {
  const { runtime, controller } = await controllerWith(makeState({ state: 'SCHEDULED' }))
  assert.equal(controller.getUpdateSafetyView().inFlightOperations, 0)

  // A start that has not returned is exactly the "startup has begun" case they must not miss.
  runtime.deferStart()
  assert.equal(controller.start().started, true)
  const whileStarting = controller.getUpdateSafetyView().inFlightOperations
  assert.ok(whileStarting > 0, 'A start that has not returned is unsettled work')

  // Reading must not register an operation: repeated reads cannot make the snapshot block itself.
  for (let index = 0; index < 5; index++) {
    assert.equal(controller.getUpdateSafetyView().inFlightOperations, whileStarting)
  }
  runtime.startDeferred?.resolve(makeState({ state: 'SCHEDULED' }))
  await controller.getStartPromise()
  assert.equal(controller.getUpdateSafetyView().inFlightOperations, 0, 'Reading never accumulated work')
})

test('the safety projection carries no checkpoint content, URL, task text or extra fields', async () => {
  const { controller } = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: businessDecision(),
    currentTaskCheckpoint: checkpoint(),
  }))
  const view = controller.getUpdateSafetyView()
  assert.deepEqual(Object.keys(view).sort(),
    ['inFlightOperations', 'pendingHumanDecision', 'pendingRecoveryCheckpoint', 'readable', 'reasonCode'])
  const serialized = JSON.stringify(view)
  for (const secret of ['SECRET-URL', 'SECRET-TASK-TEXT', BUSINESS_REASON, 'conversation']) {
    assert.equal(serialized.includes(secret), false, `the projection must not carry ${secret}`)
  }
})

test('a malformed durable shape fails the read closed instead of throwing at the caller', async () => {
  const { controller } = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1',
    currentTaskCheckpoint: { version: 1 } as unknown as GuardianTaskRecoveryCheckpoint,
  }))
  const view = controller.getUpdateSafetyView()
  assert.equal(view.readable, false)
  assert.equal(view.reasonCode, 'STATE_READ_FAILED')
  assert.equal(view.pendingHumanDecision, false)
  assert.equal(view.pendingRecoveryCheckpoint, false)
})

// ---------------------------------------------------------------- Launchpad aggregation

function configuration(index: number) {
  return {
    session: {
      id: `update-safety-${index}`, targetRepo: process.cwd(), branch: 'main',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
    },
    tasks: [{ id: 'SAFETY-001', goal: 'Verify the update safety snapshot.', guardian: {
      constraints: ['keep scope narrow'], acceptanceCriteria: ['tests pass'],
      doNotDo: ['do not access credentials'], allowedPaths: ['packages/**'], forbiddenPaths: ['secrets/**'],
    } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
    notification: { email: { enabled: false } },
  }
}

async function fixture(count = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-update-safety-'))
  for (let index = 0; index < count; index++) {
    await writeFile(join(directory, `session-${index}.json`), JSON.stringify(configuration(index)), 'utf8')
  }
  return directory
}

/** A managed app whose safety view is either a real controller projection or a fixed stand-in. */
function managedApps(options: {
  createGate?: ReturnType<typeof deferred>
  startGate?: ReturnType<typeof deferred>
  closeGate?: ReturnType<typeof deferred>
  safety?: () => WorkSessionUpdateSafetyView
} = {}) {
  const state = { created: 0, closed: 0 }
  // Separate entry signals: a test waits for these, never for the gate it is about to release.
  const entered = { create: deferred(), start: deferred(), close: deferred() }
  const create: NonNullable<NovaWingLaunchpadDependencies['createWorkSession']> = async () => {
    const index = state.created++
    entered.create.resolve()
    await options.createGate?.promise
    let closed = false
    return {
      controller: {
        start() { return { started: true } },
        ...(options.safety === undefined ? {} : { getUpdateSafetyView: options.safety }),
      },
      async start() {
        entered.start.resolve()
        await options.startGate?.promise
        return { url: `http://127.0.0.1:${55000 + index}` }
      },
      isLive() { return !closed },
      hasActiveSession() { return false },
      async close() { state.closed++; entered.close.resolve(); await options.closeGate?.promise; closed = true },
    }
  }
  return { state, entered, create }
}

const IDLE_SAFETY: () => WorkSessionUpdateSafetyView = () => ({
  readable: true, reasonCode: null, inFlightOperations: 0, pendingHumanDecision: false, pendingRecoveryCheckpoint: false,
})

const launchpadDependencies = (dependencies: NovaWingLaunchpadDependencies): NovaWingLaunchpadDependencies => ({
  readSessionStatus: async () => 'READY',
  readCodexAvailability: () => ({ state: 'available' }),
  resolveEnvironment: async () => ({}),
  gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
  repairAudit: { async record() {} },
  repairNotifier: { async notify() {} },
  ...dependencies,
})

async function launchpadWith(directory: string, dependencies: NovaWingLaunchpadDependencies = {}) {
  return createNovaWingLaunchpad({
    configDirectory: directory, shutdownMode: 'strict',
    dependencies: launchpadDependencies(dependencies),
  })
}

async function startSession(launchpad: NovaWingLaunchpad, url: string, configId: string) {
  return sessionFetch(`${url}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url, 'Cookie': await mintSession(launchpad) },
    body: JSON.stringify({ configId }),
  })
}

function navigationRegistry(launchpad: NovaWingLaunchpad) {
  return (launchpad as unknown as { liveApps: Map<string, unknown> }).liveApps
}

test('a Launchpad with no managed work is readable and unblocked', async () => {
  const directory = await fixture(1)
  const launchpad = await launchpadWith(directory, { createWorkSession: managedApps().create })
  try {
    await startOperator(launchpad)
    assert.deepEqual(launchpad.getUpdateSafetyView(), {
      readable: true, reasonCode: null, activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0,
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('history the process never took over cannot block, however many configurations exist', async () => {
  const directory = await fixture(3)
  const apps = managedApps()
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    // Three configured sessions, none admitted by this process: the scope is ownership, not disk.
    assert.deepEqual(launchpad.getUpdateSafetyView(), {
      readable: true, reasonCode: null, activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0,
    })
    assert.equal(apps.state.created, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an admitted create that has not finished, and a start with no window yet, both stay busy', async () => {
  const directory = await fixture(1)
  const createGate = deferred()
  const startGate = deferred()
  const apps = managedApps({ createGate, startGate, safety: IDLE_SAFETY })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    const address = await startOperator(launchpad)
    const configId = launchpad.getConfigs()[0]!.configId
    const pendingStart = startSession(launchpad, address.url, configId)
    await apps.entered.create.promise

    const creating = launchpad.getUpdateSafetyView()
    assert.equal(creating.readable, true)
    assert.ok(creating.activeOperations > 0, 'An admitted create is unsettled work')
    assert.equal(navigationRegistry(launchpad).size, 0, 'no window is registered yet')

    createGate.resolve()
    await apps.entered.start.promise
    const starting = launchpad.getUpdateSafetyView()
    assert.ok(starting.activeOperations > 0, 'A start that has not returned is unsettled work')
    assert.equal(navigationRegistry(launchpad).size, 0)

    startGate.resolve()
    assert.equal((await pendingStart).status, 202)
    const started = launchpad.getUpdateSafetyView()
    assert.equal(started.readable, true)
    assert.equal(navigationRegistry(launchpad).size, 1)
  } finally {
    createGate.resolve()
    startGate.resolve()
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a live session still executing stays busy, and an empty navigation map changes nothing', async () => {
  const directory = await fixture(1)
  const apps = managedApps({ safety: () => ({ readable: true, reasonCode: null, inFlightOperations: 1, pendingHumanDecision: false, pendingRecoveryCheckpoint: false }) })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    const address = await startOperator(launchpad)
    assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)
    const busy = launchpad.getUpdateSafetyView()
    assert.equal(busy.activeOperations, 1)

    // Hiding a window, or clearing the navigation registry, releases no ownership.
    navigationRegistry(launchpad).clear()
    assert.deepEqual(launchpad.getUpdateSafetyView(), busy, 'An empty navigation map proves nothing')
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('an app whose close has not settled stays counted after the navigation map is empty', async () => {
  const directory = await fixture(1)
  const closeGate = deferred()
  const apps = managedApps({ closeGate, safety: IDLE_SAFETY })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  let closing: Promise<void> | undefined
  try {
    const address = await startOperator(launchpad)
    assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)

    closing = launchpad.close()
    assert.equal(apps.state.closed, 1, 'the close has begun')
    navigationRegistry(launchpad).clear()

    const view = launchpad.getUpdateSafetyView()
    assert.equal(view.readable, true)
    assert.ok(view.activeOperations > 0, 'A close that has not settled is still unsettled work')
  } finally {
    closeGate.resolve()
    await closing?.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a managed session waiting for a human is aggregated from its real controller projection', async () => {
  const directory = await fixture(1)
  const { controller } = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: businessDecision(),
  }))
  const apps = managedApps({ safety: () => controller.getUpdateSafetyView() })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    const address = await startOperator(launchpad)
    assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)
    const view = launchpad.getUpdateSafetyView()
    assert.equal(view.readable, true)
    assert.equal(view.pendingHumanDecisions, 1)
    assert.equal(view.pendingCheckpoints, 0)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a managed session holding a recovery checkpoint is aggregated as a checkpoint', async () => {
  const directory = await fixture(1)
  const { controller } = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', currentTaskCheckpoint: checkpoint(),
  }))
  const apps = managedApps({ safety: () => controller.getUpdateSafetyView() })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    const address = await startOperator(launchpad)
    assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)
    const view = launchpad.getUpdateSafetyView()
    assert.equal(view.pendingCheckpoints, 1)
    assert.equal(view.pendingHumanDecisions, 0)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing, malformed, throwing or unhydrated owner projection fails the whole read closed', async () => {
  const directory = await fixture(1)
  const unhydrated = new FakeRuntime(makeDefinition())
  const bare = new WorkSessionControlController({ createRuntime: () => unhydrated, pollIntervalMs: 10 })
  const malformed = (() => ({ readable: true, reasonCode: null, inFlightOperations: -1 })) as unknown as () => WorkSessionUpdateSafetyView
  const cases: Array<[string, (() => WorkSessionUpdateSafetyView) | undefined, string]> = [
    ['a missing projection', undefined, 'OWNER_SAFETY_VIEW_UNAVAILABLE'],
    ['a projection that throws', () => { throw new Error('owner unavailable') }, 'OWNER_SAFETY_VIEW_UNAVAILABLE'],
    ['a malformed projection', malformed, 'OWNER_SAFETY_VIEW_UNAVAILABLE'],
    ['an unhydrated owner', () => bare.getUpdateSafetyView(), 'STATE_NOT_HYDRATED'],
  ]
  for (const [label, safety, expected] of cases) {
    const apps = managedApps(safety === undefined ? {} : { safety })
    const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
    try {
      const address = await startOperator(launchpad)
      assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)
      const view = launchpad.getUpdateSafetyView()
      assert.equal(view.readable, false, label)
      assert.equal(view.reasonCode, expected, label)
    } finally {
      await launchpad.close().catch(() => undefined)
    }
  }
  await rm(directory, { recursive: true, force: true })
})

test('the aggregated safety view exposes counts and no owner detail', async () => {
  const directory = await fixture(1)
  const { controller } = await controllerWith(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: businessDecision(), currentTaskCheckpoint: checkpoint(),
  }))
  const apps = managedApps({ safety: () => controller.getUpdateSafetyView() })
  const launchpad = await launchpadWith(directory, { createWorkSession: apps.create })
  try {
    const address = await startOperator(launchpad)
    assert.equal((await startSession(launchpad, address.url, launchpad.getConfigs()[0]!.configId)).status, 202)
    const view = launchpad.getUpdateSafetyView()
    assert.deepEqual(Object.keys(view).sort(),
      ['activeOperations', 'pendingCheckpoints', 'pendingHumanDecisions', 'readable', 'reasonCode'])
    const serialized = JSON.stringify(view)
    for (const secret of ['SECRET-URL', 'SECRET-TASK-TEXT', BUSINESS_REASON, 'conversation', 'update-safety-0']) {
      assert.equal(serialized.includes(secret), false, `the aggregation must not carry ${secret}`)
    }
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
