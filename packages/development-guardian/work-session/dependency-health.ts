import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const EXPECTED_GIT_BASH_EXECUTABLE = 'D:\\Git\\bin\\bash.exe'
export const SHELL_ENVIRONMENT_INVALID = 'SHELL_ENVIRONMENT_INVALID'

export type DependencyHealthState = 'READY' | 'UNAVAILABLE' | 'DEGRADED'
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

export interface ProductionDependencyPreflightOptions {
  env?: NodeJS.ProcessEnv
  targetRepo?: string
  commandRunner?: DependencyCommandRunner
  accessFile?: (path: string) => Promise<void>
  timeoutMs?: number
  now?: () => Date
}

const SAFE_SHELL_REMEDIATION =
  '将 Codex/task shell executable 固定为 D:\\Git\\bin\\bash.exe，更新环境后重启当前 runtime，再从现有 checkpoint Resume。'

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').replace(/\\+/gu, '\\').toLowerCase()
}

function shellFailure(actualExecutable: string, safeMessage: string): DependencyHealth {
  return {
    id: 'SHELL',
    state: 'UNAVAILABLE',
    failureType: SHELL_ENVIRONMENT_INVALID,
    safeMessage,
    expectedExecutable: EXPECTED_GIT_BASH_EXECUTABLE,
    actualExecutable,
    safeRemediation: SAFE_SHELL_REMEDIATION,
  }
}

async function defaultCommandRunner(request: DependencyCommandRequest): Promise<DependencyCommandResult> {
  return new Promise((resolveRun) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
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
    child.once('error', (error) => finish({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', (code) => finish({ exitCode: code ?? 1, stdout, stderr }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: 1, stdout, stderr, timedOut: true })
    }, request.timeoutMs)
    timer.unref()
  })
}

