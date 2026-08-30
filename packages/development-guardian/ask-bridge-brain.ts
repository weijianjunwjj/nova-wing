import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DelegationPacket,
  ExecutionReport,
  GuardianBrainTransportMetrics,
  GuardianTask,
} from './model.js'
import type { GuardianBrain } from './ports.js'
import { DEFAULT_BRAIN_REVIEW_ATTEMPT_TIMEOUT_MS } from './brain-review-budget.js'
import {
  GuardianBrainInfrastructureError,
  RetryableGuardianBrainError,
} from './brain-error.js'
import {
  buildGuardianBrainPrompt,
  parseDelegationPacket,
  TenXChatBrainProtocolError,
} from './tenx-chat-brain.js'

export type AskBridgeReasoning = 'auto' | 'instant' | 'medium' | 'high'

export interface AskBridgeOutputEvent {
  stream: 'stdout' | 'stderr'
  elapsedMs: number
  line: string
}

export interface AskBridgeTimingEvent {
  phase: 'bridge-command'
  taskId: string
  iteration: number
  durationMs: number
}

export interface AskBridgeProviderConfigurationState {
  requestedModel?: string
  requestedReasoning?: AskBridgeReasoning
  actualModel?: string | 'unknown'
  actualReasoning?: AskBridgeReasoning | 'unknown'
  configuredAt?: string
  degraded: boolean
  warning?: {
    category: 'REASONING_CONFIGURATION'
    fingerprint: 'reasoning-switch:option-not-found'
    message: string
    availableOptions: readonly string[]
  }
}

export interface AskBridgeConfigurationStatus extends AskBridgeProviderConfigurationState {
  taskId: string
}

export interface AskBridgeCommandRequest {
  executable: string
  args: readonly string[]
  timeoutMs: number
  onOutput?: (event: AskBridgeOutputEvent) => void
}

export interface AskBridgeCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type AskBridgeCommandRunner = (
  request: AskBridgeCommandRequest,
) => Promise<AskBridgeCommandResult>

export type AskBridgeProcessTreeTerminator = (child: ChildProcess) => Promise<void>

export interface AskBridgeProcessTreeCleanupOptions {
  platform?: NodeJS.Platform
  windowsTreeKill?: (pid: number) => Promise<boolean>
}

function runWindowsTreeKill(pid: number): Promise<boolean> {
  return new Promise((resolveRun) => {
    const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows'
    const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), [
      '/PID', String(pid), '/T', '/F',
    ], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    let settled = false
    const finish = (success: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(success)
    }
    killer.once('error', () => finish(false))
    killer.once('exit', (code) => finish(code === 0))
    const timer = setTimeout(() => {
      killer.kill()
      finish(false)
    }, 5_000)
    timer.unref()
  })
}

/** Terminate only the process tree rooted at the ask-bridge process spawned for this request. */
export async function terminateAskBridgeProcessTree(
  child: ChildProcess,
  options: AskBridgeProcessTreeCleanupOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32' && child.pid !== undefined) {
    const killed = await (options.windowsTreeKill ?? runWindowsTreeKill)(child.pid)
    if (killed) return
  }
  child.kill()
}

export interface AskBridgeCommandRunnerOptions {
  terminateProcessTree?: AskBridgeProcessTreeTerminator
}

export interface AskBridgeBrainOptions {
  command?: string
  conversationUrl?: string
  model?: string
  reasoning?: AskBridgeReasoning
  headless?: boolean
  verbose?: boolean
  timeoutMs?: number
  commandRunner?: AskBridgeCommandRunner
  onTiming?: (event: AskBridgeTimingEvent) => void
  onDiagnostic?: (event: AskBridgeOutputEvent) => void
  onConfiguration?: (status: AskBridgeConfigurationStatus) => void
}

/**
 * W003: AskBridgeBrain Provider State
 * 用于持久化和恢复 ChatGPT conversation 状态
 */
