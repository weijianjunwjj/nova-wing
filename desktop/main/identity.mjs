/**
 * Desktop identity has one owner. Phase 4 must select the packaged identities
 * here and use the same values in the installer / electron-builder config.
 * No development electron.exe path is a production AppUserModelID, and Phase 3
 * does not create Start Menu shortcuts, registry entries, or COM registrations.
 */
export const DESKTOP_IDENTITY = Object.freeze({
  appName: 'NovaWing',
  appUserModelId: null,
  toastActivatorCLSID: null,
})
