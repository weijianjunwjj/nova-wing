import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DESKTOP_IDENTITY } from '../main/identity.mjs'
import {
  createDesktopNotificationProvider,
  DESKTOP_NOTIFICATION_ACKNOWLEDGEMENT_MS,
  desktopNotificationIdentity,
} from '../main/notifications.mjs'

function payload(notificationId = 'session-A:completed', sessionId = 'session-A') {
  return {
    notificationId, session: { id: sessionId, targetRepo: join(tmpdir(), 'secret', 'project'), branch: 'private-branch' },
    control: { localUrl: 'http://127.0.0.1:9999/untrusted' },
    reportUrl: 'https://untrusted.example',
    safeReason: 'token=secret; private raw output',
  }
}

function fixture(options = {}) {
  const instances = []
  const clicks = []
  const diagnostics = []
  class NativeNotification extends EventEmitter {
    static supported = true
    static activation
    static isSupported() { return NativeNotification.supported }
    static handleActivation(callback) { NativeNotification.activation = callback }
    constructor(settings) {
      super()
      this.settings = settings
      this.showCount = 0
      this.closeCount = 0
      instances.push(this)
    }
    show() { this.showCount++ }
    close() { this.closeCount++; this.emit('close') }
  }
  const provider = createDesktopNotificationProvider({
    Notification: NativeNotification, platform: 'win32',
    onSessionClick: (sessionId) => { clicks.push(sessionId) },
    onDiagnostic: (detail) => { diagnostics.push(detail) }, ...options,
  })
  return { provider, NativeNotification, instances, clicks, diagnostics }
}

test('unsupported capability is absent, with no native objects or activation registration', () => {
  let constructed = false
  let registered = false
  class Unsupported extends EventEmitter {
    static isSupported() { return false }
    static handleActivation() { registered = true }
    constructor() { super(); constructed = true }
    show() {}
    close() {}
  }
  const provider = createDesktopNotificationProvider({ Notification: Unsupported, onSessionClick: () => {} })
  assert.equal(provider, undefined)
  assert.equal(constructed, false)
  assert.equal(registered, false)
})

test('capability failure is unavailable and does not expose native error text', () => {
  const { NativeNotification, provider } = fixture()
  provider.dispose()
  NativeNotification.isSupported = () => { throw new Error('secret') }
  const diagnostics = []
  assert.equal(createDesktopNotificationProvider({ Notification: NativeNotification,
    onSessionClick: () => {}, onDiagnostic: (detail) => { diagnostics.push(detail) } }), undefined)
  assert.deepEqual(diagnostics, [{ phase: 'unsupported', reason: 'CAPABILITY_CHECK_FAILED' }])
})

