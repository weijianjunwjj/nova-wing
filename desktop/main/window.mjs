import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'

/** Main-side loads bypass will-navigate, so every Main load uses this check. */
export function loadOwnedURL(window, host, url) {
  if (!host.isAllowedNavigation(url)) throw new Error(`Desktop navigation blocked: ${url}`)
  return window.loadURL(url)
}

export async function createDesktopWindow(host) {
  const window = new BrowserWindow({
    width: 1200, height: 860, show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, partition: `novawing-isolated-${randomUUID()}`,
    },
  })
  const blocked = []
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
  window.setMenuBarVisibility(false)
  await loadOwnedURL(window, host, host.launchpadUrl)
  window.show()
  return { window, blocked }
}