export interface AskBridgeBrainProviderState {
  taskConversationUrls: Record<string, string>
  reviewedTaskIds: readonly string[]
  /** Task conversations that must never become continuation truth after restart. */
  staleTaskIds?: readonly string[]
  /** Last configuration verified during this Browser/provider lifecycle. Contains no secrets. */
  configuration?: AskBridgeProviderConfigurationState
}

function defaultAskBridgeCommand(): string {
  return process.platform === 'win32'
    ? join(homedir(), '.local', 'bin', 'ask-bridge.exe')
    : 'ask-bridge'
}

export function createAskBridgeCommandRunner(
  options: AskBridgeCommandRunnerOptions = {},
): AskBridgeCommandRunner {
  const terminateProcessTree = options.terminateProcessTree ?? terminateAskBridgeProcessTree
  return (request) => new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(request.executable, [...request.args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let stdoutPending = ''
    let stderrPending = ''
    let settled = false

    const emitLines = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (request.onOutput === undefined) {
        return
      }
      const pending = stream === 'stdout' ? `${stdoutPending}${chunk}` : `${stderrPending}${chunk}`
      const lines = pending.split(/\r?\n/u)
      const remainder = lines.pop() ?? ''
      if (stream === 'stdout') {
        stdoutPending = remainder
      } else {
        stderrPending = remainder
      }
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length > 0) {
          request.onOutput({ stream, elapsedMs: performance.now() - startedAt, line: trimmed })
        }
      }
    }

    const flushPending = (): void => {
      if (request.onOutput === undefined) {
        return
      }
      for (const [stream, pending] of [
        ['stdout', stdoutPending],
        ['stderr', stderrPending],
      ] as const) {
        const trimmed = pending.trim()
        if (trimmed.length > 0) {
          request.onOutput({ stream, elapsedMs: performance.now() - startedAt, line: trimmed })
        }
      }
      stdoutPending = ''
      stderrPending = ''
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000)
      emitLines('stdout', chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-100_000)
      emitLines('stderr', chunk)
    })

    const closeCapturedStreams = (): void => {
      child.stdout.destroy()
      child.stderr.destroy()
    }

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      flushPending()
      closeCapturedStreams()
      void terminateProcessTree(child)
        .catch(() => { child.kill() })
        .finally(() => {
          resolve({
            exitCode: null,
            stdout,
            stderr: `${stderr}\nask-bridge timed out after ${String(request.timeoutMs)}ms`.trim(),
          })
        })
    }, request.timeoutMs)

    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      flushPending()
      closeCapturedStreams()
      reject(error)
    })

    child.once('exit', (exitCode) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      setTimeout(() => {
        flushPending()
        closeCapturedStreams()
        resolve({ exitCode, stdout, stderr })
      }, 50)
    })
  })
}

const defaultCommandRunner = createAskBridgeCommandRunner()

const PERFORMANCE_ISSUE_MESSAGE = 'No handler registered for issue code PerformanceIssue'

export function normalizeAskBridgeDiagnostics(value: string): string {
  const lines = value.split(/\r?\n/u)
  const normalized: string[] = []
  let performanceIssueCount = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '[chrome-devtools]' && lines[index + 1]?.trim() === PERFORMANCE_ISSUE_MESSAGE) {
      performanceIssueCount += 1
      index += 1
      continue
    }
    if (line === PERFORMANCE_ISSUE_MESSAGE) {
      performanceIssueCount += 1
      continue
    }
    if (
      line === 'code PerformanceIssue' ||
      line === `[chrome-devtools] ${PERFORMANCE_ISSUE_MESSAGE}`
    ) {
      performanceIssueCount += 1
      continue
    }
    if (line.length > 0) normalized.push(line)
  }

  if (performanceIssueCount > 0) {
    normalized.push(`[chrome-devtools] ${PERFORMANCE_ISSUE_MESSAGE} × ${String(performanceIssueCount)}`)
  }
  return normalized.join('\n').slice(-4_000)
}

