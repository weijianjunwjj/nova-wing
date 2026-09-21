import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createWindowLifecycle, loadOwnedURL } from '../main/window-lifecycle.mjs'
import { createNavigationRegistry } from '../main/navigation.mjs'

class FakeWindow extends EventEmitter {
  destroyed = false
  visible = false
  minimized = false
  focused = 0
  restores = 0
  loads = []
  calls = []
  url = ''
  loading = false
  constructor() {
    super()
    this.webContents.on('did-navigate', (_event, url) => { this.url = url })
  }
  load = async (_url) => {}
  webContents = Object.assign(new EventEmitter(), {
    getURL: () => this.url,
    isLoadingMainFrame: () => this.loading,
    setWindowOpenHandler: (handler) => { this.openHandler = handler },
    session: {
      setPermissionRequestHandler: (handler) => { this.permissionHandler = handler },
      setPermissionCheckHandler: (handler) => { this.permissionCheck = handler },
      webRequest: { onBeforeRequest: (handler) => { this.requestHandler = handler } },
    },
  })
  async loadURL(url) {
    this.loads.push(url)
    this.loading = true
    this.webContents.emit('did-start-loading')
    try {
      await this.load(url)
      if (!this.destroyed) {
        this.webContents.emit('did-navigate', {}, url)
        this.webContents.emit('did-finish-load')
        this.emit('ready-to-show')
      }
    } finally {
      this.loading = false
      this.webContents.emit('did-stop-loading')
    }
  }
  setMenuBarVisibility(value) { this.menuVisible = value }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  restore() { this.calls.push('restore'); this.minimized = false; this.restores++ }
  show() { this.calls.push('show'); this.visible = true }
  hide() { this.calls.push('hide'); this.visible = false }
  focus() { this.calls.push('focus'); this.focused++ }
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed') }
  close() {
    let prevented = false
    this.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) this.destroy()
    return prevented
  }
  crash(reason = 'crashed') { this.webContents.emit('render-process-gone', {}, { reason, exitCode: 9 }) }
}

function harness(options = {}) {
  const registry = createNavigationRegistry()
  const launchpad = {}
  const control = {}
  const launchpadUrl = 'http://127.0.0.1:44101/'
  const controlUrl = 'http://127.0.0.1:44102/session/one'
  registry.register(launchpad, launchpadUrl)
  registry.register(control, controlUrl)
  const host = { launchpadUrl, isAllowedNavigation: registry.allows, close: assert.fail }
  const windows = []
  const settings = []
  const diagnostics = []
  const lifecycle = createWindowLifecycle(host, {
    createWindow(config) {
      settings.push(config)
      const window = new FakeWindow()
      windows.push(window)
      return /** @type {import('electron').BrowserWindow} */ (/** @type {unknown} */ (window))
    },
    reportDiagnostic: (detail) => diagnostics.push(detail), ...options,
  })
  return { lifecycle, windows, settings, registry, launchpad, control, launchpadUrl, controlUrl, diagnostics, host }
}

test('ordinary close hides without releasing Host and show restores and focuses the same window', async () => {
  const { lifecycle, windows } = harness()
  await lifecycle.showWindow()
  const [window] = windows
  assert.equal(window.visible, true)
  assert.equal(window.close(), true)
  assert.equal(window.destroyed, false)
  assert.equal(window.visible, false)
  assert.equal(lifecycle.observations.hiddenCloses, 1)
  window.minimized = true
  window.calls = []
  await lifecycle.showWindow()
  assert.deepEqual(window.calls, ['restore', 'show', 'focus'])
  assert.equal(windows.length, 1)
  window.calls = []
  await lifecycle.showWindow()
  assert.deepEqual(window.calls, ['focus'])
})

