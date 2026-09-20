import { app } from 'electron'
import { requireDesktopIsolation } from './isolation.mjs'

const root = requireDesktopIsolation()
let host
let closePromise
let quitAllowed = false

export function shutdownDesktop() {
  if (!closePromise) closePromise = (async () => { await host?.close() })()
  return closePromise
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitAllowed) return
  event.preventDefault()
  void shutdownDesktop().catch((error) => {
    console.error('Desktop Host close failed:', error)
    process.exitCode = 1
  }).finally(() => { quitAllowed = true; app.quit() })
})

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
  const { window, blocked } = await createDesktopWindow(host)
  console.log(`DESKTOP_ISOLATED_FIXTURE ${JSON.stringify({ repo: fixture.repoDirectory, launchpadUrl: host.launchpadUrl })}`)
  return { window, host, fixture, blocked }
})
desktopReady.catch((error) => {
  console.error('Desktop Launchpad startup failed:', error)
  process.exitCode = 1
  app.quit()
})
