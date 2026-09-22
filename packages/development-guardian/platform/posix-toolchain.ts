import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * macOS Desktop launched from Finder/Dock inherits the launchd GUI PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which never contains nvm/Homebrew toolchains:
 * those are only added by shell startup files that a GUI app never sources.
 * Verifiers such as `npm test` then die with exit 127.
 *
 * This resolver builds a bounded, verified child environment for NovaWing's own
 * child processes. It never mutates the global environment and never executes an
 * arbitrary user command: every candidate directory is confirmed by running the
 * tool's own `--version` before it reaches the child PATH.
 */

export interface ToolchainProbeResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export type ToolchainProbe = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => ToolchainProbeResult

export interface ToolchainTools {
  git?: string
  node?: string
  npm?: string
  npx?: string
}

export interface ResolvedToolchain {
  env: NodeJS.ProcessEnv
  path: string
  tools: ToolchainTools
  /** Auditable provenance for each directory contributed to the child PATH. */
  sources: string[]
  /** True only when this resolver actually changed PATH. */
  augmented: boolean
  /** Non-fatal diagnostics; never contains secrets. */
  issues: string[]
}

export interface ToolchainOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  probe?: ToolchainProbe
  /** Advanced fallback: absolute, colon-separated directories. Never shell-expanded. */
  overridePath?: string
  /** Bounded shell discovery budget. */
  probeTimeoutMs?: number
}

const SENTINEL = '__NOVAWING_TOOLCHAIN__'
const MANAGED_TOOLS = ['node', 'npm', 'npx'] as const
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

function defaultProbe(executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): ToolchainProbeResult {
  // shell:false and piped stdio: no TTY, no shell expansion, bounded by timeout.
  const result = spawnSync(executable, [...args], {
    env: options.env, encoding: 'utf8', shell: false, timeout: options.timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? { timedOut: true } : {}),
  }
}

/** A directory is usable only if the executable exists, is a file, and answers --version. */
function verifiedExecutable(directory: string, tool: string, probe: ToolchainProbe, env: NodeJS.ProcessEnv, timeoutMs: number): string | undefined {
  if (!isAbsolute(directory)) return undefined
  const candidate = join(directory, tool)
  try {
    if (!statSync(candidate).isFile()) return undefined
  } catch { return undefined }
  const result = probe(candidate, ['--version'], { env, timeoutMs })
  if (result.status !== 0) return undefined
  return candidate
}

function pathEntries(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).filter((entry) => entry.length > 0)
}

/**
 * Windows spells the variable `Path`. `process.env` resolves either casing, but the child
 * environment this module builds is a plain object snapshot, which does not: reading
 * `env.PATH` there yields nothing on Windows and every managed tool looks missing.
 */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
}

function envPath(env: NodeJS.ProcessEnv): string {
  return Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? ''
}

