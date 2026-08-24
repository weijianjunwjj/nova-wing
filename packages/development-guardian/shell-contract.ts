import { existsSync } from 'node:fs'

/**
 * Windows Guardian commands must use a native Git for Windows Bash executable.
 * Never resolve `bash` through PATH: on Windows it may be a WSL or System32 shim.
 */
const WINDOWS_NATIVE_GIT_BASH_FALLBACK_ROOT = 'D:\\Git'

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
  if (!/^[a-z]:[\\/].+\.exe$/iu.test(candidate) || isForbiddenWindowsBash(candidate)) {
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
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], WINDOWS_NATIVE_GIT_BASH_FALLBACK_ROOT]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
  const candidate = roots
    .map((root) => root.endsWith('Git') ? `${root}\\bin\\bash.exe` : `${root}\\Git\\bin\\bash.exe`)
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
