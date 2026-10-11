import { commandEnvironment } from '../platform/environment.js'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { shellProbeContract, shellRemediation, type GuardianShellContractOptions } from '../platform/shell.js'
export { EXPECTED_GIT_BASH_EXECUTABLE } from '../platform/shell.js'
import { inspectCodexLocal } from '../codex-executor.js'
import { classifyCodexError } from '../codex-error.js'
import type { ExecutorMode } from '../coding-executor-config.js'

export const SHELL_ENVIRONMENT_INVALID = 'SHELL_ENVIRONMENT_INVALID'

/**
 * Availability, not activity. A bounded static preflight can establish READY
 * without a paid model request or an active Task. UNKNOWN is reserved for an
 * actual lack of enough information, never normal cold-start idleness.
 */
export type DependencyHealthState = 'READY' | 'UNKNOWN' | 'UNAVAILABLE' | 'DEGRADED'
export type DependencyHealthId = 'CORE' | 'SHELL' | 'BRAIN' | 'BRIDGE' | 'EXECUTOR' | 'GIT' | 'RUNTIME'

export interface DependencyHealth {
  id: DependencyHealthId
  state: DependencyHealthState
  failureType?: string
  safeMessage?: string
  expectedExecutable?: string
  actualExecutable?: string
  safeRemediation?: string
}

export interface DependencyHealthReport {
  overall: 'READY' | 'DEGRADED' | 'ENVIRONMENT_REQUIRED'
  canStart: boolean
  checkedAt: string
  dependencies: readonly DependencyHealth[]
}

export interface DependencyCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface DependencyCommandRequest {
  executable: string
  args: readonly string[]
  cwd?: string
  timeoutMs: number
}

export type DependencyCommandRunner = (request: DependencyCommandRequest) => Promise<DependencyCommandResult>

export interface ProductionDependencyPreflightOptions extends GuardianShellContractOptions {
  /** Retained as input metadata; capability checks use the current executor path. */
  controlPlane?: 'v1' | 'v2'
  env?: NodeJS.ProcessEnv
  targetRepo?: string
  commandRunner?: DependencyCommandRunner
  accessFile?: (path: string) => Promise<void>
  timeoutMs?: number
  now?: () => Date
  /** Omitted preserves the legacy DeepSeek-only preflight contract. */
  executorModes?: readonly ExecutorMode[]
  inspectCodex?: () => Promise<unknown>
  /** Strict hosts retain probe workers until process and stdio closure. */
  shutdownMode?: 'strict' | 'bounded'
  spawnProcess?: typeof spawn
}

async function defaultCommandRunner(
  request: DependencyCommandRequest,
  env: NodeJS.ProcessEnv,
  options: ProductionDependencyPreflightOptions,
): Promise<DependencyCommandResult> {
  return new Promise((resolveRun) => {
    const child = (options.spawnProcess ?? spawn)(request.executable, [...request.args], {
      cwd: request.cwd,
      env: commandEnvironment(env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let failed = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const strict = options.shutdownMode === 'strict'
    const finish = (result: DependencyCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(result)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      failed = true
      stderr = `${stderr}${error.message}`
      if (!strict) finish({ exitCode: 1, stdout, stderr })
    })
    child.once('close', (code) => finish({
      exitCode: failed || timedOut ? 1 : code ?? 1, stdout, stderr,
      ...(timedOut ? { timedOut: true } : {}),
    }))
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch (error) {
        stderr = `${stderr}\n${error instanceof Error ? error.message : String(error)}`
      }
      // A termination request cannot establish that the probe worker is gone.
      if (!strict) finish({ exitCode: 1, stdout, stderr, timedOut: true })
    }, request.timeoutMs)
    timer.unref()
  })
}

async function probeShell(options: ProductionDependencyPreflightOptions & {
  commandRunner: DependencyCommandRunner; accessFile: (path: string) => Promise<void>; timeoutMs: number
}): Promise<DependencyHealth> {
  let actual = ''
  try {
    const contract = shellProbeContract(options)
    actual = contract.executable
    if (contract.requiresAbsoluteAccess) await options.accessFile(actual)
    const result = await options.commandRunner({ executable: actual, args: contract.args, timeoutMs: options.timeoutMs })
    if (result.exitCode !== 0 || result.timedOut || !contract.valid(result.stdout, result.stderr)) throw new Error('probe failed')
    return { id: 'SHELL', state: 'READY', expectedExecutable: actual, actualExecutable: actual }
  } catch {
    return { id: 'SHELL', state: 'UNAVAILABLE', failureType: SHELL_ENVIRONMENT_INVALID,
      actualExecutable: actual, safeMessage: 'Shell executable or fingerprint probe failed.', safeRemediation: shellRemediation(options) }
  }
}

async function probeCommand(
  id: DependencyHealthId,
  failureType: string,
  safeMessage: string,
  request: DependencyCommandRequest,
  commandRunner: DependencyCommandRunner,
): Promise<DependencyHealth> {
  try {
    const result = await commandRunner(request)
    return result.exitCode === 0 && result.timedOut !== true
      ? { id, state: 'READY' }
      : { id, state: 'UNAVAILABLE', failureType, safeMessage }
  } catch {
    return { id, state: 'UNAVAILABLE', failureType, safeMessage }
  }
}

