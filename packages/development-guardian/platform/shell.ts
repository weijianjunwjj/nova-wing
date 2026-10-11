import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { isNativeGitBashIdentity, resolveWindowsGitInstallation } from './windows-git.js'

/**
 * Windows Guardian commands must use a native Git for Windows Bash executable.
 * Never resolve `bash` through PATH: on Windows it may be a WSL or System32 shim.
 */
const WINDOWS_STANDARD_PROGRAM_FILES = 'C:\\Program Files'

export interface WindowsGitBashShellContract {
  platform: 'win32'
  mode: 'git-bash-only'
  executable: string
}

export interface GuardianShellCommand {
  executable: string
  args: string[]
  /** Lets process error handling identify this contract without comparing paths. */
  nativeGitBash?: true
}

export interface GuardianShellContractOptions {
  platform?: NodeJS.Platform
  /** An explicit native Git for Windows Bash path, normally from deployment config. */
  gitBashPath?: string
  env?: NodeJS.ProcessEnv
  pathExists?: (path: string) => boolean
}

export class NativeGitBashUnavailableError extends Error {
  constructor(message = 'Native Git Bash unavailable: set NOVAWING_GIT_BASH_PATH to a native Git for Windows bash.exe') {
    super(message)
    this.name = 'NativeGitBashUnavailableError'
  }
}

function isForbiddenWindowsBash(path: string): boolean {
  const normalized = path.replaceAll('/', '\\').toLowerCase()
  return normalized.includes('\\windows\\system32\\') || normalized.includes('\\windowsapps\\')
}

function validateWindowsGitBashPath(path: string): string {
  const candidate = path.trim()
  if (!/^[a-z]:[\\/]/iu.test(candidate) || win32.basename(candidate).toLowerCase() !== 'bash.exe' || isForbiddenWindowsBash(candidate)) {
    throw new NativeGitBashUnavailableError(
      'Native Git Bash unavailable: configured path must be an absolute Git for Windows bash.exe and cannot be a Windows or WSL shim',
    )
  }
  return candidate
}

/** Resolve a native Git Bash executable without ever considering PATH or `bash`. */
export function resolveWindowsGitBashExecutable(options: GuardianShellContractOptions = {}): string {
  const env = options.env ?? process.env
  const configured = options.gitBashPath ?? env.NOVAWING_GIT_BASH_PATH
  if (configured !== undefined && configured.trim().length > 0) {
    return validateWindowsGitBashPath(configured)
  }

  const pathExists = options.pathExists ?? existsSync
  // Production discovery validates the complete installation and fingerprints.
  // The legacy pathExists seam remains a deterministic path-only unit seam.
  if (!options.pathExists) {
    try { return resolveWindowsGitInstallation({ env }).bash }
    catch { throw new NativeGitBashUnavailableError() }
  }
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs') : undefined]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
  const candidate = roots
    .map((root) => root.endsWith('Git') ? win32.join(root, 'bin', 'bash.exe') : win32.join(root, 'Git', 'bin', 'bash.exe'))
    .find((path) => pathExists(path))

  if (candidate === undefined) {
    throw new NativeGitBashUnavailableError()
  }
  return validateWindowsGitBashPath(candidate)
}

export function windowsGitBashShellContract(options: GuardianShellContractOptions = {}): WindowsGitBashShellContract {
  return {
    platform: 'win32',
    mode: 'git-bash-only',
    executable: resolveWindowsGitBashExecutable(options),
  }
}

/**
 * Build an argv-only Guardian shell invocation. Windows fails closed to native
 * Git Bash; non-Windows retains the previous `bash -lc` compatibility path.
 */
export function guardianShellCommand(
  command: string,
  options: GuardianShellContractOptions = {},
): GuardianShellCommand {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { executable: 'bash', args: ['-lc', command] }
  }
  return {
    executable: resolveWindowsGitBashExecutable(options),
    args: ['-lc', command],
    nativeGitBash: true,
  }
}

/** Compatibility alias for Windows-only callers. */
export function windowsGitBashCommand(command: string, options: GuardianShellContractOptions = {}): GuardianShellCommand {
  return guardianShellCommand(command, { ...options, platform: 'win32' })
}

/** Deprecated compatibility value; never a preflight policy. */
export const EXPECTED_GIT_BASH_EXECUTABLE = win32.join(WINDOWS_STANDARD_PROGRAM_FILES, 'Git', 'bin', 'bash.exe')

export function shellProbeContract(options: GuardianShellContractOptions = {}) {
  const command = guardianShellCommand('', options)
  const native = command.nativeGitBash === true
  return {
    executable: command.executable,
    requiresAbsoluteAccess: native,
    args: ['--noprofile', '--norc', '-c', native
      ? 'printf "%s|%s|%s" "$BASH_VERSION" "$MSYSTEM" "$OSTYPE"'
      : 'printf "%s" "$BASH_VERSION"'],
    // MSYS2, which Git for Windows derives its Bash from, reports `cygwin` for the shell's own
    // OSTYPE. Share the installation resolver's MINGW/UCRT64 identity contract;
    // a WSL relay is still refused, so this never admits a plain Cygwin shell.
    valid: (stdout: string, stderr: string) => native
      ? isNativeGitBashIdentity(stdout.trim()) && !/wsl|relay/iu.test(`${stdout}\n${stderr}`)
      : /^\d+\.\d+(?:\.\d+)?(?:\([^)]*\))?[^|]*$/u.test(stdout.trim()),
  }
}

export function shellRemediation(options: GuardianShellContractOptions = {}): string {
  return (options.platform ?? process.platform) === 'win32'
    ? 'Install native Git for Windows; set NOVAWING_GIT_BASH_PATH to its bash.exe, restart runtime and Resume.'
    : 'Install bash and Git, make both available on PATH, restart runtime and Resume.'
}

export const SHELL_START_FAILURE = 'Native Git Bash unavailable: the configured Git for Windows bash.exe could not be started'
