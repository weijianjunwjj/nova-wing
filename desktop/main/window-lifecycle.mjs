import { randomUUID } from 'node:crypto'

/** Main-side loads bypass will-navigate, so every Main load uses this check. */
export function loadOwnedURL(window, host, url) {
  if (!host.isAllowedNavigation(url)) throw new Error(`Desktop navigation blocked: ${url}`)
  return window.loadURL(url)
}

/**
 * BrowserWindow ownership only: hiding, recreation and recovery never own Host.
 * The factory seam makes races and security policy testable without Electron.
 * @param {{ launchpadUrl: string, isAllowedNavigation: (url: string) => boolean }} host
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
  /** @type {{ window?: import('electron').BrowserWindow, ready: Promise<import('electron').BrowserWindow | undefined> } | undefined} */
  let current
  let lastTrustedUrl
  let destroyedForQuit = false
  let visibleIntent = false
  /** @type {Promise<void> | undefined} */
  let pendingRecovery
  let recoveryTimes = []
  const quitting = () => destroyedForQuit || isQuitRequested()

  function diagnostic(detail) {
    // An observer failure must not turn a renderer failure into a Main failure.
    try { reportDiagnostic(detail) } catch {}
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
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }

  function recoverRenderer(window, details) {
    if (quitting() || current?.window !== window || details.reason === 'clean-exit') return
    observations.crashes++
    diagnostic({ event: 'render-process-gone', reason: details.reason, exitCode: details.exitCode })
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
        await loadOwnedURL(target, host, recoveryUrl())
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
    window.webContents.on('did-navigate', (_event, url) => remember(window, url))
    window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) remember(window, url) })
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

  function ensureWindow() {
    if (quitting()) return Promise.resolve(undefined)
    if (current && !current.window?.isDestroyed()) return current.ready
    const completion = Promise.withResolvers()
    // Publish before calling the factory or loading; either can reenter Main.
    const entry = { window: undefined, ready: completion.promise }
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
      // A synchronous factory callback can request quit before returning.
      if (quitting()) { window.destroy(); return undefined }
      await loadOwnedURL(window, host, recoveryUrl())
      if (quitting() || window.isDestroyed() || current !== entry) return undefined
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
    const window = await ensureWindow()
    if (window) showExisting(window)
    return window
  }

  function hideWindow() {
    visibleIntent = false
    const window = current?.window
    if (window && !window.isDestroyed()) window.hide()
  }

  function destroyWindowForQuit() {
    destroyedForQuit = true
    visibleIntent = false
    const window = current?.window
    if (window && !window.isDestroyed()) window.destroy()
  }

  return {
    ensureWindow, showWindow, hideWindow, destroyWindowForQuit, blocked, observations,
    get window() { return current?.window },
    get lastTrustedUrl() { return lastTrustedUrl },
    get pendingRecovery() { return pendingRecovery },
  }
}
