import { relativeTaskWorkspaceScope } from './workspace-scope.js'
import { gitExecutable } from './platform/windows-git.js'
import { commandEnvironment } from './platform/environment.js'
import { missingVerifierExecutable, resolveDesktopToolchainEnvironment } from './platform/posix-toolchain.js'
import { SHELL_START_FAILURE } from './platform/shell.js'
import { pythonRuntime } from './platform/executables.js'
import { sep } from 'node:path'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  DelegationPacket,
  ExecutionReport,
  GuardianTask,
  VerificationExecutionStep,
  VerificationResult,
  PermissionDenialEvidence,
} from './model.js'
import type { GuardianRecoverableExecutor } from './ports.js'
import type { RepositoryCheckpoint, ProviderSessionState } from './work-session/checkpoint.js'
import { LEGACY_PRE_EXISTING_DIRTY_REASON } from './work-session/legacy-recovery.js'
import {
  guardianShellCommand,
  type GuardianShellContractOptions,
} from './shell-contract.js'
import {
  buildVerificationResult,
  persistVerificationOutput,
} from './verification-evidence.js'
import { assessVerificationCommand, deterministicVerificationCapabilities, npmScriptFingerprint } from './verification-command-policy.js'

export interface GuardianCommandRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  /** Internal-only process environment additions. Executor/Claude never supplies this. */
  env?: NodeJS.ProcessEnv
  /** Internal marker for native Git Bash process errors; never inferred from a path string. */
  nativeGitBash?: true
  /** Optional stdin payload keeps large prompts out of the Windows command line. */
  stdinText?: string
}

export interface GuardianCommandResult {
  terminationConfirmed?: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type GuardianCommandRunner = (
  request: GuardianCommandRequest,
) => Promise<GuardianCommandResult>

export type ClaudeCodeTimingPhase =
  | 'clean-start'
  | 'claude-code'
  | 'inspect-changes'
  | 'verification'
  | 'executor-total'

export interface ClaudeCodeTimingEvent {
  phase: ClaudeCodeTimingPhase
  taskId: string
  iteration: number
  durationMs: number
  command?: string
  numTurns?: number
  totalCostUsd?: number
  reportedDurationMs?: number
  apiDurationMs?: number
}

/**
 * Claude 执行模式
 *
 * 区分三种语义完全不同的 invocation：
 * - fresh: 新任务第一次执行（或同 executor revise 沿用既有语义），normal prompt，normal maxTurns
 * - task-continuation: 任务延续（Exact / Recovery Resume），continuation prompt，normal maxTurns
 * - max-turn-recovery: max_turns 内部 bounded recovery，continuation prompt，固定 6 turns
 *
 * 关键：continuation prompt 不是 max_turns 专属。
 * task-continuation 用普通 task budget，不降为 6 turns。
 */
export type ClaudeExecutionMode = 'fresh' | 'task-continuation' | 'max-turn-recovery'

export interface MaxTurnRecoveryDecision {
  eligible: boolean
  reason: string
  alreadyAttempted: boolean
  subtype: string | undefined
  sessionIdPresent: boolean
  scopeBlockers: readonly string[]
  otherBlockers: readonly string[]
}

export interface ClaudeCodeExecutorOptions {
  /** Observable engineering handoff, supplied by the router, never private model context. */
  additionalExecutionContext?: string
  /** Internal provider seam: keep the existing scope/recovery/verifier contract. */
  codingRuntime?: {
    label: string
    run(input: { task: GuardianTask; packet: DelegationPacket }): Promise<{
      summary: string
      commandsRun: readonly string[]
      blockers: readonly string[]
      incompleteReason?: string
      workspaceEvidence?: import('./model.js').WorkspaceExecutionEvidence
    }>
  }
  cwd: string
  maxTurns?: number
  timeoutMs?: number
  model?: string
  allowNpmInstall?: boolean
  allowPythonBootstrap?: boolean
  commandRunner?: GuardianCommandRunner
  /** Deployment override for the Windows native Git Bash executable. */
  gitBashPath?: string
  /** Internal platform seam; production defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Internal child-environment seam; production resolves the Desktop toolchain. */
  environment?: NodeJS.ProcessEnv
  onTiming?: (event: ClaudeCodeTimingEvent) => void
  onVerification?: (result: {
    command: string
    status: 'running' | 'passed' | 'failed'
    /** Internal Guardian iteration of the Executor that ran this verification. */
    iteration: number
    /** Stable position in the verification list for this Executor iteration. */
    index?: number
    durationMs?: number
    /** Present on a completed command; safe, bounded and already redacted. */
    evidence?: VerificationResult
  }) => void
  onRecovery?: (recovery: {
    reason: 'max_turns'
    sessionId: string
    bounded: true
    /** Internal Guardian iteration of the Executor being recovered. */
    iteration: number
  }) => void
  /**
   * Runtime-owned, single-use approval for one exact deterministic verification
   * command. This is never derived from Claude input or browser input.
   */
  approvedVerificationCommand?: string
  /** Session-owned directory outside the target worktree for redacted raw verification logs. */
  verificationOutputDirectory?: string
  /** W003: 允许的 worktree checkpoint（用于 resume 验证） */
  allowedWorktreeCheckpoint?: {
    taskId: string
    branch: string
    headSha: string
    worktreeFingerprint: string
  }
}

/**
 * W003: ClaudeCodeExecutor Provider State
 * 用于持久化和恢复 Claude session 状态
 */
export interface ClaudeCodeExecutorProviderState {
  sessionId?: string
  activeTaskId?: string
}

interface ClaudeCodeJsonResult {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
  permission_denials?: unknown[]
  num_turns?: number
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
}

const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
] as const

/**
 * 敏感字段列表，必须 redact
 */
const SENSITIVE_FIELDS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'credential',
  'auth',
])

/**
 * 安全处理权限证据文本，做敏感信息 redaction
 */
function sanitizePermissionEvidenceText(
  value: unknown,
  maxLength: number,
  redactedFallback: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    return redactedFallback
  }

  const lowerValue = value.toLowerCase()
  const hasSensitive = Array.from(SENSITIVE_FIELDS).some((field) =>
    lowerValue.includes(field),
  )

  if (hasSensitive) {
    return redactedFallback
  }

  return value.slice(0, maxLength)
}

/**
 * 从 Claude permission_denials 中安全提取 evidence
 * 不信任外部数据，只提取明确允许的字段
 */
function extractPermissionDenialEvidence(
  rawDenials: unknown[],
): PermissionDenialEvidence[] {
  const evidence: PermissionDenialEvidence[] = []

  for (const denial of rawDenials.slice(0, 10)) { // 最多处理 10 个
    if (denial === null || typeof denial !== 'object' || Array.isArray(denial)) {
      evidence.push({
        summary: 'permission denial details unavailable',
      })
      continue
    }

    const denialObj = denial as Record<string, unknown>
    const result: PermissionDenialEvidence = {
      summary: 'permission denial',
    }

    // 提取 tool
    if (typeof denialObj.tool === 'string' && denialObj.tool.length > 0) {
      result.tool = denialObj.tool.slice(0, 100)
    }

    // 提取 operation / command，做 redaction
    const operation = denialObj.operation ?? denialObj.command ?? denialObj.description
    result.operation = sanitizePermissionEvidenceText(
      operation,
      300,
      '[operation contains sensitive data]',
    )

    // 提取 reason / message，做 redaction
    const reason = denialObj.reason ?? denialObj.message
    const sanitizedReason = sanitizePermissionEvidenceText(
      reason,
      200,
      'permission denial details redacted',
    )
    if (sanitizedReason !== 'permission denial details redacted') {
      result.summary = sanitizedReason
    }

    evidence.push(result)
  }

  return evidence
}