function failureDetails(result: AskBridgeCommandResult): string {
  const raw = [result.stderr.trim(), result.stdout.trim()].filter((value) => value.length > 0).join('\n') ||
    `exit=${String(result.exitCode)}`
  return normalizeAskBridgeDiagnostics(raw)
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function extractAskBridgeSubmissionMetrics(
  value: string,
): GuardianBrainTransportMetrics | undefined {
  const matches = Array.from(value.matchAll(
    /(?:Submission Metrics:\s*|submissionMetrics=)(\{[^\r\n]*\})/gu,
  ))
  const raw = matches.at(-1)?.[1]
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const promptChars = finiteNonNegative(parsed.promptChars)
    const pasteCount = finiteNonNegative(parsed.pasteCount)
    const submitCount = finiteNonNegative(parsed.submitCount)
    if (promptChars === undefined || pasteCount === undefined || submitCount === undefined) {
      return undefined
    }
    const inputMode = parsed.inputMode === 'normal' || parsed.inputMode === 'big-paste'
      ? parsed.inputMode
      : 'unknown'
    const composerSettleMs = finiteNonNegative(parsed.composerSettleMs)
    const sendReadyWaitMs = finiteNonNegative(parsed.sendReadyWaitMs)
    return {
      promptChars,
      inputMode,
      ...(composerSettleMs === undefined ? {} : { composerSettleMs }),
      ...(sendReadyWaitMs === undefined ? {} : { sendReadyWaitMs }),
      pasteCount,
      submitCount,
      submissionReached: parsed.submissionReached === true,
      reusedSubmission: parsed.reusedSubmission === true,
    }
  } catch {
    return undefined
  }
}

function isPerformanceIssueNoise(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '[chrome-devtools]' || trimmed === PERFORMANCE_ISSUE_MESSAGE
}

function isReasoningOptionFailure(details: string): boolean {
  return /(?:error switching reasoning|reasoning switch failed|reasoning-switch-failed)/iu.test(details) &&
    /(?:option not found|(?:ChatGPT\s+)?picker not found)/iu.test(details)
}

function isModelSelectionFailure(details: string): boolean {
  return /(?:error switching model|model switch failed|model selection failed)/iu.test(details)
}

function isAuthenticationFailure(details: string): boolean {
  return /\b(?:authentication|unauthorized|sign[ -]?in|login|credential|api[_ -]?key)\b/iu.test(details)
}

function isRateLimitFailure(details: string): boolean {
  return /\b(?:rate limit|too many requests|quota|credits?|balance|billing|429|402)\b/iu.test(details)
}

function extractAvailableOptions(details: string): string[] {
  const marker = /available options\s*:\s*/iu.exec(details)
  if (marker === null) return []
  return [...new Set(
    details
      .slice(marker.index + marker[0].length)
      .split(/[,\r\n]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !value.startsWith('[chrome-devtools]')),
  )].slice(0, 30)
}

function isTransientBrowserSessionTransportFailure(details: string): boolean {
  const isNonTransientPrerequisite =
    /\b(?:credential|authentication|unauthorized|account|billing|balance|credits?|quota)\b/iu.test(
      details,
    ) ||
    /\b(?:permission(?: denied| error)?|access denied|malformed|configuration|config error|ENOENT)\b/iu.test(
      details,
    ) ||
    /\b(?:executable|command)\b.{0,40}\bnot found\b/iu.test(details)
  if (isNonTransientPrerequisite) {
    return false
  }

  return (
    /\bcould not identify (?:the )?newly opened tab\b/iu.test(details) ||
    /\bnewly opened tab could not be identified\b/iu.test(details) ||
    /\b(?:error opening|failed to open) (?:a )?ChatGPT session\b/iu.test(details) ||
    /\btext entry or submission failed\b/iu.test(details) ||
    /\bcomposer is empty after input attempt\b/iu.test(details) ||
    /\bsend button did not become active(?:\/enabled)?\b/iu.test(details) ||
    /\bbrowser\b.{0,80}\b(?:tab|session)\b.{0,80}\btransport\b.{0,80}\btemporarily unavailable\b/iu.test(
      details,
    )
  )
}