function which(tool: string, directories: readonly string[], probe: ToolchainProbe, env: NodeJS.ProcessEnv, timeoutMs: number): string | undefined {
  for (const directory of directories) {
    const found = verifiedExecutable(directory, tool, probe, env, timeoutMs)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Bounded login+interactive shell discovery. The output is parsed only for
 * sentinel-prefixed `command -v` results; stderr, banners, aliases and prompts are
 * discarded, and no line is ever evaluated.
 */
function shellDiscoveredDirectories(shell: string, probe: ToolchainProbe, env: NodeJS.ProcessEnv, timeoutMs: number): string[] {
  const script = ['node', 'npm', 'npx', 'git']
    .map((tool) => `printf '%s %s\\n' '${SENTINEL}' "$(command -v ${tool} 2>/dev/null)"`)
    .join('; ')
  const result = probe(shell, ['-lic', script], { env, timeoutMs })
  if (result.status !== 0 && result.stdout.trim().length === 0) return []
  const directories: string[] = []
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = new RegExp(`^${SENTINEL}\\s+(.+)$`, 'u').exec(line.trim())
    if (match === null) continue
    const resolved = match[1]!.trim()
    // `command -v` may return an alias or builtin name; only absolute paths survive.
    if (!isAbsolute(resolved)) continue
    directories.push(resolved.slice(0, resolved.lastIndexOf('/')) || '/')
  }
  return directories
}

/** Static candidate roots, verified before use. Never assumed to exist. */
function candidateRoots(home: string): string[] {
  return [join(home, '.nvm', 'current', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

function validateOverride(override: string, probe: ToolchainProbe, env: NodeJS.ProcessEnv, timeoutMs: number): { directories: string[]; issues: string[] } {
  const issues: string[] = []
  const directories: string[] = []
  for (const entry of override.split(delimiter)) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    // Absolute, no shell expansion, no command substitution.
    if (!isAbsolute(trimmed) || /[$`~*?]/u.test(trimmed) || trimmed.includes('..')) {
      issues.push(`NOVAWING_TOOLCHAIN_PATH entry rejected (must be an absolute directory): ${trimmed.slice(0, 120)}`)
      continue
    }
    // npm/npx are node scripts; they only answer --version when node is already reachable.
    const candidateEnv = { ...env, PATH: [trimmed, ...pathEntries(envPath(env))].join(delimiter) }
    const node = verifiedExecutable(trimmed, 'node', probe, candidateEnv, timeoutMs)
    if (node === undefined) {
      issues.push(`NOVAWING_TOOLCHAIN_PATH entry has no working node: ${trimmed.slice(0, 120)}`)
      continue
    }
    directories.push(trimmed)
  }
  return { directories, issues }
}

/**
 * Resolve the child environment NovaWing should use for its own child processes.
 * The result is unchanged from the input unless a managed tool is genuinely missing.
 */
export function resolveDesktopToolchainEnvironment(options: ToolchainOptions = {}): ResolvedToolchain {
  const platform = options.platform ?? process.platform
  const env = { ...(options.env ?? process.env) }
  const home = options.home ?? env.HOME ?? ''
  const probe = options.probe ?? defaultProbe
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const currentPath = envPath(env)
  const currentDirectories = pathEntries(currentPath)
  const issues: string[] = []

  const tools: ToolchainTools = {}
  const missing: string[] = []
  for (const tool of MANAGED_TOOLS) {
    const found = which(tool, currentDirectories, probe, env, timeoutMs)
    if (found === undefined) missing.push(tool)
    else tools[tool] = found
  }
  const git = which('git', currentDirectories, probe, env, timeoutMs)
  if (git !== undefined) tools.git = git

  const resolved: ResolvedToolchain = { env, path: currentPath, tools, sources: currentDirectories.map((entry) => `path:${entry}`), augmented: false, issues }
  // Only a Desktop GUI launch on macOS needs augmentation; other hosts keep their PATH verbatim.
  if (platform !== 'darwin' || missing.length === 0) return resolved

  const override = options.overridePath ?? env.NOVAWING_TOOLCHAIN_PATH
  let discovered: string[] = []
  if (override !== undefined && override.trim().length > 0) {
    const validated = validateOverride(override, probe, env, timeoutMs)
    issues.push(...validated.issues)
    // Strict: an explicitly configured override is never silently replaced by discovery.
    discovered = validated.directories
    if (discovered.length === 0) {
      issues.push('NOVAWING_TOOLCHAIN_PATH was set but no entry provided a working node.')
      return resolved
    }
  } else {
    const shell = env.SHELL !== undefined && isAbsolute(env.SHELL) && env.SHELL.endsWith('zsh') ? env.SHELL : '/bin/zsh'
    discovered = [...shellDiscoveredDirectories(shell, probe, env, timeoutMs), ...candidateRoots(home)]
  }

  const additions: string[] = []
  for (const directory of discovered) {
    if (currentDirectories.includes(directory) || additions.includes(directory)) continue
    // Probe with the candidate directory already on PATH: npm and npx are node scripts, so
    // their `--version` only succeeds once node is reachable the way a real shell sees it.
    const candidateEnv = { ...env, [pathKey(env)]: [directory, ...currentDirectories].join(delimiter) }
    const supplies = MANAGED_TOOLS.some((tool) => missing.includes(tool) && verifiedExecutable(directory, tool, probe, candidateEnv, timeoutMs) !== undefined)
    if (!supplies) continue
    additions.push(directory)
  }
  if (additions.length === 0) return resolved

  const path = [...additions, ...currentDirectories].join(delimiter)
  const nextEnv = { ...env, [pathKey(env)]: path }
  const nextTools: ToolchainTools = {}
  for (const tool of MANAGED_TOOLS) {
    const found = which(tool, additions, probe, nextEnv, timeoutMs) ?? tools[tool]
    if (found !== undefined) nextTools[tool] = found
  }
  if (git !== undefined) nextTools.git = git
  return {
    env: nextEnv, path, tools: nextTools, augmented: true, issues,
    sources: [...additions.map((entry) => `discovered:${entry}`), ...currentDirectories.map((entry) => `path:${entry}`)],
  }
}

/**
 * The bare program name a shell verification command will look up on PATH, or undefined
 * when the command carries its own path. A path-carrying invocation is resolved by the
 * shell against the verifier cwd, never by the toolchain PATH.
 */
export function verifierExecutable(command: string): string | undefined {
  const first = /^\s*(\S+)/u.exec(command)?.[1]
  if (first === undefined) return undefined
  if (first.includes('/') || first.includes('\\')) return undefined
  return /^[\w.-]*\w[\w.-]*$/u.test(first) ? first : undefined
}

/** Windows resolves bare names through PATHEXT; POSIX does not. */
function executableNames(executable: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || /\.(?:exe|cmd|bat)$/iu.test(executable)) return [executable]
  return [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
}

/** True when the executable resolves in the given environment without spawning it. */
export function executableAvailable(executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const candidates = executableNames(executable, platform)
  if (isAbsolute(executable)) {
    return candidates.some((candidate) => {
      try { return statSync(candidate).isFile() } catch { return false }
    })
  }
  const directories = envPath(env).split(platform === 'win32' ? ';' : delimiter).filter((entry) => entry.length > 0)
  for (const candidate of candidates) {
    for (const directory of directories) {
      try { if (statSync(join(directory, candidate)).isFile()) return true } catch { /* keep scanning */ }
    }
  }
  return false
}

/**
 * The executable a verification command needs but cannot find, or undefined when the
 * command is runnable.
 *
 * Only bare executable names are judged. A command that carries its own path
 * (`./tools/check.sh`, `.venv/bin/python`) is resolved by the shell against the verifier
 * cwd — a repo-local venv may legitimately not exist until bootstrap creates it — so it is
 * never treated as a missing toolchain.
 */
export function missingVerifierExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const executable = verifierExecutable(command)
  if (executable === undefined) return undefined
  return executableAvailable(executable, env, platform) ? undefined : executable
}
