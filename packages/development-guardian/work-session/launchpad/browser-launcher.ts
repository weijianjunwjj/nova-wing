import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

export type BrowserKind = 'edge' | 'chrome'

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

async function defaultPathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function browserCandidates(env: NodeJS.ProcessEnv): readonly BrowserExecutable[] {
  const programFiles = env.PROGRAMFILES?.trim()
  const programFilesX86 = env['PROGRAMFILES(X86)']?.trim()
  const candidates: BrowserExecutable[] = []
  const add = (kind: BrowserKind, base: string | undefined, relativePath: string): void => {
    if (base === undefined || base.length === 0) return
    const executable = join(base, relativePath)
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
): Promise<BrowserExecutable | undefined> {
  for (const candidate of browserCandidates(env)) {
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

export async function openLaunchpadInAppMode(
  launchpadUrl: string,
  options: {
    env?: NodeJS.ProcessEnv
    pathExists?: BrowserPathExists
    spawnBrowser?: BrowserProcessSpawner
  } = {},
): Promise<{ opened: boolean; browser?: BrowserKind }> {
  assertLoopbackLaunchpadUrl(launchpadUrl)
  const browser = await findBrowserExecutable(
    options.env ?? process.env,
    options.pathExists ?? defaultPathExists,
  )
  if (browser === undefined) return { opened: false }

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
