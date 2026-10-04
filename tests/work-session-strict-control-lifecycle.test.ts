import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import { createProductionWorkSessionUi, type TrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]
}

function watch(operation: Promise<unknown>): () => boolean {
  let settled = false
  void operation.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

function trustedConfig(storageUrl: string): TrustedWorkSessionConfig {
  return {
    session: { id: 'strict-control', targetRepo: process.cwd(), branch: 'feat/v0.4-desktop',
      limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'lifecycle test', guardian: { constraints: [], acceptanceCriteria: [],
      doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false },
    storageUrl,
  }
}

await test('strict controller shares close, drains accepted start, and rejects every new mutation', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  let etaClosed = 0
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    taskEta: { project: () => undefined, close: () => { etaClosed++ } } })
  assert.deepEqual(controller.start(), { started: true })
  const closing = controller.close()
  const settled = watch(closing)
  assert.equal(controller.close(), closing)
  assert.deepEqual(controller.start(), { started: false })
  for (const result of [controller.requestPause(), controller.requestStopAfterTask(), controller.resume({}),
    controller.resumeRecoverable({}), controller.approvePendingVerificationAndContinue(),
    controller.rejectPendingVerification(), controller.repairRuntimeAndResume(), controller.recoverFailedCheckpoint()]) {
    assert.equal(result.accepted, false)
    assert.match(result.reason ?? '', /closing/u)
  }
  await assert.rejects(controller.loadPersistedState(), /closing/u)
  assert.equal(settled(), false)
  assert.equal(etaClosed, 1)
  runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
  await closing
  assert.equal(runtime.startCalls, 1)
  assert.equal(controller.hasActiveOperation(), false)
  assert.equal(etaClosed, 1)
})

await test('default controller close retains bounded behavior with an unfinished operation', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  const controller = new WorkSessionControlController({ createRuntime: () => runtime })
  controller.start()
  const running = controller.getStartPromise()
  await controller.close()
  assert.equal(controller.hasActiveOperation(), true)
  runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
  await running
})

await test('controller and server publish shared close before synchronous ETA cleanup reentry', async (context) => {
  for (const owner of ['controller', 'server'] as const) {
    await context.test(owner, async () => {
      const failure = new Error('reentrant ETA cleanup failed')
      let nested: Promise<void> | undefined
      let cleanupCalls = 0
      const controller = new WorkSessionControlController({ createRuntime: () => new FakeRuntime(makeDefinition()), shutdownMode: 'strict',
        taskEta: { project: () => undefined, close: () => {
          cleanupCalls++
          nested = owner === 'controller' ? controller.close() : server.close()
          throw failure
        } } })
      const server = new WorkSessionControlServer({ controller, port: 0 })
      if (owner === 'server') await startOperator(server)
      const closing = owner === 'controller' ? controller.close() : server.close()
      assert.equal(nested, closing, 'a synchronous destructor must observe the published close operation')
      await assert.rejects(closing, (error) => leaves(error).includes(failure))
      assert.equal(cleanupCalls, 1)
      assert.equal(controller.getSubscriberCount(), 0)
      assert.equal(server.isListening(), false)
    })
  }
})

await test('strict scheduled dispatch admitted before preflight closes only after real execution settles', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({ state: 'SCHEDULED', scheduledStartAt: '2026-01-01T00:00:00.000Z' })
  runtime.deferStart()
  const preflightEntered = deferred()
  const preflight = deferred()
  const dispatched = deferred()
  const start = runtime.start.bind(runtime)
  runtime.start = () => { dispatched.resolve(); return start() }
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    beforeResume: async () => { preflightEntered.resolve(); await preflight.promise } })
  assert.equal(controller.start().started, true)
  await preflightEntered.promise
  const closing = controller.close()
  const settled = watch(closing)
  assert.equal(controller.start().started, false)
  preflight.resolve()
  await dispatched.promise
  assert.equal(settled(), false)
  assert.equal(runtime.startCalls, 1)
  runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
  await closing
})

