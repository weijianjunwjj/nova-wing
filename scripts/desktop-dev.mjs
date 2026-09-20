import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createDesktopIsolation, installedElectronBinary, repositoryRoot } from './desktop-isolation.mjs'
import { detachedSmokeProcess, terminateOwnedElectron } from './platform/desktop-smoke-environment.mjs'

let isolation
try {
  const electron = await installedElectronBinary()
  isolation = await createDesktopIsolation()
  console.log(`Desktop offline fixture repository: ${join(isolation.root, 'repo')}`)
  console.log('Composer: branch desktop-smoke-fixture; allowed path fixture.txt; disable auto commit, auto push and email.')
  const child = spawn(electron, [join(repositoryRoot, 'desktop/main/index.mjs'),
    `--user-data-dir=${join(isolation.root, 'electron-user-data')}`], {
    cwd: join(isolation.root, 'repo'), env: isolation.env, shell: false,
    windowsHide: false, detached: detachedSmokeProcess, stdio: 'inherit',
  })
  const interrupt = () => { void terminateOwnedElectron(child).catch((error) => {
    console.error(error)
    process.exitCode = 1
  }) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolveExit(signal ? 1 : code ?? 1))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (isolation) {
    try { await isolation.cleanup() } catch (error) {
      console.error(`Desktop temporary directory cleanup failed: ${String(error)}`)
      process.exitCode = 1
    }
  }
}
