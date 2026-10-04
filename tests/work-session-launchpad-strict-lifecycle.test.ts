import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http, { type Server } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createNovaWingLaunchpad,
  type NovaWingLaunchpad,
  type NovaWingLaunchpadDependencies,
} from '../packages/development-guardian/work-session/launchpad/server.js'
import { ProductionWorkSessionInitializationError } from '../packages/development-guardian/work-session/production-lifecycle-errors.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function inspect(launchpad: NovaWingLaunchpad) {
  // Observe actual owned resources; no production-only test hooks are needed.
  return launchpad as unknown as {
    server: Server
    scheduleRecoveryTimer: NodeJS.Timeout | undefined
    liveApps: Map<string, unknown>
    recoverScheduledSessions(): Promise<void>
  }
}

function observe(promise: Promise<unknown>) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

async function pending(settled: () => boolean) {
  // An event-loop barrier, not a duration-based guess about operation ordering.
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled(), false, 'shutdown must remain pending while an admitted operation is gated')
}

function noResources(launchpad: NovaWingLaunchpad) {
  assert.equal(inspect(launchpad).server.listening, false)
  assert.equal(launchpad.getAddress(), undefined)
  assert.equal(inspect(launchpad).scheduleRecoveryTimer, undefined)
  assert.equal(inspect(launchpad).liveApps.size, 0)
}

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? [error, ...error.errors.flatMap(errorTree)]
    : [error]
}

const ready = { overall: 'READY' as const, canStart: true, checkedAt: new Date(0).toISOString(), dependencies: [] }