/**
 * One-shot dependency preflight. It never invokes a model and never retries.
 * Probe deadlines stay bounded; strict hosts also wait for worker closure.
 * Every subprocess is addressed by an explicit path.
 */
export async function runProductionDependencyPreflight(
  options: ProductionDependencyPreflightOptions = {},
): Promise<DependencyHealthReport> {
  const env = options.env ?? process.env
  const commandRunner = options.commandRunner ?? ((request) => defaultCommandRunner(request, env, options))
  const accessFile = options.accessFile ?? (async (path: string) => access(path))
  const timeoutMs = options.timeoutMs ?? 3_000
  const shell = await probeShell({ ...options, env, commandRunner, accessFile, timeoutMs })
  const actualExecutable = shell.actualExecutable ?? ''
  const runtime: DependencyHealth = process.execPath.length > 0
    ? { id: 'RUNTIME', state: 'READY' }
    : { id: 'RUNTIME', state: 'UNAVAILABLE', failureType: 'RUNTIME_UNAVAILABLE', safeMessage: 'Node runtime 不可用。' }

  let dependencies: DependencyHealth[]
  if (shell.state !== 'READY') {
    dependencies = [
      { id: 'CORE', state: 'DEGRADED', failureType: SHELL_ENVIRONMENT_INVALID, safeMessage: 'NovaWing Core 等待有效 shell environment。' },
      shell,
      { id: 'EXECUTOR', state: 'UNAVAILABLE', failureType: 'EXECUTOR_UNAVAILABLE', safeMessage: 'Executor preflight 因 shell environment 无效而跳过。' },
      { id: 'GIT', state: 'UNAVAILABLE', failureType: 'GIT_UNAVAILABLE', safeMessage: 'Git preflight 因 shell environment 无效而跳过。' },
      runtime,
    ]
  } else {
    const cwd = options.targetRepo
    const [executor, git] = await Promise.all([
      (async (): Promise<DependencyHealth> => {
        // Launchpad has no active Task at cold start, but its default Codex
        // executor still has a real local SDK/runtime preflight. Do not turn
        // idleness into UNKNOWN.
        const modes = options.executorModes?.length === 0 ? ['codex'] : options.executorModes ?? ['deepseek']
        if (modes.some((mode) => mode !== 'deepseek')) {
          try { await (options.inspectCodex?.() ?? inspectCodexLocal(env, options.targetRepo)) }
          catch (error) {
            const classified = classifyCodexError(error)
            return { id: 'EXECUTOR', state: 'UNAVAILABLE', failureType: classified.kind,
              safeMessage: classified.message,
              safeRemediation: classified.kind === 'auth_required' ? '请在本机 Codex 使用 ChatGPT 登录；不要配置 OPENAI_API_KEY。' : '检查 NovaWing Codex Local 配置；不会自动改用其他 OpenAI 模型或 API。' }
          }
        }
        if (!modes.includes('deepseek')) return { id: 'EXECUTOR', state: 'READY' }
        return probeCommand('EXECUTOR', 'EXECUTOR_UNAVAILABLE', 'DeepSeek runtime 不可用。', {
        executable: actualExecutable,
        args: ['--noprofile', '--norc', '-lc', 'command -v claude >/dev/null && claude --version >/dev/null'],
        timeoutMs,
        }, commandRunner)
      })(),
      probeCommand('GIT', 'GIT_UNAVAILABLE', 'Git 或目标仓库不可用。', {
        executable: actualExecutable,
        args: ['--noprofile', '--norc', '-lc', cwd === undefined ? 'git --version >/dev/null' : 'git rev-parse --is-inside-work-tree >/dev/null'],
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs,
      }, commandRunner),
    ])
    const coreState: DependencyHealthState = [executor, git, runtime]
      .some((item) => item.state === 'UNAVAILABLE' || item.state === 'DEGRADED')
      ? 'DEGRADED'
      : 'READY'
    dependencies = [{ id: 'CORE', state: coreState }, shell, executor, git, runtime]
  }

  const shellInvalid = shell.state !== 'READY'
  const canStart = !shellInvalid && dependencies
    .filter((item) => item.id !== 'CORE')
    .every((item) => item.state !== 'UNAVAILABLE')
  const degraded = dependencies.some((item) => item.state === 'DEGRADED')
  return {
    overall: shellInvalid ? 'ENVIRONMENT_REQUIRED' : canStart && !degraded ? 'READY' : 'DEGRADED',
    canStart,
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    dependencies,
  }
}

export class DependencyPreflightError extends Error {
  constructor(readonly report: DependencyHealthReport) {
    super(report.dependencies.find((item) => item.id !== 'CORE' && (item.state === 'UNAVAILABLE' || item.state === 'DEGRADED'))?.safeMessage ?? 'Dependency preflight failed')
    this.name = 'DependencyPreflightError'
  }
}

export function requireDependencyPreflightReady(report: DependencyHealthReport): void {
  if (!report.canStart) throw new DependencyPreflightError(report)
}