await test('strict controller drains hydration, propagates operation errors, and attempts ETA cleanup', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  const hydration = deferred<ReturnType<typeof makeState>>()
  runtime.loadPersistedState = () => hydration.promise
  const operationError = new Error('hydrate failed')
  const etaError = new Error('ETA cleanup failed')
  let etaClosed = 0
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    taskEta: { project: () => undefined, close: () => { etaClosed++; throw etaError } } })
  controller.subscribe({ onEvent() {}, onSnapshot() {} })
  const loading = controller.loadPersistedState()
  const loadingFailure = assert.rejects(loading, /hydrate failed/u)
  const closing = controller.close()
  const failure = assert.rejects(closing, (error) => {
    assert.deepEqual(new Set(leaves(error)), new Set([operationError, etaError]))
    return true
  })
  hydration.reject(operationError)
  await Promise.all([loadingFailure, failure])
  assert.equal(controller.close(), closing)
  assert.equal(controller.getSubscriberCount(), 0)
  assert.equal(etaClosed, 1)
})

await test('strict controller drains every asynchronous resume, approval, repair and checkpoint entry point', async (context) => {
  for (const kind of ['resume', 'interrupted', 'durable-approval', 'approve', 'reject', 'runtime-repair', 'checkpoint'] as const) {
    await context.test(kind, async () => {
      const work = deferred<ReturnType<typeof makeState>>()
      let calls = 0
      const run = () => { calls++; return work.promise }
      const runtime = Object.assign(new FakeRuntime(makeDefinition()), {
        resume: run, resumeInterrupted: run, resumeWithDurableVerificationApproval: run,
        approvePendingVerificationAndContinue: run, rejectPendingVerification: run,
        repairRuntimeAndResume: run, recoverFailedGitCheckpoint: run,
      })
      runtime.state = makeState({ state: 'SUSPENDED', currentTaskId: 'T1', suspensionReason: 'USER_PAUSED' })
      if (kind === 'interrupted') runtime.state.state = 'RUNNING'
      if (kind === 'durable-approval') runtime.durableVerificationRecoveryAvailable = true
      if (kind === 'approve' || kind === 'reject') {
        runtime.state.humanRequired = { category: 'DECISION_REQUIRED', reason: 'approve verification' }
        runtime.state.pendingVerificationApproval = { sessionId: runtime.state.sessionId, taskId: 'T1', command: 'npm test',
          commandFingerprint: 'test-command', generation: 1, status: 'REQUESTED' }
      }
      if (kind === 'runtime-repair') {
        runtime.state.humanRequired = { category: 'ENVIRONMENT_REQUIRED', reason: 'PROVIDER_UNAVAILABLE' }
      }
      if (kind === 'checkpoint') {
        runtime.state = makeState({ state: 'FAILED', currentTaskId: 'T1', failureStage: 'GIT_PUSH',
          failureCategory: 'GIT_PUSH_FAILED', checkpointCommits: { T1: 'abcdef' } })
      }
      const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict' })
      const result = kind === 'resume' ? controller.resume({})
        : kind === 'interrupted' || kind === 'durable-approval' ? controller.resumeRecoverable({})
          : kind === 'approve' ? controller.approvePendingVerificationAndContinue()
            : kind === 'reject' ? controller.rejectPendingVerification()
              : kind === 'runtime-repair' ? controller.repairRuntimeAndResume() : controller.recoverFailedCheckpoint()
      assert.equal(result.accepted, true)
      const closing = controller.close()
      const settled = watch(closing)
      await Promise.resolve()
      assert.equal(settled(), false)
      assert.equal(calls, 1)
      work.resolve(makeState({ state: 'COMPLETED' }))
      await closing
      assert.equal(controller.hasActiveOperation(), false)
    })
  }
})

