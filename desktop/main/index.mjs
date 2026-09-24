import { app, Menu, nativeImage, Notification, powerSaveBlocker, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { requireDesktopIsolation } from './isolation.mjs'
import { createShutdownCoordinator, describeShutdownError } from './shutdown.mjs'
import { createElectronUpdaterAdapter } from './electron-updater-adapter.mjs'
import { createUpdaterLifecycle } from './updater-lifecycle.mjs'
import { createDesktopPowerManager } from './power.mjs'
import { createDesktopTray } from './tray.mjs'
import { createDesktopNotificationProvider } from './notifications.mjs'
import { DESKTOP_IDENTITY } from './identity.mjs'
import { initializeDesktopPlatform } from './platform.mjs'
import { createDesktopEvidence } from './evidence.mjs'

app.setName(DESKTOP_IDENTITY.appName)
// Windows-only calls are kept in the dedicated Desktop platform adapter.
initializeDesktopPlatform(app)
const root = process.env.NOVAWING_DESKTOP_SMOKE_ROOT ? requireDesktopIsolation() : undefined
if (!app.isPackaged && !root) throw new Error('Development Desktop requires the isolated launcher')
let fixture
// userData is configured before requesting the lock; no fixture, package import,
// Host, Launchpad or database may be created by a secondary process.
export const desktopInstance = {
  primary: app.requestSingleInstanceLock(), secondInstanceCount: 0,
  fixtureCreateCount: 0, hostCreateCount: 0, launchpadCreateCount: 0,
  get runtimeCreateCount() { return fixture?.evidence.runtimeCreateCount ?? 0 },
}
let host
let windows
let tray
let power
let notifications
let updater
let unsubscribeUpdater = () => {}
let record = (_event, _detail) => {}
function reportBackgroundFailure(error) {
  console.error(`DESKTOP_BACKGROUND_FAILURE ${JSON.stringify({ error: describeShutdownError(error) })}`)
}
/**
 * The real update adapter, or null when electron-updater cannot be constructed here. A failure
 * degrades to a not-configured capability instead of failing startup, and the capability policy
 * still decides whether the product may install anything at all.
 *
 * `autoUpdater` is a lazy getter on the CommonJS default export, not a named ESM export.
 */
function createUpdateAdapter() {
  try {
    return createElectronUpdaterAdapter({ autoUpdater: electronUpdater.autoUpdater })
  } catch (error) {
    reportBackgroundFailure(error)
    return null
  }
}

// Windows from a packaged app is the only installable configuration today, and it is granted as
// an explicitly unsigned bootstrap. macOS stays blocked by signing, and an unpackaged run is
// never installable. Nothing here checks, downloads or installs on its own: only the explicit
// Tray actions reach the updater, and an ordinary quit can never install a staged update.
const updaterLifecycle = createUpdaterLifecycle({
  platform: process.platform, packaged: app.isPackaged, adapter: createUpdateAdapter(),
  reportFailure: reportBackgroundFailure,
})
export const desktopShutdown = createShutdownCoordinator({
  getStartup: () => desktopReady,
  getHost: () => host,
  // The single final quit: an ordinary quit unless an install was authorized at admission.
  requestFinalQuit: updaterLifecycle.finalQuit({ quit: () => app.quit() }),
  afterDrain() {
    // Keep native recovery controls and the blocker throughout strict drain.
    // On Host failure this continuation is never entered.
    notifications?.dispose()
    power?.dispose()
    unsubscribeUpdater()
    updater?.dispose()
    tray?.destroy()
    windows?.destroyWindowForQuit()
    record('strict-quit-drained', { power: power?.snapshot() })
  },
  reportFailure(error) {
    process.exitCode = 1
    console.error(`DESKTOP_SHUTDOWN_FAILURE ${JSON.stringify({ result: 'FAIL', error: describeShutdownError(error) })}`)
  },
})

export function shutdownDesktop() {
  return desktopShutdown.shutdown()
}

if (desktopInstance.primary) {
  // Owning this event explicitly keeps Main/Tray/Host alive without a window.
  app.on('window-all-closed', () => {})
  app.on('before-quit', desktopShutdown.beforeQuit)
  const showWhenReady = () => {
    void desktopReady.then((desktop) => desktop?.windows?.showWindow()).catch(reportBackgroundFailure)
  }
  app.on('second-instance', () => {
    desktopInstance.secondInstanceCount++
    record('second-instance', { count: desktopInstance.secondInstanceCount })
    showWhenReady()
  })
  app.on('activate', showWhenReady)
} else {
  console.log(`DESKTOP_SINGLE_INSTANCE ${JSON.stringify({ ...desktopInstance, lockAcquired: false })}`)
  app.quit()
}

// End ESM evaluation before waiting for ready. This stage still uses isolated fake work.
export const desktopReady = desktopInstance.primary ? app.whenReady().then(async () => {
  const { createDesktopHost } = await import('./host.mjs')
  const { createDesktopWindowLifecycle } = await import('./window.mjs')
  const { platformPaths } = await import('nova-wing/development-guardian')
  if (!root) record = createDesktopEvidence(platformPaths().data)
  record('startup', { identity: DESKTOP_IDENTITY, packaged: app.isPackaged, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, execPath: process.execPath, cwd: process.cwd(),
    userData: app.getPath('userData'), paths: platformPaths(), versions: process.versions })
  app.setName(DESKTOP_IDENTITY.appName)
  notifications = createDesktopNotificationProvider({
    Notification,
    isQuitRequested: () => desktopShutdown.requested,
    onSessionClick: (sessionId) => windows?.showSession(sessionId),
    onDiagnostic: (detail) => { record('notification', detail); console.error(`DESKTOP_NOTIFICATION_DIAGNOSTIC ${JSON.stringify(detail)}`) },
  })
  power = createDesktopPowerManager({ powerSaveBlocker, reportFailure: reportBackgroundFailure })
  if (root) {
    const { createIsolatedLaunchpadFixture } = await import('./isolated-fixture.mjs')
    desktopInstance.fixtureCreateCount++
    fixture = await createIsolatedLaunchpadFixture({
      root, env: process.env, holdTasks: process.env.NOVAWING_DESKTOP_HOLD_TASKS === '1',
    })
  }
  desktopInstance.hostCreateCount++
  host = await createDesktopHost({ configDirectory: fixture?.configDirectory ?? platformPaths().trustedConfig, env: process.env,
    dependencies: { ...fixture?.dependencies, activityObserver: power.observe }, desktopNotifier: notifications ?? null })
  desktopInstance.launchpadCreateCount++
  await host.start()
  // The install path is assembled here because it needs the live Host. The Tray only forwards
  // explicit user intent into this Main-owned controller; it never owns update state or policy.
  updater = updaterLifecycle.createUpdater({
    host,
    // The existing coordinator is the only exit, and it stops admission synchronously.
    requestQuit: () => desktopShutdown.requestQuit(),
    readShutdownState: () => desktopShutdown,
  })
  // Startup was admitted before quit; let its owner settle without opening a
  // late window. The coordinator waits for this operation and closes the host.
  if (desktopShutdown.requested) return { window: undefined, host, fixture, blocked: [], updater }
  windows = createDesktopWindowLifecycle(host, {
    isQuitRequested: () => desktopShutdown.requested,
    reportDiagnostic: (diagnostic) => { record('window-lifecycle', { ...diagnostic, phase: diagnostic.event, event: 'window-lifecycle' }); console.error(`DESKTOP_WINDOW_LIFECYCLE ${JSON.stringify(diagnostic)}`) },
  })
  tray = createDesktopTray({ Tray, Menu, nativeImage,
    showWindow: () => windows.showWindow(), hideWindow: () => windows.hideWindow(),
    requestQuit: () => app.quit(), updater,
    notifyNoUpdate: () => notifications?.notifyUpToDate(DESKTOP_IDENTITY.version),
    reportFailure: reportBackgroundFailure,
  })
  unsubscribeUpdater = updater.subscribe((snapshot) => {
    tray.setUpdaterSnapshot(snapshot)
    record('updater-state', {
      state: snapshot.state, reasonCode: snapshot.reasonCode,
      candidateVersion: snapshot.candidate?.version ?? null,
      capability: snapshot.capability,
      observations: snapshot.observations,
    })
  })
  power.subscribe((count) => tray.setActivity(count))
  power.subscribe(() => record('power', power.snapshot()))
  await windows.showWindow()
  windows.window?.on('hide', () => record('window-hidden', { power: power.snapshot(), tray: !tray.tray.isDestroyed() }))
  record('ready', { launchpadUrl: host.launchpadUrl, tray: !tray.tray.isDestroyed(), trayImage: tray.diagnostics })
  if (fixture) console.log(`DESKTOP_ISOLATED_FIXTURE ${JSON.stringify({ repo: fixture.repoDirectory, launchpadUrl: host.launchpadUrl })}`)
  return { get window() { return windows.window }, host, fixture, blocked: windows.blocked, windows, tray, power, notifications, updater }
}) : Promise.resolve(undefined)
desktopReady.catch((error) => {
  console.error(`DESKTOP_STARTUP_FAILURE ${JSON.stringify({ result: 'FAIL', error: describeShutdownError(error) })}`)
  process.exitCode = 1
  app.quit()
})
