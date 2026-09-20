import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { desktopReady, shutdownDesktop } from '../main/index.mjs'

const checkNames = [
  'electron_main', 'isolation', 'launchpad_create', 'launchpad_start', 'launchpad_http',
  'browser_load', 'renderer_js', 'renderer_node_access', 'launchpad_api',
  'session_create', 'session_start', 'control_origin_registered', 'control_navigation',
  'control_http', 'control_sse', 'fake_task', 'terminal_state',
  'renderer_reload_no_duplicate_runtime', 'external_navigation_blocked', 'random_loopback_blocked',
  'file_navigation_blocked', 'javascript_navigation_blocked', 'window_open_denied',
  'webview_denied', 'permission_denied', 'host_close', 'control_origin_unregistered',
]
/** @type {Record<string, {status: 'PASS' | 'FAIL', detail?: unknown}>} */
const checks = Object.fromEntries(checkNames.map((name) => [name, { status: 'FAIL', detail: 'Not run' }]))
const result = {
  result: 'FAIL', checks, childPids: [], errors: [], diagnostics: {},
  environment: {
    electron: process.versions.electron ?? null, node: process.versions.node,
    chrome: process.versions.chrome ?? null, v8: process.versions.v8,
    modules: process.versions.modules, platform: process.platform, arch: process.arch,
    execPath: process.execPath, cwd: process.cwd(),
  },
}

/** @param {string} name @param {unknown} [detail] */
function pass(name, detail) { checks[name] = { status: 'PASS', ...(detail === undefined ? {} : { detail }) } }