await test('strict controller also waits for its presentation service cleanup', async () => {
  const eta = deferred()
  let etaClosed = false
  const controller = new WorkSessionControlController({ createRuntime: () => new FakeRuntime(makeDefinition()), shutdownMode: 'strict',
    taskEta: { project: () => undefined, close: () => { etaClosed = true }, settled: () => eta.promise } })
  const closing = controller.close()
  const settled = watch(closing)
  await Promise.resolve()
  assert.equal(etaClosed, true)
  assert.equal(settled(), false)
  eta.resolve()
  await closing
})

await test('real SSE remains independent of strict drain and closes before the HTTP listener', { timeout: 10_000 }, async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict' })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  const cookie = await mintSession(server)
  const response = await sessionFetch(`${address.url}/api/events`)
  const reader = response.body!.getReader()
  await reader.read()
  assert.equal(controller.getSubscriberCount(), 1)
  controller.start()
  const closing = server.close()
  const settled = watch(closing)
  assert.equal(server.close(), closing)
  const streamEnded = (async () => { while (!(await reader.read()).done) { /* drain actual network stream */ } })()
  try {
    for (const route of ['start', 'pause', 'stop-after-task', 'resume', 'resume-recoverable', 'approve-verification',
      'reject-verification', 'runtime-repair', 'recover-checkpoint']) {
      const rejected = await sessionFetch(`${address.url}/api/session/${route}`, { method: 'POST', body: '{}',
        headers: { 'Cookie': cookie, Origin: address.url, 'Content-Type': 'application/json' } })
      assert.equal(rejected.status, 503, route)
      assert.match(await rejected.text(), /closing/u)
    }
    assert.equal((await sessionFetch(`${address.url}/api/events`)).status, 503)
    assert.equal(settled(), false)
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await Promise.all([closing, streamEnded])
    assert.equal(server.isListening(), false)
    assert.equal(controller.getSubscriberCount(), 0)
    assert.equal(controller.hasActiveOperation(), false)
    assert.equal(runtime.startCalls, 1)
  } finally {
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await server.close()
  }
})

await test('strict Control drains admitted work and SSE without waiting for HTTP preconnections', { timeout: 10_000 }, async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict' })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  const http = (server as unknown as { server: Server }).server
  const response = await sessionFetch(`${address.url}/api/events`)
  const reader = response.body!.getReader()
  await reader.read()
  const connected = once(http, 'connection')
  const empty = createConnection({ host: address.host, port: address.port })
  await Promise.all([connected, once(empty, 'connect')])
  const partialConnected = once(http, 'connection')
  const partial = createConnection({ host: address.host, port: address.port })
  const [[partialServerSocket]] = await Promise.all([partialConnected, once(partial, 'connect')])
  const headersReceived = once(partialServerSocket, 'data')
  partial.write('GET /api/status HTTP/1.1\r\nHost:')
  await headersReceived
  controller.start()
  const closing = server.close()
  const settled = watch(closing)
  let sseEnded = false
  const streamEnded = (async () => {
    while (!(await reader.read()).done) { /* keep consuming the live SSE response */ }
    sseEnded = true
  })()
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled(), false)
    assert.equal(sseEnded, false, 'an admitted Runtime still owns the live SSE response')
    assert.equal(empty.destroyed, false)
    assert.equal(partial.destroyed, false)
    const httpClosed = once(http, 'close', { signal: AbortSignal.timeout(2_000) })
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await httpClosed
    await Promise.all([closing, streamEnded])
    assert.equal(server.isListening(), false)
    assert.equal(controller.getSubscriberCount(), 0)
    assert.equal(runtime.startCalls, 1)
  } finally {
    empty.destroy()
    partial.destroy()
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await Promise.all([server.close(), streamEnded])
  }
})

