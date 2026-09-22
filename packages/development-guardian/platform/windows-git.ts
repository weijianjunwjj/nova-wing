import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

export interface GitDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  gitBashPath?: string
  exists?: (path: string) => boolean
  registryRoots?: () => string[]
  probe?: (bash: string, git: string) => boolean
}

function registryRoots(env: NodeJS.ProcessEnv): string[] {
  const system = env.SystemRoot ?? env.SYSTEMROOT
  if (!system) return []
  return ['HKCU', 'HKLM'].flatMap((hive) => {
    const result = spawnSync(win32.join(system, 'System32', 'reg.exe'),
      ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: 3000 })
    const value = /^\s*InstallPath\s+REG_SZ\s+(.+)$/mu.exec(result.stdout ?? '')?.[1]?.trim()
    return result.status === 0 && value ? [value] : []
  })
}

/**
 * Native Git Bash identity. MSYS2, which Git for Windows derives its Bash from, changed the
 * shell's own `OSTYPE` from `msys` to `cygwin`, so both spellings are the native identity.
 * A plain Cygwin shell is still refused: it does not report an MINGW `MSYSTEM`, has no
 * `msys-2.0.dll`, ships no `cmd/git.exe`, and its Git is not a `.windows.` build.
 */
export function isNativeGitBashIdentity(output: string): boolean {
  return /^[^|]+\|MINGW(?:32|64|ARM64)\|(?:msys|cygwin)$/u.test(output)
}

/** Native Git for Windows version banner; a plain Cygwin Git never carries the `.windows.` token. */
export function isGitForWindowsVersion(output: string): boolean {
  return /^git version [\d.]+\.windows\.\d+/u.test(output)
}

function fingerprint(bash: string, git: string): boolean {
  const options = { encoding: 'utf8' as const, windowsHide: true, shell: false, timeout: 3000 }
  const shell = spawnSync(bash, ['--noprofile', '--norc', '-c', 'printf "%s|%s|%s" "$BASH_VERSION" "$MSYSTEM" "$OSTYPE"'], options)
  const version = spawnSync(git, ['--version'], options)
  return shell.status === 0 && isNativeGitBashIdentity(shell.stdout.trim()) &&
    version.status === 0 && isGitForWindowsVersion(version.stdout.trim())
}

const cache = new Map<string, { root: string; bash: string; git: string; source: string }>()

/** Select a Git installation, never an arbitrary PATH bash or a WSL shim. */
export function resolveWindowsGitInstallation(options: GitDiscoveryOptions = {}) {
  const env = options.env ?? process.env
  const explicit = env.NOVAWING_GIT_BASH_PATH?.trim() || options.gitBashPath?.trim()
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const key = JSON.stringify([explicit, pathValue, env.SystemRoot ?? env.SYSTEMROOT, env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA])
  const testSeam = options.exists || options.registryRoots || options.probe
  if (!testSeam && cache.has(key)) return cache.get(key)!
  const exists = options.exists ?? existsSync
  const candidates: { root: string; source: string; bash?: string }[] = []
  if (explicit) {
    if (!win32.isAbsolute(explicit) || !/^[a-z]:[\\/]/iu.test(explicit) ||
        /\\(?:system32|windowsapps)\\/iu.test(explicit.replaceAll('/', '\\')) ||
        !/^(?:bin|usr[\\/]bin)[\\/]bash\.exe$/iu.test(win32.relative(win32.resolve(explicit, '..', '..'), explicit)) &&
        !/[\\/]usr[\\/]bin[\\/]bash\.exe$/iu.test(explicit)) throw new Error('Invalid native Git Bash override')
    const root = /[\\/]usr[\\/]bin[\\/]bash\.exe$/iu.test(explicit)
      ? win32.resolve(explicit, '..', '..', '..') : win32.resolve(explicit, '..', '..')
    candidates.push({ root, source: 'explicit', bash: explicit })
  } else {
    for (const root of (options.registryRoots ?? (() => registryRoots(env)))()) candidates.push({ root, source: 'registry' })
    for (const entry of pathValue.split(';').filter(Boolean)) {
      if (!win32.isAbsolute(entry) || !exists(win32.join(entry, 'git.exe'))) continue
      if (/^(?:cmd|bin)$/iu.test(win32.basename(entry))) candidates.push({ root: win32.dirname(entry), source: 'PATH installation' })
      if (/mingw(?:64|32)[\\/]bin$/iu.test(entry)) candidates.push({ root: win32.resolve(entry, '..', '..'), source: 'PATH installation' })
    }
    for (const root of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files',
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter((value): value is string => Boolean(value))) {
      candidates.push({ root: win32.join(root, 'Git'), source: 'standard installation' })
    }
  }
  for (const candidate of candidates) {
    const bash = candidate.bash ?? win32.join(candidate.root, 'bin', 'bash.exe')
    const git = win32.join(candidate.root, 'cmd', 'git.exe')
    if (![bash, git, win32.join(candidate.root, 'usr', 'bin', 'msys-2.0.dll')].every(exists)) continue
    if (!(options.probe ?? fingerprint)(bash, git)) continue
    const result = { root: candidate.root, bash: testSeam ? bash : realpathSync(bash),
      git: testSeam ? git : realpathSync(git), source: candidate.source }
    if (!testSeam) cache.set(key, result)
    return result
  }
  throw new Error('Native Git for Windows installation unavailable; install Git for Windows or configure its Bash path')
}

export function gitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === 'win32' ? resolveWindowsGitInstallation({ env }).git : 'git'
}

/** One child PATH for Bash, checkpoint, MCP and the SDK; no global environment writes. */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...env }
  const installation = resolveWindowsGitInstallation({ env })
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: `${win32.dirname(installation.git)};${win32.join(installation.root, 'bin')};${env[key] ?? ''}` }
}

export interface NativeGitContract {
  /** The executable the product spawns on this host. */
  readonly git: string
  readonly environment: NodeJS.ProcessEnv
  /** Native Git Bash, present only where the product verifies a shell-level contract. */
  readonly shell?: string
}

/**
 * Host-native Git contract, delegating to the same resolution the runtime uses.
 * Windows verifies through its own installation and native Git Bash; other hosts
 * use the PATH `git` the documented remediation requires.
 */
export function nativeGitContract(env: NodeJS.ProcessEnv = process.env): NativeGitContract {
  if (process.platform !== 'win32') return { git: gitExecutable(env), environment: gitEnvironment(env) }
  const installation = resolveWindowsGitInstallation({ env })
  return { git: installation.git, environment: gitEnvironment(env), shell: installation.bash }
}