test('window recreation restores only a committed main-frame URL and revalidates revoked origins', async () => {
  const { lifecycle, windows, registry, control, controlUrl, launchpadUrl } = harness()
  await lifecycle.showWindow()
  windows[0].webContents.emit('did-navigate', {}, controlUrl)
  assert.equal(lifecycle.lastTrustedUrl, controlUrl)
  windows[0].webContents.emit('did-navigate-in-page', {}, `${launchpadUrl}child`, false)
  assert.equal(lifecycle.lastTrustedUrl, controlUrl)
  for (const url of ['http://127.0.0.1:44999/', 'https://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    windows[0].webContents.emit('did-navigate', {}, url)
    windows[0].webContents.emit('did-navigate-in-page', {}, url, true)
    assert.equal(lifecycle.lastTrustedUrl, controlUrl)
  }
  windows[0].destroy()
  await lifecycle.showWindow()
  assert.deepEqual(windows[1].loads, [controlUrl])
  registry.unregister(control)
  windows[1].destroy()
  await lifecycle.showWindow()
  assert.deepEqual(windows[2].loads, [launchpadUrl])
  assert.equal(lifecycle.lastTrustedUrl, launchpadUrl)
  assert.equal(lifecycle.observations.created, 3)
})

test('pending navigation never becomes the trusted recovery address', async () => {
  const { lifecycle, windows, launchpadUrl, controlUrl } = harness()
  await lifecycle.showWindow()
  windows[0].webContents.emit('will-frame-navigate', { url: controlUrl, preventDefault: assert.fail })
  assert.equal(lifecycle.lastTrustedUrl, launchpadUrl)
  windows[0].destroy()
  await lifecycle.showWindow()
  assert.deepEqual(windows[1].loads, [launchpadUrl])
})

test('hardened policy remains on every new BrowserWindow and Main loads check the registry', async () => {
  const { lifecycle, windows, settings, host, registry, controlUrl, control } = harness()
  await lifecycle.ensureWindow()
  const [window] = windows
  assert.equal(window.visible, false)
  assert.equal(window.menuVisible, false)
  assert.deepEqual(settings[0].webPreferences, {
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
    partition: settings[0].webPreferences.partition,
  })
  assert.match(settings[0].webPreferences.partition, /^novawing-isolated-/u)
  assert.equal('preload' in settings[0].webPreferences, false)
  assert.equal('backgroundThrottling' in settings[0].webPreferences, false)
  let prevented = 0
  for (const name of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    window.webContents.emit(name, { url: 'https://example.com', preventDefault() { prevented++ } })
  }
  assert.equal(prevented, 3)
  assert.deepEqual(window.openHandler({ url: controlUrl }), { action: 'deny' })
  window.permissionHandler(undefined, 'notifications', (allowed) => assert.equal(allowed, false))
  assert.equal(window.permissionCheck(), false)
  window.requestHandler({ url: 'http://127.0.0.1:44103' }, (answer) => assert.deepEqual(answer, { cancel: true }))
  registry.unregister(control)
  assert.throws(() => loadOwnedURL(window, host, controlUrl), /navigation blocked/u)
  window.destroy()
  await lifecycle.ensureWindow()
  assert.notEqual(settings[0].webPreferences.partition, settings[1].webPreferences.partition)
})

test('renderer recovery keeps a hidden window hidden and reloads the still-owned Control URL', async () => {
  const { lifecycle, windows, controlUrl, diagnostics } = harness()
  await lifecycle.showWindow()
  windows[0].webContents.emit('did-navigate', {}, controlUrl)
  lifecycle.hideWindow()
  windows[0].crash('oom')
  await lifecycle.pendingRecovery
  assert.equal(windows.length, 1)
  assert.equal(windows[0].visible, false)
  assert.equal(windows[0].loads.at(-1), controlUrl)
  assert.equal(lifecycle.observations.crashes, 1)
  assert.equal(lifecycle.observations.recovered, 1)
  assert.deepEqual(diagnostics.filter((item) => ['render-process-gone', 'recovered'].includes(item.event)).map((item) => item.event), ['render-process-gone', 'recovered'])
})

test('crash recovery falls back to Launchpad after Control revocation and preserves visible intent', async () => {
  const { lifecycle, windows, registry, control, controlUrl, launchpadUrl } = harness()
  await lifecycle.showWindow()
  windows[0].webContents.emit('did-navigate', {}, controlUrl)
  registry.unregister(control)
  windows[0].crash('killed')
  await lifecycle.pendingRecovery
  assert.equal(windows[0].loads.at(-1), launchpadUrl)
  assert.equal(windows[0].visible, true)
})

test('automatic crash recovery is finite even when each navigation succeeds', async () => {
  let time = 100
  const { lifecycle, windows, diagnostics } = harness({ now: () => time, maxRecoveryAttempts: 2, recoveryWindowMs: 1000 })
  await lifecycle.showWindow()
  for (let attempt = 0; attempt < 3; attempt++) {
    windows[0].crash()
    await lifecycle.pendingRecovery
  }
  assert.equal(lifecycle.observations.crashes, 3)
  assert.equal(lifecycle.observations.recoveryAttempts, 2)
  assert.equal(lifecycle.observations.recoveryLimited, 1)
  assert.equal(windows[0].loads.length, 3)
  assert.equal(diagnostics.at(-1).event, 'recovery-limit')
  time += 1000
  windows[0].crash()
  await lifecycle.pendingRecovery
  assert.equal(lifecycle.observations.recoveryAttempts, 3)
})

test('recovery load failure is diagnosed once and diagnostic callback failure is isolated', async () => {
  const { lifecycle, windows } = harness({ reportDiagnostic() { throw new Error('observer failed') } })
  await lifecycle.showWindow()
  windows[0].load = async () => { throw new Error('renderer load failed') }
  windows[0].crash('abnormal-exit')
  await lifecycle.pendingRecovery
  assert.equal(lifecycle.observations.recoveryFailures, 1)
  assert.equal(lifecycle.observations.recoveryAttempts, 1)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].destroyed, false)
})