await test('an incomplete HTTP body is drained but cannot gain mutation admission after close', { timeout: 10_000 }, async () => {
  const runtime = new FakeRuntime(makeDefinition())
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict' })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  const cookie = await mintSession(server)
  const received = deferred()
  const http = (server as unknown as { server: Server }).server
  http.once('request', () => received.resolve())
  const result = deferred<{ status: number; body: string }>()
  const client = request(`${address.url}/api/session/start`, { method: 'POST', headers: {
    'Cookie': cookie, Origin: address.url, 'Content-Length': '2',
  } }, (response) => {
    let body = ''
    response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    response.on('end', () => result.resolve({ status: response.statusCode!, body }))
  })
  client.on('error', result.reject)
  client.flushHeaders()
  await received.promise
  const closing = server.close()
  const settled = watch(closing)
  await Promise.resolve()
  assert.equal(settled(), false)
  client.end('{}')
  assert.equal((await result.promise).status, 503)
  await closing
  assert.equal(runtime.startCalls, 0)
  assert.equal(server.isListening(), false)
})

await test('new partial-body mutation during shutdown gets 503 and cannot keep the HTTP listener alive', { timeout: 10_000 }, async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict' })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  const cookie = await mintSession(server)
  controller.start()
  const closing = server.close()
  const settled = watch(closing)
  const disconnected = deferred()
  const result = deferred<{ status: number; connection: string | undefined; body: string }>()
  const client = request(`${address.url}/api/session/start`, { method: 'POST', headers: {
    'Cookie': cookie, Origin: address.url, 'Content-Length': '2',
  } }, (response) => {
    let body = ''
    response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    response.on('end', () => result.resolve({ status: response.statusCode!, connection: response.headers.connection, body }))
  })
  client.once('socket', (socket) => socket.once('close', () => disconnected.resolve()))
  client.on('error', result.reject)
  try {
    // No body and no request.end(): a rejected new request cannot become a
    // shutdown-owned operation or require cooperative client completion.
    client.flushHeaders()
    const rejected = await result.promise
    assert.equal(rejected.status, 503)
    assert.equal(rejected.connection, 'close')
    assert.match(rejected.body, /closing/u)
    await disconnected.promise
    assert.equal(settled(), false, 'the originally admitted runtime is still gated')
    assert.equal(runtime.startCalls, 1)
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await closing
    assert.equal(server.isListening(), false)
    assert.equal(controller.hasActiveOperation(), false)
  } finally {
    client.destroy()
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await server.close()
  }
})

await test('control listener start and close share operations even when listen has not completed', async () => {
  const controller = new WorkSessionControlController({ createRuntime: () => new FakeRuntime(makeDefinition()), shutdownMode: 'strict' })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const starting = server.start()
  assert.equal(server.start(), starting)
  const closing = server.close()
  assert.equal(server.close(), closing)
  await Promise.all([starting, closing])
  assert.equal(server.isListening(), false)
  assert.equal(server.start(), starting, 'already admitted startup keeps its shared outcome after close')
  const neverStarted = new WorkSessionControlServer({ controller, port: 0 })
  await neverStarted.close()
  await assert.rejects(neverStarted.start(), /closing/u)
})

await test('controller cleanup failure still closes a real SSE stream and HTTP listener', { timeout: 10_000 }, async () => {
  const failure = new Error('controller cleanup failed')
  const controller = new WorkSessionControlController({ createRuntime: () => new FakeRuntime(makeDefinition()), shutdownMode: 'strict',
    taskEta: { project: () => undefined, close: () => { throw failure } } })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  const response = await sessionFetch(`${address.url}/api/events`)
  const reader = response.body!.getReader()
  await reader.read()
  const streamEnded = (async () => { while (!(await reader.read()).done) { /* consume until EOF */ } })()
  await assert.rejects(server.close(), (error) => leaves(error).includes(failure))
  await streamEnded
  assert.equal(controller.getSubscriberCount(), 0)
  assert.equal(server.isListening(), false)
})