/**
 * Guardian 可独立执行的 deterministic verification 命令（MVP allowlist）。
 * 这些能力给 Guardian executor，而不是 Claude：Reviewer 看到 permission denial
 * 命中这里时，应把验证命令放进 verification 由 Guardian 执行，而不是 blocked。
 */
function getDeterministicVerificationCapabilities(): string[] {
  return deterministicVerificationCapabilities()
}

/**
 * 获取当前 Executor 允许的 capabilities
 */
function getExecutorCapabilities(options: {
  allowNpmInstall?: boolean
  allowPythonBootstrap?: boolean
}): string[] {
  const capabilities = [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'git status',
    'git diff',
  ]

  if (options.allowNpmInstall === true) {
    capabilities.push('npm install')
  }

  if (options.allowPythonBootstrap === true) {
    capabilities.push('python venv bootstrap')
    capabilities.push('venv pip install')
  }

  return capabilities
}

function defaultCommandRunner(request: GuardianCommandRequest): Promise<GuardianCommandResult> {
  return new Promise((resolve, reject) => {
    const inheritedEnvironment = request.env ?? process.env
    const processEnvironment = request.nativeGitBash === true
      ? {
          ...inheritedEnvironment,
          BASH: request.executable,
          NOVAWING_GIT_BASH_PATH: request.executable,
          SHELL: request.executable,
          npm_config_script_shell: request.executable,
        }
      : inheritedEnvironment
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: processEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`
    })
    child.stdin.on('error', () => {})
    child.stdin.end(request.stdinText)

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill()
      resolve({
        exitCode: null,
        signal: 'SIGTERM',
        terminationConfirmed: false,
        stdout,
        stderr: `${stderr}\ncommand timed out after ${request.timeoutMs}ms`.trim(),
      })
    }, request.timeoutMs)

    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (
        request.nativeGitBash === true &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        reject(new Error(
          SHELL_START_FAILURE,
        ))
        return
      }
      reject(error)
    })

    child.once('exit', (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

function claudeCommand(
  args: readonly string[],
  shellOptions: GuardianShellContractOptions,
): { executable: string; args: string[]; nativeGitBash?: true } {
  const command = guardianShellCommand('exec claude "$@"', shellOptions)
  return {
    executable: command.executable,
    args: [...command.args, '--', ...args],
    ...(command.nativeGitBash === true ? { nativeGitBash: true } : {}),
  }
}

function parseClaudeResult(stdout: string): ClaudeCodeJsonResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new Error('Claude Code returned empty stdout')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch (error) {
    throw new Error(
      `Claude Code returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude Code JSON result must be an object')
  }
  return parsed as ClaudeCodeJsonResult
}

function buildClaudePrompt(task: GuardianTask, packet: DelegationPacket): string {
  const parts = ['你是 NovaWing Development Guardian 的 Executor。', '']
  parts.push(`目标：${packet.goal}`, '')
  if (packet.instructions.length > 0) {
    parts.push('执行指令：', ...packet.instructions.map((instruction) => `- ${instruction}`), '')
  }
  if (packet.constraints.length > 0) {
    parts.push('实现约束：', ...packet.constraints.map((constraint) => `- ${constraint}`), '')
  }
  if (task.allowedPaths !== undefined && task.allowedPaths.length > 0) {
    parts.push('允许修改：', ...task.allowedPaths.map((path) => `- ${path}`), '')
  }
  if (task.forbiddenPaths !== undefined && task.forbiddenPaths.length > 0) {
    parts.push('禁止修改：', ...task.forbiddenPaths.map((path) => `- ${path}`), '')
  }
  if (packet.doNotDo.length > 0) {
    parts.push('明确禁止：', ...packet.doNotDo.map((rule) => `- ${rule}`), '')
  }
  parts.push('完成后只简要报告实际完成内容和 blocker（如有）。')
  return parts.join('\n')
}

function buildContinuationPrompt(task: GuardianTask, packet: DelegationPacket): string {
  const parts = [
    '继续当前任务。保留当前工作区修改，不要从头重新实现，不要重新从头分析。',
    '优先完成尚未完成的实现、必要回归测试和任务要求的 deterministic verification。',
    '',
    `目标：${packet.goal}`,
    '',
  ]
  if (packet.constraints.length > 0) {
    parts.push('实现约束：', ...packet.constraints.map((constraint) => `- ${constraint}`), '')
  }
  if (task.allowedPaths !== undefined && task.allowedPaths.length > 0) {
    parts.push('允许修改：', ...task.allowedPaths.map((path) => `- ${path}`), '')
  }
  if (task.forbiddenPaths !== undefined && task.forbiddenPaths.length > 0) {
    parts.push('禁止修改：', ...task.forbiddenPaths.map((path) => `- ${path}`), '')
  }
  if (packet.doNotDo.length > 0) {
    parts.push('明确禁止：', ...packet.doNotDo.map((rule) => `- ${rule}`), '')
  }
  parts.push('完成后只简要报告实际完成内容和 blocker（如有）。')
  return parts.join('\n')
}

/**
 * 解析 git status --porcelain --untracked-files=all 输出为 changedFiles。
 *
 * 与 worktree fingerprint 对 runtime artifact 的语义保持一致（见 worktree-fingerprint）：
 * - untracked（??）且位于 node_modules/.venv/dist 等产物目录 → 忽略。
 *   构建产物不是任务交付物，不该塞进 execution_report 撑爆 Reviewer prompt；
 * - tracked 修改（即使位于这些产物目录）→ 始终纳入，不得 blanket-ignore。
 */
function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const statusPrefix = line.slice(0, 2)
      const path = line.slice(3).trim()
      const renameTarget = path.includes(' -> ') ? path.split(' -> ').at(-1) : path
      return { statusPrefix, path: renameTarget ?? path }
    })
    .filter(
      (entry) =>
        entry.path.length > 0 &&
        !(entry.statusPrefix === '??' && isIgnoredScopePath(entry.path)),
    )
    .filter((entry, index, all) => all.findIndex((other) => other.path === entry.path) === index)
    .map((entry) => entry.path)
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
}