test('concurrent ensure calls share creation and hide beats a pending show without opening late', async () => {
  const gate = Promise.withResolvers()
  const window = new FakeWindow()
  window.load = () => gate.promise
  const { lifecycle } = harness({ createWindow: () => window })
  const first = lifecycle.ensureWindow()
  assert.equal(lifecycle.ensureWindow(), first)
  const show = lifecycle.showWindow()
  lifecycle.hideWindow()
  gate.resolve(undefined)
  assert.equal(await first, window)
  await show
  assert.equal(window.visible, false)
  assert.equal(window.focused, 0)
  assert.equal(lifecycle.observations.created, 1)
})

test('creation is published before synchronous factory reentry', async () => {
  let lifecycle
  let reentered
  const window = new FakeWindow()
  ;({ lifecycle } = harness({ createWindow() { reentered = lifecycle.ensureWindow(); return window } }))
  const first = lifecycle.ensureWindow()
  assert.equal(first, reentered)
  await first
  assert.equal(lifecycle.observations.created, 1)
})

test('quit suppresses late show and recovery, while ordinary close then permits final destruction', async () => {
  let requested = false
  const gate = Promise.withResolvers()
  const window = new FakeWindow()
  window.load = () => gate.promise
  const { lifecycle } = harness({ createWindow: () => window, isQuitRequested: () => requested })
  const show = lifecycle.showWindow()
  requested = true
  gate.resolve(undefined)
  assert.equal(await show, undefined)
  assert.equal(window.visible, false)
  window.crash()
  assert.equal(lifecycle.pendingRecovery, undefined)
  assert.equal(window.close(), false)
  assert.equal(window.destroyed, true)
  assert.equal(await lifecycle.showWindow(), undefined)
  assert.equal(lifecycle.observations.created, 1)
})

test('destroyForQuit prevents recreation during a pending load and is idempotent', async () => {
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const window = new FakeWindow()
  window.load = () => { entered.resolve(); return gate.promise }
  const { lifecycle } = harness({ createWindow: () => window })
  const show = lifecycle.showWindow()
  await entered.promise
  lifecycle.destroyWindowForQuit()
  lifecycle.destroyWindowForQuit()
  gate.reject(new Error('window destroyed during load'))
  assert.equal(await show, undefined)
  assert.equal(await lifecycle.ensureWindow(), undefined)
  assert.equal(window.destroyed, true)
  assert.equal(lifecycle.observations.created, 1)
})

test('failed startup releases its unreturned window and a later show can retry', async () => {
  const failure = new Error('initial load failed')
  const gate = Promise.withResolvers()
  const failedWindow = new FakeWindow()
  failedWindow.load = () => gate.promise
  const replacement = new FakeWindow()
  let attempts = 0
  const { lifecycle } = harness({ createWindow: () => ++attempts === 1 ? failedWindow : replacement })
  const ready = lifecycle.ensureWindow()
  gate.reject(failure)
  await assert.rejects(ready, (error) => error === failure)
  assert.equal(failedWindow.destroyed, true)
  assert.equal(lifecycle.window, undefined)
  assert.equal(await lifecycle.showWindow(), replacement)
  assert.equal(replacement.visible, true)
  assert.equal(attempts, 2)
})

test('destroy and show while an older load is pending cannot let its cleanup destroy the replacement', async () => {
  const firstLoad = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const original = new FakeWindow()
  const replacement = new FakeWindow()
  original.load = () => { entered.resolve(); return firstLoad.promise }
  let attempts = 0
  const { lifecycle } = harness({ createWindow: () => ++attempts === 1 ? original : replacement })
  const pending = lifecycle.showWindow()
  await entered.promise
  original.destroy()
  assert.equal(await lifecycle.showWindow(), replacement)
  assert.equal(replacement.visible, true)
  firstLoad.reject(new Error('old window was destroyed'))
  await assert.rejects(pending, /old window was destroyed/u)
  assert.equal(lifecycle.window, replacement)
  assert.equal(replacement.destroyed, false)
  assert.equal(attempts, 2)
})