test('all three kinds declare DESKTOP and acknowledge only native show with private generic text', async (t) => {
  const { provider, instances } = fixture()
  t.after(() => provider.dispose())
  assert.equal(provider.notificationChannel, 'DESKTOP')
  assert.deepEqual(provider.notificationKinds, ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'])
  const methods = ['notifyCompleted', 'notifyFailed', 'notifyHumanRequired']
  const titles = ['NovaWing · 任务已完成', 'NovaWing · 任务失败', 'NovaWing · 需要你的处理']
  for (const [index, method] of methods.entries()) {
    let settled = false
    const delivery = provider[method](payload()).then(() => { settled = true })
    const native = instances[index]
    await Promise.resolve()
    assert.equal(settled, false, 'show() itself is not successful delivery')
    assert.equal(native.showCount, 1)
    assert.equal(native.settings.title, titles[index])
    assert.equal(provider.snapshot().pendingDeliveries, 1)
    assert.doesNotMatch(JSON.stringify(native.settings), /secret|private|127\.0\.0\.1|untrusted|C:\//u)
    native.emit('show')
    await delivery
    native.emit('show')
    assert.equal(provider.snapshot().counts.shown, index + 1, 'repeated show is not a second delivery')
  }
  assert.equal(provider.snapshot().pendingDeliveries, 0)
  assert.equal(provider.snapshot().activeNotificationRefs, 3)
})

test('identity follows durable notification generation and is reused for pending delivery and retry', async (t) => {
  const { provider, instances } = fixture()
  t.after(() => provider.dispose())
  const input = payload('session-A:task-1:2')
  const first = provider.notifyHumanRequired(input)
  const duplicate = provider.notifyHumanRequired(input)
  assert.equal(first, duplicate)
  assert.equal(instances.length, 1)
  const rejection = assert.rejects(first, /NATIVE_FAILED/u)
  instances[0].emit('failed', {}, 'private error')
  await rejection
  const retry = provider.notifyHumanRequired(input)
  assert.equal(instances[1].settings.id, instances[0].settings.id)
  instances[1].emit('show')
  await retry
  await provider.notifyHumanRequired(input)
  assert.equal(instances.length, 2, 'an already acknowledged retained claim is not re-shown')
  assert.notEqual(desktopNotificationIdentity('HUMAN_REQUIRED', input),
    desktopNotificationIdentity('HUMAN_REQUIRED', payload('session-A:task-1:3')))
  assert.notEqual(desktopNotificationIdentity('COMPLETED', input), desktopNotificationIdentity('FAILED', input))
  assert.notEqual(desktopNotificationIdentity('COMPLETED', input),
    desktopNotificationIdentity('COMPLETED', payload(input.notificationId, 'session-B')))
})

test('native failed rejects safely without changing business payload or leaving resources', async () => {
  const { provider, instances, diagnostics } = fixture()
  const input = Object.freeze({ ...payload(), state: 'COMPLETED', completionReason: 'ALL_TASKS_COMPLETED' })
  const delivery = provider.notifyCompleted(input)
  const rejection = assert.rejects(delivery, (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Desktop notification failed: NATIVE_FAILED')
    return true
  })
  instances[0].emit('failed', {}, `token=private, ${join(tmpdir(), 'secret', 'project')}`)
  await rejection
  assert.equal(input.state, 'COMPLETED')
  assert.equal(input.completionReason, 'ALL_TASKS_COMPLETED')
  assert.doesNotMatch(JSON.stringify(diagnostics), /token|private|secret/u)
  assert.equal(provider.snapshot().counts.failed, 1)
  assert.equal(provider.snapshot().pendingDeliveries, 0)
  assert.equal(provider.snapshot().activeNotificationRefs, 0)
  assert.equal(provider.snapshot().timerCount, 0)
  assert.deepEqual(instances[0].eventNames(), [])
  assert.equal(instances[0].closeCount, 1)
  provider.dispose()
})

test('acknowledgement timeout is finite, fails, and permits an existing runtime retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { provider, instances } = fixture()
  t.after(() => provider.dispose())
  const first = provider.notifyCompleted(payload())
  const rejection = assert.rejects(first, /ACKNOWLEDGEMENT_TIMEOUT/u)
  t.mock.timers.tick(DESKTOP_NOTIFICATION_ACKNOWLEDGEMENT_MS - 1)
  assert.equal(provider.snapshot().pendingDeliveries, 1)
  t.mock.timers.tick(1)
  await rejection
  assert.equal(provider.snapshot().counts.timedOut, 1)
  assert.equal(provider.snapshot().activeNotificationRefs, 0)
  assert.equal(provider.snapshot().timerCount, 0)
  const retry = provider.notifyCompleted(payload())
  assert.equal(instances[1].settings.id, instances[0].settings.id)
  instances[1].emit('show')
  await retry
  assert.equal(provider.snapshot().counts.shown, 1)
})

test('construction and synchronous show exceptions fail delivery using safe reasons', async (t) => {
  const { NativeNotification, provider } = fixture()
  provider.dispose()
  class ConstructionFailed extends NativeNotification {
    constructor(settings) { super(settings); throw new Error('sensitive construction failure') }
  }
  const failingConstructor = createDesktopNotificationProvider({ Notification: ConstructionFailed, onSessionClick: () => {} })
  t.after(() => failingConstructor.dispose())
  await assert.rejects(failingConstructor.notifyCompleted(payload()), { message: 'Desktop notification failed: CONSTRUCTION_FAILED' })
  assert.equal(failingConstructor.snapshot().timerCount, 0)
  const second = fixture()
  t.after(() => second.provider.dispose())
  second.NativeNotification.prototype.show = () => { throw new Error('private failure') }
  await assert.rejects(second.provider.notifyFailed(payload()), { message: 'Desktop notification failed: SHOW_FAILED' })
  assert.equal(second.provider.snapshot().activeNotificationRefs, 0)
})

test('instance click carries only session identity; centralized arguments never navigate', async (t) => {
  const { provider, NativeNotification, instances, clicks } = fixture()
  t.after(() => provider.dispose())
  const delivery = provider.notifyCompleted(payload())
  const identity = instances[0].settings.id
  assert.equal(await provider.activateNotification(identity), false, 'a pending toast cannot navigate')
  instances[0].emit('show')
  await delivery
  for (const argumentsValue of [identity, 'session-A', 'http://127.0.0.1:9999', 'file:///private', 'unsafe-command --private']) {
    NativeNotification.activation({ type: 'click', arguments: argumentsValue })
  }
  assert.deepEqual(clicks, [])
  instances[0].emit('click')
  await Promise.resolve()
  assert.deepEqual(clicks, ['session-A'])
  assert.equal(await provider.activateNotification('http://127.0.0.1:9999'), false)
  assert.equal(provider.snapshot().counts.clicked, 1)
  assert.equal(provider.snapshot().counts.unresolvedActivations, 5)
})

test('close before show fails; Windows timed-out close after show retains bounded instance click', async (t) => {
  const { provider, instances, clicks } = fixture()
  t.after(() => provider.dispose())
  const first = provider.notifyCompleted(payload())
  const rejection = assert.rejects(first, /CLOSED_BEFORE_ACKNOWLEDGEMENT/u)
  instances[0].emit('close')
  await rejection
  const retry = provider.notifyCompleted(payload())
  instances[1].emit('show')
  await retry
  instances[1].emit('close', { reason: 'timedOut' })
  assert.equal(provider.snapshot().activeNotificationRefs, 1)
  instances[1].emit('click')
  await Promise.resolve()
  assert.deepEqual(clicks, ['session-A'])
})

test('missing close event cannot retain native notification objects forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { provider, instances } = fixture({ retentionMs: 100 })
  t.after(() => provider.dispose())
  const delivery = provider.notifyCompleted(payload())
  instances[0].emit('show')
  await delivery
  assert.equal(provider.snapshot().activeNotificationRefs, 1)
  t.mock.timers.tick(100)
  assert.equal(provider.snapshot().activeNotificationRefs, 0)
  assert.equal(provider.snapshot().timerCount, 0)
  assert.deepEqual(instances[0].eventNames(), [])
  assert.equal(await provider.activateNotification(instances[0].settings.id), false)
})

