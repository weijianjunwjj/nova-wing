import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import { SmtpWorkSessionNotifier, WorkSessionRuntime } from 'nova-wing/development-guardian'
import { desktopInstance, desktopReady, desktopShutdown, shutdownDesktop } from '../main/index.mjs'
import { createDesktopNotificationProvider } from '../main/notifications.mjs'
import { createResourceTracker } from './resource-tracker.mjs'
import { windowNavigationRegression } from './window-navigation-regression.mjs'

const names = [
  'completed_generated', 'completed_desktop_delivery', 'failed_generated', 'failed_desktop_delivery',
  'human_required_generated', 'human_required_desktop_delivery', 'user_paused_not_notified',
  'desktop_independent_from_email_opt_in', 'channel_retry_isolated', 'duplicate_suppression',
  'unsupported_not_registered', 'provider_failure_does_not_change_task', 'hidden_window_notification',
  'click_session_resolution', 'click_show_restore_focus', 'click_no_duplicate_runtime', 'window_navigation_regression', 'notification_drain', 'cleanup',
]
/** @type {Record<string, {status: string, detail?: unknown}>} */
const checks = Object.fromEntries(names.map((name) => [name, { status: 'FAIL', detail: 'Not run' }]))
const result = {
  name: 'DESKTOP_NATIVE_NOTIFICATION', result: 'FAIL', checks, errors: [], childPids: [],
  environment: { electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
  windowsNativeToastVisual: 'NEEDS_PACKAGED_VALIDATION',
  clickAutomation: 'Main provider click handler; no Windows notification-center automation',
}
let allowVerifiedQuit = false
app.on('before-quit', (event) => {
  if (desktopInstance.primary && desktopShutdown.completed && !allowVerifiedQuit) event.preventDefault()
})
function pass(name, detail = undefined) {
  checks[name] = { status: 'PASS', ...(detail === undefined ? {} : { detail }) }
  console.error(`DESKTOP_NOTIFICATION_SMOKE_CHECK ${JSON.stringify({ name, status: 'PASS' })}`)
}
async function eventually(description, condition, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await condition()
    if (value) return value
    await delay(25)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}`)
}
function evaluate(window, expression) { return window.webContents.executeJavaScript(expression, true) }
async function status(url) {
  const response = await fetch(`${url}/api/status`)
  assert.equal(response.status, 200)
  return response.json()
}

/** Failure injection exercises the same provider, preserving real business failure semantics. */
function failingNativeClass(mode = 'failed') {
  return class InjectedNotification extends EventEmitter {
    constructor(_options) { super() }
    static isSupported() { return true }
    static handleActivation() {}
    show() { if (mode === 'failed') queueMicrotask(() => this.emit('failed', {}, 'injected native delivery failure')) }
    close() { this.emit('close') }
  }
}

async function run() {
  let desktop
  let tracker
  let current = 'completed_generated'
  const auxiliaryProviders = []
  const auxiliaryRuntimes = []
  try {
    process.stdout.write('')
    process.stderr.write('')
    tracker = createResourceTracker()
    desktop = await desktopReady
    const { host, fixture, windows, notifications, power } = desktop
    assert.ok(notifications, 'This real-host smoke requires Electron Notification.isSupported()')
    assert.equal(notifications.notificationChannel, 'DESKTOP')
    assert.deepEqual(notifications.notificationKinds, ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'])
    const launchToken = await evaluate(desktop.window,
      `JSON.parse(document.getElementById('novawing-bootstrap').textContent).launchToken`)
    const create = async (taskId, extra = {}) => {
      const response = await fetch(`${host.launchpadUrl}/api/session/create`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: host.launchpadUrl, 'X-NovaWing-Launchpad-Token': launchToken },
        body: JSON.stringify({ ...fixture.createRequest, requestId: `notification-${taskId}-request`,
          tasks: [{ id: taskId, goal: 'Exercise isolated notification Runtime ownership' }], ...extra }) })
      const body = await response.json()
      assert.equal(response.status, 202, JSON.stringify(body))
      return { ...body, sessionId: (await status(body.controlUrl)).configuredSession.id }
    }
    const counts = () => ({ host: desktopInstance.hostCreateCount,
      runtime: fixture.getEvidence().runtimeCreateCount, executions: fixture.getEvidence().taskRunCount })
    const shown = () => notifications.snapshot().counts.shown
    const providerFor = (mode = 'failed') => {
      const provider = createDesktopNotificationProvider({ Notification: failingNativeClass(mode),
        onSessionClick: (sessionId) => windows.showSession(sessionId), platform: process.platform,
        acknowledgementTimeoutMs: 80, isQuitRequested: () => desktopShutdown.requested })
      assert.ok(provider)
      auxiliaryProviders.push(provider)
      return provider
    }
    const finish = async (session, expectedState) => {
      const owned = fixture.getSession(session.sessionId)
      await eventually(`session ${session.sessionId} reaches ${expectedState}`, () =>
        owned.runtime.getDurableState()?.state === expectedState && !owned.app.hasActiveSession())
      await owned.runtime.getNotificationPromise()
      return owned.runtime
    }
    const click = async (session, kind, { minimize = false } = {}) => {
      const record = notifications.snapshot().activeNotifications.find((entry) =>
        entry.sessionId === session.sessionId && entry.kind === kind)
      assert.ok(record, `Retained notification identity for ${kind}`)
      const before = counts()
      if (minimize) {
        await windows.showWindow()
        desktop.window.minimize()
        await eventually('native window minimized', () => desktop.window.isMinimized())
      } else windows.hideWindow()
      assert.equal(host.resolveSessionUrl(session.sessionId), session.controlUrl)
      assert.equal(await notifications.activateNotification(record.identity), true)
      await eventually('click restored and focused native window', () => desktop.window.isVisible() &&
        desktop.window.isFocused() && !desktop.window.isMinimized())
      const restored = await evaluate(desktop.window, 'fetch("/api/status").then(response => response.json())')
      assert.equal(restored.configuredSession.id, session.sessionId)
      assert.equal(new URL(desktop.window.webContents.getURL()).origin, session.controlUrl)
      assert.deepEqual(counts(), before, 'A notification click must only navigate the existing Host and Runtime')
      return { kind, sessionId: session.sessionId, identity: record.identity, ...before,
        visible: true, focused: true, minimized: false }
    }

    // Ordinary idle must never derive notification work from activity/polling.
    assert.equal(power.snapshot().activeCount, 0)
    assert.equal(shown(), 0)
    for (let i = 0; i < 3; i++) {
      const response = await fetch(host.launchpadUrl)
      // Consume the response body: abandoning a large Launchpad response can
      // retain an active HTTP socket until GC and prevent strict server close.
      await response.text()
      assert.equal(response.status, 200)
    }
    assert.equal(shown(), 0)

    const completedGate = fixture.armTask('NOTIFICATION-COMPLETED')
    const completed = await create('NOTIFICATION-COMPLETED')
    await completedGate.started
    await desktop.window.loadURL(completed.controlUrl)
    desktop.window.close()
    assert.equal(desktop.window.isVisible(), false)
    const completedBefore = notifications.snapshot().counts
    completedGate.release()
    const completedRuntime = await finish(completed, 'COMPLETED')
    const completedState = completedRuntime.getDurableState()
    assert.equal(completedState.completionReason, 'ALL_TASKS_COMPLETED')
    assert.equal(completedState.completionNotificationAttempted, true)
    assert.equal(completedState.completionNotified, true)
    assert.equal((await completedRuntime.loadPersistedState()).completionNotified, true)
    assert.equal(desktop.window.isVisible(), false)
    assert.equal(notifications.snapshot().counts.created - completedBefore.created, 1)
    assert.equal(shown() - completedBefore.shown, 1, 'SENT requires an actual Electron show event')
    assert.deepEqual(completedRuntime.getLastNotificationDelivery().channels, [{ channel: 'DESKTOP', status: 'SENT' }])
    pass('completed_generated', { sessionId: completed.sessionId, completionReason: completedState.completionReason,
      durableAttempted: true, durableNotified: true })
    pass('completed_desktop_delivery', { source: 'real Electron Notification show event', attempts: 1, shown: 1 })
    pass('desktop_independent_from_email_opt_in', { smtpEnabled: false, emailNotifyOnCompleted: false,
      channels: completedRuntime.getLastNotificationDelivery().channels,
      assertion: 'Production composition delivered DESKTOP COMPLETED with SMTP and completion email disabled' })
    const clicks = [await click(completed, 'COMPLETED')]

    current = 'failed_generated'
    const taskFailure = 'isolated native notification task failure'
    const failedGate = fixture.armTask('NOTIFICATION-FAILED', { behavior: { type: 'FAILED', error: taskFailure } })
    const failed = await create('NOTIFICATION-FAILED')
    await failedGate.started
    windows.hideWindow()
    const failedBefore = notifications.snapshot().counts
    failedGate.release()
    const failedRuntime = await finish(failed, 'FAILED')
    const failure = failedRuntime.getDurableState()
    assert.equal(failure.failureReason, taskFailure)
    assert.ok(failure.failureStage)
    assert.ok(failure.failureCategory)
    assert.equal(failure.failureNotificationAttempted, true)
    assert.equal(failure.failureNotified, true)
    assert.equal(fixture.getSession(failed.sessionId).runtimeStartErrors.length, 1)
    assert.match(fixture.getSession(failed.sessionId).runtimeStartErrors[0].message, /isolated native notification task failure/u)
    assert.equal(desktop.window.isVisible(), false)
    assert.equal(shown() - failedBefore.shown, 1)
    assert.equal(notifications.snapshot().counts.created - failedBefore.created, 1)
    assert.deepEqual(failedRuntime.getLastNotificationDelivery().channels, [{ channel: 'DESKTOP', status: 'SENT' }])
    pass('failed_generated', { source: 'FakeTaskRunner FAILED result through real Runtime',
      sessionId: failed.sessionId, state: failure.state, stage: failure.failureStage, category: failure.failureCategory })
    pass('failed_desktop_delivery', { attempts: 1, shown: 1, failureReasonUnchanged: true })
    clicks.push(await click(failed, 'FAILED', { minimize: true }))

    current = 'human_required_generated'
    const humanGate = fixture.armTask('NOTIFICATION-HUMAN', {
      behavior: { type: 'HUMAN_REQUIRED', category: 'DECISION_REQUIRED', reason: 'Isolated operator decision' },
    })
    const human = await create('NOTIFICATION-HUMAN')
    await humanGate.started
    windows.hideWindow()
    const humanBefore = notifications.snapshot().counts
    humanGate.release()
    const humanRuntime = await finish(human, 'SUSPENDED')
    const humanState = humanRuntime.getDurableState()
    assert.equal(humanState.humanRequired.category, 'DECISION_REQUIRED')
    assert.equal(humanState.lastNotifiedHumanRequiredGeneration, humanState.humanRequiredGeneration)
    assert.equal(power.snapshot().activeCount, 0)
    assert.equal(power.snapshot().blockerActive, false)
    assert.equal(fixture.getSession(human.sessionId).runtimeCloseCount, 0)
    assert.equal(desktop.window.isVisible(), false)
    assert.equal(shown() - humanBefore.shown, 1)
    assert.equal(notifications.snapshot().counts.created - humanBefore.created, 1)
    assert.deepEqual(humanRuntime.getLastNotificationDelivery().channels, [{ channel: 'DESKTOP', status: 'SENT' }])
    pass('human_required_generated', { state: humanState.state, category: humanState.humanRequired.category,
      generation: humanState.humanRequiredGeneration, runtimeAlive: true, powerBlockerActive: false })
    pass('human_required_desktop_delivery', { attempts: 1, shown: 1 })
    clicks.push(await click(human, 'HUMAN_REQUIRED'))
    pass('hidden_window_notification', { kinds: ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'], shownWhileHidden: 3 })
    pass('click_session_resolution', { clicks, payload: 'internal identity mapped to sessionId',
      navigationSource: 'Host live owned-origin registry' })
    pass('click_show_restore_focus', { allVisibleAndFocused: true, minimizedWindowRestored: true })
    pass('click_no_duplicate_runtime', { clicks, allCountsUnchanged: true })

    current = 'window_navigation_regression'
    pass(current, await windowNavigationRegression(desktop, completed, failed))

    current = 'user_paused_not_notified'
    const quietBefore = notifications.snapshot().counts.created
    const pauseGate = fixture.armTask('NOTIFICATION-PAUSE')
    const paused = await create('NOTIFICATION-PAUSE', { tasks: [
      { id: 'NOTIFICATION-PAUSE', goal: 'Pause before claiming the next offline task' },
      { id: 'NOTIFICATION-NEVER-CLAIMED', goal: 'Must remain unclaimed while paused' },
    ] })
    await pauseGate.started
    assert.equal(fixture.getSession(paused.sessionId).runtime.requestPause().accepted, true)
    pauseGate.release()
    const pausedRuntime = await finish(paused, 'SUSPENDED')
    assert.equal(pausedRuntime.getDurableState().suspensionReason, 'USER_PAUSED')
    assert.equal(pausedRuntime.getDurableState().humanRequired, undefined)
    assert.equal(pausedRuntime.getLastNotificationDelivery(), undefined)
    const scheduledStartAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    fixture.allowFutureSchedule(scheduledStartAt)
    const executionsBefore = fixture.getEvidence().taskRunCount
    const scheduled = await create('NOTIFICATION-SCHEDULED', { scheduled_start_at: scheduledStartAt, schedule_source: 'custom' })
    await eventually('future schedule stays idle', async () => (await status(scheduled.controlUrl)).runtime.state === 'SCHEDULED')
    assert.equal(fixture.getEvidence().taskRunCount, executionsBefore)
    assert.equal(power.snapshot().blockerActive, false)
    assert.equal(notifications.snapshot().counts.created, quietBefore)
    pass('user_paused_not_notified', { suspensionReason: 'USER_PAUSED', humanRequired: false,
      ordinaryIdleNotified: false, futureScheduleNotified: false, futureScheduleExecuted: false })

    current = 'duplicate_suppression'
    await windows.showSession(completed.sessionId)
    const duplicateBefore = notifications.snapshot().counts.created
    const duplicateRuntimeBefore = counts()
    const reloaded = once(desktop.window.webContents, 'did-finish-load')
    desktop.window.reload()
    await reloaded
    windows.hideWindow()
    await windows.showWindow()
    // Open and reconnect real Chromium EventSource streams. No event or delivery is fabricated.
    const sseReconnects = await evaluate(desktop.window, `(async () => {
      for (let i = 0; i < 2; i++) await new Promise((resolve, reject) => {
        const stream = new EventSource('/api/events')
        const timer = setTimeout(() => { stream.close(); reject(new Error('SSE connect timeout')) }, 4000)
        stream.addEventListener('connected', () => { clearTimeout(timer); stream.close(); resolve() }, { once: true })
      })
      for (let i = 0; i < 4; i++) await fetch('/api/status').then(response => response.json())
      return 2
    })()`)
    assert.equal(sseReconnects, 2)
    const crashed = once(desktop.window.webContents, 'render-process-gone')
    desktop.window.webContents.forcefullyCrashRenderer()
    await crashed
    await windows.pendingRecovery
    await eventually('renderer crash recovery retained completed session', async () => {
      if (!desktop.window || desktop.window.isDestroyed() || desktop.window.webContents.isLoadingMainFrame()) return false
      try { return (await evaluate(desktop.window, 'fetch("/api/status").then(response => response.json())')).configuredSession.id === completed.sessionId }
      catch { return false }
    })
    await windows.pendingRecovery
    const previousWindow = desktop.window
    previousWindow.destroy()
    await windows.showWindow()
    assert.notEqual(desktop.window, previousWindow)
    assert.equal(new URL(desktop.window.webContents.getURL()).origin, completed.controlUrl)
    await completedRuntime.getNotificationPromise()
    assert.equal(notifications.snapshot().counts.created, duplicateBefore)
    assert.deepEqual(counts(), duplicateRuntimeBefore)
    pass('duplicate_suppression', { notificationCountBefore: duplicateBefore,
      notificationCountAfter: notifications.snapshot().counts.created,
      actions: ['reload', 'hide/show', 'renderer crash/recovery', 'real SSE reconnect', 'window recreation', 'status polling'],
      realSseConnections: sseReconnects, durableIdentity: completedRuntime.getLastNotificationDelivery().notificationId })

    // Invalid identities cannot smuggle a URL into navigation. Unknown session IDs fall back to Launchpad.
    assert.equal(await notifications.activateNotification('http://127.0.0.1:9/untrusted'), false)
    await windows.showSession('unregistered-session')
    assert.equal(new URL(desktop.window.webContents.getURL()).origin, host.launchpadUrl)

    current = 'unsupported_not_registered'
    let unsupportedConstructed = 0
    class UnsupportedNotification extends EventEmitter {
      static isSupported() { return false }
      constructor(_options) { super(); unsupportedConstructed++ }
      show() { assert.fail('Unsupported notifications must never be created') }
      close() {}
    }
    const unsupported = createDesktopNotificationProvider({ Notification: UnsupportedNotification,
      onSessionClick: () => assert.fail('Unsupported provider must not route clicks') })
    assert.equal(unsupported, undefined)
    const unsupportedGate = fixture.armTask('NOTIFICATION-UNSUPPORTED', { desktopNotifier: null })
    const unsupportedSession = await create('NOTIFICATION-UNSUPPORTED')
    await unsupportedGate.started
    unsupportedGate.release()
    const unsupportedRuntime = await finish(unsupportedSession, 'COMPLETED')
    assert.equal(unsupportedRuntime.getLastNotificationDelivery(), undefined)
    assert.notEqual(unsupportedRuntime.getDurableState().completionNotificationAttempted, true)
    assert.notEqual(unsupportedRuntime.getDurableState().completionNotified, true)
    assert.equal(unsupportedConstructed, 0)
    pass('unsupported_not_registered', { provider: 'absent', desktopCapability: false, nativeObjectsCreated: 0,
      businessState: 'COMPLETED', syntheticSkippedOrSent: false })

    current = 'channel_retry_isolated'
    let emailAttempts = 0
    const retryProvider = providerFor()
    const email = new SmtpWorkSessionNotifier({
      transport: { async sendMail() { emailAttempts++; return { accepted: true } } },
      from: 'novawing@example.invalid', to: 'operator@example.invalid',
    })
    const retryRuntime = new WorkSessionRuntime({
      definition: { id: 'notification-channel-retry', targetRepo: fixture.repoDirectory, branch: fixture.branch,
        tasks: [{ id: 'RETRY', goal: 'Offline channel retry isolation' }], limits: { softMinutes: 5, hardMinutes: 10, maxTasks: 2 } },
      storageUrl: pathToFileURL(join(fixture.dataDirectory, 'notification-channel-retry.db')).href,
      taskRunner: { async run() { return { status: 'COMPLETED' } } },
      notifyOnCompleted: true, notificationRetryDelayMs: 0,
      notificationChannels: [{ channel: 'EMAIL', notifier: email }, { channel: 'DESKTOP', notifier: retryProvider }],
    })
    auxiliaryRuntimes.push(retryRuntime)
    await retryRuntime.start()
    await retryRuntime.getNotificationPromise()
    assert.equal(emailAttempts, 1)
    assert.equal(retryProvider.snapshot().counts.created, 2)
    assert.equal(retryProvider.snapshot().counts.failed, 2)
    assert.deepEqual(retryRuntime.getLastNotificationDelivery().channels.map(({ channel, status: delivery }) =>
      ({ channel, status: delivery })), [{ channel: 'EMAIL', status: 'SENT' }, { channel: 'DESKTOP', status: 'FAILED' }])
    assert.equal(retryRuntime.getDurableState().state, 'COMPLETED')
    await retryRuntime.close()
    pass('channel_retry_isolated', { emailAttempts, desktopAttempts: 2, retryLimit: 1,
      channels: retryRuntime.getLastNotificationDelivery().channels,
      smtpTransport: 'in-memory sendMail fixture; no network' })

    current = 'provider_failure_does_not_change_task'
    const failures = []
    /** @type {Array<[string, import('nova-wing/development-guardian').FakeTaskBehavior, string]>} */
    const failureCases = [
      ['COMPLETED', { type: 'COMPLETED' }, 'COMPLETED'],
      ['FAILED', { type: 'FAILED', error: 'original isolated business failure' }, 'FAILED'],
      ['HUMAN_REQUIRED', { type: 'HUMAN_REQUIRED', category: 'DECISION_REQUIRED', reason: 'original isolated human decision' }, 'SUSPENDED'],
    ]
    for (const [kind, behavior, expectedState] of failureCases) {
      const failedProvider = providerFor()
      const id = `NOTIFICATION-PROVIDER-FAILURE-${kind}`
      const gate = fixture.armTask(id, { behavior, desktopNotifier: failedProvider })
      const session = await create(id)
      await gate.started
      gate.release()
      const runtime = await finish(session, expectedState)
      const delivery = runtime.getLastNotificationDelivery()
      assert.equal(delivery.status, 'FAILED')
      assert.equal(delivery.channels[0].channel, 'DESKTOP')
      assert.equal(delivery.channels[0].status, 'FAILED')
      assert.equal(failedProvider.snapshot().counts.created, 2)
      assert.equal(failedProvider.snapshot().counts.failed, 2)
      assert.equal(failedProvider.snapshot().pendingDeliveries, 0)
      if (behavior.type === 'FAILED') assert.equal(runtime.getDurableState().failureReason, behavior.error)
      if (behavior.type === 'HUMAN_REQUIRED') assert.equal(runtime.getDurableState().humanRequired.reason, behavior.reason)
      failures.push({ kind, businessState: runtime.getDurableState().state, delivery: delivery.status, attempts: 2 })
    }
    pass('provider_failure_does_not_change_task', { cases: failures, source: 'injected Electron failed event through Production composition' })

    current = 'notification_drain'
    console.error('DESKTOP_NOTIFICATION_SMOKE_DRAIN starting')
    const timeoutProvider = providerFor('timeout')
    const drainGate = fixture.armTask('NOTIFICATION-DRAIN', { desktopNotifier: timeoutProvider })
    const drain = await create('NOTIFICATION-DRAIN')
    await drainGate.started
    drainGate.release()
    await eventually('an in-flight delivery awaiting acknowledgement', () => timeoutProvider.snapshot().pendingDeliveries === 1)
    console.error('DESKTOP_NOTIFICATION_SMOKE_DRAIN pending')
    result.childPids = app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid)
    const started = performance.now()
    const closing = shutdownDesktop()
    let settled = false
    void closing.then(() => { settled = true })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(desktopShutdown.requested, true)
    assert.equal(shutdownDesktop(), closing)
    await closing
    console.error('DESKTOP_NOTIFICATION_SMOKE_DRAIN closed')
    const elapsedMs = performance.now() - started
    assert.ok(elapsedMs < 5_000, `Bounded provider drain took ${elapsedMs}ms`)
    const drainRuntime = fixture.getSession(drain.sessionId).runtime
    assert.equal(drainRuntime.getDurableState().state, 'COMPLETED')
    assert.equal(drainRuntime.getLastNotificationDelivery().channels[0].status, 'FAILED')
    assert.equal(timeoutProvider.snapshot().counts.timedOut, 2)
    assert.equal(timeoutProvider.snapshot().counts.created, 2)
    assert.equal(timeoutProvider.snapshot().pendingDeliveries, 0)
    pass('notification_drain', { pendingAtStrictQuit: true, businessState: 'COMPLETED', deliveryStatus: 'FAILED',
      attempts: 2, acknowledgementTimeoutMs: 80, elapsedMs, shutdownOperations: desktopShutdown.observations.shutdownOperations })

    current = 'cleanup'
    for (const provider of auxiliaryProviders) provider.dispose()
    const providerSnapshots = [notifications, ...auxiliaryProviders].map((provider) => provider.snapshot())
    for (const snapshot of providerSnapshots) {
      assert.equal(snapshot.pendingDeliveries, 0)
      assert.equal(snapshot.activeNotificationRefs, 0)
      assert.equal(snapshot.timerCount, 0)
    }
    assert.equal(await notifications.activateNotification(clicks[0].identity), false)
    assert.equal(await windows.showSession(completed.sessionId), undefined)
    assert.equal(fixture.getEvidence().runtimeCloseCount, fixture.getEvidence().runtimeCreateCount)
    assert.equal(fixture.getEvidence().forbiddenCapabilityAttempts, 0)
    assert.deepEqual(host.ownedOrigins(), [])
    await nextTurn()
    await nextTurn()
    const resources = await eventually('strict notification resources destroyed', async () => {
      await nextTurn()
      const snapshot = tracker.snapshot()
      return snapshot.live.length === 0 ? snapshot : false
    })
    pass('cleanup', { pendingDeliveries: 0, temporaryNotificationRefs: 0, timers: 0,
      activationAfterShutdown: 'fail-closed', runtimeCloseCount: fixture.getEvidence().runtimeCloseCount, resources })
    result.result = Object.values(checks).every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
  } catch (error) {
    const detail = String(error?.stack ?? error)
    checks[current] = { status: 'FAIL', detail }
    result.errors.push({ check: current, error: detail })
    if (desktop) result.diagnostics = { fixture: desktop.fixture.getEvidence(), host: desktop.host.observations,
      window: desktop.windows?.observations, instance: desktopInstance, notifications: desktop.notifications?.snapshot(),
      providers: auxiliaryProviders.map((provider) => provider.snapshot()), shutdown: desktopShutdown.observations }
    console.error(`DESKTOP_NOTIFICATION_SMOKE_FAILURE ${JSON.stringify({ check: current, error: detail,
      diagnostics: result.diagnostics })}`)
    process.exitCode = 1
  } finally {
    tracker?.stop()
    if (result.result !== 'PASS') {
      desktop?.fixture.releaseTasks()
      for (const runtime of auxiliaryRuntimes) {
        try { await runtime.close() } catch (error) { result.errors.push({ check: 'auxiliary cleanup', error: String(error) }) }
      }
      try { await shutdownDesktop() } catch (error) { result.errors.push({ check: 'cleanup', error: String(error) }) }
    }
    for (const provider of auxiliaryProviders) provider.dispose()
    await new Promise((done) => process.stdout.write(`DESKTOP_NATIVE_NOTIFICATION ${JSON.stringify(result)}\n`, done))
    console.log(`WINDOWS_NATIVE_TOAST_VISUAL ${result.windowsNativeToastVisual}`)
    allowVerifiedQuit = true
    app.quit()
  }
}

if (desktopInstance.primary) void run()