test('destroyed renderer recovery recreates only the window and shares a concurrent show request', async () => {
  const { lifecycle, windows, controlUrl } = harness()
  await lifecycle.showWindow()
  windows[0].webContents.emit('did-navigate', {}, controlUrl)
  windows[0].crash()
  const recovery = lifecycle.pendingRecovery
  windows[0].destroy()
  const shown = lifecycle.showWindow()
  await Promise.all([recovery, shown])
  assert.equal(windows.length, 2)
  assert.equal(lifecycle.window, windows[1])
  assert.equal(windows[1].visible, true)
  assert.deepEqual(windows[1].loads, [controlUrl])
})

test('a close or quit during renderer recovery cannot cause a late show', async () => {
  let requested = false
  const { lifecycle, windows } = harness({ isQuitRequested: () => requested })
  await lifecycle.showWindow()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  windows[0].load = () => { entered.resolve(undefined); return release.promise }
  windows[0].crash()
  await entered.promise
  windows[0].close()
  requested = true
  release.resolve(undefined)
  await lifecycle.pendingRecovery
  assert.equal(windows[0].visible, false)
  assert.equal(lifecycle.observations.recovered, 0)
  assert.equal(lifecycle.observations.recoveryFailures, 0)
})

test('Session click resolves trusted identity, restores hidden window and falls back to Launchpad', async () => {
  const { lifecycle, windows, host, registry, control, controlUrl, launchpadUrl } = harness()
  host.resolveSessionUrl = (id) => id === 'one' ? controlUrl : undefined
  await lifecycle.showWindow()
  const [window] = windows
  window.minimized = true
  lifecycle.hideWindow()
  await lifecycle.showSession('one')
  assert.equal(window.loads.at(-1), controlUrl)
  assert.equal(window.visible, true)
  assert.equal(window.restores, 1)
  assert.equal(window.focused, 2)
  registry.unregister(control)
  await lifecycle.showSession('one')
  assert.equal(window.loads.at(-1), launchpadUrl)
  await lifecycle.showSession('https://example.com')
  assert.equal(window.loads.at(-1), launchpadUrl)
  assert.equal(windows.length, 1)
})

test('Session click re-resolves after asynchronous creation, with quit and hide preventing late show', async () => {
  let quit = false
  let resolveSessionUrl
  const gate = Promise.withResolvers()
  const window = new FakeWindow()
  window.load = () => gate.promise
  const { lifecycle, host, registry, control, controlUrl, launchpadUrl } = harness({
    createWindow: () => window, isQuitRequested: () => quit,
  })
  host.resolveSessionUrl = (id) => resolveSessionUrl?.(id)
  resolveSessionUrl = () => controlUrl
  const click = lifecycle.showSession('one')
  await Promise.resolve()
  registry.unregister(control)
  lifecycle.hideWindow()
  gate.resolve(undefined)
  await click
  assert.equal(window.loads.at(-1), launchpadUrl)
  assert.equal(window.visible, false)
  quit = true
  const loads = window.loads.length
  assert.equal(await lifecycle.showSession('one'), undefined)
  assert.equal(window.loads.length, loads)
})

test('Session click rejects an arbitrary mapped URL and serializes successive session loads', async () => {
  const { lifecycle, windows, host, launchpadUrl, controlUrl } = harness()
  host.resolveSessionUrl = (id) => id === 'one' ? controlUrl : 'file:///private'
  await lifecycle.ensureWindow()
  await Promise.all([lifecycle.showSession('one'), lifecycle.showSession('untrusted')])
  assert.deepEqual(windows[0].loads, [launchpadUrl, controlUrl, launchpadUrl])
  assert.equal(lifecycle.lastTrustedUrl, launchpadUrl)
})

test('Session revocation during navigation falls back even while its owned origin drains', async () => {
  const { lifecycle, host, windows, controlUrl, launchpadUrl } = harness()
  let live = true
  host.resolveSessionUrl = () => live ? controlUrl : undefined
  await lifecycle.showWindow()
  const entered = Promise.withResolvers()
  const loadGate = Promise.withResolvers()
  windows[0].load = (url) => {
    if (url === controlUrl) { entered.resolve(undefined); return loadGate.promise }
    return Promise.resolve()
  }
  const click = lifecycle.showSession('one')
  await entered.promise
  live = false
  assert.equal(host.isAllowedNavigation(controlUrl), true)
  loadGate.reject(new Error('Control server closed while Runtime still drains'))
  await click
  assert.equal(windows[0].loads.at(-1), launchpadUrl)
  assert.equal(windows[0].visible, true)
})

