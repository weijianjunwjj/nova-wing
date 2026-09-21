import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDesktopHost } from '../main/host.mjs'
import { createShutdownCoordinator, describeShutdownError } from '../main/shutdown.mjs'

async function flushPromises() { for (let i = 0; i < 8; i++) await Promise.resolve() }

function fakeHostOptions(launchpad, dependencies = {}, onFactory = undefined) {
  return { configDirectory: 'unused-isolated-config', env: {}, dependencies,
    launchpadFactory: async (options) => {
      assert.equal(options.shutdownMode, 'strict', 'Desktop must explicitly opt into strict shutdown')
      await onFactory?.(options)
      return launchpad
    } }
}

test('Desktop host shares start and close and drains an admitted start before close settles', async () => {
  const started = Promise.withResolvers()
  const releaseStart = Promise.withResolvers()
  const releaseClose = Promise.withResolvers()
  let starts = 0
  let closes = 0
  let listener = false
  const launchpad = {
    async start() {
      starts++
      started.resolve(undefined)
      await releaseStart.promise
      listener = true
      return { url: 'http://127.0.0.1:43111', port: 43111 }
    },
    async close() {
      closes++
      await releaseStart.promise
      await releaseClose.promise
      listener = false
    },
  }
  const host = await createDesktopHost(fakeHostOptions(launchpad))
  const start = host.start()
  assert.equal(host.start(), start)
  await started.promise
  const close = host.close()
  assert.equal(host.close(), close)
  let closed = false
  void close.then(() => { closed = true })
  await flushPromises()
  assert.equal(closed, false)
  assert.equal(closes, 1, 'Closing stops Launchpad admission before startup drains')
  assert.equal(host.start(), start, 'A repeated start only observes the already admitted operation')
  releaseStart.resolve(undefined)
  await start
  assert.equal(listener, true)
  assert.equal(closed, false)
  assert.equal(host.isAllowedNavigation('http://127.0.0.1:43111'), false)
  assert.deepEqual(host.ownedOrigins(), [])
  releaseClose.resolve(undefined)
  await close
  assert.equal(listener, false)
  assert.equal(starts, 1)
  assert.equal(closes, 1)
  assert.equal(host.observations.closeCalls, 1)
})

test('Desktop host close before start rejects new startup and shares completed close', async () => {
  let starts = 0
  let closes = 0
  const host = await createDesktopHost(fakeHostOptions({
    async start() { starts++; return { url: 'http://127.0.0.1:43112' } },
    async close() { closes++ },
  }))
  const close = host.close()
  await close
  assert.equal(host.close(), close)
  await assert.rejects(host.start(), /closing/u)
  assert.equal(starts, 0)
  assert.equal(closes, 1)
})

test('Desktop host cleans up and reports startup and cleanup errors during the race', async () => {
  const release = Promise.withResolvers()
  const startError = new Error('listen failed')
  const closeError = new Error('cleanup failed')
  let closes = 0
  const host = await createDesktopHost(fakeHostOptions({
    async start() { await release.promise; throw startError },
    async close() { closes++; throw closeError },
  }))
  const start = host.start()
  const startRejected = assert.rejects(start, (error) => error === startError)
  const close = host.close()
  const closeRejected = assert.rejects(close, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [startError, closeError])
    return true
  })
  release.resolve(undefined)
  await Promise.all([startRejected, closeRejected])
  assert.equal(host.close(), close)
  assert.equal(closes, 1)
  assert.deepEqual(host.ownedOrigins(), [])
})

test('Desktop host completed start registers an origin and closes it once', async () => {
  const host = await createDesktopHost(fakeHostOptions({
    async start() { return { url: 'http://127.0.0.1:43113' } },
    async close() {},
  }))
  await host.start()
  assert.equal(host.isAllowedNavigation('http://127.0.0.1:43113'), true)
  await host.close()
  assert.deepEqual(host.ownedOrigins(), [])
})

test('Desktop host shares a synchronously throwing close and clears its origin', async () => {
  const failure = new Error('synchronous Launchpad cleanup failure')
  let closes = 0
  const host = await createDesktopHost(fakeHostOptions({
    async start() { return { url: 'http://127.0.0.1:43114' } },
    close() { closes++; throw failure },
  }))
  await host.start()
  const close = host.close()
  assert.equal(host.close(), close)
  await assert.rejects(close, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [failure])
    return true
  })
  assert.equal(closes, 1)
  assert.deepEqual(host.ownedOrigins(), [])
})

test('Desktop host publishes shared operations before synchronous start and close reentry', async () => {
  let starts = 0
  let closes = 0
  let reenteredStart
  let reenteredClose
  const host = await createDesktopHost(fakeHostOptions({
    start() {
      starts++
      if (starts === 1) reenteredStart = host.start()
      return Promise.resolve({ url: 'http://127.0.0.1:43117' })
    },
    close() {
      closes++
      if (closes === 1) reenteredClose = host.close()
      return Promise.resolve()
    },
  }))
  const start = host.start()
  assert.equal(reenteredStart, start)
  assert.equal(starts, 1)
  await start
  const close = host.close()
  assert.equal(reenteredClose, close)
  assert.equal(closes, 1)
  await close
  assert.equal(host.observations.closeCalls, 1)
  assert.deepEqual(host.ownedOrigins(), [])
})

