import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Only OS launch inputs survive; production credentials and Node/Electron overrides do not. */
export function smokeEnvironment(root, source = process.env) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'])
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined && allowed.has(key.toUpperCase())))
  return {
    ...env,
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home', 'roaming'), LOCALAPPDATA: join(root, 'home', 'local'),
    XDG_CONFIG_HOME: join(root, 'home', 'config'), XDG_DATA_HOME: join(root, 'home', 'data'),
    XDG_CACHE_HOME: join(root, 'home', 'cache'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    NOVAWING_DESKTOP_SMOKE_ROOT: root,
    NOVAWING_CONFIG_DIR: join(root, 'config'), NOVAWING_DATA_DIR: join(root, 'data'),
  }
}

export const detachedSmokeProcess = process.platform !== 'win32'

/** @param {import('node:child_process').ChildProcess} child */
export async function terminateOwnedElectron(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // The PID comes only from our live ChildProcess; never use image/name matching.
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot) throw new Error('SystemRoot unavailable for owned process cleanup')
    await new Promise((resolveKill, reject) => {
      const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      const timeout = setTimeout(() => { killer.kill(); killer.unref(); reject(new Error('Owned tree cleanup timed out')) }, 5_000)
      killer.once('error', (error) => { clearTimeout(timeout); reject(error) })
      killer.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolveKill(undefined)
        else reject(new Error(`Owned tree cleanup failed (${code})`))
      })
    })
  } else {
    // spawn(detached: true) gives this child its own process group on POSIX.
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}