test('retained objects have a capacity bound and pending deliveries are never evicted as successes', async (t) => {
  const { provider, instances } = fixture({ maxRetained: 2 })
  t.after(() => provider.dispose())
  const first = provider.notifyCompleted(payload('one'))
  const second = provider.notifyCompleted(payload('two'))
  await assert.rejects(provider.notifyCompleted(payload('three')), /capacity reached/u)
  assert.equal(provider.snapshot().pendingDeliveries, 2)
  instances[0].emit('show')
  await first
  const third = provider.notifyCompleted(payload('three'))
  assert.equal(instances[0].closeCount, 1, 'oldest settled object is evicted')
  assert.equal(provider.snapshot().activeNotificationRefs, 2)
  instances[1].emit('show')
  instances[2].emit('show')
  await Promise.all([second, third])
  assert.equal(provider.snapshot().counts.shown, 3)
})

test('quit request disables click synchronously while admitted delivery and retry can settle', async (t) => {
  let quitRequested = false
  const { provider, instances, NativeNotification, clicks } = fixture({ isQuitRequested: () => quitRequested })
  t.after(() => provider.dispose())
  const first = provider.notifyCompleted(payload())
  const rejection = assert.rejects(first, /NATIVE_FAILED/u)
  quitRequested = true
  instances[0].emit('failed')
  await rejection
  const retry = provider.notifyCompleted(payload())
  instances[1].emit('show')
  await retry
  instances[1].emit('click')
  NativeNotification.activation({ type: 'click', arguments: 'anything' })
  assert.equal(await provider.activateNotification(instances[1].settings.id), false)
  assert.deepEqual(clicks, [])
  assert.equal(provider.snapshot().counts.unresolvedActivations, 0)
})

