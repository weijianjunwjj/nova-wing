import { DESKTOP_IDENTITY } from './identity.mjs'

/** Identity must be established before lock, Window, Tray and Notification. */
export function initializeDesktopPlatform(app) {
  if (process.platform === 'win32') {
    app.setAppUserModelId(DESKTOP_IDENTITY.appUserModelId)
    app.setToastActivatorCLSID(DESKTOP_IDENTITY.toastActivatorCLSID)
  }
}
