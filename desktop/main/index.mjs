import { app } from 'electron'
import { requireDesktopIsolation } from './isolation.mjs'
import { createShutdownCoordinator, describeShutdownError } from './shutdown.mjs'

const root = requireDesktopIsolation()
let host
export const desktopShutdown = createShutdownCoordinator({
  getStartup: () => desktopReady,
  getHost: () => host,
  requestFinalQuit: () => app.quit(),
  reportFailure(error) {
    process.exitCode = 1
    console.error(`DESKTOP_SHUTDOWN_FAILURE ${JSON.stringify({ result: 'FAIL', error: describeShutdownError(error) })}`)
  },
})

export function shutdownDesktop() {
  return desktopShutdown.shutdown()
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', desktopShutdown.beforeQuit)

// End ESM evaluation before waiting for ready. Phase 1B only uses isolated fake work.
export const desktopReady = app.whenReady().then(async () => {
  const { createIsolatedLaunchpadFixture } = await import('./isolated-fixture.mjs')
  const { createDesktopHost } = await import('./host.mjs')
  const { createDesktopWindow } = await import('./window.mjs')
  const fixture = await createIsolatedLaunchpadFixture({
    root, env: process.env, holdTasks: process.env.NOVAWING_DESKTOP_HOLD_TASKS === '1',
  })
  host = await createDesktopHost({ configDirectory: fixture.configDirectory, env: process.env, dependencies: fixture.dependencies })
  await host.start()
  // Startup was admitted before quit; let its owner settle without opening a
  // late window. The coordinator waits for this operation and closes the host.
  if (desktopShutdown.requested) return { window: undefined, host, fixture, blocked: [] }
  const { window, blocked } = await createDesktopWindow(host)
  console.log(`DESKTOP_ISOLATED_FIXTURE ${JSON.stringify({ repo: fixture.repoDirectory, launchpadUrl: host.launchpadUrl })}`)
  return { window, host, fixture, blocked }
})
desktopReady.catch((error) => {
  console.error(`DESKTOP_STARTUP_FAILURE ${JSON.stringify({ result: 'FAIL', error: describeShutdownError(error) })}`)
  process.exitCode = 1
  app.quit()
})
