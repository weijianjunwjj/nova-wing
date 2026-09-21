import { app, Menu, nativeImage, powerSaveBlocker, Tray } from 'electron'
import { requireDesktopIsolation } from './isolation.mjs'
import { createShutdownCoordinator, describeShutdownError } from './shutdown.mjs'
import { createDesktopPowerManager } from './power.mjs'
import { createDesktopTray } from './tray.mjs'

const root = requireDesktopIsolation()
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
function reportBackgroundFailure(error) {
  console.error(`DESKTOP_BACKGROUND_FAILURE ${JSON.stringify({ error: describeShutdownError(error) })}`)
}
export const desktopShutdown = createShutdownCoordinator({
  getStartup: () => desktopReady,
  getHost: () => host,
  requestFinalQuit: () => app.quit(),
  afterDrain() {
    // Keep native recovery controls and the blocker throughout strict drain.
    // On Host failure this continuation is never entered.
    power?.dispose()
    tray?.destroy()
    windows?.destroyWindowForQuit()
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
    showWhenReady()
  })
  app.on('activate', showWhenReady)
} else {
  console.log(`DESKTOP_SINGLE_INSTANCE ${JSON.stringify({ ...desktopInstance, lockAcquired: false })}`)
  app.quit()
}

// End ESM evaluation before waiting for ready. This stage still uses isolated fake work.
export const desktopReady = desktopInstance.primary ? app.whenReady().then(async () => {
  const { createIsolatedLaunchpadFixture } = await import('./isolated-fixture.mjs')
  const { createDesktopHost } = await import('./host.mjs')
  const { createDesktopWindowLifecycle } = await import('./window.mjs')
  power = createDesktopPowerManager({ powerSaveBlocker, reportFailure: reportBackgroundFailure })
  desktopInstance.fixtureCreateCount++
  fixture = await createIsolatedLaunchpadFixture({
    root, env: process.env, holdTasks: process.env.NOVAWING_DESKTOP_HOLD_TASKS === '1',
  })
  desktopInstance.hostCreateCount++
  host = await createDesktopHost({ configDirectory: fixture.configDirectory, env: process.env,
    dependencies: { ...fixture.dependencies, activityObserver: power.observe } })
  desktopInstance.launchpadCreateCount++
  await host.start()
  // Startup was admitted before quit; let its owner settle without opening a
  // late window. The coordinator waits for this operation and closes the host.
  if (desktopShutdown.requested) return { window: undefined, host, fixture, blocked: [] }
  windows = createDesktopWindowLifecycle(host, {
    isQuitRequested: () => desktopShutdown.requested,
    reportDiagnostic: (diagnostic) => console.error(`DESKTOP_RENDERER_RECOVERY ${JSON.stringify(diagnostic)}`),
  })
  tray = createDesktopTray({ Tray, Menu, nativeImage,
    showWindow: () => windows.showWindow(), hideWindow: () => windows.hideWindow(),
    requestQuit: () => app.quit(), reportFailure: reportBackgroundFailure,
  })
  power.subscribe((count) => tray.setActivity(count))
  await windows.showWindow()
  console.log(`DESKTOP_ISOLATED_FIXTURE ${JSON.stringify({ repo: fixture.repoDirectory, launchpadUrl: host.launchpadUrl })}`)
  return { get window() { return windows.window }, host, fixture, blocked: windows.blocked, windows, tray, power }
}) : Promise.resolve(undefined)
desktopReady.catch((error) => {
  console.error(`DESKTOP_STARTUP_FAILURE ${JSON.stringify({ result: 'FAIL', error: describeShutdownError(error) })}`)
  process.exitCode = 1
  app.quit()
})
