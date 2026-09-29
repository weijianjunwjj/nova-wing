import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { win32 } from 'node:path'

export type BrowserKind = 'edge' | 'chrome' | 'default'

export interface BrowserExecutable {
  kind: BrowserKind
  executable: string
}

export type BrowserPathExists = (path: string) => Promise<boolean>

export interface DetachedBrowserProcess {
  once(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export type BrowserProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: {
    detached: true
    stdio: 'ignore'
    shell: false
    windowsHide: false
  },
) => DetachedBrowserProcess

export interface DefaultBrowserOpenerProcess {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
}

export type DefaultBrowserOpenerSpawner = (
  executable: string,
  args: readonly string[],
  options: { stdio: 'ignore'; shell: false; windowsHide: true },
) => DefaultBrowserOpenerProcess

async function defaultPathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function browserCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly BrowserExecutable[] {
  if (platform === 'darwin') return [
    { kind: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  ]
  if (platform !== 'win32') return [
    { kind: 'chrome', executable: '/usr/bin/google-chrome' },
    { kind: 'chrome', executable: '/usr/bin/chromium' },
  ]
  const programFiles = (env.ProgramFiles ?? env.PROGRAMFILES)?.trim()
  const programFilesX86 = (env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'])?.trim()
  const candidates: BrowserExecutable[] = []
  const add = (kind: BrowserKind, base: string | undefined, relativePath: string): void => {
    if (base === undefined || base.length === 0) return
    const executable = win32.join(base, relativePath)
    if (!candidates.some((candidate) => candidate.executable === executable)) {
      candidates.push({ kind, executable })
    }
  }

  add('edge', programFilesX86, 'Microsoft/Edge/Application/msedge.exe')
  add('edge', programFiles, 'Microsoft/Edge/Application/msedge.exe')
  add('chrome', programFiles, 'Google/Chrome/Application/chrome.exe')
  add('chrome', programFilesX86, 'Google/Chrome/Application/chrome.exe')
  return candidates
}

export async function findBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: BrowserPathExists = defaultPathExists,
  platform: NodeJS.Platform = process.platform,
): Promise<BrowserExecutable | undefined> {
  for (const candidate of browserCandidates(env, platform)) {
    if (await pathExists(candidate.executable)) return candidate
  }
  return undefined
}

function defaultSpawnBrowser(
  executable: string,
  args: readonly string[],
  options: {
    detached: true
    stdio: 'ignore'
    shell: false
    windowsHide: false
  },
): DetachedBrowserProcess {
  return spawn(executable, [...args], options)
}

function defaultSpawnOpener(
  executable: string,
  args: readonly string[],
  options: { stdio: 'ignore'; shell: false; windowsHide: true },
): DefaultBrowserOpenerProcess {
  return spawn(executable, [...args], options)
}

function assertLoopbackLaunchpadUrl(url: string): void {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error('Launchpad URL must be an HTTP 127.0.0.1 URL with a dynamic port')
  }
}

export async function openLaunchpadInDefaultBrowser(
  launchpadUrl: string,
  options: {
    platform?: NodeJS.Platform
    spawnOpener?: DefaultBrowserOpenerSpawner
  } = {},
): Promise<{ opened: boolean; browser?: BrowserKind }> {
  assertLoopbackLaunchpadUrl(launchpadUrl)
  const platform = options.platform ?? process.platform
  const executable = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', launchpadUrl] : [launchpadUrl]

  return new Promise((resolveOpen) => {
    let settled = false
    const finish = (opened: boolean): void => {
      if (settled) return
      settled = true
      resolveOpen(opened ? { opened: true, browser: 'default' } : { opened: false })
    }
    try {
      const child = (options.spawnOpener ?? defaultSpawnOpener)(executable, args, {
        stdio: 'ignore', shell: false, windowsHide: true,
      })
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
    } catch {
      finish(false)
    }
  })
}

export async function openLaunchpadInAppMode(
  launchpadUrl: string,
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    pathExists?: BrowserPathExists
    spawnBrowser?: BrowserProcessSpawner
  } = {},
): Promise<{ opened: boolean; browser?: BrowserKind }> {
  assertLoopbackLaunchpadUrl(launchpadUrl)
  const browser = await findBrowserExecutable(
    options.env ?? process.env,
    options.pathExists ?? defaultPathExists,
    options.platform ?? process.platform,
  )
  if (browser === undefined) {
    const platform = options.platform ?? process.platform
    if (platform === 'win32') return { opened: false }
    return new Promise((resolveOpen) => {
      const child = spawn(platform === 'darwin' ? 'open' : 'xdg-open', [launchpadUrl], { stdio: 'ignore', shell: false })
      child.once('error', () => resolveOpen({ opened: false }))
      child.once('close', (code) => resolveOpen(code === 0 ? { opened: true, browser: 'default' } : { opened: false }))
    })
  }

  const spawnBrowser = options.spawnBrowser ?? defaultSpawnBrowser
  try {
    const child = spawnBrowser(
      browser.executable,
      [`--app=${launchpadUrl}`, '--new-window', '--window-size=1240,820'],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      },
    )
    child.once('error', () => {
      // The HTTP server remains available even if the browser exits or fails later.
    })
    child.unref()
    return { opened: true, browser: browser.kind }
  } catch {
    return { opened: false }
  }
}
