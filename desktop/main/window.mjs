import { app, BrowserWindow } from 'electron'
import { createWindowLifecycle } from './window-lifecycle.mjs'
import { prepareDesktopWindowPresentation } from './platform.mjs'

export { loadOwnedURL } from './window-lifecycle.mjs'

export function createDesktopWindowLifecycle(host, options = {}) {
  return createWindowLifecycle(host, { preparePresentation: () => prepareDesktopWindowPresentation(app),
    ...options, createWindow: (settings) => new BrowserWindow(settings) })
}

/** Compatibility factory; Main retains the lifecycle for background operation. */
export async function createDesktopWindow(host) {
  const lifecycle = createDesktopWindowLifecycle(host)
  const window = await lifecycle.showWindow()
  return { window, blocked: lifecycle.blocked, lifecycle }
}
