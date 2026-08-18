import { spawn } from 'node:child_process'

import type { DelegationPacket, ExecutionReport, GuardianTask, VerificationResult } from './model.js'
import type { GuardianExecutor } from './ports.js'

export interface GuardianCommandRequest {
  executable: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
}

export interface GuardianCommandResult {
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

export interface ClaudeCodeExecutorOptions {
  cwd: string
  maxTurns?: number
  timeoutMs?: number
  model?: string
  commandRunner?: GuardianCommandRunner
  onTiming?: (event: ClaudeCodeTimingEvent) => void
}

interface ClaudeCodeJsonResult {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
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

const ALLOWED_VERIFICATION_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm run check',
  'git diff --check',
])

function defaultCommandRunner(request: GuardianCommandRequest): Promise<GuardianCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1_000_000)
    })

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill()
      resolve({
        exitCode: null,
        signal: 'SIGTERM',
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

function bashCommand(command: string): { executable: string; args: string[] } {
  return {
    executable: 'bash',
    args: ['-lc', command],
  }
}

function claudeCommand(args: readonly string[]): { executable: string; args: string[] } {
  return {
    executable: 'bash',
    args: ['-lc', 'exec claude "$@"', '--', ...args],
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
  return [
    '你是 NovaWing Development Guardian 的 Executor。',
    '只执行下面 Delegation Packet 中明确要求的开发工作，不扩大范围。',
    '禁止 git commit、git push、发布、删除仓库、修改凭据或绕过权限。',
    '不要为了“顺手优化”重构无关代码。',
    '验证命令由 Guardian 在你结束后独立执行；你可以阅读和编辑代码，但不要伪造验证结果。',
    '',
    `task=${JSON.stringify({
      id: task.id,
      goal: task.goal,
      iteration: task.iteration,
      allowed_paths: task.allowedPaths ?? null,
      forbidden_paths: task.forbiddenPaths ?? null,
    })}`,
    `delegation_packet=${JSON.stringify({
      goal: packet.goal,
      instructions: packet.instructions,
      constraints: packet.constraints,
      verification: packet.verification,
      do_not_do: packet.doNotDo,
    })}`,
    '',
    '完成后只需简要说明实际做了什么和仍存在的 blocker。',
  ].join('\n')
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const path = line.slice(3).trim()
      const renameTarget = path.includes(' -> ') ? path.split(' -> ').at(-1) : path
      return renameTarget ?? path
    })
    .filter((path, index, all) => path.length > 0 && all.indexOf(path) === index)
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
}

function matchesPathRule(path: string, rule: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRule = normalizePath(rule)
  if (normalizedRule.endsWith('/**')) {
    const prefix = normalizedRule.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`)
}

function scopeBlockers(task: GuardianTask, changedFiles: readonly string[]): string[] {
  const blockers: string[] = []
  if (task.allowedPaths !== undefined && task.allowedPaths.length > 0) {
    for (const path of changedFiles) {
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

export class ClaudeCodeExecutor implements GuardianExecutor {
  private readonly runner: GuardianCommandRunner
  private readonly timeoutMs: number
  private readonly maxTurns: number
  private sessionId: string | undefined
  private activeTaskId: string | undefined

  constructor(private readonly options: ClaudeCodeExecutorOptions) {
    this.runner = options.commandRunner ?? defaultCommandRunner
    this.timeoutMs = options.timeoutMs ?? 20 * 60 * 1000
    this.maxTurns = options.maxTurns ?? 12
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

  private async runBash(command: string, timeoutMs = this.timeoutMs): Promise<GuardianCommandResult> {
    const spec = bashCommand(command)
    return this.runner({
      executable: spec.executable,
      args: spec.args,
      cwd: this.options.cwd,
      timeoutMs,
    })
  }

  private async readChangedFiles(): Promise<{
    changedFiles: string[]
    blocker?: string
  }> {
    const status = await this.runBash('git status --porcelain', 30_000)
    if (status.exitCode !== 0) {
      return {
        changedFiles: [],
        blocker: `cannot inspect changed files: ${commandFailureDetails(status)}`,
      }
    }
    return { changedFiles: parseChangedFiles(status.stdout) }
  }

  private async ensureCleanStart(task: GuardianTask): Promise<string | undefined> {
    if (this.activeTaskId === task.id) {
      return undefined
    }
    if (this.activeTaskId !== undefined && this.activeTaskId !== task.id) {
      return `executor is already bound to another task: ${this.activeTaskId}`
    }

    const status = await this.runBash('git status --porcelain', 30_000)
    if (status.exitCode !== 0) {
      return `cannot inspect git status: ${commandFailureDetails(status)}`
    }
    if (status.stdout.trim().length > 0) {
      return 'target repository has pre-existing changes; MVP requires a clean worktree before autonomous execution'
    }

    this.activeTaskId = task.id
    return undefined
  }

  private buildClaudeArgs(task: GuardianTask, packet: DelegationPacket): string[] {
    const args = [
      '-p',
      buildClaudePrompt(task, packet),
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      String(this.maxTurns),
    ]

    if (this.options.model !== undefined) {
      args.push('--model', this.options.model)
    }
    if (this.sessionId !== undefined) {
      args.push('--resume', this.sessionId)
    }
    args.push('--allowedTools', ...DEFAULT_ALLOWED_TOOLS)
    return args
  }

  private async verify(task: GuardianTask, commands: readonly string[]): Promise<{
    results: VerificationResult[]
    blockers: string[]
    commandsRun: string[]
  }> {
    const effectiveCommands = [...new Set(['git diff --check', ...commands.map((command) => command.trim())])]
    const results: VerificationResult[] = []
    const blockers: string[] = []
    const commandsRun: string[] = []

    for (const command of effectiveCommands) {
      if (command.length === 0) {
        continue
      }
      if (!ALLOWED_VERIFICATION_COMMANDS.has(command)) {
        results.push({
          name: command,
          status: 'skipped',
          details: 'verification command is not in the MVP allowlist',
        })
        blockers.push(`verification command requires human approval: ${command}`)
        continue
      }

      commandsRun.push(command)
      const startedAt = performance.now()
      const result = await this.runBash(command)
      this.emitTiming(task, 'verification', performance.now() - startedAt, { command })
      results.push({
        name: command,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        ...(result.exitCode === 0 ? {} : { details: commandFailureDetails(result) }),
      })
    }

    return { results, blockers, commandsRun }
  }

  private reportSummary(parsed: ClaudeCodeJsonResult): string {
    return typeof parsed.result === 'string' && parsed.result.trim().length > 0
      ? parsed.result.trim()
      : 'Claude Code 执行结束。'
  }

  async execute(input: {
    task: GuardianTask
    packet: DelegationPacket
  }): Promise<ExecutionReport> {
    const totalStartedAt = performance.now()
    try {
      const cleanStartedAt = performance.now()
      const startBlocker = await this.ensureCleanStart(input.task)
      this.emitTiming(input.task, 'clean-start', performance.now() - cleanStartedAt, {
        command: 'git status --porcelain',
      })
      if (startBlocker !== undefined) {
        return {
          summary: 'Claude Code 未启动。',
          changedFiles: [],
          commandsRun: ['git status --porcelain'],
          verificationResults: [],
          blockers: [startBlocker],
        }
      }

      const args = this.buildClaudeArgs(input.task, input.packet)
      const spec = claudeCommand(args)
      const claudeStartedAt = performance.now()
      const claude = await this.runner({
        executable: spec.executable,
        args: spec.args,
        cwd: this.options.cwd,
        timeoutMs: this.timeoutMs,
      })
      const claudeDurationMs = performance.now() - claudeStartedAt

      const changedStartedAt = performance.now()
      const changed = await this.readChangedFiles()
      this.emitTiming(input.task, 'inspect-changes', performance.now() - changedStartedAt, {
        command: 'git status --porcelain',
      })
      const blockers = [
        ...(changed.blocker === undefined ? [] : [changed.blocker]),
        ...scopeBlockers(input.task, changed.changedFiles),
      ]

      if (claude.exitCode !== 0) {
        this.emitTiming(input.task, 'claude-code', claudeDurationMs)
        blockers.push(`Claude Code failed: ${commandFailureDetails(claude)}`)
        return {
          summary: 'Claude Code 执行失败。',
          changedFiles: changed.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers,
        }
      }

      let parsed: ClaudeCodeJsonResult
      try {
        parsed = parseClaudeResult(claude.stdout)
      } catch (error) {
        this.emitTiming(input.task, 'claude-code', claudeDurationMs)
        blockers.push(error instanceof Error ? error.message : String(error))
        return {
          summary: 'Claude Code 返回了无法解析的结果。',
          changedFiles: changed.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers,
        }
      }

      this.emitTiming(input.task, 'claude-code', claudeDurationMs, {
        ...(typeof parsed.num_turns === 'number' ? { numTurns: parsed.num_turns } : {}),
        ...(typeof parsed.total_cost_usd === 'number' ? { totalCostUsd: parsed.total_cost_usd } : {}),
        ...(typeof parsed.duration_ms === 'number' ? { reportedDurationMs: parsed.duration_ms } : {}),
        ...(typeof parsed.duration_api_ms === 'number' ? { apiDurationMs: parsed.duration_api_ms } : {}),
      })

      if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
        this.sessionId = parsed.session_id
      }
      if (parsed.is_error === true || (parsed.subtype !== undefined && parsed.subtype !== 'success')) {
        blockers.push(`Claude Code result is not successful: ${parsed.subtype ?? 'unknown'}`)
      }

      if (blockers.length > 0) {
        return {
          summary: this.reportSummary(parsed),
          changedFiles: changed.changedFiles,
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [],
          blockers,
        }
      }

      const verification = await this.verify(input.task, input.packet.verification)
      blockers.push(...verification.blockers)

      return {
        summary: this.reportSummary(parsed),
        changedFiles: changed.changedFiles,
        commandsRun: ['claude -p --output-format json', ...verification.commandsRun],
        verificationResults: verification.results,
        blockers,
      }
    } finally {
      this.emitTiming(input.task, 'executor-total', performance.now() - totalStartedAt)
    }
  }
}