test('Desktop Control wrapper closes admission synchronously and shares reentrant start and close', async () => {
  const drained = Promise.withResolvers()
  let wrapped = {
    async start() { assert.fail('Control wrapper was not constructed') },
    async close() { assert.fail('Control wrapper was not constructed') },
  }
  let starts = 0
  let closes = 0
  let reenteredStart
  let reenteredClose
  const host = await createDesktopHost(fakeHostOptions(
    { start: async () => ({ url: 'http://127.0.0.1:43115' }), close: () => wrapped.close() },
    { createWorkSession: async () => ({
      start() {
        starts++
        if (starts === 1) reenteredStart = wrapped.start()
        return Promise.resolve({ url: 'http://127.0.0.1:43116' })
      },
      close() {
        closes++
        if (closes === 1) reenteredClose = wrapped.close()
        return drained.promise
      },
    }) },
    async (options) => {
      wrapped = await options.dependencies.createWorkSession({ session: { id: 'control-reentrant' } }, {})
    },
  ))
  await host.start()
  const start = wrapped.start()
  assert.equal(reenteredStart, start)
  assert.equal(starts, 1)
  await start
  const close = host.close()
  assert.equal(closes, 1, 'Control close must enter before Host close returns its promise')
  assert.equal(wrapped.close(), wrapped.close())
  assert.equal(reenteredClose, wrapped.close())
  assert.equal(closes, 1)
  assert.equal(host.observations.pendingControlCloses, 1)
  drained.resolve(undefined)
  await close
  assert.equal(host.observations.pendingControlCloses, 0)
  assert.deepEqual(host.observations.controlUnregistered, ['http://127.0.0.1:43116'])
  assert.deepEqual(host.ownedOrigins(), [])
})

test('Desktop Control wrapper rejects first start after its close was admitted', async () => {
  let wrapped = {
    async start() { assert.fail('Control wrapper was not constructed') },
    async close() { assert.fail('Control wrapper was not constructed') },
  }
  let starts = 0
  const host = await createDesktopHost(fakeHostOptions(
    { start: async () => ({ url: 'http://127.0.0.1:43118' }), close: () => wrapped.close() },
    { createWorkSession: async () => ({
      start() { starts++; return Promise.resolve({ url: 'http://127.0.0.1:43119' }) },
      close: async () => {},
    }) },
    async (options) => { wrapped = await options.dependencies.createWorkSession({ session: { id: 'control-close-first' } }, {}) },
  ))
  await host.close()
  await assert.rejects(wrapped.start(), /closing/u)
  assert.equal(starts, 0)
})

test('Main coordinator waits for an admitted factory before the host exists and reuses repeated quit', async () => {
  const startup = Promise.withResolvers()
  const drain = Promise.withResolvers()
  let host
  let closes = 0
  let finalQuits = 0
  let prevented = 0
  const coordinator = createShutdownCoordinator({
    getStartup: () => startup.promise, getHost: () => host,
    requestFinalQuit() { finalQuits++ }, reportFailure: assert.fail,
  })
  const event = { preventDefault() { prevented++ } }
  coordinator.beforeQuit(event)
  const close = coordinator.shutdown()
  coordinator.beforeQuit(event)
  coordinator.beforeQuit(event)
  assert.equal(coordinator.shutdown(), close)
  await flushPromises()
  assert.equal(coordinator.completed, false)
  assert.equal(closes, 0)
  host = { async close() { closes++; await drain.promise } }
  startup.resolve(undefined)
  await flushPromises()
  assert.equal(closes, 1)
  assert.equal(finalQuits, 0)
  drain.resolve(undefined)
  await close
  await flushPromises()
  assert.equal(coordinator.completed, true)
  assert.equal(finalQuits, 1)
  coordinator.beforeQuit(event)
  assert.equal(prevented, 3, 'The final app.quit may pass without recursion')
  assert.deepEqual(coordinator.observations, { quitRequests: 3, shutdownOperations: 1, finalQuitRequests: 1, failures: 0 })
})