async function fixture(options: { count?: number; scheduled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-strict-launchpad-'))
  for (let index = 0; index < (options.count ?? 1); index++) {
    await writeFile(join(directory, `session-${index}.json`), JSON.stringify({
      session: {
        id: `strict-launchpad-${index}`,
        targetRepo: process.cwd(), branch: 'main',
        limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
        ...(options.scheduled ? { scheduledStartAt: '2099-01-01T00:00:00.000Z', scheduleSource: 'custom' } : {}),
      },
      tasks: [{ id: 'STRICT-001', goal: 'Verify strict shutdown with controlled operations.', guardian: {
        constraints: ['keep scope narrow'], acceptanceCriteria: ['tests pass'],
        doNotDo: ['do not access credentials'], allowedPaths: ['packages/**'], forbiddenPaths: ['secrets/**'],
      } }],
      gitCheckpoint: { autoCommit: false, autoPush: false },
      executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      notification: { email: { enabled: false } },
    }), 'utf8')
  }
  return directory
}

function fakeApps(options: {
  createGate?: ReturnType<typeof deferred>
  createEntered?: ReturnType<typeof deferred>
  closeGate?: ReturnType<typeof deferred>
  closeEntered?: ReturnType<typeof deferred>
  closeErrors?: Error[]
} = {}) {
  const state = { created: 0, started: 0, controllerStarted: 0, closed: 0, live: 0 }
  const create: NonNullable<NovaWingLaunchpadDependencies['createWorkSession']> = async () => {
    const index = state.created++
    options.createEntered?.resolve()
    await options.createGate?.promise
    state.live++
    let closed = false
    return {
      controller: { start() { state.controllerStarted++; return { started: true } } },
      async start() { state.started++; return { url: `http://127.0.0.1:${54000 + index}` } },
      isLive() { return !closed },
      hasActiveSession() { return false },
      async close() {
        state.closed++
        options.closeEntered?.resolve()
        await options.closeGate?.promise
        if (!closed) { closed = true; state.live-- }
        if (options.closeErrors?.[index] !== undefined) throw options.closeErrors[index]
      },
    }
  }
  return { state, create }
}

async function create(directory: string, dependencies: NovaWingLaunchpadDependencies = {}, strict = true) {
  return createNovaWingLaunchpad({
    configDirectory: directory,
    ...(strict ? { shutdownMode: 'strict' as const } : {}),
    dependencies: {
      readSessionStatus: async () => 'READY',
      readCodexAvailability: () => ({ state: 'available' }),
      resolveEnvironment: async () => ({}),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairAudit: { async record() {} },
      repairNotifier: { async notify() {} },
      ...dependencies,
    },
  })
}

function composer(requestId: string) {
  return {
    requestId, targetRepo: process.cwd(),
    directPathEnabled: false, goldenPathEnabled: false,
    tasks: [{ id: 'STRICT-CREATE', goal: 'Verify the admitted lifecycle operation finishes.' }],
    guardian: { allowedPaths: ['packages/**', 'tests/**'] },
  }
}

const sessionCookies = new WeakMap<NovaWingLaunchpad, string>()
async function readyCookie(launchpad: NovaWingLaunchpad): Promise<string> {
  let cookie = sessionCookies.get(launchpad)
  if (!cookie) { cookie = await mintSession(launchpad); sessionCookies.set(launchpad, cookie) }
  return cookie
}

async function post(launchpad: NovaWingLaunchpad, url: string, action: string, body: unknown) {
  return sessionFetch(`${url}/api/session/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url, 'Cookie': await readyCookie(launchpad) },
    body: JSON.stringify(body),
  })
}

async function assertRejected(launchpad: NovaWingLaunchpad, url: string, action: string, body: unknown) {
  try {
    const response = await post(launchpad, url, action, body)
    assert.ok(response.status >= 400, `${action} must not succeed after shutdown begins`)
    await response.arrayBuffer()
  } catch (error) {
    // Stopping listener admission is also an allowed fail-closed response.
    if (error instanceof TypeError && error.message === 'fetch failed') return
    throw error
  }
}

test('strict Launchpad shares start and close promises and closes every app exactly once', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const closeGate = deferred()
  const closeEntered = deferred()
  const apps = fakeApps({ closeGate, closeEntered })
  const launchpad = await create(directory, { createWorkSession: apps.create })
  try {
    const starting = launchpad.start()
    assert.equal(launchpad.start(), starting)
    const address = await starting
    assert.equal(launchpad.start(), starting)
    assert.equal((await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })).status, 202)
    const closing = launchpad.close()
    const settled = observe(closing)
    assert.equal(launchpad.close(), closing)
    await closeEntered.promise
    await pending(settled)
    assert.equal(apps.state.closed, 1)
    assert.equal(apps.state.live, 1)
    closeGate.resolve()
    await closing
    assert.equal(launchpad.close(), closing)
    assert.equal(apps.state.closed, 1)
    assert.equal(apps.state.live, 0)
    noResources(launchpad)
  } finally {
    closeGate.resolve()
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad drains owned apps without waiting for HTTP preconnections', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const closeGate = deferred()
  const closeEntered = deferred()
  const apps = fakeApps({ closeGate, closeEntered })
  const launchpad = await create(directory, { createWorkSession: apps.create })
  const address = await startOperator(launchpad)
  const response = await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })
  assert.equal(response.status, 202)
  await response.text()
  const server = inspect(launchpad).server
  const connected = once(server, 'connection')
  const empty = createConnection({ host: address.host, port: address.port })
  await Promise.all([connected, once(empty, 'connect')])
  const partialConnected = once(server, 'connection')
  const partial = createConnection({ host: address.host, port: address.port })
  const [[partialServerSocket]] = await Promise.all([partialConnected, once(partial, 'connect')])
  const headersReceived = once(partialServerSocket, 'data')
  partial.write('GET / HTTP/1.1\r\nHost:')
  await headersReceived
  try {
    const closing = launchpad.close()
    await closeEntered.promise
    await pending(observe(closing))
    assert.equal(apps.state.live, 1)
    assert.equal(empty.destroyed, false)
    assert.equal(partial.destroyed, false)
    const httpClosed = once(server, 'close', { signal: AbortSignal.timeout(2_000) })
    closeGate.resolve()
    await httpClosed
    await closing
    assert.equal(apps.state.closed, 1)
    assert.equal(apps.state.live, 0)
    noResources(launchpad)
  } finally {
    empty.destroy()
    partial.destroy()
    closeGate.resolve()
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad close before start rejects startup and owns no resources', async () => {
  const directory = await fixture()
  let reads = 0
  const launchpad = await create(directory, { readSessionStatus: async () => { reads++; return 'READY' } })
  try {
    const closing = launchpad.close()
    assert.equal(launchpad.close(), closing)
    await closing
    await assert.rejects(launchpad.start(), /clos/i)
    assert.equal(reads, 0)
    noResources(launchpad)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const phase of ['hydrate', 'preflight', 'listen'] as const) {
  test(`strict Launchpad drains startup while ${phase} is pending without a late listener or interval`, { timeout: 10_000 }, async () => {
    const directory = await fixture()
    const entered = deferred()
    const gate = deferred()
    let phaseCalls = 0
    const launchpad = await create(directory, {
      ...(phase === 'hydrate' ? { readSessionStatus: async () => { phaseCalls++; entered.resolve(); await gate.promise; return 'READY' as const } } : {}),
      ...(phase === 'preflight' ? { preflight: async () => { phaseCalls++; entered.resolve(); await gate.promise; return ready } } : {}),
    })
    const server = inspect(launchpad).server
    const originalListen = server.listen.bind(server)
    if (phase === 'listen') {
      server.listen = ((port: number, host: string, listener: () => void) => originalListen(port, host, () => {
        phaseCalls++
        entered.resolve()
        void gate.promise.then(listener)
      })) as Server['listen']
    }
    let starting: Promise<unknown> | undefined
    try {
      starting = launchpad.start()
      void starting.catch(() => undefined)
      assert.equal(launchpad.start(), starting)
      await entered.promise
      const closing = launchpad.close()
      const settled = observe(closing)
      assert.equal(launchpad.close(), closing)
      await pending(settled)
      gate.resolve()
      await Promise.allSettled([starting])
      await closing
      assert.equal(phaseCalls, 1)
      noResources(launchpad)
      await new Promise<void>((resolve) => setImmediate(resolve))
      noResources(launchpad)
    } finally {
      gate.resolve()
      await starting?.catch(() => undefined)
      await launchpad.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('strict Launchpad reports a startup failure that occurs during close', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const entered = deferred()
  const gate = deferred()
  const failure = new Error('hydrate failed during strict shutdown')
  const launchpad = await create(directory, { readSessionStatus: async () => {
    entered.resolve(); await gate.promise; throw failure
  } })
  try {
    const starting = launchpad.start()
    const startFailed = assert.rejects(starting, (error) => errorTree(error).includes(failure))
    await entered.promise
    const closing = launchpad.close()
    const closeFailed = assert.rejects(closing, (error) => errorTree(error).includes(failure))
    assert.equal(launchpad.close(), closing)
    gate.resolve()
    await Promise.all([startFailed, closeFailed])
    noResources(launchpad)
  } finally {
    gate.resolve()
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad waits for every hydrate probe when an earlier probe rejects', { timeout: 10_000 }, async () => {
  const directory = await fixture({ count: 2 })
  const entered = deferred()
  const gate = deferred()
  const failure = new Error('first hydration probe failed')
  let remainingProbeSettled = false
  const launchpad = await create(directory, { readSessionStatus: async (config) => {
    if (config.session.id.endsWith('-0')) throw failure
    entered.resolve()
    await gate.promise
    remainingProbeSettled = true
    return 'READY'
  } })
  try {
    const starting = launchpad.start()
    const startFailed = assert.rejects(starting, (error) => errorTree(error).includes(failure))
    await entered.promise
    const closing = launchpad.close()
    const settled = observe(closing)
    const closeFailed = assert.rejects(closing, (error) => errorTree(error).includes(failure))
    await pending(settled)
    assert.equal(remainingProbeSettled, false)
    gate.resolve()
    await Promise.all([startFailed, closeFailed])
    assert.equal(remainingProbeSettled, true)
    noResources(launchpad)
  } finally {
    gate.resolve()
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad drains an admitted repair agent, durable audit and notifier', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const agentEntered = deferred()
  const agentGate = deferred()
  const notifierEntered = deferred()
  const notifierGate = deferred()
  let repairCalls = 0
  let auditCalls = 0
  let notifications = 0
  const launchpad = await create(directory, {
    createWorkSession: async () => { throw new Error('refused repair must not create a runtime') },
    repairAgent: { id: 'gated-strict-repair', async repair() {
      repairCalls++
      agentEntered.resolve()
      await agentGate.promise
      return { classification: 'REPAIR_REJECTED', reason: 'approval must remain a human decision' }
    } },
    repairLlmAgent: { id: 'unused-model', async repair() { assert.fail('approval cannot invoke a model') } },
    repairAudit: { async record() { auditCalls++ } },
    repairNotifier: { async notify() {
      notifications++
      notifierEntered.resolve()
      await notifierGate.promise
    } },
  })
  let request: Promise<Response> | undefined
  try {
    const address = await startOperator(launchpad)
    request = post(launchpad, address.url, 'repair', {
      ...composer('strict-gated-manual-repair'),
      guardian: {
        allowedPaths: ['packages/**'], acceptanceCriteria: ['custom proof'],
        acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      },
    })
    await agentEntered.promise
    const closing = launchpad.close()
    const settled = observe(closing)
    await pending(settled)
    await assertRejected(launchpad, address.url, 'repair', composer('strict-rejected-manual-repair'))
    agentGate.resolve()
    await notifierEntered.promise
    assert.equal(auditCalls, 1)
    await pending(settled)
    notifierGate.resolve()
    const response = await request
    assert.equal(response.status, 400)
    await response.arrayBuffer()
    await closing
    assert.equal(repairCalls, 1)
    assert.equal(notifications, 1)
    noResources(launchpad)
  } finally {
    agentGate.resolve()
    notifierGate.resolve()
    await request?.catch(() => undefined)
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

for (const action of ['create', 'start', 'repair', 'delete'] as const) {
  test(`strict Launchpad drains a ${action} handler admitted before its body arrives and rejects new mutations`, { timeout: 10_000 }, async () => {
    const directory = await fixture()
    const apps = fakeApps()
    const launchpad = await create(directory, { createWorkSession: apps.create })
    let request: http.ClientRequest | undefined
    let responseOperation: Promise<number> | undefined
    try {
      const address = await startOperator(launchpad)
      const configId = launchpad.getConfigs()[0]!.configId
      const body = JSON.stringify(action === 'start' || action === 'delete' ? { configId } : composer(`strict-admitted-${action}`))
      const cookie = await readyCookie(launchpad)
      const admitted = deferred()
      inspect(launchpad).server.once('request', () => admitted.resolve())
      responseOperation = new Promise<number>((resolveResponse, rejectResponse) => {
        request = http.request(`${address.url}/api/session/${action}`, {
          method: 'POST', agent: false,
          headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            Origin: address.url, 'Cookie': cookie,
          },
        }, (response) => {
          response.resume()
          response.on('end', () => resolveResponse(response.statusCode ?? 0))
          response.on('error', rejectResponse)
        })
        request.on('error', rejectResponse)
        request.flushHeaders()
      })
      void responseOperation.catch(() => undefined)
      await admitted.promise
      const closing = launchpad.close()
      const settled = observe(closing)
      assert.equal(launchpad.close(), closing)
      for (const rejectedAction of ['create', 'start', 'repair', 'delete']) {
        await assertRejected(launchpad, address.url, rejectedAction,
          rejectedAction === 'start' || rejectedAction === 'delete' ? { configId } : composer(`strict-rejected-${rejectedAction}`))
      }
      await pending(settled)
      assert.equal(apps.state.created, 0, 'a partial body has not yet created a runtime')
      request!.end(body)
      assert.equal(await responseOperation, action === 'delete' ? 200 : 202)
      await closing
      assert.equal(apps.state.created, action === 'delete' ? 0 : 1)
      assert.equal(apps.state.closed, apps.state.created)
      assert.equal(apps.state.live, 0)
      noResources(launchpad)
    } finally {
      request?.destroy()
      await responseOperation?.catch(() => undefined)
      await launchpad.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('strict Launchpad drains admitted scheduled recovery and stops further recovery admission', { timeout: 10_000 }, async () => {
  const directory = await fixture({ scheduled: true })
  const entered = deferred()
  const gate = deferred()
  const apps = fakeApps({ createEntered: entered, createGate: gate })
  let recover = false
  let reads = 0
  const launchpad = await create(directory, {
    createWorkSession: apps.create,
    readSessionStatus: async () => { reads++; return recover ? 'SCHEDULED' : 'READY' },
  })
  let recovery: Promise<void> | undefined
  try {
    await startOperator(launchpad)
    recover = true
    recovery = inspect(launchpad).recoverScheduledSessions()
    await entered.promise
    const closing = launchpad.close()
    const settled = observe(closing)
    const readsBefore = reads
    const repeatedRecovery = inspect(launchpad).recoverScheduledSessions()
    assert.equal(reads, readsBefore, 'closing does not admit a new recovery poll')
    await pending(settled)
    gate.resolve()
    await Promise.all([recovery, repeatedRecovery])
    await closing
    assert.equal(apps.state.created, 1)
    assert.equal(apps.state.started, 1)
    assert.equal(apps.state.controllerStarted, 1)
    assert.equal(apps.state.closed, 1)
    assert.equal(apps.state.live, 0)
    noResources(launchpad)
  } finally {
    gate.resolve()
    await recovery?.catch(() => undefined)
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad preserves app startup and cleanup failures even when HTTP responds with a safe error', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const entered = deferred()
  const gate = deferred()
  const startupFailure = new Error('production app start failed during shutdown')
  const cleanupFailure = new Error('production app cleanup also failed')
  let cleanupCalls = 0
  const launchpad = await create(directory, { createWorkSession: async () => ({
    controller: { start() { assert.fail('a failed app must never start its controller') } },
    async start() { entered.resolve(); await gate.promise; throw startupFailure },
    isLive() { return false },
    hasActiveSession() { return false },
    async close() { cleanupCalls++; throw cleanupFailure },
  }) })
  let request: Promise<Response> | undefined
  try {
    const address = await startOperator(launchpad)
    request = post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })
    await entered.promise
    const closing = launchpad.close()
    const settled = observe(closing)
    const failed = assert.rejects(closing, (error) => {
      const errors = errorTree(error)
      assert.ok(errors.includes(startupFailure), 'safe HTTP errors must not erase a startup failure')
      assert.ok(errors.includes(cleanupFailure), 'cleanup failure must remain observable by the owner')
      return true
    })
    await pending(settled)
    gate.resolve()
    const response = await request
    assert.equal(response.status, 500)
    assert.doesNotMatch(await response.text(), /production app/)
    await failed
    assert.equal(cleanupCalls, 1)
    assert.equal(inspect(launchpad).server.listening, false)
    assert.equal(inspect(launchpad).scheduleRecoveryTimer, undefined)
  } finally {
    gate.resolve()
    await request?.catch(() => undefined)
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('strict Launchpad attempts every cleanup and preserves HTTP and multiple app errors', { timeout: 10_000 }, async () => {
  const directory = await fixture({ count: 2 })
  const failures = [new Error('first app close failed'), new Error('second app close failed')]
  const serverFailure = new Error('launchpad HTTP close failed')
  const apps = fakeApps({ closeErrors: failures })
  const launchpad = await create(directory, { createWorkSession: apps.create })
  const server = inspect(launchpad).server
  const originalClose = server.close.bind(server)
  let listenerCloseCalls = 0
  try {
    const address = await startOperator(launchpad)
    for (const config of launchpad.getConfigs()) {
      assert.equal((await post(launchpad, address.url, 'start', { configId: config.configId })).status, 202)
    }
    server.close = ((callback?: (error?: Error) => void) => {
      listenerCloseCalls++
      return originalClose(() => callback?.(serverFailure))
    }) as Server['close']
    const closing = launchpad.close()
    assert.equal(launchpad.close(), closing)
    await assert.rejects(closing, (error) => {
      assert.ok(error instanceof AggregateError)
      const errors = errorTree(error)
      for (const failure of [...failures, serverFailure]) assert.ok(errors.includes(failure), failure.message)
      return true
    })
    assert.equal(apps.state.closed, 2)
    assert.equal(apps.state.live, 0)
    assert.equal(listenerCloseCalls, 1)
    assert.equal(server.listening, false)
    assert.equal(inspect(launchpad).scheduleRecoveryTimer, undefined)
    await assertRejected(launchpad, address.url, 'create', composer('strict-after-failed-close'))
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('default Launchpad close retains the explicit bounded timeout compatibility', { timeout: 10_000 }, async () => {
  const directory = await fixture()
  const gate = deferred()
  const entered = deferred()
  const apps = fakeApps({ closeEntered: entered, closeGate: gate })
  const launchpad = await create(directory, { createWorkSession: apps.create, shutdownTimeoutMs: 1 }, false)
  const keepAlive = http.createServer()
  await new Promise<void>((resolve) => keepAlive.listen(0, '127.0.0.1', resolve))
  try {
    const address = await startOperator(launchpad)
    assert.equal((await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })).status, 202)
    const closing = launchpad.close()
    await entered.promise
    await closing
    assert.equal(apps.state.live, 1, 'the existing default mode remains bounded while owner cleanup is gated')
    gate.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(apps.state.live, 0)
    assert.equal(apps.state.closed, 1)
    assert.equal(inspect(launchpad).server.listening, false)
  } finally {
    gate.resolve()
    await launchpad.close().catch(() => undefined)
    await new Promise<void>((resolve) => keepAlive.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('ordinary factory failures before shutdown do not poison a later successful strict close', async () => {
  const directory = await fixture()
  const launchpad = await create(directory, { createWorkSession: async () => { throw new Error('invalid session configuration') } })
  try {
    const address = await startOperator(launchpad)
    const response = await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })
    assert.equal(response.status, 500)
    await response.text()
    await launchpad.close()
    noResources(launchpad)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

test('strict Launchpad publishes shared close before an owned cleanup synchronously reenters', async () => {
  const directory = await fixture()
  let reentered: Promise<void> | undefined
  let closes = 0
  const launchpad = await create(directory, { createWorkSession: async () => ({
    controller: { start: () => ({ started: true }) },
    start: async () => ({ url: 'http://127.0.0.1:54000' }),
    isLive: () => true, hasActiveSession: () => false,
    close() { closes++; reentered = launchpad.close(); return Promise.resolve() },
  }) })
  try {
    const address = await startOperator(launchpad)
    const response = await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })
    assert.equal(response.status, 202)
    await response.text()
    const closing = launchpad.close()
    assert.equal(reentered, closing)
    await closing
    assert.equal(closes, 1)
    noResources(launchpad)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

test('failed cleanup of a partially initialized factory remains visible to strict shutdown', async () => {
  const directory = await fixture()
  const cleanup = new Error('partial Runtime cleanup failed')
  const failure = new ProductionWorkSessionInitializationError(new Error('hydration failed'), [cleanup])
  const launchpad = await create(directory, { createWorkSession: async () => { throw failure } })
  try {
    const address = await startOperator(launchpad)
    const response = await post(launchpad, address.url, 'start', { configId: launchpad.getConfigs()[0]!.configId })
    assert.equal(response.status, 500)
    await response.text()
    await assert.rejects(launchpad.close(), (error) => errorTree(error).includes(cleanup))
    noResources(launchpad)
  } finally { await launchpad.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }) }
})
