import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'
export interface AskBridgeProcessTreeCleanupOptions {
  platform?: NodeJS.Platform
  windowsTreeKill?: (pid: number) => Promise<boolean>
}

function runWindowsTreeKill(pid: number): Promise<boolean> {
  return new Promise((resolveRun) => {
    const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows'
    const killer = spawn(win32.join(systemRoot, 'System32', 'taskkill.exe'), [
      '/PID', String(pid), '/T', '/F',
    ], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    let settled = false
    const finish = (success: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(success)
    }
    killer.once('error', () => finish(false))
    killer.once('exit', (code) => finish(code === 0))
    const timer = setTimeout(() => {
      killer.kill()
      finish(false)
    }, 5_000)
    timer.unref()
  })
}

/** Terminate only the process tree rooted at the ask-bridge process spawned for this request. */
export async function terminateAskBridgeProcessTree(
  child: ChildProcess,
  options: AskBridgeProcessTreeCleanupOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32' && child.pid !== undefined) {
    const killed = await (options.windowsTreeKill ?? runWindowsTreeKill)(child.pid)
    if (killed) return
  }
  child.kill()
}