function transportFailureFingerprint(details: string): string | undefined {
  if (/\bsend button did not become active(?:\/enabled)?\b/iu.test(details)) {
    return 'brain-transport:browser-send-button-inactive'
  }
  if (/\bcould not identify (?:the )?newly opened tab\b/iu.test(details)) {
    return 'brain-transport:browser-new-tab-unidentified'
  }
  return undefined
}

function isRejectedConversationContinuation(details: string): boolean {
  return (
    /\b(?:conversation|thread|session)(?: url)?\b.{0,80}\b(?:not found|does not exist|no longer exists|expired|invalid|mismatch|does not match|cannot be continued|could not be continued|continuation rejected)\b/iu.test(
      details,
    ) ||
    /\b(?:failed|unable|refused) to (?:continue|resume)\b.{0,80}\b(?:conversation|thread|session)\b/iu.test(
      details,
    )
  )
}

function extractThreadLinks(stdout: string): string[] {
  return Array.from(
    new Set(
      Array.from(
        stdout.matchAll(/^Thread Link:\s+(https:\/\/chatgpt\.com\/c\/[^\s]+)\s*$/gmu),
        (match) => match[1],
      ).filter((url): url is string => url !== undefined),
    ),
  )
}

async function readBridgeOutput(outputPath: string, fallbackStdout: string): Promise<string> {
  try {
    const output = await readFile(outputPath, 'utf8')
    if (output.trim().length > 0) {
      return output.trim()
    }
  } catch {
    // Test doubles or older bridge versions may not create --output files.
  }
  return fallbackStdout.trim()
}

export class AskBridgeBrain implements GuardianBrain {
  private readonly runner: AskBridgeCommandRunner
  private readonly timeoutMs: number
  private readonly command: string
  private readonly headless: boolean
  private readonly taskConversationUrls = new Map<string, string>()
  private readonly reviewedTaskIds = new Set<string>()
  private readonly staleTaskIds = new Set<string>()
  private providerConfiguration: AskBridgeProviderConfigurationState | undefined
  private configurationResyncRequested = false
  private lastTransportMetrics: GuardianBrainTransportMetrics | undefined
  /** Tasks whose replaceable state must override the constructor's initial URL. */
  private readonly rotatedTaskIds = new Set<string>()

  constructor(private readonly options: AskBridgeBrainOptions = {}) {
    this.runner = options.commandRunner ?? defaultCommandRunner
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BRAIN_REVIEW_ATTEMPT_TIMEOUT_MS
    this.command = options.command ?? defaultAskBridgeCommand()
    this.headless = options.headless ?? process.platform !== 'win32'
  }

  /**
   * W003: 捕获当前 provider state 用于持久化
   */
  captureProviderState(): AskBridgeBrainProviderState {
    return {
      taskConversationUrls: Object.fromEntries(this.taskConversationUrls),
      reviewedTaskIds: Array.from(this.reviewedTaskIds),
      staleTaskIds: Array.from(this.staleTaskIds),
      ...(this.providerConfiguration === undefined
        ? {}
        : { configuration: this.cloneProviderConfiguration(this.providerConfiguration) }),
    }
  }

  captureConfigurationStatus(taskId: string): AskBridgeConfigurationStatus | undefined {
    return this.providerConfiguration === undefined
      ? undefined
      : {
          taskId,
          ...this.cloneProviderConfiguration(this.providerConfiguration),
        }
  }

  captureLastTransportMetrics(): GuardianBrainTransportMetrics | undefined {
    return this.lastTransportMetrics === undefined ? undefined : { ...this.lastTransportMetrics }
  }

  /** Explicitly require the next review to re-apply the requested provider configuration. */
  requestConfigurationResync(): void {
    this.configurationResyncRequested = true
  }

