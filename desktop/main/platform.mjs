import { DESKTOP_IDENTITY } from './identity.mjs'

/** Identity must be established before lock, Window, Tray and Notification. */
export function initializeDesktopPlatform(app) {
  if (process.platform === 'win32') {
    app.setAppUserModelId(DESKTOP_IDENTITY.appUserModelId)
    app.setToastActivatorCLSID(DESKTOP_IDENTITY.toastActivatorCLSID)
  }
}

/** Explicit show/restore intent must activate the app before macOS paints/focuses its window. */
export function prepareDesktopWindowPresentation(app, platform = process.platform) {
  if (platform === 'darwin') app.focus({ steal: true })
}
