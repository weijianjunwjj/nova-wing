import { randomUUID } from 'node:crypto'

/** Main-side loads bypass will-navigate, so every Main load uses this check. */
export function loadOwnedURL(window, host, url) {
  if (!host.isAllowedNavigation(url)) throw new Error(`Desktop navigation blocked: ${url}`)
  return window.loadURL(url)
}

/**
 * BrowserWindow ownership only: hiding, recreation and recovery never own Host.
 * The factory seam makes races and security policy testable without Electron.
 * @param {{ launchpadUrl: string, isAllowedNavigation: (url: string) => boolean,
 *   resolveSessionUrl?: (sessionId: string) => string | undefined }} host
 * @param {{ createWindow: (settings: import('electron').BrowserWindowConstructorOptions) => import('electron').BrowserWindow,
 *   isQuitRequested?: () => boolean, reportDiagnostic?: (diagnostic: object) => void,
 *   now?: () => number, maxRecoveryAttempts?: number, recoveryWindowMs?: number }} options
 */
export function createWindowLifecycle(host, {
  createWindow, isQuitRequested = () => false,
  reportDiagnostic = (diagnostic) => console.error(`DESKTOP_RENDERER_RECOVERY ${JSON.stringify(diagnostic)}`),
  now = Date.now, maxRecoveryAttempts = 3, recoveryWindowMs = 60_000,
}) {
  if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 1 || recoveryWindowMs <= 0) {
    throw new Error('Desktop recovery limits must be positive')
  }
  const blocked = []
  const observations = { created: 0, hiddenCloses: 0, crashes: 0, recoveryAttempts: 0, recovered: 0, recoveryFailures: 0, recoveryLimited: 0 }
  /** @type {{ window?: import('electron').BrowserWindow, ready: Promise<import('electron').BrowserWindow | undefined>, navigation: Promise<void>, pendingLoads: number, healthy: boolean, crashed: boolean, generation: number, target?: string } | undefined} */
  let current
  let lastTrustedUrl
  let destroyedForQuit = false
  let visibleIntent = false
  /** @type {Promise<void> | undefined} */
  let pendingRecovery
  let pendingSessionNavigation = Promise.resolve()
  let recoveryTimes = []
  const quitting = () => destroyedForQuit || isQuitRequested()

  function diagnostic(detail) {
    // An observer failure must not turn a renderer failure into a Main failure.
    try { reportDiagnostic(detail) } catch {}
  }

  function trace(event, window = current?.window, extra = {}) {
    const destroyed = !window || window.isDestroyed()
    diagnostic({ event, timestamp: new Date(now()).toISOString(), windowId: window?.id,
      currentUrl: destroyed ? undefined : window.webContents.getURL(), targetUrl: current?.target,
      isVisible: !destroyed && window.isVisible(), isDestroyed: destroyed,
      isLoading: !destroyed && window.webContents.isLoadingMainFrame(), ...extra })
  }

  const sameUrl = (left, right) => left && right && new URL(left).href === new URL(right).href

  // Renderer-initiated navigation also belongs to this window. Await its actual
  // completion instead of showing a blank document or aborting it with loadURL.
  function pageIdle(window) {
    if (window.isDestroyed()) return Promise.reject(new Error('Desktop window destroyed'))
    if (!window.webContents.isLoadingMainFrame()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const contents = window.webContents
      const cleanup = () => {
        contents.removeListener('did-stop-loading', finished)
        contents.removeListener('render-process-gone', failed)
        window.removeListener('closed', failed)
      }
      const finished = () => { cleanup(); resolve(undefined) }
      const failed = () => { cleanup(); reject(new Error('Desktop page unavailable')) }
      contents.on('did-stop-loading', finished)
      contents.on('render-process-gone', failed)
      window.on('closed', failed)
    })
  }

  function navigate(window, destination) {
    const entry = current
    if (!entry || entry.window !== window || quitting()) return Promise.resolve()
    entry.pendingLoads++
    const operation = entry.navigation.then(async () => {
      if (quitting() || window.isDestroyed() || current !== entry) return
      if (!entry.crashed) await pageIdle(window)
      if (quitting() || window.isDestroyed() || current !== entry) return
      const url = destination()
      if (!host.isAllowedNavigation(url)) throw new Error(`Desktop navigation blocked: ${url}`)
      if (entry.healthy && sameUrl(window.webContents.getURL(), url)) {
        trace('navigation-reused', window, { targetUrl: url })
        return
      }
      entry.target = url
      entry.healthy = false
      const generation = entry.generation
      entry.crashed = false
      // Keep the visible intent, but never expose a new/failed document while loading.
      if (window.isVisible()) window.hide()
      trace('navigation-start', window, { targetUrl: url })
      await loadOwnedURL(window, host, url)
      await pageIdle(window)
      if (!window.isDestroyed() && current === entry) {
        entry.healthy = generation === entry.generation
        trace('navigation-ready', window, { targetUrl: url })
      }
    }).finally(() => { entry.pendingLoads--; entry.target = undefined })
    // All Main loads (creation, session routing, crash recovery) share this tail.
    entry.navigation = operation.catch(() => {})
    return operation
  }

  function recoveryUrl() {
    if (lastTrustedUrl && host.isAllowedNavigation(lastTrustedUrl)) return lastTrustedUrl
    if (host.isAllowedNavigation(host.launchpadUrl)) return host.launchpadUrl
    throw new Error('Desktop has no live owned URL for window recovery')
  }

  function remember(window, url) {
    if (current?.window === window && !window.isDestroyed() && host.isAllowedNavigation(url)) lastTrustedUrl = url
  }

  function showExisting(window) {
    if (quitting() || !visibleIntent || window.isDestroyed() || current?.window !== window) return
    if (!current.healthy || current.pendingLoads || window.webContents.isLoadingMainFrame()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    trace('window-shown', window)
  }

  function recoverRenderer(window, details) {
    if (quitting() || current?.window !== window || details.reason === 'clean-exit') return
    observations.crashes++
    current.healthy = false
    current.crashed = true
    current.generation++
    const crashedTarget = current.target
    if (window.isVisible()) window.hide()
    trace('render-process-gone', window, { reason: details.reason, exitCode: details.exitCode })
    // A crash during recovery is already owned by that attempt's load promise.
    if (pendingRecovery) return
    const timestamp = now()
    recoveryTimes = recoveryTimes.filter((time) => timestamp - time < recoveryWindowMs)
    if (recoveryTimes.length >= maxRecoveryAttempts) {
      observations.recoveryLimited++
      diagnostic({ event: 'recovery-limit', attempts: recoveryTimes.length, recoveryWindowMs })
      return
    }
    recoveryTimes.push(timestamp)
    observations.recoveryAttempts++
    const entry = current
    const operation = Promise.resolve().then(async () => {
      // Initial load may itself be the failed renderer. Its factory releases
      // that window before recovery decides whether a replacement is needed.
      await entry.ready.catch(() => undefined)
      if (quitting()) return
      let target = current?.window
      if (current !== entry || !target || target.isDestroyed()) {
        // A concurrent show may already be loading a replacement. Its shared
        // creation promise owns that navigation; a second load would abort it.
        target = await ensureWindow()
      } else {
        await navigate(target, () => current?.healthy ? recoveryUrl()
          : crashedTarget && host.isAllowedNavigation(crashedTarget) ? crashedTarget : recoveryUrl())
      }
      if (quitting() || !target || target.isDestroyed() || current?.window !== target) return
      showExisting(target)
      observations.recovered++
      diagnostic({ event: 'recovered', url: lastTrustedUrl })
    }).catch((error) => {
      if (quitting()) return
      observations.recoveryFailures++
      diagnostic({ event: 'recovery-failed', message: error instanceof Error ? error.message : String(error) })
    }).finally(() => { if (pendingRecovery === operation) pendingRecovery = undefined })
    pendingRecovery = operation
  }

  function attach(window) {
    const guard = (event) => {
      if (!host.isAllowedNavigation(event.url)) {
        blocked.push(event.url)
        event.preventDefault()
      }
    }
    window.webContents.on('will-frame-navigate', guard)
    window.webContents.on('will-redirect', guard)
    window.webContents.setWindowOpenHandler(({ url }) => { blocked.push(url); return { action: 'deny' } })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = host.isAllowedNavigation(details.url)
      if (!allowed) blocked.push(details.url)
      callback({ cancel: !allowed })
    })
    // did-navigate is main-frame only. In-page navigation explicitly checks it.
    // Never use pending destinations, child-frame navigation or getURL as trust.
    window.webContents.on('did-navigate', (_event, url) => { remember(window, url); trace('did-navigate', window, { url }) })
    window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) remember(window, url) })
    window.webContents.on('did-start-loading', () => {
      if (current?.window === window) current.healthy = false
      trace('did-start-loading', window)
    })
    window.webContents.on('did-stop-loading', () => trace('did-stop-loading', window))
    window.webContents.on('did-finish-load', () => {
      if (current?.window === window) current.healthy = host.isAllowedNavigation(window.webContents.getURL())
      trace('did-finish-load', window)
    })
    window.webContents.on('render-process-gone', (_event, details) => recoverRenderer(window, details))
    window.on('close', (event) => {
      if (quitting()) return
      event.preventDefault()
      observations.hiddenCloses++
      hideWindow()
    })
    window.on('closed', () => { if (current?.window === window) current = undefined })
    window.setMenuBarVisibility(false)
  }

  function ensureWindow(destination = recoveryUrl) {
    if (quitting()) return Promise.resolve(undefined)
    if (current && !current.window?.isDestroyed()) return current.ready
    const completion = Promise.withResolvers()
    // Publish before calling the factory or loading; either can reenter Main.
    const entry = { window: undefined, ready: completion.promise, navigation: Promise.resolve(), pendingLoads: 0, healthy: false, crashed: false, generation: 0, target: undefined }
    current = entry
    void (async () => {
      const window = createWindow({
        width: 1200, height: 860, show: false,
        webPreferences: {
          nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
          webviewTag: false, partition: `novawing-isolated-${randomUUID()}`,
        },
      })
      entry.window = window
      observations.created++
      attach(window)
      const firstPaint = new Promise((resolve) => {
        const finish = (painted) => {
          window.removeListener('ready-to-show', ready)
          window.removeListener('closed', failed)
          window.webContents.removeListener('render-process-gone', failed)
          resolve(painted)
        }
        const ready = () => finish(true)
        const failed = () => finish(false)
        window.once('ready-to-show', ready)
        window.once('closed', failed)
        window.webContents.once('render-process-gone', failed)
      })
      // A synchronous factory callback can request quit before returning.
      if (quitting()) { window.destroy(); return undefined }
      await navigate(window, destination)
      if (quitting() || window.isDestroyed() || current !== entry) return undefined
      const painted = await firstPaint
      if (quitting() || window.isDestroyed() || current !== entry) return undefined
      if (!painted) throw new Error('Desktop renderer unavailable before first paint')
      return window
    })().catch((error) => {
      if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
      if (current === entry) current = undefined
      if (quitting()) return undefined
      throw error
    }).then(completion.resolve, completion.reject)
    return completion.promise
  }

  async function showWindow() {
    if (quitting()) return undefined
    visibleIntent = true
    trace('show-request')
    const window = await ensureWindow()
    // Activation/Tray may arrive while a notification or renderer recovery owns
    // navigation. A stable tail, not a timer, decides when showing is safe.
    while (window && !window.isDestroyed() && current?.window === window) {
      const entry = current
      const navigation = entry.navigation
      const sessions = pendingSessionNavigation
      const recovery = pendingRecovery
      await Promise.all([navigation, sessions, recovery])
      await pageIdle(window)
      if (navigation === entry.navigation && sessions === pendingSessionNavigation && !pendingRecovery) break
    }
    if (window && !window.isDestroyed() && current?.window === window &&
        (!current.healthy || !host.isAllowedNavigation(window.webContents.getURL()))) await navigate(window, recoveryUrl)
    if (window) showExisting(window)
    return window
  }

  function showSession(sessionId) {
    if (quitting()) return Promise.resolve(undefined)
    visibleIntent = true
    trace('session-click', current?.window, { sessionId, targetUrl: host.resolveSessionUrl?.(sessionId) })
    // Serialize clicks and re-resolve the live mapping after every await. No
    // notification payload is ever interpreted as a navigation destination.
    const operation = pendingSessionNavigation.then(async () => {
      if (quitting()) return undefined
      const destination = () => {
        const live = host.resolveSessionUrl?.(sessionId)
        return live && host.isAllowedNavigation(live) ? live : host.launchpadUrl
      }
      const window = await ensureWindow(destination)
      if (quitting() || !window || window.isDestroyed()) return undefined
      const sessionUrl = host.resolveSessionUrl?.(sessionId)
      const url = sessionUrl && host.isAllowedNavigation(sessionUrl) ? sessionUrl : host.launchpadUrl
      const revoked = () => !host.isAllowedNavigation(url) ||
        (url === sessionUrl && host.resolveSessionUrl?.(sessionId) !== sessionUrl)
      try {
        await navigate(window, destination)
      } catch (error) {
        if (quitting()) return undefined
        if (!revoked()) throw error
      }
      if (quitting()) return undefined
      // The server can be revoked while Chromium is finishing its load.
      if (revoked() && host.isAllowedNavigation(host.launchpadUrl)) {
        await navigate(window, () => host.launchpadUrl)
      }
      showExisting(window)
      return window
    })
    pendingSessionNavigation = operation.then(() => undefined, () => undefined)
    return operation
  }

  function hideWindow() {
    visibleIntent = false
    const window = current?.window
    if (window && !window.isDestroyed()) window.hide()
    trace('window-hidden', window)
  }

  function destroyWindowForQuit() {
    destroyedForQuit = true
    visibleIntent = false
    const window = current?.window
    if (window && !window.isDestroyed()) window.destroy()
  }

  return {
    ensureWindow, showWindow, showSession, hideWindow, destroyWindowForQuit, blocked, observations,
    get window() { return current?.window },
    get lastTrustedUrl() { return lastTrustedUrl },
    get pendingRecovery() { return pendingRecovery },
  }
}