  /**
   * W003: 从持久化 state 恢复
   */
  restoreProviderState(state: AskBridgeBrainProviderState): void {
    this.taskConversationUrls.clear()
    this.reviewedTaskIds.clear()
    this.staleTaskIds.clear()
    this.rotatedTaskIds.clear()
    this.configurationResyncRequested = false
    if (state.configuration !== undefined) {
      this.providerConfiguration = this.cloneProviderConfiguration(state.configuration)
    }

    const staleTaskIds = new Set(state.staleTaskIds ?? [])
    for (const [taskId, url] of Object.entries(state.taskConversationUrls)) {
      if (staleTaskIds.has(taskId)) continue
      this.taskConversationUrls.set(taskId, url)
      this.rotatedTaskIds.add(taskId)
    }

    for (const taskId of state.reviewedTaskIds) {
      if (staleTaskIds.has(taskId)) continue
      this.reviewedTaskIds.add(taskId)
    }

    for (const taskId of staleTaskIds) {
      this.staleTaskIds.add(taskId)
      this.rotatedTaskIds.add(taskId)
    }
  }

  resetTaskReviewSession(taskId: string): void {
    this.markTaskConversationStale(taskId)
  }

  private markTaskConversationStale(taskId: string): void {
    this.taskConversationUrls.delete(taskId)
    this.reviewedTaskIds.delete(taskId)
    this.staleTaskIds.add(taskId)
    this.rotatedTaskIds.add(taskId)
  }

  private conversationFailure(
    taskId: string,
    reason: 'missing' | 'mismatch' | 'rejected' | 'ambiguous-thread-link',
  ): RetryableGuardianBrainError {
    this.markTaskConversationStale(taskId)
    return new RetryableGuardianBrainError(
      'ask-bridge Reviewer conversation cannot be continued safely',
      'conversation',
      {
        ...this.failureContext(),
        failureType: 'BRAIN_CONVERSATION_MISMATCH',
        fingerprint: `brain-conversation:${reason}`,
      },
    )
  }

  private conversationUrlForTask(taskId: string): string | undefined {
    return this.rotatedTaskIds.has(taskId)
      ? this.taskConversationUrls.get(taskId)
      : this.options.conversationUrl ?? this.taskConversationUrls.get(taskId)
  }

  private cloneProviderConfiguration(
    configuration: AskBridgeProviderConfigurationState,
  ): AskBridgeProviderConfigurationState {
    return {
      ...configuration,
      ...(configuration.warning === undefined
        ? {}
        : {
            warning: {
              ...configuration.warning,
              availableOptions: [...configuration.warning.availableOptions],
            },
          }),
    }
  }

  private syncRequestedConfiguration(): void {
    if (this.options.model === undefined && this.options.reasoning === undefined) return

    const previous = this.providerConfiguration
    const reasoningChanged =
      this.options.reasoning !== undefined &&
      previous?.requestedReasoning !== this.options.reasoning
    const next = this.cloneProviderConfiguration(previous ?? { degraded: false })
    if (reasoningChanged) delete next.warning
    this.providerConfiguration = {
      ...next,
      ...(this.options.model === undefined ? {} : { requestedModel: this.options.model }),
      ...(this.options.reasoning === undefined
        ? {}
        : { requestedReasoning: this.options.reasoning }),
      ...(reasoningChanged ? { degraded: false } : {}),
    }
  }

  private shouldConfigureModel(): boolean {
    return this.options.model !== undefined &&
      (this.configurationResyncRequested ||
        this.providerConfiguration?.actualModel !== this.options.model)
  }

  private shouldConfigureReasoning(omitReasoning: boolean): boolean {
    if (omitReasoning || this.options.reasoning === undefined) return false
    if (this.configurationResyncRequested) return true
    const configuration = this.providerConfiguration
    if (
      configuration?.requestedReasoning === this.options.reasoning &&
      configuration.degraded
    ) {
      return false
    }
    return configuration?.actualReasoning !== this.options.reasoning
  }