await test('Production shared close attempts runtime and controller cleanup after server failure, retaining all errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-strict-production-'))
  try {
    for (const runtimeFails of [false, true]) {
      const calls = { server: 0, runtime: 0, eta: 0 }
      const serverError = new Error('server cleanup failed')
      const runtimeError = new Error('runtime cleanup failed')
      const app = await createProductionWorkSessionUi(trustedConfig(pathToFileURL(join(directory, `${runtimeFails}.db`)).href), {
        shutdownMode: 'strict', serverPort: 0, env: { NOVAWING_DATA_DIR: directory },
        taskEta: { project: () => undefined, close: () => { calls.eta++ } },
        createRuntime: (config) => Object.assign(new FakeRuntime(config.definition), { close: async () => {
          calls.runtime++
          if (runtimeFails) throw runtimeError
        } }),
      })
      app.server.close = () => { calls.server++; throw serverError }
      const closing = app.close()
      assert.equal(app.close(), closing)
      await assert.rejects(closing, (error) => {
        assert.deepEqual(leaves(error), runtimeFails ? [serverError, runtimeError] : [serverError])
        return true
      })
      assert.deepEqual(calls, { server: 1, runtime: 1, eta: 1 })
      await assert.rejects(app.start(), /closing/u)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

await test('Production keeps an admitted start shared during and after close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-production-start-close-'))
  let runtimeClosed = 0
  const app = await createProductionWorkSessionUi(trustedConfig(pathToFileURL(join(directory, 'session.db')).href), {
    shutdownMode: 'strict', serverPort: 0, env: { NOVAWING_DATA_DIR: directory },
    createRuntime: (config) => Object.assign(new FakeRuntime(config.definition), {
      close: async () => { runtimeClosed++ },
    }),
  })
  try {
    const starting = app.start()
    assert.equal(app.start(), starting)
    const closing = app.close()
    assert.equal(app.start(), starting)
    await Promise.all([starting, closing])
    assert.equal(app.start(), starting)
    assert.equal(app.isLive(), false)
    assert.equal(runtimeClosed, 1)
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Production publishes shared close before synchronous server cleanup reentry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-production-reentrant-close-'))
  let runtimeClosed = 0
  let serverClosed = 0
  let nested: Promise<void> | undefined
  const app = await createProductionWorkSessionUi(trustedConfig(pathToFileURL(join(directory, 'session.db')).href), {
    shutdownMode: 'strict', serverPort: 0, env: { NOVAWING_DATA_DIR: directory },
    createRuntime: (config) => Object.assign(new FakeRuntime(config.definition), {
      close: async () => { runtimeClosed++ },
    }),
  })
  const originalClose = app.server.close.bind(app.server)
  app.server.close = () => {
    serverClosed++
    nested = app.close()
    return originalClose()
  }
  try {
    await startOperator(app)
    const closing = app.close()
    assert.equal(nested, closing)
    await closing
    assert.equal(serverClosed, 1)
    assert.equal(runtimeClosed, 1)
    assert.equal(app.isLive(), false)
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Production hydration failure cleans every owner and retains initialization plus cleanup errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-strict-hydration-'))
  const hydrationError = new Error('production hydration failed')
  const cleanupError = new Error('production runtime cleanup failed')
  let runtimeClosed = 0
  let etaClosed = 0
  try {
    await assert.rejects(createProductionWorkSessionUi(trustedConfig(pathToFileURL(join(directory, 'session.db')).href), {
      shutdownMode: 'strict', serverPort: 0, env: { NOVAWING_DATA_DIR: directory },
      taskEta: { project: () => undefined, close: () => { etaClosed++ } },
      createRuntime: (config) => Object.assign(new FakeRuntime(config.definition), {
        loadPersistedState: async () => { throw hydrationError },
        close: async () => { runtimeClosed++; throw cleanupError },
      }),
    }), (error) => {
      assert.deepEqual(leaves(error), [hydrationError, cleanupError])
      return true
    })
    assert.equal(runtimeClosed, 1)
    assert.equal(etaClosed, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