test('Main coordinator immediately closes assigned host and aggregates startup plus cleanup failure', async () => {
  const startup = Promise.withResolvers()
  const drain = Promise.withResolvers()
  const startupError = new Error('startup failed')
  const closeError = new AggregateError([new Error('HTTP cleanup'), new Error('Runtime cleanup')], 'owners failed')
  let closes = 0
  let finalQuits = 0
  const failures = []
  const coordinator = createShutdownCoordinator({
    getStartup: () => startup.promise,
    getHost: () => ({ close() { closes++; return drain.promise } }),
    requestFinalQuit() { finalQuits++ }, reportFailure(error) { failures.push(error) },
  })
  const event = { preventDefault() {} }
  coordinator.beforeQuit(event)
  assert.equal(closes, 1)
  const close = coordinator.shutdown()
  const rejected = assert.rejects(close, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [startupError, closeError])
    return true
  })
  drain.reject(closeError)
  startup.reject(startupError)
  await rejected
  await flushPromises()
  coordinator.beforeQuit(event)
  assert.equal(coordinator.shutdown(), close)
  assert.equal(closes, 1)
  assert.equal(finalQuits, 0)
  assert.equal(failures.length, 1)
  assert.equal(coordinator.requested, true)
  assert.equal(coordinator.completed, false)
  const structured = JSON.stringify(describeShutdownError(failures[0]))
  for (const message of ['startup failed', 'HTTP cleanup', 'Runtime cleanup']) assert.match(structured, new RegExp(message, 'u'))
})

test('Main coordinator publishes shared shutdown before owner close emits another quit', async () => {
  const drain = Promise.withResolvers()
  let closes = 0
  let finalQuits = 0
  let reentered
  const event = { preventDefault() {} }
  const coordinator = createShutdownCoordinator({
    getStartup: async () => {},
    getHost: () => ({ close() {
      closes++
      if (closes === 1) {
        reentered = coordinator.shutdown()
        coordinator.beforeQuit(event)
      }
      return drain.promise
    } }),
    requestFinalQuit() { finalQuits++ }, reportFailure: assert.fail,
  })
  coordinator.beforeQuit(event)
  const shutdown = coordinator.shutdown()
  assert.equal(reentered, shutdown)
  assert.equal(closes, 1)
  assert.equal(coordinator.observations.shutdownOperations, 1)
  assert.equal(finalQuits, 0)
  drain.resolve(undefined)
  await shutdown
  await flushPromises()
  assert.equal(finalQuits, 1)
  assert.deepEqual(coordinator.observations, { quitRequests: 2, shutdownOperations: 1, finalQuitRequests: 1, failures: 0 })
})

test('Session registry resolves only live started controls and revokes synchronously without creating work', async () => {
  const drain = Promise.withResolvers()
  /** @type {(config: object, options: object) => Promise<{ start(): Promise<unknown>, close(): Promise<void> }>} */
  let create = async (_config, _options) => { throw new Error('Factory not ready') }
  let creations = 0
  let live = true
  const provider = { notificationChannel: 'DESKTOP' }
  const host = await createDesktopHost({
    ...fakeHostOptions({ start: async () => ({ url: 'http://127.0.0.1:43201' }), close: async () => {} }, {
      async createWorkSession(_config, options) {
        creations++
        assert.equal(options.desktopNotifier, provider)
        return {
          start: async () => ({ url: `http://127.0.0.1:${43201 + creations}` }),
          close: () => drain.promise,
          isLive: () => live,
        }
      },
    }, async (options) => { create = options.dependencies.createWorkSession }),
    desktopNotifier: provider,
  })
  await host.start()
  const control = await create({ session: { id: 'one' } }, {})
  assert.equal(host.resolveSessionUrl('one'), undefined)
  await control.start()
  assert.equal(host.resolveSessionUrl('one'), 'http://127.0.0.1:43202')
  for (const identity of ['missing', 'http://127.0.0.1:43202', 'file:///secret', '__proto__', {}, null]) {
    assert.equal(host.resolveSessionUrl(identity), undefined)
  }
  live = false
  assert.equal(host.resolveSessionUrl('one'), undefined)
  live = true
  const closing = control.close()
  assert.equal(host.resolveSessionUrl('one'), undefined, 'A draining Control is no longer a click target')
  assert.equal(creations, 1)
  drain.resolve(undefined)
  await closing
  await host.close()
  assert.equal(host.resolveSessionUrl('one'), undefined)
})

test('closing a replaced Session owner cannot remove the new live mapping', async () => {
  /** @type {(config: object, options: object) => Promise<{ start(): Promise<unknown>, close(): Promise<void> }>} */
  let create = async (_config, _options) => { throw new Error('Factory not ready') }
  let count = 0
  const host = await createDesktopHost(fakeHostOptions(
    { start: async () => ({ url: 'http://127.0.0.1:43210' }), close: async () => {} },
    { async createWorkSession() {
      const url = `http://127.0.0.1:${43211 + count++}`
      return { start: async () => ({ url }), close: async () => {} }
    } }, async (options) => { create = options.dependencies.createWorkSession },
  ))
  await host.start()
  const first = await create({ session: { id: 'same' } }, {})
  const second = await create({ session: { id: 'same' } }, {})
  await first.start()
  await second.start()
  await first.close()
  assert.equal(host.resolveSessionUrl('same'), 'http://127.0.0.1:43212')
  await second.close()
  await host.close()
})