  private rememberSuccessfulConfiguration(args: readonly string[]): void {
    const configuredModel = args.includes('--model')
    const configuredReasoning = args.includes('--reasoning')
    if (!configuredModel && !configuredReasoning) return

    const previous = this.cloneProviderConfiguration(
      this.providerConfiguration ?? { degraded: false },
    )
    if (configuredReasoning) delete previous.warning
    this.providerConfiguration = {
      ...previous,
      ...(configuredModel && this.options.model !== undefined
        ? { requestedModel: this.options.model, actualModel: this.options.model }
        : {}),
      ...(configuredReasoning && this.options.reasoning !== undefined
        ? {
            requestedReasoning: this.options.reasoning,
            actualReasoning: this.options.reasoning,
            degraded: false,
          }
        : {}),
      configuredAt: new Date().toISOString(),
    }
    this.configurationResyncRequested = false
  }

  private failureContext(): {
    adapter: string
    requestedModel?: string
    requestedReasoning?: AskBridgeReasoning
  } {
    return {
      adapter: 'ask-bridge/chatgpt',
      ...(this.options.model === undefined ? {} : { requestedModel: this.options.model }),
      ...(this.options.reasoning === undefined
        ? {}
        : { requestedReasoning: this.options.reasoning }),
    }
  }

  private buildArgs(
    taskId: string,
    iteration: number,
    prompt: string,
    outputPath: string,
    timeoutMs: number,
    omitReasoning = false,
  ): string[] {
    const args = ['--provider', 'chatgpt', `--headless=${String(this.headless)}`]
    const conversationUrl = this.conversationUrlForTask(taskId)
    const isFirstReview = !this.reviewedTaskIds.has(taskId)

    if (this.options.verbose === true) {
      args.push('--verbose')
    }
    // A successful transport may have already given us a task Thread Link
    // even when packet parsing failed. Reuse that trusted task URL before
    // considering --new, so a protocol retry stays in the same session.
    if (conversationUrl !== undefined) {
      args.push('--session-url', conversationUrl)
    } else if (isFirstReview) {
      args.push('--new')
    }
    if (this.shouldConfigureModel() && this.options.model !== undefined) {
      args.push('--model', this.options.model)
    }
    if (this.shouldConfigureReasoning(omitReasoning) && this.options.reasoning !== undefined) {
      args.push('--reasoning', this.options.reasoning)
    }

    const promptFingerprint = createHash('sha256').update(prompt).digest('hex')
    const operationId = createHash('sha256')
      .update(`${taskId}\0${String(iteration)}\0${promptFingerprint}`)
      .digest('hex')
    args.push(
      '--operation-id', `novawing-${operationId}`,
      '--prompt-fingerprint', `sha256-${promptFingerprint}`,
      '--timeout', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '--output', outputPath,
      prompt,
    )
    return args
  }

  private rememberConversation(taskId: string, stdout: string): void {
    const expectedUrl = this.conversationUrlForTask(taskId)
    const returnedUrls = extractThreadLinks(stdout)
    if (returnedUrls.length > 1) {
      throw this.conversationFailure(taskId, 'ambiguous-thread-link')
    }
    const returnedUrl = returnedUrls[0]

    if (expectedUrl !== undefined && returnedUrl !== undefined && returnedUrl !== expectedUrl) {
      throw this.conversationFailure(taskId, 'mismatch')
    }

    if (
      (this.options.conversationUrl === undefined || this.rotatedTaskIds.has(taskId)) &&
      expectedUrl === undefined &&
      returnedUrl !== undefined
    ) {
      this.taskConversationUrls.set(taskId, returnedUrl)
      this.staleTaskIds.delete(taskId)
    }
  }