test('shutdown clears pending promises, timers and listeners and lifetime activation is fail-closed', async () => {
  const { provider, instances, NativeNotification, clicks } = fixture()
  const shown = provider.notifyCompleted(payload('shown'))
  instances[0].emit('show')
  await shown
  const pending = provider.notifyHumanRequired(payload('pending'))
  const rejection = assert.rejects(pending, /PROVIDER_DISPOSED/u)
  provider.beginShutdown()
  assert.equal(await provider.activateNotification(instances[0].settings.id), false)
  provider.dispose()
  provider.dispose()
  await rejection
  for (const native of instances) {
    assert.equal(native.closeCount, 1)
    assert.deepEqual(native.eventNames(), [])
    native.emit('click')
    native.emit('show')
  }
  NativeNotification.activation({ type: 'click', arguments: 'session-A' })
  const snapshot = provider.snapshot()
  assert.equal(snapshot.disposed, true)
  assert.equal(snapshot.pendingDeliveries, 0)
  assert.equal(snapshot.activeNotificationRefs, 0)
  assert.equal(snapshot.timerCount, 0)
  assert.deepEqual(clicks, [])
  await assert.rejects(provider.notifyCompleted(payload()), /disposed/u)
})

test('diagnostic and click callback failures stay outside delivery success', async (t) => {
  const { provider, instances } = fixture({
    onDiagnostic: () => { throw new Error('observer failed') },
    onSessionClick: async () => { throw new Error('host navigation failed') },
  })
  t.after(() => provider.dispose())
  const delivered = provider.notifyFailed(payload())
  instances[0].emit('show')
  await delivered
  assert.equal(await provider.activateNotification(instances[0].settings.id), false)
  assert.equal(provider.snapshot().counts.routeFailed, 1)
  assert.equal(provider.snapshot().counts.failed, 0)
  assert.equal(provider.snapshot().counts.shown, 1)
})

test('cleanup tolerates native close failure and non-Windows needs no activation API', async () => {
  const { provider, instances, NativeNotification } = fixture({ platform: 'darwin' })
  assert.equal(NativeNotification.activation, undefined)
  const delivered = provider.notifyCompleted(payload())
  instances[0].emit('show')
  await delivered
  instances[0].close = () => { throw new Error('native close failed') }
  provider.dispose()
  assert.equal(provider.snapshot().activeNotificationRefs, 0)
  assert.equal(provider.snapshot().timerCount, 0)
})

test('identity config pins the immutable product and notification identities', () => {
  assert.equal(DESKTOP_IDENTITY.appName, 'NovaWing')
  assert.equal(DESKTOP_IDENTITY.version, '0.4.1')
  assert.equal(DESKTOP_IDENTITY.appUserModelId, 'io.github.weijianjunwjj.novawing')
  assert.equal(DESKTOP_IDENTITY.toastActivatorCLSID, '5F5D220B-E789-5710-A023-D7CA6AD8E382')
  assert.equal(Object.isFrozen(DESKTOP_IDENTITY), true)
})