async function probeShell(options: Required<Pick<ProductionDependencyPreflightOptions, 'commandRunner' | 'accessFile' | 'timeoutMs'>> & {
  actualExecutable: string
}): Promise<DependencyHealth> {
  const actual = options.actualExecutable
  if (normalizeWindowsPath(actual) !== normalizeWindowsPath(EXPECTED_GIT_BASH_EXECUTABLE)) {
    return shellFailure(actual, '实际 shell executable 不是 NovaWing 要求的 Git Bash。')
  }
  try {
    await options.accessFile(actual)
  } catch {
    return shellFailure(actual, '要求的 Git Bash executable 不存在或不可执行。')
  }
  const result = await options.commandRunner({
    executable: actual,
    args: ['--noprofile', '--norc', '-c', 'printf "%s|%s|%s" "$BASH_VERSION" "$MSYSTEM" "$OSTYPE"'],
    timeoutMs: options.timeoutMs,
  })
  const fingerprint = result.stdout.trim()
  if (
    result.timedOut === true ||
    result.exitCode !== 0 ||
    /wsl|relay|\/bin\/bash/iu.test(`${result.stdout}\n${result.stderr}`) ||
    !/^[^|]+\|MINGW64\|msys$/u.test(fingerprint)
  ) {
    return shellFailure(actual, 'shell fingerprint 不是原生 Git Bash，或命中了 System32/WSL relay。')
  }
  return {
    id: 'SHELL',
    state: 'READY',
    expectedExecutable: EXPECTED_GIT_BASH_EXECUTABLE,
    actualExecutable: actual,
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
 * One-shot, bounded, side-effect-free dependency preflight. It never invokes a
 * model and never retries. Every subprocess is addressed by an explicit path.
 */
export async function runProductionDependencyPreflight(
  options: ProductionDependencyPreflightOptions = {},
): Promise<DependencyHealthReport> {
  const env = options.env ?? process.env
  const commandRunner = options.commandRunner ?? defaultCommandRunner
  const accessFile = options.accessFile ?? (async (path: string) => access(path))
  const timeoutMs = options.timeoutMs ?? 3_000
  // This is the executable NovaWing itself will invoke with shell:false. Parent
  // shell variables such as Git Bash's /usr/bin/bash are POSIX-internal paths
  // and are not Windows process executable identities.
  const actualExecutable = env.NOVAWING_GIT_BASH_PATH?.trim() || EXPECTED_GIT_BASH_EXECUTABLE
  const shell = await probeShell({ actualExecutable, commandRunner, accessFile, timeoutMs })
  const runtime: DependencyHealth = process.execPath.length > 0
    ? { id: 'RUNTIME', state: 'READY' }
    : { id: 'RUNTIME', state: 'UNAVAILABLE', failureType: 'RUNTIME_UNAVAILABLE', safeMessage: 'Node runtime 不可用。' }

  let dependencies: DependencyHealth[]
  if (shell.state !== 'READY') {
    dependencies = [
      { id: 'CORE', state: 'DEGRADED', failureType: SHELL_ENVIRONMENT_INVALID, safeMessage: 'NovaWing Core 等待有效 shell environment。' },
      shell,
      { id: 'BRAIN', state: 'UNAVAILABLE', failureType: 'BRAIN_TRANSPORT_FAILED', safeMessage: 'Brain preflight 因 shell environment 无效而跳过。' },
      { id: 'BRIDGE', state: 'UNAVAILABLE', failureType: 'BRAIN_TRANSPORT_FAILED', safeMessage: 'Bridge preflight 因 shell environment 无效而跳过。' },
      { id: 'EXECUTOR', state: 'UNAVAILABLE', failureType: 'EXECUTOR_UNAVAILABLE', safeMessage: 'Executor preflight 因 shell environment 无效而跳过。' },
      { id: 'GIT', state: 'UNAVAILABLE', failureType: 'GIT_UNAVAILABLE', safeMessage: 'Git preflight 因 shell environment 无效而跳过。' },
      runtime,
    ]
  } else {
    const cwd = options.targetRepo
    const askBridgeExecutable = env.NOVAWING_ASK_BRIDGE_PATH?.trim() || join(homedir(), '.local', 'bin', 'ask-bridge.exe')
    const [bridge, executor, git] = await Promise.all([
      Promise.all([
        probeCommand('BRIDGE', 'BRAIN_TRANSPORT_FAILED', 'AskBridge transport 不可用。', {
          executable: askBridgeExecutable, args: ['--version'], timeoutMs,
        }, commandRunner),
        probeCommand('BRIDGE', 'BRAIN_CONFIGURATION_FAILED', 'AskBridge configuration 不可用。', {
          executable: askBridgeExecutable, args: ['config'], timeoutMs,
        }, commandRunner),
      ]).then(([transport, configuration]) => transport.state === 'READY' ? configuration : transport),
      probeCommand('EXECUTOR', 'EXECUTOR_UNAVAILABLE', 'Executor provider 不可用。', {
        executable: actualExecutable,
        args: ['--noprofile', '--norc', '-lc', 'command -v claude >/dev/null && claude --version >/dev/null'],
        timeoutMs,
      }, commandRunner),
      probeCommand('GIT', 'GIT_UNAVAILABLE', 'Git 或目标仓库不可用。', {
        executable: actualExecutable,
        args: ['--noprofile', '--norc', '-lc', cwd === undefined ? 'git --version >/dev/null' : 'git rev-parse --is-inside-work-tree >/dev/null'],
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs,
      }, commandRunner),
    ])
    const brain: DependencyHealth = bridge.state === 'READY'
      ? { id: 'BRAIN', state: 'READY' }
      : {
          id: 'BRAIN',
          state: 'UNAVAILABLE',
          ...(bridge.failureType === undefined ? {} : { failureType: bridge.failureType }),
          safeMessage: 'Brain transport/configuration 不可用。',
        }
    const coreState: DependencyHealthState = [brain, executor, git, runtime].every((item) => item.state === 'READY')
      ? 'READY'
      : 'DEGRADED'
    dependencies = [{ id: 'CORE', state: coreState }, shell, brain, bridge, executor, git, runtime]
  }

  const shellInvalid = shell.state !== 'READY'
  const canStart = !shellInvalid && dependencies
    .filter((item) => item.id !== 'CORE')
    .every((item) => item.state === 'READY')
  return {
    overall: shellInvalid ? 'ENVIRONMENT_REQUIRED' : canStart ? 'READY' : 'DEGRADED',
    canStart,
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    dependencies,
  }
}

export class DependencyPreflightError extends Error {
  constructor(readonly report: DependencyHealthReport) {
    super(report.dependencies.find((item) => item.state !== 'READY')?.safeMessage ?? 'Dependency preflight failed')
    this.name = 'DependencyPreflightError'
  }
}

export function requireDependencyPreflightReady(report: DependencyHealthReport): void {
  if (!report.canStart) throw new DependencyPreflightError(report)
}