function matchesPathRule(path: string, rule: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRule = normalizePath(rule)
  if (normalizedRule === '.') return normalizedPath !== '..' && !normalizedPath.startsWith('../') && !normalizedPath.startsWith('/')
  if (normalizedRule.endsWith('/**')) {
    const prefix = normalizedRule.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`)
}

/** 依赖/产物目录：允许能力（venv bootstrap 等）产生的执行产物不算 scope 修改 */
const SCOPE_IGNORED_DIR_SEGMENTS = new Set(['node_modules', '.venv', 'dist'])

function isIgnoredScopePath(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((segment) => SCOPE_IGNORED_DIR_SEGMENTS.has(segment))
}

export function scopeBlockers(task: GuardianTask, changedFiles: readonly string[], workspaceRoot?: string): string[] {
  if (workspaceRoot !== undefined) {
    try { task = relativeTaskWorkspaceScope(workspaceRoot, task) }
    catch { return ['invalid workspace scope configuration'] }
  }
  const blockers: string[] = []
  if (task.allowedPaths !== undefined && task.allowedPaths.length > 0) {
    for (const path of changedFiles) {
      // 能进入 changedFiles 的 artifact path 已是 tracked meaningful change（parseChangedFiles
      // 只过滤 untracked 产物），必须进入 allowed scope 检查，不得按目录名 blanket-ignore。
      if (!task.allowedPaths.some((rule) => matchesPathRule(path, rule))) {
        blockers.push(`changed file is outside allowed scope: ${path}`)
      }
    }
  }
  if (task.forbiddenPaths !== undefined) {
    for (const path of changedFiles) {
      if (task.forbiddenPaths.some((rule) => matchesPathRule(path, rule))) {
        blockers.push(`changed file is inside forbidden scope: ${path}`)
      }
    }
  }
  return blockers
}

function commandFailureDetails(result: GuardianCommandResult): string {
  const details = result.stderr.trim() || result.stdout.trim()
  if (details.length > 0) {
    return details.slice(-4_000)
  }
  return `exit=${String(result.exitCode)} signal=${String(result.signal)}`
}

/**
 * Runs the public `git diff --check` verification with staging-equivalent
 * semantics without ever opening the repository's real index for writing.
 *
 * The temporary index starts at HEAD, receives exactly the meaningful status
 * paths, then uses `diff --cached --check`.  Its directory is private to
 * NovaWing and is removed on every exit path.
 */
export async function runStagedEquivalentDiffCheck(cwd: string, timeoutMs: number): Promise<GuardianCommandResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'novawing-guardian-index-'))
  const indexPath = join(tempDir, 'index')
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  let stdout = ''
  let stderr = ''

  const runGit = (args: readonly string[]): Promise<GuardianCommandResult> => new Promise((resolve) => {
    const child = spawn(gitExecutable(), [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let commandStdout = ''
    let commandStderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { commandStdout += chunk })
    child.stderr.on('data', (chunk: string) => { commandStderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: null, signal: 'SIGTERM', terminationConfirmed: false, stdout: commandStdout, stderr: `${commandStderr}\ncommand timed out after ${timeoutMs}ms`.trim() })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: 1, signal: null, stdout: commandStdout, stderr: `${commandStderr}${error.message}` })
    })
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({ exitCode, signal, stdout: commandStdout, stderr: commandStderr })
    })
  })

  try {
    for (const args of [
      ['read-tree', 'HEAD'],
      ['status', '--porcelain', '--untracked-files=all'],
    ] as const) {
      const result = await runGit(args)
      stdout += result.stdout
      stderr += result.stderr
      if (result.exitCode !== 0) {
        return { ...result, stdout, stderr: `temporary index git ${args[0]} failed: ${stderr}` }
      }
      if (args[0] === 'status') {
        const files = parseChangedFiles(result.stdout)
        if (files.length > 0) {
          const add = await runGit(['add', '--', ...files])
          stdout += add.stdout
          stderr += add.stderr
          if (add.exitCode !== 0) {
            return { ...add, stdout, stderr: `temporary index git add failed: ${stderr}` }
          }
        }
      }
    }
    const check = await runGit(['diff', '--cached', '--check'])
    return { ...check, stdout: `${stdout}${check.stdout}`, stderr: `${stderr}${check.stderr}` }
  } catch (error) {
    return { exitCode: 1, signal: null, stdout, stderr: `temporary index verification failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Resolve the Desktop child toolchain once per process. Discovery shells out to a login
 * shell, so it must never run per command. A Finder-launched macOS app otherwise has no
 * node/npm on PATH and every `npm` verifier dies with exit 127.
 */
let cachedDesktopEnvironment: NodeJS.ProcessEnv | undefined
function desktopChildEnvironment(): NodeJS.ProcessEnv {
  cachedDesktopEnvironment ??= resolveDesktopToolchainEnvironment().env
  return cachedDesktopEnvironment
}

export class ClaudeCodeExecutor implements GuardianRecoverableExecutor {
  private executionOwnershipReleased = true
  hasReleasedExecutionOwnership(): boolean { return this.executionOwnershipReleased }
  private readonly runner: GuardianCommandRunner
  private readonly timeoutMs: number
  private readonly maxTurns: number
  private sessionId: string | undefined
  private allowedCheckpoint: RepositoryCheckpoint | undefined
  private activeTaskId: string | undefined
  private approvedVerificationCommandAvailable: boolean

  constructor(private readonly options: ClaudeCodeExecutorOptions) {
    const runner = options.commandRunner ?? defaultCommandRunner
    this.runner = async (request) => {
      const result = await runner(request)
      if (result.terminationConfirmed === false) this.executionOwnershipReleased = false
      return result
    }
    this.timeoutMs = options.timeoutMs ?? 20 * 60 * 1000
    this.maxTurns = options.maxTurns ?? 12
    this.approvedVerificationCommandAvailable = options.approvedVerificationCommand !== undefined
  }

  /**
   * W003: 捕获当前 provider state 用于持久化
   *
   * 只返回 provider-owned durable state（如 Claude sessionId）。
   * 不返回 executor-instance ephemeral binding（如 activeTaskId）。
   */
  captureProviderState(): ProviderSessionState {
    return {
      ...(this.sessionId !== undefined ? { claudeSessionId: this.sessionId } : {}),
    }
  }

  /**
   * W003: 从持久化 state 恢复
   *
   * 只恢复 provider-owned durable state（如 Claude sessionId）。
   * 不恢复 executor-instance ephemeral binding（如 activeTaskId）。
   *
   * activeTaskId 必须 always start undefined，即使 restore 了 sessionId。
   */
  restoreProviderState(state: ProviderSessionState): void {
    if (state.claudeSessionId !== undefined) {
      this.sessionId = state.claudeSessionId
    }
  }

  /**
   * W003: 设置恢复检查点
   */
  setRecoveryCheckpoint(checkpoint: RepositoryCheckpoint): void {
    this.allowedCheckpoint = checkpoint
  }

  private shellOptions(): GuardianShellContractOptions {
    return {
      ...(this.options.gitBashPath === undefined ? {} : { gitBashPath: this.options.gitBashPath }),
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
    }
  }

  /** The resolved child environment shared by Bash, Git, the verifier and the provider CLI. */
  private ambientEnvironment(): NodeJS.ProcessEnv {
    return commandEnvironment(this.options.environment ?? desktopChildEnvironment(), this.options.platform)
  }

  private commandEnvironment(executable: string, nativeGitBash?: true): NodeJS.ProcessEnv {
    const ambient = this.ambientEnvironment()
    if (nativeGitBash !== true) return ambient
    return {
      ...ambient,
      BASH: executable,
      NOVAWING_GIT_BASH_PATH: executable,
      SHELL: executable,
      npm_config_script_shell: executable,
    }
  }

  private emitTiming(
    task: GuardianTask,
    phase: ClaudeCodeTimingPhase,
    durationMs: number,
    details: Omit<ClaudeCodeTimingEvent, 'phase' | 'taskId' | 'iteration' | 'durationMs'> = {},
  ): void {
    this.options.onTiming?.({
      phase,
      taskId: task.id,
      iteration: task.iteration,
      durationMs,
      ...details,
    })
  }

  private async runBash(command: string, timeoutMs = this.timeoutMs, cwd = this.options.cwd): Promise<GuardianCommandResult> {
    const spec = guardianShellCommand(command, this.shellOptions())
    const env = this.commandEnvironment(spec.executable, spec.nativeGitBash)
    return this.runner({
      executable: spec.executable,
      args: spec.args,
      cwd,
      timeoutMs,
      ...(env === undefined ? {} : { env }),
      ...(spec.nativeGitBash === true ? { nativeGitBash: true } : {}),
    })
  }

  private async prepareNpmVerifierDependencies(cwd: string): Promise<{
    command: string; result: GuardianCommandResult; classification: 'ENVIRONMENT_FAILURE' | 'VERIFIER_CONFIGURATION_FAILURE'
  } | undefined> {
    if (this.options.allowNpmInstall !== true) return undefined
    const manifestPath = join(cwd, 'package.json')
    let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest }
    catch { return undefined }
    if (Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.devDependencies ?? {}).length === 0 ||
      await access(join(cwd, 'node_modules')).then(() => true, () => false)) return undefined
    const ignored = await this.runBash('git check-ignore -q node_modules/', 10_000, cwd)
    if (ignored.exitCode !== 0) return { command: 'npm install', classification: 'VERIFIER_CONFIGURATION_FAILURE', result: {
      exitCode: 1, signal: null, stdout: '', stderr: 'node_modules is not ignored by this Git repository; dependency setup would change the verification workspace.',
    } }
    // The toolchain is prepared outside assertion evidence and cannot rewrite
    // the manifest or lockfile. Root and unrelated dependency hooks stay disabled.
    const command = await access(join(cwd, 'package-lock.json')).then(() => true, () => false)
      ? 'npm ci --ignore-scripts --no-audit --no-fund'
      : 'npm install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund'
    const installed = await this.runBash(command, this.timeoutMs, cwd)
    if (installed.exitCode !== 0 ||
      (manifest.dependencies?.['better-sqlite3'] === undefined && manifest.devDependencies?.['better-sqlite3'] === undefined))
      return { command, classification: 'ENVIRONMENT_FAILURE', result: installed }
    // better-sqlite3 needs its own native binding. Rebuild only this known package;
    // do not enable arbitrary project postinstall scripts or rebuild all packages.
    const rebuild = 'npm rebuild better-sqlite3 --no-audit --no-fund'
    return { command: `${command} && ${rebuild}`, classification: 'ENVIRONMENT_FAILURE',
      result: await this.runBash(rebuild, this.timeoutMs, cwd) }
  }

  private async readChangedFiles(): Promise<{
    changedFiles: string[]
    blocker?: string
  }> {
    const status = await this.runBash('git status --porcelain --untracked-files=all', 30_000)
    if (status.exitCode !== 0) {
      return {
        changedFiles: [],
        blocker: `cannot inspect changed files: ${commandFailureDetails(status)}`,
      }
    }
    return { changedFiles: parseChangedFiles(status.stdout) }
  }

  private async ensureCleanStart(task: GuardianTask): Promise<{
    blocker?: string
    /** true 表示本次 execute 是 task continuation（checkpoint 验证通过后授权） */
    continuation: boolean
  }> {
    // A 场景：same executor / same task / revise
    // activeTaskId 内存绑定授权 dirty worktree，但不构成 resume（保持既有 revise 语义）。
    // 必须在跑 git status 之前短路：原逻辑不消费额外命令队列，
    // 否则同 executor revise 会多一次 git status，破坏命令序列。
    if (this.activeTaskId === task.id) {
      return { continuation: false }
    }

    // 一个 executor 实例只允许绑定一个任务
    if (this.activeTaskId !== undefined && this.activeTaskId !== task.id) {
      return {
        blocker: `executor is already bound to another task: ${this.activeTaskId}`,
        continuation: false,
      }
    }

    const status = await this.runBash('git status --porcelain', 30_000)
    if (status.exitCode !== 0) {
      return {
        blocker: `cannot inspect git status: ${commandFailureDetails(status)}`,
        continuation: false,
      }
    }

    const hasDirtyFiles = status.stdout.trim().length > 0

    // W003: 有 allowedWorktreeCheckpoint 时验证是否匹配
    // checkpoint 验证通过 → NEW executor 的 task continuation（Exact / Recovery Resume）
    // RepositoryCheckpoint 才是恢复授权依据；sessionId 不授权 dirty worktree 放行
    const checkpoint = this.allowedCheckpoint ?? this.options.allowedWorktreeCheckpoint
    if (hasDirtyFiles && checkpoint !== undefined) {
      // this.allowedCheckpoint 是 RepositoryCheckpoint (没有 taskId)
      // this.options.allowedWorktreeCheckpoint 有 taskId
      const checkpointTaskId = 'taskId' in checkpoint ? checkpoint.taskId : undefined

      // 验证 taskId 匹配（仅当 checkpoint 有 taskId 时）
      if (checkpointTaskId !== undefined && checkpointTaskId !== task.id) {
        return {
          blocker: `dirty worktree belongs to different task: expected ${checkpointTaskId}, got ${task.id}`,
          continuation: false,
        }
      }

      // 验证 branch
      const branchResult = await this.runBash('git branch --show-current', 30_000)
      if (branchResult.exitCode !== 0) {
        return {
          blocker: `cannot read current branch: ${commandFailureDetails(branchResult)}`,
          continuation: false,
        }
      }
      const currentBranch = branchResult.stdout.trim()
      if (currentBranch !== checkpoint.branch) {
        return {
          blocker: `REPO_DRIFT: branch changed from ${checkpoint.branch} to ${currentBranch}`,
          continuation: false,
        }
      }

      // 验证 HEAD
      const headResult = await this.runBash('git rev-parse HEAD', 30_000)
      if (headResult.exitCode !== 0) {
        return {
          blocker: `cannot read HEAD: ${commandFailureDetails(headResult)}`,
          continuation: false,
        }
      }
      const currentHead = headResult.stdout.trim()
      if (currentHead !== checkpoint.headSha) {
        return {
          blocker: `REPO_DRIFT: HEAD changed from ${checkpoint.headSha.slice(0, 8)} to ${currentHead.slice(0, 8)}`,
          continuation: false,
        }
      }

      // 验证 worktree fingerprint
      const fullStatus = await this.runBash('git status --porcelain --untracked-files=all', 30_000)
      if (fullStatus.exitCode !== 0) {
        return {
          blocker: `cannot read full git status: ${commandFailureDetails(fullStatus)}`,
          continuation: false,
        }
      }

      // 动态导入 worktree-fingerprint（避免循环依赖）
      const { parseGitStatus, computeWorktreeFingerprint } = await import('./work-session/worktree-fingerprint.js')
      const entries = parseGitStatus(fullStatus.stdout)
      const currentFingerprint = await computeWorktreeFingerprint(this.options.cwd, entries)

      if (currentFingerprint !== checkpoint.worktreeFingerprint) {
        return {
          blocker: `REPO_DRIFT: worktree files changed since checkpoint`,
          continuation: false,
        }
      }

      // checkpoint 验证通过，允许 dirty worktree，本次 execute 是 task continuation
      return { continuation: true }
    }

    // 没有 checkpoint，要求 clean worktree（W002 之前的行为）
    if (hasDirtyFiles) {
      return {
        blocker: LEGACY_PRE_EXISTING_DIRTY_REASON,
        continuation: false,
      }
    }

    return { continuation: false }
  }

  private buildClaudeArgs(
    task: GuardianTask,
    packet: DelegationPacket,
    mode: ClaudeExecutionMode,
  ): string[] {
    const useContinuationPrompt = mode !== 'fresh'
    const maxTurns = mode === 'max-turn-recovery' ? 6 : this.maxTurns
    const args = [
      '-p',
      [useContinuationPrompt ? buildContinuationPrompt(task, packet) : buildClaudePrompt(task, packet),
        this.options.additionalExecutionContext ?? ''].filter(Boolean).join('\n\n'),
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      String(maxTurns),
    ]

    if (this.options.model !== undefined) {
      args.push('--model', this.options.model)
    }

    // --resume 策略：
    // - max-turn-recovery: sessionId 存在时必须 --resume（recovery 前置条件已保证 sessionIdPresent）
    // - task-continuation: 有 restored sessionId 时 --resume（Exact Resume），无 sessionId 时不 --resume（Recovery Resume）
    // - fresh: 同 executor revise 时已有 sessionId 则继续该 session（W002 既有行为）
    // 三种模式下 --resume 只取决于 sessionId 是否存在，不依赖 mode。
    // 只有 setRecoveryCheckpoint 验证通过的 checkpoint 才能授权 dirty worktree，
    // sessionId 本身不授权任何 dirty worktree 放行（见 ensureCleanStart）。
    if (this.sessionId !== undefined) {
      args.push('--resume', this.sessionId)
    }

    const allowedTools: string[] = [...DEFAULT_ALLOWED_TOOLS]
    if (this.options.allowNpmInstall === true) {
      allowedTools.push('Bash(npm install:*)')
    }
    if (this.options.allowPythonBootstrap === true) {
      allowedTools.push(`Bash(${pythonRuntime(this.options.platform).bootstrap})`)
      allowedTools.push(`Bash(${pythonRuntime(this.options.platform).venv} -m pip install:*)`)
    }
    args.push('--allowedTools', ...allowedTools)
    return args
  }

  private async verify(
    task: GuardianTask,
    commands: readonly string[],
    includeBaseline = true,
    scopedSteps?: readonly VerificationExecutionStep[],
  ): Promise<{
    results: VerificationResult[]
    blockers: string[]
    commandsRun: string[]
  }> {
    const scoped = scopedSteps !== undefined
    const effectiveSteps: VerificationExecutionStep[] = scopedSteps === undefined
      ? [...new Set([...(includeBaseline ? ['git diff --check'] : []), ...commands.map((command) => command.trim())])]
        .filter(Boolean).map((command, index) => ({ stepId: `legacy-${index + 1}`, command, cwd: '.' }))
      : [
          ...(includeBaseline && !scopedSteps.some((step) => step.command === 'git diff --check' && step.cwd === '.')
            ? [{ stepId: 'baseline-diff-check', command: 'git diff --check', cwd: '.' }]
            : []),
          ...scopedSteps,
        ]
    const results: VerificationResult[] = []
    const blockers: string[] = []
    const commandsRun: string[] = []

    const repositoryRoot = await realpath(this.options.cwd)
    for (const [index, step] of effectiveSteps.entries()) {
      const command = step.command.trim()
      if (command.length === 0) {
        continue
      }
      let actualCwd: string | undefined
      let cwdFailure: string | undefined
      if (isAbsolute(step.cwd)) cwdFailure = 'verification cwd must be repository-relative'
      else {
        try {
          actualCwd = await realpath(resolve(repositoryRoot, step.cwd))
          const escaped = relative(repositoryRoot, actualCwd)
          if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
            cwdFailure = 'verification cwd escapes the repository workspace'
          }
        } catch {
          cwdFailure = 'verification cwd does not exist or cannot be resolved'
        }
      }
      if (cwdFailure !== undefined || actualCwd === undefined) {
        const reason = `${cwdFailure ?? 'verification cwd is invalid'}: ${step.cwd}`
        results.push({ name: command, ...(scoped ? { stepId: step.stepId, command, cwd: step.cwd, admission: 'UNSUPPORTED' as const } : {}),
          status: 'skipped', details: reason, classification: 'VERIFIER_CONFIGURATION_FAILURE' })
        blockers.push(`verification step ${step.stepId} was not started: ${reason}`)
        continue
      }

      if (step.sourceManifest !== undefined || step.sourceScript !== undefined || step.sourceFingerprint !== undefined) {
        let sourceValid = step.sourceManifest !== undefined && step.sourceScript !== undefined && step.sourceFingerprint !== undefined
        if (sourceValid) {
          try {
            if (isAbsolute(step.sourceManifest!)) sourceValid = false
            else {
              const manifestPath = await realpath(resolve(repositoryRoot, step.sourceManifest!))
              const escaped = relative(repositoryRoot, manifestPath)
              if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) sourceValid = false
              else {
                const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { scripts?: unknown }
                const scripts = parsed.scripts !== null && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
                  ? Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
                  : {}
                sourceValid = npmScriptFingerprint(scripts, step.sourceScript!) === step.sourceFingerprint
              }
            }
          } catch { sourceValid = false }
        }
        if (!sourceValid) {
          const reason = `verification plan source changed or is invalid: ${step.sourceManifest ?? 'missing manifest'}`
          results.push({ name: command, ...(scoped ? { stepId: step.stepId, command, cwd: step.cwd, admission: 'UNSUPPORTED' as const } : {}),
            status: 'skipped', details: reason, classification: 'VERIFIER_CONFIGURATION_FAILURE' })
          blockers.push(`verification step ${step.stepId} was not started: ${reason}`)
          continue
        }
      }

      const admission = assessVerificationCommand(command)
      const runtimeApproved = this.approvedVerificationCommandAvailable &&
        this.options.approvedVerificationCommand === command
      if (admission.status !== 'ALLOWED' && !runtimeApproved) {
        results.push({
          name: command,
          ...(scoped ? { stepId: step.stepId, command, cwd: step.cwd, admission: admission.status } : {}),
          status: 'skipped',
          details: admission.reason,
          classification: admission.status === 'UNSUPPORTED' ? 'VERIFIER_CONFIGURATION_FAILURE' : 'PERMISSION_REQUIRED',
        })
        blockers.push(admission.status === 'UNSUPPORTED'
          ? `verification step ${step.stepId} is unsupported and was not started: ${command}`
          : `verification command requires human approval: ${command}`)
        continue
      }

      if (runtimeApproved) {
        // Consume before spawning the verifier. Provider retries/revise loops
        // cannot turn one durable approval into repeated command execution.
        this.approvedVerificationCommandAvailable = false
      }
      // Never spawn a verifier whose own executable cannot resolve: a bare exit 127 from
      // the shell surfaces as UNKNOWN and hides a missing toolchain behind a generic error.
      // An injected command runner is the unit-test seam, where the host environment is
      // deliberately irrelevant.
      const missingTool = this.options.commandRunner === undefined
        ? missingVerifierExecutable(command, this.ambientEnvironment(), this.options.platform)
        : undefined
      if (missingTool !== undefined) {
        const reason = `Required verifier tool is unavailable: ${missingTool} (verifier ${step.stepId}, command: ${command})`
        results.push({ name: command, ...(scoped ? { stepId: step.stepId, command, cwd: step.cwd, admission: admission.status } : {}),
          status: 'skipped', details: reason, classification: 'ENVIRONMENT_FAILURE' })
        blockers.push(`verification step ${step.stepId} was not started: ${reason}`)
        continue
      }
      if (/^npm(?:\s+run)?\s+(?:test|typecheck|build|lint|check)(?:\s|$)/u.test(command)) {
        const setup = await this.prepareNpmVerifierDependencies(actualCwd)
        if (setup !== undefined) {
          commandsRun.push(setup.command)
          if (setup.result.terminationConfirmed === false) this.executionOwnershipReleased = false
          if (setup.result.exitCode !== 0) {
            const rawOutputRef = await persistVerificationOutput({
              ...(this.options.verificationOutputDirectory === undefined
                ? {} : { directory: this.options.verificationOutputDirectory }),
              taskId: task.id, iteration: task.iteration, index, command: setup.command, result: setup.result,
            })
            const reason = `Required npm verifier dependencies could not be prepared: ${setup.result.stderr || setup.result.stdout || setup.command}`
            results.push({ name: command, ...(scoped ? { stepId: step.stepId, command, cwd: step.cwd, admission: admission.status } : {}),
              status: 'skipped', details: reason, classification: setup.classification,
              ...(rawOutputRef === undefined ? {} : { rawOutputRef }) })
            blockers.push(`verification step ${step.stepId} was not started: ${reason}`)
            continue
          }
        }
      }
      commandsRun.push(command)
      this.options.onVerification?.({ command, status: 'running', iteration: task.iteration, index })
      const startedAt = performance.now()
      // Preserve the Reviewer-visible command name while upgrading its actual
      // behavior.  Injected command runners retain the established unit-test
      // seam; production always uses the isolated index implementation.
      const result = command === 'git diff --check' && this.options.commandRunner === undefined
        ? await runStagedEquivalentDiffCheck(this.options.cwd, this.timeoutMs)
        : await this.runBash(command, this.timeoutMs, command === 'git diff --check' ? repositoryRoot : actualCwd)
      const durationMs = performance.now() - startedAt
      if (result.terminationConfirmed === false) this.executionOwnershipReleased = false
      this.emitTiming(task, 'verification', durationMs, { command })
      const status = result.exitCode === 0 ? 'passed' : 'failed'
      const rawOutputRef = status === 'failed'
        ? await persistVerificationOutput({
            ...(this.options.verificationOutputDirectory === undefined
              ? {}
              : { directory: this.options.verificationOutputDirectory }),
            taskId: task.id,
            iteration: task.iteration,
            index,
            command,
            result,
          })
        : undefined
      const evidence = buildVerificationResult({
        command,
        result,
        durationMs,
        ...(rawOutputRef === undefined ? {} : { rawOutputRef }),
      })
      this.options.onVerification?.({
        command,
        status,
        iteration: task.iteration,
        index,
        durationMs,
        evidence,
      })
      results.push({ ...evidence, ...(scoped
        ? { stepId: step.stepId, command, cwd: step.cwd, admission: runtimeApproved ? 'ALLOWED' as const : admission.status }
        : {}) })
    }

    return { results, blockers, commandsRun }
  }

  /**
   * Recovery boundary for ENVIRONMENT_REQUIRED. This deliberately bypasses
   * clean-start inspection and Claude invocation: only failed deterministic
   * verification commands are executed again.
   */
  async retryVerification(input: {
    task: GuardianTask
    report: ExecutionReport
    verificationSteps?: readonly VerificationExecutionStep[]
  }): Promise<ExecutionReport> {
    const failedCommands = input.report.verificationResults
      .filter((result) => result.status === 'failed')
      .map((result) => result.name)
    if (failedCommands.length === 0 && input.verificationSteps === undefined) return input.report

    const retry = await this.verify(input.task, failedCommands, false, input.verificationSteps)
    if (input.verificationSteps !== undefined) {
      const latestRawOutputRef = retry.results.find((result) => result.rawOutputRef !== undefined)?.rawOutputRef
      return { ...input.report, commandsRun: [...input.report.commandsRun, ...retry.commandsRun], verificationResults: retry.results,
        blockers: [...input.report.blockers, ...retry.blockers], ...(latestRawOutputRef === undefined ? {} : { rawOutputRef: latestRawOutputRef }) }
    }
    const retriedByName = new Map(retry.results.map((result) => [result.name, result]))
    const verificationResults = input.report.verificationResults.map(
      (result) => retriedByName.get(result.name) ?? result,
    )
    const latestRawOutputRef = retry.results.find((result) => result.rawOutputRef !== undefined)?.rawOutputRef
    return {
      ...input.report,
      commandsRun: [...input.report.commandsRun, ...retry.commandsRun],
      verificationResults,
      blockers: [...input.report.blockers, ...retry.blockers],
      ...(latestRawOutputRef === undefined
        ? {}
        : { rawOutputRef: latestRawOutputRef }),
    }
  }

  private reportSummary(parsed: ClaudeCodeJsonResult): string {
    return typeof parsed.result === 'string' && parsed.result.trim().length > 0
      ? parsed.result.trim()
      : 'Claude Code 执行结束。'
  }

  private evaluateMaxTurnRecovery(
    parsed: ClaudeCodeJsonResult,
    scopeBlockers: readonly string[],
    otherBlockers: readonly string[],
    permissionDenials: readonly PermissionDenialEvidence[],
    maxTurnRecoveryAttempted: boolean,
  ): MaxTurnRecoveryDecision {
    const sessionIdPresent = typeof parsed.session_id === 'string' && parsed.session_id.length > 0
    const hasPermissionDenials = permissionDenials.length > 0

    if (maxTurnRecoveryAttempted) {
      return {
        eligible: false,
        reason: 'recovery already attempted',
        alreadyAttempted: true,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    if (parsed.subtype !== 'error_max_turns') {
      return {
        eligible: false,
        reason: `subtype is not error_max_turns (actual: ${parsed.subtype ?? 'undefined'})`,
        alreadyAttempted: false,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    if (!sessionIdPresent) {
      return {
        eligible: false,
        reason: 'session_id missing or empty',
        alreadyAttempted: false,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    // W002: max_turns + permission denial 禁止 internal recovery
    // 需要 Reviewer 判断是否可用已有能力替代
    if (hasPermissionDenials) {
      return {
        eligible: false,
        reason: 'permission denials present, requires Reviewer judgement',
        alreadyAttempted: false,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    if (scopeBlockers.length > 0) {
      return {
        eligible: false,
        reason: `scope blockers present: ${scopeBlockers[0]}`,
        alreadyAttempted: false,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    if (otherBlockers.length > 0) {
      return {
        eligible: false,
        reason: `other blockers present: ${otherBlockers[0]}`,
        alreadyAttempted: false,
        subtype: parsed.subtype,
        sessionIdPresent,
        scopeBlockers,
        otherBlockers,
      }
    }

    return {
      eligible: true,
      reason: 'recoverable_max_turns',
      alreadyAttempted: false,
      subtype: parsed.subtype,
      sessionIdPresent,
      scopeBlockers,
      otherBlockers,
    }
  }

  private async executeClaudeOnce(
    task: GuardianTask,
    packet: DelegationPacket,
    mode: ClaudeExecutionMode,
  ): Promise<{
    claude: GuardianCommandResult
    parsed: ClaudeCodeJsonResult
    changedFiles: string[]
    scopeBlockers: string[]
    otherBlockers: string[]
    permissionDenials: PermissionDenialEvidence[]
    claudeDurationMs: number
  }> {
    const argsWithPrompt = this.buildClaudeArgs(task, packet, mode)
    const prompt = argsWithPrompt[1]
    const stdinText = typeof prompt === 'string' &&
      (this.options.additionalExecutionContext !== undefined || prompt.length > 8_000)
      ? prompt
      : undefined
    const args = stdinText === undefined
      ? argsWithPrompt
      : [argsWithPrompt[0]!, ...argsWithPrompt.slice(2)]
    const spec = claudeCommand(args, this.shellOptions())
    const env = this.commandEnvironment(spec.executable, spec.nativeGitBash)
    const claudeStartedAt = performance.now()
    const claude = await this.runner({
      executable: spec.executable,
      args: spec.args,
      cwd: this.options.cwd,
      timeoutMs: this.timeoutMs,
      ...(env === undefined ? {} : { env }),
      ...(spec.nativeGitBash === true ? { nativeGitBash: true } : {}),
      ...(stdinText === undefined ? {} : { stdinText }),
    })
    const claudeDurationMs = performance.now() - claudeStartedAt

    const changedStartedAt = performance.now()
    const changed = await this.readChangedFiles()
    this.emitTiming(task, 'inspect-changes', performance.now() - changedStartedAt, {
      command: 'git status --porcelain --untracked-files=all',
    })
    const taskScopeBlockers = [
      ...(changed.blocker === undefined ? [] : [changed.blocker]),
      ...scopeBlockers(task, changed.changedFiles),
    ]
    const otherBlockers: string[] = []
    const permissionDenials: PermissionDenialEvidence[] = []

    // 尝试解析 JSON，即使 exitCode != 0 也要尝试提取 subtype 和 session_id 用于诊断
    let parsed: ClaudeCodeJsonResult
    let parseError: Error | undefined
    try {
      parsed = parseClaudeResult(claude.stdout)
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error))
      parsed = { subtype: 'parse_failure' }
    }

    // 如果 exitCode != 0，记录失败原因但继续尝试诊断
    if (claude.exitCode !== 0) {
      this.emitTiming(task, 'claude-code', claudeDurationMs)
      const isTimeout = claude.exitCode === null && claude.signal === 'SIGTERM'

      // 特殊处理：Claude 使用 exitCode=1 表达 error_max_turns，但这是合法的 terminal result
      // 如果成功解析出 error_max_turns，不将其视为普通 transport failure
      const isMaxTurnsResult =
        parsed.subtype === 'error_max_turns' && parseError === undefined

      if (isMaxTurnsResult) {
        // 这是 max_turns terminal result（无论 session_id 是否存在）
        // 保留真实的 parsed，让 evaluateMaxTurnRecovery 和后续诊断判断
        // 注：exitCode=1 本身不是阻止恢复的理由，real blocker 是缺少 session_id / permission_denials 等
      } else {
        // 普通失败：timeout / parse failure / 其他 error subtype
        if (isTimeout) {
          otherBlockers.push(`Claude Code execution timed out after ${this.timeoutMs}ms`)
        } else {
          otherBlockers.push(`Claude Code failed: ${commandFailureDetails(claude)}`)
        }

        return {
          claude,
          parsed: { subtype: 'executor_failure' },
          changedFiles: changed.changedFiles,
          scopeBlockers: taskScopeBlockers,
          otherBlockers,
          permissionDenials,
          claudeDurationMs,
        }
      }
    }

    // exitCode === 0，但解析失败
    if (parseError !== undefined) {
      this.emitTiming(task, 'claude-code', claudeDurationMs)
      otherBlockers.push(parseError.message)
      return {
        claude,
        parsed: { subtype: 'parse_failure' },
        changedFiles: changed.changedFiles,
        scopeBlockers: taskScopeBlockers,
        otherBlockers,
        permissionDenials,
        claudeDurationMs,
      }
    }

    this.emitTiming(task, 'claude-code', claudeDurationMs, {
      ...(typeof parsed.num_turns === 'number' ? { numTurns: parsed.num_turns } : {}),
      ...(typeof parsed.total_cost_usd === 'number' ? { totalCostUsd: parsed.total_cost_usd } : {}),
      ...(typeof parsed.duration_ms === 'number' ? { reportedDurationMs: parsed.duration_ms } : {}),
      ...(typeof parsed.duration_api_ms === 'number' ? { apiDurationMs: parsed.duration_api_ms } : {}),
    })

    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      this.sessionId = parsed.session_id
    }

    // 提取 permission denial evidence，但不直接加入 blockers
    if (Array.isArray(parsed.permission_denials) && parsed.permission_denials.length > 0) {
      permissionDenials.push(...extractPermissionDenialEvidence(parsed.permission_denials))
    }

    if (parsed.is_error === true || (parsed.subtype !== undefined && parsed.subtype !== 'success')) {
      if (parsed.subtype !== 'error_max_turns') {
        otherBlockers.push(`Claude Code result is not successful: ${parsed.subtype ?? 'unknown'}`)
      }
    }

    return {
      claude,
      parsed,
      changedFiles: changed.changedFiles,
      scopeBlockers: taskScopeBlockers,
      otherBlockers,
      permissionDenials,
      claudeDurationMs,
    }
  }

  async execute(input: {
    task: GuardianTask
    packet: DelegationPacket
  }): Promise<ExecutionReport> {
    const totalStartedAt = performance.now()
    let maxTurnRecoveryAttempted = false
    try {
      const cleanStartedAt = performance.now()
      const startCheck = await this.ensureCleanStart(input.task)
      this.emitTiming(input.task, 'clean-start', performance.now() - cleanStartedAt, {
        command: 'git status --porcelain',
      })
      if (startCheck.blocker !== undefined) {
        return {
          summary: `${this.options.codingRuntime?.label ?? 'Claude Code'} 未启动。`,
          changedFiles: [],
          commandsRun: ['git status --porcelain'],
          verificationResults: [],
          blockers: [startCheck.blocker],
        }
      }

      // 记录当前 active task，用于后续 revise 判断
      this.activeTaskId = input.task.id

      if (this.options.codingRuntime !== undefined) {
        const result = await this.options.codingRuntime.run(input)
        const changed = await this.readChangedFiles()
        // Transport evidence can be lost after real writes. Preserve those files
        // and continue to deterministic verification; only a zero-change no-op
        // requires a fresh Executor attempt.
        const runtimeBlockers = changed.changedFiles.length > 0
          ? result.blockers.filter((blocker) => !blocker.startsWith('NO_OP_EXECUTION:'))
          : result.blockers
        const blockers = [...runtimeBlockers, ...scopeBlockers(input.task, changed.changedFiles),
          ...(changed.blocker === undefined ? [] : [changed.blocker])]
        if (result.workspaceEvidence !== undefined && changed.changedFiles.length === 0 &&
          result.workspaceEvidence.alreadySatisfied === undefined && blockers.length === 0) {
          blockers.push('NO_OP_EXECUTION: No changes and no explicit, observed ALREADY_SATISFIED evidence')
        }
        const verification = blockers.length === 0 && result.incompleteReason === undefined && input.packet.deferVerification !== true
          ? await this.verify(input.task, input.packet.verification)
          : { results: [], blockers: [], commandsRun: [] }
        return {
          summary: result.summary,
          ...(result.workspaceEvidence === undefined ? {} : { workspaceExecution: {
            ...result.workspaceEvidence,
            outcome: blockers.length > 0 || result.incompleteReason !== undefined ? 'EXECUTION_BLOCKED' as const
              : changed.changedFiles.length > 0 ? 'IMPLEMENTED' as const : 'ALREADY_SATISFIED' as const,
          } }),
          changedFiles: changed.changedFiles,
          commandsRun: [...result.commandsRun, ...verification.commandsRun],
          verificationResults: verification.results,
          blockers: [...blockers, ...verification.blockers],
          ...(result.incompleteReason === undefined ? {} : { incompleteReason: result.incompleteReason }),
          executorCapabilities: ['list_files', 'read_file', 'write_file', 'delete_file', 'git_status', 'git_diff_summary'],
          deterministicVerificationCapabilities: getDeterministicVerificationCapabilities(),
        }
      }

      // 第一次 Claude invocation 的 mode：
      // - checkpoint 验证通过（startCheck.continuation）→ task-continuation（Exact / Recovery Resume）
      // - 其他（clean worktree 或 same executor revise）→ fresh
      // 只有 RepositoryCheckpoint 验证通过才能进入 task-continuation，sessionId 不授权
      const firstMode: ClaudeExecutionMode = startCheck.continuation ? 'task-continuation' : 'fresh'
      let firstAttempt = await this.executeClaudeOnce(input.task, input.packet, firstMode)
      let finalAttempt = firstAttempt

      const recoveryDecision = this.evaluateMaxTurnRecovery(
        firstAttempt.parsed,
        firstAttempt.scopeBlockers,
        firstAttempt.otherBlockers,
        firstAttempt.permissionDenials,
        maxTurnRecoveryAttempted,
      )

      if (recoveryDecision.eligible) {
        maxTurnRecoveryAttempted = true
        this.options.onRecovery?.({
          reason: 'max_turns',
          sessionId: firstAttempt.parsed.session_id ?? '',
          bounded: true,
          iteration: input.task.iteration,
        })

        // 输出诊断：恢复触发
        const diagnosticInfo = `[MAX_TURN_RECOVERY_DECISION] eligible=true reason=recoverable_max_turns exitCode=${firstAttempt.claude.exitCode} signal=${firstAttempt.claude.signal ?? 'null'} subtype=${recoveryDecision.subtype} sessionIdPresent=${recoveryDecision.sessionIdPresent} scopeBlockers=${recoveryDecision.scopeBlockers.length} otherBlockers=${recoveryDecision.otherBlockers.length}`
        // 诊断信息仅用于测试验证，生产环境不显示
        if (this.options.onRecovery !== undefined) {
          // 在 recovery callback 存在时输出诊断（测试场景）
          firstAttempt.otherBlockers.push(diagnosticInfo)
        }

        const recoveryAttempt = await this.executeClaudeOnce(input.task, input.packet, 'max-turn-recovery')
        finalAttempt = recoveryAttempt

        // 第二次 max_turns 后的判断
        if (recoveryAttempt.parsed.subtype === 'error_max_turns') {
          // 检查第二次是否也满足安全边界（无 scope violation、无其他 blocker）
          const secondRecoveryDecision = this.evaluateMaxTurnRecovery(
            recoveryAttempt.parsed,
            recoveryAttempt.scopeBlockers,
            recoveryAttempt.otherBlockers,
            recoveryAttempt.permissionDenials,
            true, // 已经尝试过一次 recovery
          )

          if (
            secondRecoveryDecision.scopeBlockers.length === 0 &&
            secondRecoveryDecision.otherBlockers.length === 0
          ) {
            // 安全边界正常，只是工作未完成
            // 不添加 blocker，让 Guardian 重新请求 Brain review
            finalAttempt = {
              ...recoveryAttempt,
              otherBlockers: [],
            }
            // incompleteReason 将在最终 return 时添加
          } else {
            // 有真正的安全 blocker
            const recoveryFailureContext =
              recoveryAttempt.scopeBlockers.length > 0
                ? `recovery 产生 scope violation: ${recoveryAttempt.scopeBlockers[0]}`
                : `recovery 失败: ${recoveryAttempt.otherBlockers[0]}`

            finalAttempt = {
              ...recoveryAttempt,
              otherBlockers: [
                ...recoveryAttempt.otherBlockers,
                `首次达到 max_turns 后自动 resume 一次，${recoveryFailureContext}`,
              ],
            }
          }
        } else if (
          recoveryAttempt.otherBlockers.length > 0 ||
          recoveryAttempt.scopeBlockers.length > 0
        ) {
          // recovery 运行中产生 blocker
          finalAttempt = recoveryAttempt
        }
        // 否则 recovery 成功，使用 recoveryAttempt 的结果
      } else if (
        firstAttempt.parsed.subtype === 'error_max_turns' &&
        firstAttempt.permissionDenials.length > 0 &&
        firstAttempt.scopeBlockers.length === 0 &&
        firstAttempt.otherBlockers.length === 0
      ) {
        // W002: max_turns + permission denial，无 scope violation 或其他 blocker
        // 不触发 internal recovery，也不作为 blocker
        // 直接跳到最终检查，返回 incompleteReason 给 Reviewer
        finalAttempt = firstAttempt
      } else if (firstAttempt.parsed.subtype === 'error_max_turns') {
        // 诊断输出：记录为什么没有触发恢复（exitCode=0 但其他条件不满足）
        const diagnosticInfo = `[MAX_TURN_RECOVERY_DECISION] eligible=${recoveryDecision.eligible} reason=${recoveryDecision.reason} exitCode=${firstAttempt.claude.exitCode} signal=${firstAttempt.claude.signal ?? 'null'} subtype=${recoveryDecision.subtype} sessionIdPresent=${recoveryDecision.sessionIdPresent} scopeBlockers=${recoveryDecision.scopeBlockers.length} otherBlockers=${recoveryDecision.otherBlockers.length}`

        finalAttempt = {
          ...firstAttempt,
          otherBlockers: [
            ...firstAttempt.otherBlockers,
            firstAttempt.scopeBlockers.length > 0
              ? `达到 max_turns 但存在 scope violation，不自动恢复`
              : typeof firstAttempt.parsed.session_id !== 'string' ||
                  firstAttempt.parsed.session_id.length === 0
                ? `达到 max_turns 但没有 session_id，不自动恢复`
                : firstAttempt.otherBlockers.length > 0
                  ? `达到 max_turns 但存在其他 blocker，不自动恢复`
                  : `达到 max_turns: ${firstAttempt.parsed.subtype ?? 'unknown'}`,
            diagnosticInfo,
          ],
        }
      }

      const allBlockers = [...finalAttempt.scopeBlockers, ...finalAttempt.otherBlockers]
      const executorCapabilities = getExecutorCapabilities({
        allowNpmInstall: this.options.allowNpmInstall ?? false,
        allowPythonBootstrap: this.options.allowPythonBootstrap ?? false,
      })
      const deterministicVerificationCapabilities = getDeterministicVerificationCapabilities()

      // 检查是否是第二次 max_turns 且安全边界正常，或者有 permission denials 但无其他 blocker
      const isSecondMaxTurnsSafe =
        maxTurnRecoveryAttempted &&
        finalAttempt.parsed.subtype === 'error_max_turns' &&
        allBlockers.length === 0

      const hasPermissionDenialsOnly =
        finalAttempt.permissionDenials.length > 0 &&
        allBlockers.length === 0 &&
        finalAttempt.parsed.subtype !== 'error_max_turns'

      const isFirstMaxTurnsWithPermissionDenial =
        !maxTurnRecoveryAttempted &&
        finalAttempt.parsed.subtype === 'error_max_turns' &&
        finalAttempt.permissionDenials.length > 0 &&
        allBlockers.length === 0

      // 如果有 scope violation 或其他真正的 blocker，返回 blockers
      if (allBlockers.length > 0) {
        return {
          summary: this.reportSummary(finalAttempt.parsed),
          changedFiles: finalAttempt.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers: allBlockers,
          ...(finalAttempt.permissionDenials.length > 0
            ? { permissionDenials: finalAttempt.permissionDenials }
            : {}),
          executorCapabilities,
          deterministicVerificationCapabilities,
        }
      }

      //如果只有 permission denials，不运行 verification，让 Reviewer 判断
      if (hasPermissionDenialsOnly) {
        return {
          summary: this.reportSummary(finalAttempt.parsed),
          changedFiles: finalAttempt.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers: [],
          incompleteReason: '执行遇到权限拒绝，需要 Reviewer 判断是否可使用已有授权能力替代；如不能则 blocked',
          permissionDenials: finalAttempt.permissionDenials,
          executorCapabilities,
          deterministicVerificationCapabilities,
        }
      }

      // W002: 首次 max_turns + permission denial
      // 不触发 internal recovery，返回 incompleteReason 给 Reviewer
      if (isFirstMaxTurnsWithPermissionDenial) {
        return {
          summary: this.reportSummary(finalAttempt.parsed),
          changedFiles: finalAttempt.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers: [],
          incompleteReason:
            '执行达到 max_turns 且遇到权限拒绝，需要 Reviewer 判断是否可使用已有授权能力替代；如不能则 blocked',
          permissionDenials: finalAttempt.permissionDenials,
          executorCapabilities,
          deterministicVerificationCapabilities,
        }
      }

      // 如果是第二次 max_turns 且安全边界正常，不运行 verification
      // 因为已知任务未完成，让 Guardian 重新请求 Brain review
      if (isSecondMaxTurnsSafe) {
        return {
          summary: this.reportSummary(finalAttempt.parsed),
          changedFiles: finalAttempt.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers: [],
          incompleteReason:
            '执行预算耗尽（12 + 6 turns），但安全边界正常，需要 Brain 判断是否继续',
          ...(finalAttempt.permissionDenials.length > 0
            ? { permissionDenials: finalAttempt.permissionDenials }
            : {}),
          executorCapabilities,
          deterministicVerificationCapabilities,
        }
      }

      const verification = input.packet.deferVerification === true
        ? { results: [], blockers: [], commandsRun: [] }
        : await this.verify(input.task, input.packet.verification)
      allBlockers.push(...verification.blockers)
      const rawOutputRef = verification.results.find(
        (result) => result.rawOutputRef !== undefined,
      )?.rawOutputRef

      return {
        summary: this.reportSummary(finalAttempt.parsed),
        changedFiles: finalAttempt.changedFiles,
        commandsRun: ['claude -p --output-format json', ...verification.commandsRun],
        verificationResults: verification.results,
        blockers: allBlockers,
        ...(rawOutputRef === undefined ? {} : { rawOutputRef }),
        executorCapabilities,
        deterministicVerificationCapabilities,
      }
    } finally {
      this.emitTiming(input.task, 'executor-total', performance.now() - totalStartedAt)
    }
  }
}