test('A/B: hidden healthy Control stays loaded across Tray show and repeated same-session clicks', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showSession('one')
  const window = windows[0]
  assert.deepEqual(window.loads, [controlUrl], 'initial Session routing skips Launchpad')
  lifecycle.hideWindow()
  await lifecycle.showWindow()
  lifecycle.hideWindow()
  await Promise.all([lifecycle.showSession('one'), lifecycle.showSession('one'), lifecycle.showWindow()])
  assert.deepEqual(window.loads, [controlUrl])
  assert.equal(window.visible, true)
})

test('C: different-session click loads once; concurrent Tray show cannot expose its pending document', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showWindow()
  lifecycle.hideWindow()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  windows[0].load = () => { entered.resolve(); return release.promise }
  const click = lifecycle.showSession('one')
  await entered.promise
  const show = lifecycle.showWindow()
  assert.equal(windows[0].visible, false)
  release.resolve()
  await Promise.all([show, click])
  assert.equal(windows[0].loads.filter((url) => url === controlUrl).length, 1)
  assert.equal(windows[0].visible, true)
})

test('D: destroyed-window click shares creation and displays only after target load finishes', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showWindow()
  windows[0].destroy()
  const created = lifecycle.showSession('one')
  await created
  assert.equal(windows.length, 2)
  assert.deepEqual(windows[1].loads, [controlUrl])
  assert.equal(windows[1].visible, true)
})

test('E: recovery in flight and same-session click share one navigation and do not show early', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showSession('one')
  const window = windows[0]
  lifecycle.hideWindow()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  window.load = () => { entered.resolve(); return release.promise }
  window.crash()
  const recovery = lifecycle.pendingRecovery
  await entered.promise
  const click = lifecycle.showSession('one')
  const show = lifecycle.showWindow()
  assert.equal(window.visible, false)
  release.resolve()
  await Promise.all([recovery, click, show])
  assert.deepEqual(window.loads, [controlUrl, controlUrl])
  assert.equal(window.visible, true)
})

test('E reverse: crash during Session load queues recovery instead of concurrent loadURL', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showWindow()
  const window = windows[0]
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let active = 0
  let maximum = 0
  window.load = async () => {
    maximum = Math.max(maximum, ++active)
    if (window.loads.length === 2) { entered.resolve(); await release.promise }
    active--
  }
  const click = lifecycle.showSession('one')
  await entered.promise
  window.crash()
  const recovery = lifecycle.pendingRecovery
  release.resolve()
  await Promise.all([click, recovery])
  assert.equal(maximum, 1)
  assert.equal(window.url, controlUrl)
  assert.equal(window.visible, true)
})

test('Electron ordering: resolved loadURL precedes did-stop-loading and cannot expose the window', async () => {
  const { lifecycle, host, windows, controlUrl } = harness()
  host.resolveSessionUrl = () => controlUrl
  await lifecycle.showWindow()
  lifecycle.hideWindow()
  const window = windows[0]
  const finished = Promise.withResolvers()
  window.loadURL = async (url) => {
    window.loading = true
    window.webContents.emit('did-start-loading')
    window.webContents.emit('did-navigate', {}, url)
    window.webContents.emit('did-finish-load')
    finished.resolve()
  }
  const click = lifecycle.showSession('one')
  await finished.promise
  assert.equal(window.visible, false)
  window.loading = false
  window.webContents.emit('did-stop-loading')
  await click
  assert.equal(window.visible, true)
})

test('new window waits for first paint as well as a finished document', async () => {
  const attemptedPaint = Promise.withResolvers()
  class PaintGatedWindow extends FakeWindow {
    emit(name, ...args) {
      if (name === 'ready-to-show') { attemptedPaint.resolve(); return true }
      return super.emit(name, ...args)
    }
  }
  const window = new PaintGatedWindow()
  const { lifecycle } = harness({ createWindow: () => window })
  const show = lifecycle.showWindow()
  await attemptedPaint.promise
  assert.equal(window.visible, false)
  EventEmitter.prototype.emit.call(window, 'ready-to-show')
  await show
  assert.equal(window.visible, true)
})