  async review(input: {
    task: GuardianTask
    report?: ExecutionReport
    protocolRepair?: boolean
    transportTimeoutMs?: number
  }): Promise<DelegationPacket> {
    const taskId = input.task.id
    this.lastTransportMetrics = undefined
    this.syncRequestedConfiguration()
    if (this.reviewedTaskIds.has(taskId) && this.conversationUrlForTask(taskId) === undefined) {
      throw this.conversationFailure(taskId, 'missing')
    }

    const prompt = buildGuardianBrainPrompt(input)
    const outputPath = join(tmpdir(), `novawing-ask-bridge-${randomUUID()}.md`)
    const startedAt = performance.now()
    const operationTimeoutMs = Math.min(input.transportTimeoutMs ?? this.timeoutMs, this.timeoutMs)

    try {
      const runBridge = async (omitReasoning = false): Promise<{
        result: AskBridgeCommandResult
        args: readonly string[]
      }> => {
        const remainingOperationMs = Math.max(
          0,
          Math.floor(operationTimeoutMs - (performance.now() - startedAt)),
        )
        if (remainingOperationMs < 1_000) {
          return {
            result: {
              exitCode: null,
              stdout: '',
              stderr: 'ask-bridge operation budget exhausted',
            },
            args: [],
          }
        }
        try {
          const args = this.buildArgs(
            taskId,
            input.task.iteration,
            prompt,
            outputPath,
            remainingOperationMs,
            omitReasoning,
          )
          const result = await this.runner({
            executable: this.command,
            args,
            timeoutMs: remainingOperationMs,
            ...(this.options.onDiagnostic === undefined
              ? {}
              : {
                  onOutput: (event) => {
                    if (this.options.verbose === true || !isPerformanceIssueNoise(event.line)) {
                      this.options.onDiagnostic?.(event)
                    }
                  },
                }),
          })
          this.lastTransportMetrics = extractAskBridgeSubmissionMetrics(
            `${result.stderr}\n${result.stdout}`,
          ) ?? this.lastTransportMetrics
          return { result, args }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new GuardianBrainInfrastructureError(`ask-bridge unavailable: ${message}`, {
            category: 'TRANSPORT',
            failureType: 'BRAIN_UNAVAILABLE',
            ...this.failureContext(),
            rawError: message,
          })
        }
      }

      let reasoningDegraded = this.providerConfiguration?.degraded === true
      const attemptedContinuation = this.conversationUrlForTask(taskId) !== undefined
      let bridgeRun = await runBridge()
      let { result } = bridgeRun

      if (
        result.exitCode !== 0 &&
        bridgeRun.args.includes('--reasoning') &&
        this.options.reasoning !== undefined
      ) {
        const details = failureDetails(result)
        if (isReasoningOptionFailure(details)) {
          const availableOptions = extractAvailableOptions(details)
          const failedConfiguration = this.cloneProviderConfiguration(
            this.providerConfiguration ?? { degraded: false },
          )
          delete failedConfiguration.configuredAt
          this.providerConfiguration = {
            ...failedConfiguration,
            requestedReasoning: this.options.reasoning,
            actualReasoning: 'unknown',
            degraded: true,
            ...(!bridgeRun.args.includes('--model') || this.options.model === undefined
              ? {}
              : { requestedModel: this.options.model, actualModel: 'unknown' }),
            warning: {
              category: 'REASONING_CONFIGURATION',
              fingerprint: 'reasoning-switch:option-not-found',
              message: 'Requested reasoning could not be configured; continuing with the current UI setting.',
              availableOptions,
            },
          }
          this.configurationResyncRequested = false
          this.options.onConfiguration?.({
            taskId,
            ...this.cloneProviderConfiguration(this.providerConfiguration),
          })
          reasoningDegraded = true
          await unlink(outputPath).catch(() => {})
          bridgeRun = await runBridge(true)
          result = bridgeRun.result
        }
      }

      if (result.exitCode === 0) {
        this.rememberSuccessfulConfiguration(bridgeRun.args)
        reasoningDegraded = this.providerConfiguration?.degraded === true
      }

      this.options.onTiming?.({
        phase: 'bridge-command',
        taskId,
        iteration: input.task.iteration,
        durationMs: performance.now() - startedAt,
      })

      if (result.exitCode !== 0) {
        this.rememberConversation(taskId, result.stdout)
        const isTimeout = result.exitCode === null
        if (isTimeout) {
          throw new RetryableGuardianBrainError(
            `ChatGPT review timed out after ${operationTimeoutMs}ms`,
            'timeout',
            {
              ...this.failureContext(),
              failureType: 'BRAIN_TRANSPORT_FAILED',
              degraded: reasoningDegraded,
              fingerprint: 'brain-transport:timeout',
            },
          )
        }
        const details = failureDetails(result)
        if (attemptedContinuation && isRejectedConversationContinuation(details)) {
          throw this.conversationFailure(taskId, 'rejected')
        }
        if (isTransientBrowserSessionTransportFailure(details)) {
          const fingerprint = transportFailureFingerprint(details)
          throw new RetryableGuardianBrainError(`ask-bridge failed: ${details}`, 'transport', {
            ...this.failureContext(),
            degraded: reasoningDegraded,
            rawError: details,
            failureType: 'BRAIN_TRANSPORT_FAILED',
            ...(fingerprint === undefined ? {} : { fingerprint }),
          })
        }
        const authenticationFailure = isAuthenticationFailure(details)
        const rateLimitFailure = isRateLimitFailure(details)
        const configurationFailure = authenticationFailure || rateLimitFailure || isModelSelectionFailure(details) || isReasoningOptionFailure(details)
        throw new GuardianBrainInfrastructureError(`ask-bridge failed: ${details}`, {
          category: configurationFailure ? 'CONFIGURATION' : 'TRANSPORT',
          failureType: authenticationFailure
            ? 'BRAIN_AUTH_REQUIRED'
            : rateLimitFailure
              ? 'BRAIN_RATE_LIMITED'
              : configurationFailure
                ? 'BRAIN_CONFIGURATION_FAILED'
                : 'BRAIN_TRANSPORT_FAILED',
          ...this.failureContext(),
          availableOptions: extractAvailableOptions(details),
          degraded: reasoningDegraded,
          ...(isModelSelectionFailure(details)
            ? { fingerprint: 'model-selection:option-not-found' }
            : isReasoningOptionFailure(details)
              ? { fingerprint: 'reasoning-switch:option-not-found' }
              : {}),
          rawError: details,
        })
      }

      this.rememberConversation(taskId, result.stdout)

      const response = await readBridgeOutput(outputPath, result.stdout)
      if (response.length === 0) {
        const details = failureDetails(result)
        throw new GuardianBrainInfrastructureError(`ask-bridge returned empty response: ${details}`, {
          category: 'RESPONSE',
          failureType: 'BRAIN_RESPONSE_INVALID',
          ...this.failureContext(),
          degraded: reasoningDegraded,
          rawError: details,
        })
      }

      let packet: DelegationPacket
      try {
        packet = parseDelegationPacket(response)
      } catch (error) {
        if (error instanceof TenXChatBrainProtocolError && error.kind === 'format') {
          // The bridge transport succeeded, but the Reviewer did not honor the
          // strict JSON wire format. Never retain or surface the raw response.
          throw new RetryableGuardianBrainError(error.message, 'protocol', {
            ...this.failureContext(),
            degraded: reasoningDegraded,
            failureType: 'BRAIN_RESPONSE_INVALID',
            fingerprint: 'brain-protocol:json-format',
          })
        }
        if (error instanceof TenXChatBrainProtocolError) {
          throw new GuardianBrainInfrastructureError(error.message, {
            category: 'PROTOCOL',
            failureType: 'BRAIN_RESPONSE_INVALID',
            ...this.failureContext(),
            degraded: reasoningDegraded,
            fingerprint: 'brain-protocol:packet-contract',
          })
        }
        throw error
      }
      this.reviewedTaskIds.add(taskId)
      const successfulStatus = this.captureConfigurationStatus(taskId)
      if (successfulStatus !== undefined) this.options.onConfiguration?.(successfulStatus)
      return packet
    } finally {
      await unlink(outputPath).catch(() => {})
    }
  }
}