/** @param {string} description @param {() => unknown | Promise<unknown>} condition @param {number} [timeoutMs] */
async function eventually(description, condition, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    last = await condition()
    if (last) return last
    await delay(30)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}; last result: ${JSON.stringify(last)}`)
}

/** @param {import('electron').BrowserWindow} window @param {string} expression */
function evaluate(window, expression) { return window.webContents.executeJavaScript(expression, true) }

/** The browser performs the real relative fetch with its normal Origin and cookies. */
async function rendererStatus(window) {
  return evaluate(window, `(async () => {
    const response = await fetch('/api/status')
    if (!response.ok) throw new Error('Control status HTTP ' + response.status)
    return response.json()
  })()`)
}

/** @param {import('electron').BrowserWindow} window @param {string} url */
async function assertBlockedNavigation(window, url) {
  const before = window.webContents.getURL()
  await evaluate(window, `window.location.assign(${JSON.stringify(url)}); true`)
  await delay(150)
  assert.equal(window.webContents.getURL(), before, `Unowned navigation escaped: ${url}`)
  assert.equal(await evaluate(window, 'document.title'), 'NovaWing Work Session 控制台')
}

async function runLaunchpadSmoke() {
  let currentCheck = 'electron_main'
  let desktop
  let unrelatedServer
  try {
    assert.ok(process.versions.electron, 'Use the pinned real Electron binary')
    assert.equal(process.type, 'browser')
    pass('electron_main', result.environment)
    currentCheck = 'isolation'
    const root = process.env.NOVAWING_DESKTOP_SMOKE_ROOT
    assert.ok(root && isAbsolute(root) && basename(root).startsWith('novawing-desktop-smoke-'))
    assert.equal(resolve(process.cwd()), join(root, 'repo'))
    assert.equal(process.env.NOVAWING_CONFIG_DIR, join(root, 'config'))
    assert.equal(process.env.NOVAWING_DATA_DIR, join(root, 'data'))
    // Main isolates Electron paths synchronously before app.whenReady; no top-level await.
    desktop = await desktopReady
    const { window, host, fixture, blocked } = desktop
    assert.equal(fixture.repoDirectory, join(root, 'repo'))
    assert.equal(fixture.configDirectory, join(root, 'config'))
    assert.equal(fixture.dataDirectory, join(root, 'data'))
    assert.ok(app.getPath('userData').startsWith(`${root}\\`) || app.getPath('userData').startsWith(`${root}/`))
    pass('isolation', { root, config: fixture.configDirectory, data: fixture.dataDirectory, repo: fixture.repoDirectory })
    pass('launchpad_create', { factory: 'createNovaWingLaunchpad' })
    assert.ok(host.launchpadUrl)
    pass('launchpad_start', { url: host.launchpadUrl })

    currentCheck = 'launchpad_http'
    const launchpadResponse = await fetch(host.launchpadUrl)
    assert.equal(launchpadResponse.status, 200)
    assert.match(launchpadResponse.headers.get('content-security-policy') ?? '', /script-src 'self'/u)
    assert.match(await launchpadResponse.text(), /<title>NovaWing Launchpad<\/title>/u)
    pass('launchpad_http', { status: 200, existingCsp: true })
    currentCheck = 'browser_load'
    await eventually('BrowserWindow visible after native show', () => window.isVisible())
    assert.equal(window.webContents.getURL(), `${host.launchpadUrl}/`)
    assert.equal(window.webContents.getTitle(), 'NovaWing Launchpad')
    pass('browser_load', { url: window.webContents.getURL(), title: window.webContents.getTitle() })
    currentCheck = 'renderer_js'
    await eventually('existing Launchpad JS analytics render', () => evaluate(window,
      `document.querySelector('[data-analytics-summary]').querySelectorAll('strong').length > 0`))
    const composerOpened = await evaluate(window, `(() => {
      document.querySelector('[data-composer-toggle]').click()
      return !document.querySelector('[data-composer-form]').hidden
    })()`)
    assert.equal(composerOpened, true, 'The existing app.js must install the composer click handler')
    pass('renderer_js', { composerClickHandler: true, analyticsRendered: true })
    const nodeAccess = await evaluate(window, '({ require: typeof require, process: typeof process })')
    assert.deepEqual(nodeAccess, { require: 'undefined', process: 'undefined' })
    const preferences = /** @type {import('electron').WebContents & {getLastWebPreferences(): import('electron').WebPreferences}} */
      (window.webContents).getLastWebPreferences()
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.sandbox, true)
    assert.equal(preferences.webSecurity, true)
    assert.ok(!preferences.preload)
    pass('renderer_node_access', nodeAccess)
    currentCheck = 'launchpad_api'
    const launchpadApi = await evaluate(window, `(async () => {
      const response = await fetch('/api/session/configs')
      const configs = await response.json()
      const unauthorized = await fetch('/api/session/create', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      })
      return {status: response.status, configCount: configs.length, unauthorized: unauthorized.status}
    })()`)
    assert.deepEqual(launchpadApi, { status: 200, configCount: 0, unauthorized: 403 })
    pass('launchpad_api', launchpadApi)

    // Observe Chromium's actual fetch/EventSource traffic. No mock fetch, injected
    // EventSource replacement, alternate renderer, or direct runtime start is used.
    const responses = []
    const sseMessages = []
    window.webContents.debugger.attach('1.3')
    window.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.responseReceived') responses.push({
        url: params.response.url, status: params.response.status, type: params.type,
      })
      if (method === 'Network.eventSourceMessageReceived') sseMessages.push({
        requestId: params.requestId, eventName: params.eventName, data: params.data,
      })
    })
    await window.webContents.debugger.sendCommand('Network.enable')
    currentCheck = 'session_create'
    const taskId = 'DESKTOP-SMOKE-001'
    await evaluate(window, `(() => {
      const form = document.querySelector('[data-composer-form]')
      form.elements.targetRepo.value = ${JSON.stringify(fixture.repoDirectory)}
      form.elements.branch.value = ${JSON.stringify(fixture.branch)}
      form.elements.allowedPaths.value = 'fixture.txt'
      form.elements.autoCommit.checked = false
      form.elements.autoPush.checked = false
      form.elements.emailEnabled.checked = false
      form.querySelector('[data-task-id]').value = ${JSON.stringify(taskId)}
      form.querySelector('[data-task-goal]').value = 'Complete one offline desktop fixture'
      form.requestSubmit()
      return true
    })()`)
    await eventually('real Launchpad create response and Control navigation', async () => {
      const url = window.webContents.getURL()
      if (window.webContents.isLoadingMainFrame()) return false
      if (url !== `${host.launchpadUrl}/`) return true
      const error = await evaluate(window, `document.querySelector('[data-composer-error]')?.textContent || ''`)
      assert.equal(error, '', `Existing composer rejected the fixture: ${error}`)
      return false
    })
    const createResponse = responses.find((response) => response.url === `${host.launchpadUrl}/api/session/create`)
    assert.ok(createResponse, 'Chromium must have sent the existing create API request')
    assert.equal(createResponse.status, 202)
    const initialEvidence = fixture.getEvidence()
    assert.equal(initialEvidence.productionUiCreateCount, 1)
    assert.equal(initialEvidence.runtimeCreateCount, 1)
    assert.equal(initialEvidence.fixtureControlPlane, 'v1')
    pass('session_create', { httpStatus: createResponse.status, productionFactory: 'createProductionWorkSessionUi',
      fixtureControlPlane: initialEvidence.fixtureControlPlane, runtimeCreateCount: 1 })
    const controlUrl = new URL(window.webContents.getURL()).origin
    assert.notEqual(controlUrl, host.launchpadUrl)
    assert.equal(host.isAllowedNavigation(controlUrl), true)
    assert.ok(host.ownedOrigins().includes(controlUrl))
    assert.deepEqual(host.observations.controlRegistered, [controlUrl])
    pass('control_origin_registered', { launchpad: host.launchpadUrl, control: controlUrl })
    assert.equal(window.webContents.getTitle(), 'NovaWing Work Session 控制台')
    pass('control_navigation', { url: window.webContents.getURL(), source: 'existing window.location.assign(controlUrl)' })
    currentCheck = 'control_http'
    const runningSnapshot = await rendererStatus(window)
    assert.equal(runningSnapshot.runtime.started, true)
    assert.equal(runningSnapshot.runtime.state, 'RUNNING')
    assert.equal(runningSnapshot.configuredSession.tasks[0].id, taskId)
    pass('session_start', { state: runningSnapshot.runtime.state, startedAt: runningSnapshot.runtime.startedAt })
    pass('control_http', { status: 200, sessionId: runningSnapshot.configuredSession.id })
    currentCheck = 'control_sse'
    await eventually('native EventSource connected frame', () => sseMessages.some((message) => message.eventName === 'connected'))
    await eventually('existing Control UI RUNNING render', () => evaluate(window,
      `document.getElementById('state-badge').classList.contains('badge-running')`))
    assert.ok(responses.some((response) => response.url === `${controlUrl}/api/status` && response.status === 200))
    const messagesBeforeRelease = sseMessages.length
    fixture.releaseTasks()
    currentCheck = 'terminal_state'
    await eventually('existing Control UI terminal state from SSE', () => evaluate(window,
      `document.getElementById('state-badge').classList.contains('badge-completed') &&
       document.getElementById('overview-status').textContent === '已完成'`))
    const terminalSnapshot = await rendererStatus(window)
    assert.equal(terminalSnapshot.runtime.state, 'COMPLETED')
    assert.deepEqual(terminalSnapshot.runtime.completedTaskIds, [taskId])
    assert.ok(sseMessages.length > messagesBeforeRelease)
    assert.ok(sseMessages.slice(messagesBeforeRelease).some((message) =>
      message.eventName === 'snapshot' || message.eventName === 'activity'))
    pass('control_sse', { transport: 'native EventSource', observedBy: 'Chromium Network.eventSourceMessageReceived',
      connected: true, eventsAfterTaskRelease: sseMessages.length - messagesBeforeRelease,
      eventNames: [...new Set(sseMessages.map((message) => message.eventName))] })
    const completedEvidence = fixture.getEvidence()
    assert.equal(completedEvidence.taskRunCount, 1)
    assert.equal(completedEvidence.fakeExecutionCount, 1)
    assert.equal(completedEvidence.forbiddenCapabilityAttempts, 0)
    pass('fake_task', { taskRunCount: 1, fakeExecutionCount: 1, forbiddenCapabilityAttempts: 0, runner: 'existing FakeTaskRunner' })
    pass('terminal_state', { state: terminalSnapshot.runtime.state, completedTaskIds: terminalSnapshot.runtime.completedTaskIds,
      rendererBadge: await evaluate(window, `document.getElementById('state-badge').textContent`) })

    currentCheck = 'renderer_reload_no_duplicate_runtime'
    const beforeReload = fixture.getEvidence()
    const persistedBeforeReload = await fixture.getPersistedStates()
    const reloaded = once(window.webContents, 'did-finish-load')
    window.reload()
    await reloaded
    await eventually('persisted terminal state after renderer reload', () => evaluate(window,
      `document.getElementById('state-badge')?.classList.contains('badge-completed')`))
    const afterReload = fixture.getEvidence()
    const persistedAfterReload = await fixture.getPersistedStates()
    assert.deepEqual(persistedAfterReload, persistedBeforeReload, 'Renderer reload must preserve the actual durable workflow state')
    const reloadedSnapshot = await rendererStatus(window)
    for (const key of ['productionUiCreateCount', 'runtimeCreateCount', 'taskRunCount', 'fakeExecutionCount']) {
      assert.equal(afterReload[key], beforeReload[key], `${key} changed on Renderer reload`)
    }
    assert.equal(reloadedSnapshot.configuredSession.id, terminalSnapshot.configuredSession.id)
    assert.equal(reloadedSnapshot.runtime.state, 'COMPLETED')
    assert.equal(reloadedSnapshot.runtime.startedAt, terminalSnapshot.runtime.startedAt)
    assert.deepEqual(reloadedSnapshot.runtime.completedTaskIds, [taskId])
    pass('renderer_reload_no_duplicate_runtime', { productionUiCreateCount: afterReload.productionUiCreateCount,
      runtimeCreateCount: afterReload.runtimeCreateCount, taskRunCount: afterReload.taskRunCount,
      fakeExecutionCount: afterReload.fakeExecutionCount, sessionId: reloadedSnapshot.configuredSession.id,
      state: reloadedSnapshot.runtime.state, completedTaskIds: reloadedSnapshot.runtime.completedTaskIds,
      persistedSnapshotUnchanged: true })

    currentCheck = 'external_navigation_blocked'
    assert.equal(host.isAllowedNavigation('https://example.com/'), false)
    await assertBlockedNavigation(window, 'https://example.com/')
    assert.ok(blocked.includes('https://example.com/'), 'The Host-owned navigation guard must record denial')
    pass('external_navigation_blocked', { attempted: 'https://example.com/', currentUrl: window.webContents.getURL() })
    currentCheck = 'random_loopback_blocked'
    let unrelatedRequests = 0
    unrelatedServer = createServer((_request, response) => { unrelatedRequests++; response.end('unowned local server') })
    await new Promise((resolveListen) => unrelatedServer.listen(0, '127.0.0.1', resolveListen))
    const unrelatedAddress = unrelatedServer.address()
    assert.ok(unrelatedAddress && typeof unrelatedAddress !== 'string')
    const unrelatedUrl = `http://127.0.0.1:${unrelatedAddress.port}/`
    assert.equal(host.isAllowedNavigation(unrelatedUrl), false)
    await assertBlockedNavigation(window, unrelatedUrl)
    assert.ok(blocked.includes(unrelatedUrl), 'The unregistered port must be denied by the ownership guard')
    const unrelatedLocalhostUrl = `http://localhost:${unrelatedAddress.port}/`
    assert.equal(host.isAllowedNavigation(unrelatedLocalhostUrl), false)
    await assertBlockedNavigation(window, unrelatedLocalhostUrl)
    assert.ok(blocked.includes(unrelatedLocalhostUrl), 'The localhost spelling must not grant trust')
    assert.equal(unrelatedRequests, 0, 'Blocked navigation must not reach another local server')
    pass('random_loopback_blocked', { attempted: [unrelatedUrl, unrelatedLocalhostUrl], requestsReceived: unrelatedRequests })
    currentCheck = 'file_navigation_blocked'
    const fileUrl = pathToFileURL(join(fixture.repoDirectory, 'fixture.txt')).href
    assert.equal(host.isAllowedNavigation(fileUrl), false)
    await assertBlockedNavigation(window, fileUrl)
    pass('file_navigation_blocked', { scheme: 'file:', currentUrl: window.webContents.getURL() })
    currentCheck = 'javascript_navigation_blocked'
    const javascriptUrl = 'javascript:document.documentElement.dataset.unownedExecuted="yes"'
    assert.equal(host.isAllowedNavigation(javascriptUrl), false)
    await assertBlockedNavigation(window, javascriptUrl)
    assert.equal(await evaluate(window, `document.documentElement.dataset.unownedExecuted || null`), null)
    pass('javascript_navigation_blocked', { scheme: 'javascript:', executed: false })
    currentCheck = 'window_open_denied'
    const windowsBefore = BrowserWindow.getAllWindows().length
    assert.equal(await evaluate(window, `window.open('https://example.com/') === null`), true)
    await delay(100)
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore)
    pass('window_open_denied', { createdWindows: 0 })
    currentCheck = 'webview_denied'
    let attachedWebviews = 0
    window.webContents.on('did-attach-webview', () => { attachedWebviews++ })
    await evaluate(window, `(() => {
      const view = document.createElement('webview')
      view.id = 'desktop-smoke-webview'
      view.src = ${JSON.stringify(unrelatedUrl)}
      document.body.append(view)
      return true
    })()`)
    await delay(100)
    assert.notEqual(preferences.webviewTag, true)
    assert.equal(attachedWebviews, 0)
    assert.equal(unrelatedRequests, 0)
    await evaluate(window, `document.getElementById('desktop-smoke-webview').remove(); true`)
    pass('webview_denied', { webviewTag: preferences.webviewTag ?? false, attachedWebviews })
    currentCheck = 'permission_denied'
    const permission = await evaluate(window, `Notification.requestPermission()`)
    assert.equal(permission, 'denied')
    pass('permission_denied', { notification: permission })
    await new Promise((resolveClose, rejectClose) => unrelatedServer.close((error) => error ? rejectClose(error) : resolveClose(undefined)))
    unrelatedServer = undefined
    window.webContents.debugger.detach()
    result.childPids = app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid)

    currentCheck = 'host_close'
    const closed = once(window, 'closed')
    const quitting = once(app, 'before-quit')
    window.close()
    await closed
    await quitting
    // The production last-window -> app.quit path initiates close. Await the same
    // promise; do not manually close Launchpad or Runtime to simulate that path.
    assert.equal(host.observations.closeCalls, 1, 'Window close must initiate Host shutdown before the test awaits it')
    await shutdownDesktop()
    assert.equal(window.isDestroyed(), true)
    const closedEvidence = fixture.getEvidence()
    assert.equal(closedEvidence.runtimeCloseCount, 1)
    assert.equal(host.observations.closeCalls, 1)
    assert.equal(host.observations.pendingControlCloses, 0)
    assert.deepEqual(host.observations.errors, [])
    pass('host_close', { trigger: 'last BrowserWindow closed', runtimeCloseCount: closedEvidence.runtimeCloseCount,
      closeCalls: host.observations.closeCalls })
    assert.equal(host.isAllowedNavigation(controlUrl), false)
    assert.deepEqual(host.ownedOrigins(), [])
    assert.deepEqual(host.observations.controlUnregistered, [controlUrl])
    pass('control_origin_unregistered', { control: controlUrl, ownedOrigins: [] })
    result.result = Object.values(checks).every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
  } catch (error) {
    const detail = String(error?.stack ?? error)
    result.checks[currentCheck] = { status: 'FAIL', detail }
    result.errors.push({ check: currentCheck, error: detail })
    if (desktop) {
      result.diagnostics = {
        fixture: desktop.fixture.getEvidence(),
        host: desktop.host.observations,
        ownedOrigins: desktop.host.ownedOrigins(),
        blocked: desktop.blocked,
      }
      if (!desktop.window.isDestroyed()) {
        try {
          Object.assign(result.diagnostics, { renderer: await evaluate(desktop.window, `({
            url: location.href, title: document.title,
            composerError: document.querySelector('[data-composer-error]')?.textContent,
            state: document.getElementById('state-badge')?.textContent,
            overviewStatus: document.getElementById('overview-status')?.textContent
          })`) })
        } catch { /* Preserve the original failure if the Renderer has already gone away. */ }
      }
    }
    process.exitCode = 1
  } finally {
    if (unrelatedServer) unrelatedServer.close()
    if (result.result !== 'PASS') {
      desktop?.fixture.releaseTasks()
      try { await shutdownDesktop?.() } catch (error) { result.errors.push({ check: 'failure_cleanup', error: String(error?.stack ?? error) }) }
    }
    console.log(`DESKTOP_LAUNCHPAD_SMOKE ${JSON.stringify(result)}`)
    if (result.result !== 'PASS') app.quit()
  }
}

// Electron must finish evaluating its entry before it can emit ready.
void runLaunchpadSmoke()
