import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { app, powerSaveBlocker } from 'electron'
import { desktopInstance, desktopReady, desktopShutdown, shutdownDesktop } from '../main/index.mjs'
import { createResourceTracker } from './resource-tracker.mjs'

const names = [
  'window_close_hides', 'host_survives_hide', 'runtime_survives_hide', 'task_survives_hide',
  'hidden_completion', 'durable_hidden_completion', 'same_session_restored',
  'tray_created', 'tray_show', 'tray_hide', 'tray_hide_show_10x', 'close_to_tray_show_10x', 'tray_survives_crash',
  'single_instance', 'second_instance_focus', 'no_duplicate_host', 'secondary_no_database',
  'renderer_crash_detected', 'renderer_recovered', 'runtime_survives_renderer_crash',
  'destroyed_window_recovery', 'window_all_closed_background',
  'power_idle_off', 'power_active_on', 'power_hidden_on', 'power_crash_on',
  'power_multi_activity', 'power_terminal_off', 'power_failure_release', 'power_scheduled_idle', 'power_suspended_off',
  'explicit_quit_uses_strict_shutdown', 'power_quit_drain', 'strict_resources',
]
/** @type {Record<string, {status: string, detail?: unknown}>} */
const checks = Object.fromEntries(names.map((name) => [name, { status: 'FAIL', detail: 'Not run' }]))
const result = {
  name: 'DESKTOP_BACKGROUND_RUNTIME', result: 'FAIL', checks, errors: [], childPids: [], diagnostics: {},
  environment: { electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
}
let allowVerifiedQuit = false
app.on('before-quit', (event) => {
  if (desktopInstance.primary && desktopShutdown.completed && !allowVerifiedQuit) event.preventDefault()
})
function pass(name, detail = undefined) { checks[name] = { status: 'PASS', ...(detail === undefined ? {} : { detail }) } }
async function eventually(description, condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await condition()
    if (value) return value
    await delay(25)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}`)
}
function evaluate(window, expression) { return window.webContents.executeJavaScript(expression, true) }
async function visibleSurface(window) {
  assert.equal(window.isVisible(), true)
  assert.equal(window.webContents.isLoadingMainFrame(), false)
  const page = await evaluate(window, '({ ready: document.readyState, textLength: document.body.innerText.length })')
  assert.equal(page.ready, 'complete')
  assert.ok(page.textLength > 100)
  const bitmap = (await window.webContents.capturePage()).toBitmap()
  assert.ok(bitmap.length > 0)
  let colored = 0
  let samples = 0
  for (let index = 0; index < bitmap.length; index += 400) {
    samples++
    if (bitmap[index] < 240 || bitmap[index + 1] < 240 || bitmap[index + 2] < 240) colored++
  }
  const nonWhiteRatio = colored / samples
  assert.ok(nonWhiteRatio > 0.1, 'Restored BrowserWindow must not present a blank white surface')
  return nonWhiteRatio
}
async function status(url) {
  const response = await fetch(`${url}/api/status`)
  assert.equal(response.status, 200)
  return response.json()
}

async function run() {
  let desktop
  let tracker
  let current = 'power_idle_off'
  try {
    process.stdout.write('')
    process.stderr.write('')
    tracker = createResourceTracker()
    desktop = await desktopReady
    const { host, fixture, power, tray, windows } = desktop
    const nativeTray = tray.tray
    const samplePower = () => {
      const sample = power.snapshot()
      assert.equal(sample.blockerActive, sample.blockerId !== undefined && powerSaveBlocker.isStarted(sample.blockerId))
      return sample
    }
    const assertIdle = async () => {
      await eventually('all accepted work leases released', () => power.snapshot().activeCount === 0)
      assert.equal(samplePower().blockerActive, false)
    }
    const clickTray = (id) => {
      const item = tray.menu.getMenuItemById(id)
      assert.ok(item?.click, `Actual Tray menu action ${id} must exist`)
      Reflect.apply(item.click, item, [item, desktop.window, {}])
    }
    const launchToken = await evaluate(desktop.window,
      `JSON.parse(document.getElementById('novawing-bootstrap').textContent).launchToken`)
    const create = async (taskId, extra = {}) => {
      const response = await fetch(`${host.launchpadUrl}/api/session/create`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: host.launchpadUrl, 'X-NovaWing-Launchpad-Token': launchToken },
        body: JSON.stringify({ ...fixture.createRequest, requestId: `background-${taskId}-request`,
          tasks: [{ id: taskId, goal: 'Exercise isolated background Runtime ownership' }], ...extra }) })
      const body = await response.json()
      assert.equal(response.status, 202, JSON.stringify(body))
      return { ...body, sessionId: (await status(body.controlUrl)).configuredSession.id }
    }
    await assertIdle()
    pass('power_idle_off', samplePower())
    assert.equal(nativeTray.isDestroyed(), false)
    assert.equal(tray.tray, nativeTray)
    pass('tray_created', { native: true, destroyed: false })

    current = 'window_close_hides'
    const firstGate = fixture.armTask('BACKGROUND-001')
    const first = await create('BACKGROUND-001')
    await firstGate.started
    await desktop.window.loadURL(first.controlUrl)
    await eventually('native window visible', () => desktop.window.isVisible())
    assert.equal(samplePower().blockerActive, true)
    const firstBlocker = samplePower().blockerId
    pass('power_active_on', samplePower())
    const firstWindow = desktop.window
    firstWindow.close()
    assert.equal(firstWindow.isDestroyed(), false)
    assert.equal(firstWindow.isVisible(), false)
    assert.equal(desktopShutdown.requested, false)
    assert.equal(host.observations.closeCalls, 0)
    assert.equal((await fetch(host.launchpadUrl)).status, 200)
    assert.equal((await status(first.controlUrl)).runtime.state, 'RUNNING')
    assert.equal(fixture.getEvidence().runtimeCloseCount, 0)
    assert.equal(fixture.getEvidence().taskRunCount, 1)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 0)
    assert.equal(samplePower().blockerId, firstBlocker)
    assert.equal(samplePower().blockerActive, true)
    pass('window_close_hides', { destroyed: false, visible: false, shutdownRequested: false })
    pass('host_survives_hide', { closeCalls: 0, launchpadHttp: 200 })
    pass('runtime_survives_hide', { runtimeCreateCount: 1, runtimeCloseCount: 0 })
    pass('task_survives_hide', { taskRunCount: 1, fakeExecutionCount: 0, state: 'RUNNING' })
    pass('power_hidden_on', samplePower())

    current = 'hidden_completion'
    firstGate.release()
    await eventually('hidden task completed', () => fixture.getEvidence().sessions[0].durableState?.state === 'COMPLETED')
    await assertIdle()
    assert.equal(firstWindow.isVisible(), false)
    assert.equal(desktopShutdown.requested, false)
    assert.equal(fixture.getEvidence().runtimeCloseCount, 0)
    const persisted = await fixture.getPersistedStates()
    assert.equal(persisted[0].state, 'COMPLETED')
    assert.deepEqual(persisted[0].completedTaskIds, ['BACKGROUND-001'])
    pass('hidden_completion', { windowHidden: true, state: 'COMPLETED', hostAlive: true })
    pass('durable_hidden_completion', { state: persisted[0].state, completedTaskIds: persisted[0].completedTaskIds })
    pass('power_terminal_off', samplePower())
    clickTray('show')
    await eventually('actual Tray show handler', () => desktop.window.isVisible() && desktop.window.isFocused())
    const restored = await evaluate(desktop.window, 'fetch("/api/status").then(response => response.json())')
    assert.equal(restored.configuredSession.id, first.sessionId)
    assert.equal(restored.runtime.state, 'COMPLETED')
    assert.equal(fixture.getEvidence().runtimeCreateCount, 1)
    assert.equal(fixture.getEvidence().taskRunCount, 1)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 1)
    pass('same_session_restored', { sessionId: first.sessionId, runtimeCreateCount: 1, taskRunCount: 1 })
    pass('tray_show', { sameWindow: desktop.window === firstWindow, focused: true })
    clickTray('hide')
    assert.equal(desktop.window.isVisible(), false)
    assert.equal(nativeTray.isDestroyed(), false)
    pass('tray_hide', { hidden: true, trayAlive: true })

    current = 'tray_hide_show_10x'
    const trayBaseline = { host: desktopInstance.hostCreateCount, runtime: fixture.getEvidence().runtimeCreateCount,
      windows: windows.observations.created, loads: windows.observations.navigationLoads,
      recoveries: windows.observations.presentationRecoveries }
    const trayRatios = []
    for (let cycle = 0; cycle < 10; cycle++) {
      clickTray('hide')
      assert.equal(desktop.window.isVisible(), false)
      clickTray('show')
      await windows.showWindow()
      assert.equal(desktop.window, firstWindow)
      trayRatios.push(await visibleSurface(desktop.window))
    }
    assert.equal(desktopInstance.hostCreateCount, trayBaseline.host)
    assert.equal(fixture.getEvidence().runtimeCreateCount, trayBaseline.runtime)
    assert.equal(windows.observations.created, trayBaseline.windows)
    assert.equal(windows.observations.navigationLoads, trayBaseline.loads)
    assert.equal(windows.observations.presentationRecoveries, trayBaseline.recoveries)
    pass('tray_hide_show_10x', { cycles: 10, whiteScreens: 0, sameWindow: true,
      nonWhiteRatios: trayRatios, baseline: trayBaseline })

    current = 'close_to_tray_show_10x'
    const closeBaseline = { host: desktopInstance.hostCreateCount, runtime: fixture.getEvidence().runtimeCreateCount,
      windows: windows.observations.created, loads: windows.observations.navigationLoads,
      recoveries: windows.observations.presentationRecoveries }
    const closeRatios = []
    for (let cycle = 0; cycle < 10; cycle++) {
      desktop.window.close()
      assert.equal(desktop.window.isDestroyed(), false)
      assert.equal(desktop.window.isVisible(), false)
      clickTray('show')
      await windows.showWindow()
      assert.equal(desktop.window, firstWindow)
      closeRatios.push(await visibleSurface(desktop.window))
    }
    assert.equal(desktopInstance.hostCreateCount, closeBaseline.host)
    assert.equal(fixture.getEvidence().runtimeCreateCount, closeBaseline.runtime)
    assert.equal(windows.observations.created, closeBaseline.windows)
    assert.equal(windows.observations.navigationLoads, closeBaseline.loads)
    assert.equal(windows.observations.presentationRecoveries, closeBaseline.recoveries)
    pass('close_to_tray_show_10x', { cycles: 10, whiteScreens: 0, sameWindow: true,
      nonWhiteRatios: closeRatios, baseline: closeBaseline })

    current = 'single_instance'
    const secondInstance = once(app, 'second-instance')
    console.log(`DESKTOP_BACKGROUND_SECONDARY_READY ${JSON.stringify({ pid: process.pid, sessionId: first.sessionId,
      userData: app.getPath('userData'), ...desktopInstance })}`)
    await secondInstance
    await eventually('second-instance show and focus', () => desktop.window.isVisible() && desktop.window.isFocused())
    const secondary = await eventually('external secondary clean-exit verification', async () => {
      try { return JSON.parse(await readFile(join(fixture.root, 'secondary-result.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    })
    assert.equal(secondary.result, 'PASS', JSON.stringify(secondary))
    assert.equal(desktopInstance.secondInstanceCount, 1)
    assert.equal(desktopInstance.hostCreateCount, 1)
    assert.equal(desktopInstance.launchpadCreateCount, 1)
    assert.equal(desktopInstance.fixtureCreateCount, 1)
    assert.equal(fixture.getEvidence().runtimeCreateCount, 1)
    assert.equal(desktop.host, host)
    pass('single_instance', secondary)
    pass('second_instance_focus', { count: desktopInstance.secondInstanceCount, visible: true, focused: true })
    pass('no_duplicate_host', { ...desktopInstance, runtimeCreateCount: fixture.getEvidence().runtimeCreateCount })
    pass('secondary_no_database', { ...secondary.report, databaseFilesUnchanged: secondary.databaseFilesUnchanged })

    current = 'renderer_crash_detected'
    const crashGate = fixture.armTask('BACKGROUND-CRASH-002')
    const crashTask = await create('BACKGROUND-CRASH-002')
    await crashGate.started
    await desktop.window.loadURL(crashTask.controlUrl)
    const crashWindow = desktop.window
    const crashed = once(crashWindow.webContents, 'render-process-gone')
    const crashBlocker = samplePower().blockerId
    crashWindow.webContents.forcefullyCrashRenderer()
    const [, details] = await crashed
    await windows.pendingRecovery
    assert.ok(['crashed', 'killed', 'oom', 'abnormal-exit'].includes(details.reason), JSON.stringify(details))
    assert.equal(host.observations.closeCalls, 0)
    assert.equal(fixture.getEvidence().runtimeCreateCount, 2)
    assert.equal(fixture.getEvidence().runtimeCloseCount, 0)
    assert.equal(fixture.getEvidence().taskRunCount, 2)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 1)
    assert.equal((await status(crashTask.controlUrl)).runtime.state, 'RUNNING')
    assert.equal(samplePower().blockerId, crashBlocker)
    assert.equal(samplePower().blockerActive, true)
    pass('renderer_crash_detected', details)
    pass('runtime_survives_renderer_crash', { runtimeCreateCount: 2, runtimeCloseCount: 0, taskRunCount: 2 })
    pass('power_crash_on', samplePower())
    await eventually('Renderer recovered at registered Control URL', async () => {
      const window = desktop.window
      if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return false
      try { return await evaluate(window, 'document.title === "NovaWing Work Session 控制台"') }
      catch { return false }
    })
    const crashRestored = await evaluate(desktop.window, 'fetch("/api/status").then(response => response.json())')
    assert.equal(crashRestored.configuredSession.id, crashTask.sessionId)
    assert.equal(crashRestored.runtime.state, 'RUNNING')
    assert.equal(new URL(desktop.window.webContents.getURL()).origin, crashTask.controlUrl)
    assert.equal(nativeTray.isDestroyed(), false)
    pass('renderer_recovered', { sessionId: crashTask.sessionId, url: desktop.window.webContents.getURL() })
    pass('tray_survives_crash', { sameTray: tray.tray === nativeTray, destroyed: false })
    crashGate.release()
    await eventually('crashed Renderer task completes once', async () => (await status(crashTask.controlUrl)).runtime.state === 'COMPLETED')
    await assertIdle()
    assert.equal(fixture.getEvidence().taskRunCount, 2)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 2)

    current = 'destroyed_window_recovery'
    const oldWindow = desktop.window
    const allClosed = once(app, 'window-all-closed')
    oldWindow.destroy()
    await allClosed
    assert.equal(desktopShutdown.requested, false)
    assert.equal(host.observations.closeCalls, 0)
    assert.equal(nativeTray.isDestroyed(), false)
    pass('window_all_closed_background', { shutdownRequested: false, closeCalls: 0, trayAlive: true })
    await windows.showWindow()
    assert.notEqual(desktop.window, oldWindow)
    assert.equal(desktop.window.isDestroyed(), false)
    assert.equal(new URL(desktop.window.webContents.getURL()).origin, crashTask.controlUrl)
    assert.equal(fixture.getEvidence().runtimeCreateCount, 2)
    assert.equal(desktop.host, host)
    pass('destroyed_window_recovery', { previousId: oldWindow.id, newId: desktop.window.id,
      url: desktop.window.webContents.getURL(), runtimeCreateCount: 2 })

    current = 'power_multi_activity'
    const startsBefore = power.observations.starts
    const stopsBefore = power.observations.stops
    const gateA = fixture.armTask('BACKGROUND-MULTI-A')
    const gateB = fixture.armTask('BACKGROUND-MULTI-B')
    const taskA = await create('BACKGROUND-MULTI-A')
    await gateA.started
    const sharedBlocker = samplePower().blockerId
    const taskB = await create('BACKGROUND-MULTI-B')
    await gateB.started
    assert.ok(samplePower().activeCount >= 2)
    assert.equal(samplePower().blockerId, sharedBlocker)
    assert.equal(power.observations.starts, startsBefore + 1)
    gateA.release()
    await eventually('Session A released while Session B stays active', async () =>
      (await status(taskA.controlUrl)).runtime.state === 'COMPLETED' && power.snapshot().activeCount === 1)
    assert.equal(samplePower().blockerActive, true)
    assert.equal(samplePower().blockerId, sharedBlocker)
    assert.equal(power.observations.stops, stopsBefore)
    assert.equal((await status(taskB.controlUrl)).runtime.state, 'RUNNING')
    gateB.release()
    await eventually('Session B completed', async () => (await status(taskB.controlUrl)).runtime.state === 'COMPLETED')
    await assertIdle()
    assert.equal(power.observations.starts, startsBefore + 1)
    assert.equal(power.observations.stops, stopsBefore + 1)
    pass('power_multi_activity', { sessions: [taskA.sessionId, taskB.sessionId], blockerId: sharedBlocker,
      startCount: 1, stopCount: 1, activeAfterFirstRelease: 1 })

    current = 'power_failure_release'
    const originalError = new Error('isolated-background-runner-failure')
    const failureGate = fixture.armTask('BACKGROUND-FAILURE', { error: originalError })
    const failureTask = await create('BACKGROUND-FAILURE')
    await failureGate.started
    assert.equal(samplePower().blockerActive, true)
    failureGate.release()
    await eventually('thrown fake task settles', () => !fixture.getSession(failureTask.sessionId).app.hasActiveSession())
    await assertIdle()
    const failed = fixture.getSession(failureTask.sessionId).runtime.getDurableState()
    // Existing runner-error semantics may leave a durable RUNNING snapshot.
    // The settled accepted operation, rather than that snapshot, releases power.
    assert.equal(fixture.getSession(failureTask.sessionId).app.hasActiveSession(), false)
    const [propagatedError] = fixture.getSession(failureTask.sessionId).runtimeStartErrors
    assert.ok(propagatedError instanceof Error)
    assert.equal(propagatedError.message, originalError.message)
    pass('power_failure_release', { error: originalError.message, state: failed.state, power: samplePower(),
      propagatedRuntimeError: propagatedError.message, source: 'actual fake task runner throw through production Runtime/controller' })

    current = 'power_suspended_off'
    const suspendGate = fixture.armTask('BACKGROUND-HUMAN', {
      behavior: { type: 'HUMAN_REQUIRED', category: 'DECISION_REQUIRED', reason: 'Isolated operator decision gate' },
    })
    const suspendTask = await create('BACKGROUND-HUMAN')
    await suspendGate.started
    assert.equal(samplePower().blockerActive, true)
    suspendGate.release()
    await eventually('real Runtime suspended for human decision', async () => (await status(suspendTask.controlUrl)).runtime.state === 'SUSPENDED')
    await assertIdle()
    const suspended = fixture.getSession(suspendTask.sessionId).runtime.getDurableState()
    assert.equal(suspended.humanRequired.category, 'DECISION_REQUIRED')
    pass('power_suspended_off', { state: suspended.state, category: suspended.humanRequired.category, power: samplePower() })

    current = 'power_scheduled_idle'
    const scheduledStartAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    fixture.allowFutureSchedule(scheduledStartAt)
    const scheduledBefore = { taskRunCount: fixture.getEvidence().taskRunCount, starts: power.observations.starts }
    const scheduled = await create('BACKGROUND-SCHEDULED', { scheduled_start_at: scheduledStartAt, schedule_source: 'custom' })
    await eventually('future scheduled state settled', async () => (await status(scheduled.controlUrl)).runtime.state === 'SCHEDULED')
    await assertIdle()
    assert.equal(fixture.getEvidence().taskRunCount, scheduledBefore.taskRunCount)
    assert.equal(power.observations.starts, scheduledBefore.starts)
    pass('power_scheduled_idle', { scheduledStartAt, actualExecutions: 0, newBlockers: 0, power: samplePower() })

    current = 'explicit_quit_uses_strict_shutdown'
    const quitGate = fixture.armTask('BACKGROUND-QUIT')
    const quitTask = await create('BACKGROUND-QUIT')
    await quitGate.started
    clickTray('hide')
    const quitBlocker = samplePower().blockerId
    assert.equal(samplePower().blockerActive, true)
    result.childPids = app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid)
    clickTray('quit')
    const shutdown = shutdownDesktop()
    let settled = false
    void shutdown.then(() => { settled = true })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(desktopShutdown.requested, true)
    assert.equal(host.observations.closeCalls, 1)
    assert.equal(nativeTray.isDestroyed(), false)
    assert.equal(samplePower().blockerId, quitBlocker)
    assert.equal(samplePower().blockerActive, true)
    assert.equal(shutdownDesktop(), shutdown)
    quitGate.release()
    await shutdown
    assert.equal(fixture.getSession(quitTask.sessionId).runtime.getDurableState().state, 'COMPLETED')
    assert.equal(power.snapshot().activeCount, 0)
    assert.equal(samplePower().blockerActive, false)
    assert.equal(nativeTray.isDestroyed(), true)
    assert.equal(desktopShutdown.observations.shutdownOperations, 1)
    assert.equal(desktopShutdown.observations.finalQuitRequests, 1)
    assert.equal(fixture.getEvidence().runtimeCloseCount, fixture.getEvidence().runtimeCreateCount)
    assert.deepEqual(host.ownedOrigins(), [])
    pass('explicit_quit_uses_strict_shutdown', { trigger: 'actual Tray Quit menu handler',
      ...desktopShutdown.observations, runtimeCloseCount: fixture.getEvidence().runtimeCloseCount, trayDestroyed: true })
    pass('power_quit_drain', { pendingWhileGateHeld: true, blockerHeldUntilSettle: true, final: samplePower() })
    current = 'strict_resources'
    await nextTurn()
    await nextTurn()
    const resources = await eventually('strict background resources all destroyed', async () => {
      await nextTurn()
      const snapshot = tracker.snapshot()
      return snapshot.live.length === 0 ? snapshot : false
    })
    pass('strict_resources', resources)
    assert.equal(fixture.getEvidence().forbiddenCapabilityAttempts, 0)
    result.result = Object.values(checks).every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
  } catch (error) {
    const detail = String(error?.stack ?? error)
    checks[current] = { status: 'FAIL', detail }
    result.errors.push({ check: current, error: detail })
    if (desktop) result.diagnostics = { fixture: desktop.fixture.getEvidence(), host: desktop.host.observations,
      window: desktop.windows.observations, instance: desktopInstance, power: desktop.power.snapshot(),
      powerObservations: desktop.power.observations, shutdown: desktopShutdown.observations }
    process.exitCode = 1
  } finally {
    tracker?.stop()
    if (result.result !== 'PASS') {
      desktop?.fixture.releaseTasks()
      try { await shutdownDesktop() } catch (error) { result.errors.push({ check: 'cleanup', error: String(error) }) }
    }
    await new Promise((done) => process.stdout.write(`DESKTOP_BACKGROUND_RUNTIME ${JSON.stringify(result)}\n`, done))
    allowVerifiedQuit = true
    app.quit()
  }
}

// Secondary must execute the very same Desktop entry, but never any fixture work.
if (desktopInstance.primary) void run()
