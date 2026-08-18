import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DelegationPacket, ExecutionReport, GuardianTask } from './model.js'
import type { GuardianBrain } from './ports.js'
import { buildGuardianBrainPrompt, parseDelegationPacket } from './tenx-chat-brain.js'

export type AskBridgeReasoning = 'auto' | 'instant' | 'medium' | 'high'

export interface AskBridgeOutputEvent {
  stream: 'stdout' | 'stderr'
  elapsedMs: number
  line: string
}

export interface AskBridgeTimingEvent {
  phase: 'bridge-command' | 'tab-isolation'
  taskId: string
  iteration: number
  durationMs: number
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

export interface AskBridgeTabIsolationRequest {
  conversationUrl: string
}

export type AskBridgeTabIsolator = (
  request: AskBridgeTabIsolationRequest,
) => Promise<boolean>

export interface AskBridgeBrainOptions {
  command?: string
  conversationUrl?: string
  model?: string
  reasoning?: AskBridgeReasoning
  headless?: boolean
  verbose?: boolean
  timeoutMs?: number
  commandRunner?: AskBridgeCommandRunner
  tabIsolator?: AskBridgeTabIsolator
  onTiming?: (event: AskBridgeTimingEvent) => void
  onDiagnostic?: (event: AskBridgeOutputEvent) => void
}

interface ChromeProcessRecord {
  pid?: number
  browser_id?: string
}

interface ChromeVersionResponse {
  webSocketDebuggerUrl?: string
}

interface ChromeDebugTarget {
  id?: string
  type?: string
  url?: string
}

function defaultAskBridgeCommand(): string {
  return process.platform === 'win32'
    ? join(homedir(), '.local', 'bin', 'ask-bridge.exe')
    : 'ask-bridge'
}

function defaultCommandRunner(request: AskBridgeCommandRequest): Promise<AskBridgeCommandResult> {
  return new Promise((resolve, reject) => {
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
      child.kill()
      closeCapturedStreams()
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\nask-bridge timed out after ${String(request.timeoutMs)}ms`.trim(),
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

function failureDetails(result: AskBridgeCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit=${String(result.exitCode)}`).slice(-4_000)
}

function extractThreadLink(stdout: string): string | undefined {
  const match = /^Thread Link:\s+(https:\/\/chatgpt\.com\/c\/[^\s]+)\s*$/mu.exec(stdout)
  return match?.[1]
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

function browserIdFromWebSocketUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined
  }
  const match = /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):9223\/devtools\/browser\/([^/?#]+)$/u.exec(url)
  return match?.[1]
}

function chatGptConversationKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) {
      return undefined
    }
    const parts = url.pathname.split('/').filter(Boolean)
    const marker = parts.indexOf('c')
    const id = marker >= 0 ? parts[marker + 1] : undefined
    return id === undefined || id.length === 0 ? undefined : id
  } catch {
    return undefined
  }
}

async function readDebugJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:9223${path}`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) {
      return undefined
    }
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

async function askBridgeChromeOwned(): Promise<boolean> {
  try {
    const recordText = await readFile(join(homedir(), '.config', 'ask-bridge', 'chrome.pid'), 'utf8')
    const parsed = JSON.parse(recordText) as ChromeProcessRecord
    const expectedBrowserId = parsed.browser_id
    if (expectedBrowserId === undefined || expectedBrowserId.length === 0) {
      return false
    }
    const version = await readDebugJson<ChromeVersionResponse>('/json/version')
    return browserIdFromWebSocketUrl(version?.webSocketDebuggerUrl) === expectedBrowserId
  } catch {
    return false
  }
}

async function defaultTabIsolator(request: AskBridgeTabIsolationRequest): Promise<boolean> {
  if (!(await askBridgeChromeOwned())) {
    return false
  }

  const expectedKey = chatGptConversationKey(request.conversationUrl)
  if (expectedKey === undefined) {
    return false
  }

  const targets = await readDebugJson<ChromeDebugTarget[]>('/json/list')
  if (targets === undefined) {
    return false
  }

  const chatGptTargets = targets.filter(
    (target) => target.type === 'page' && chatGptConversationKey(target.url) !== undefined,
  )
  const matching = chatGptTargets.filter(
    (target) => chatGptConversationKey(target.url) === expectedKey && target.id !== undefined,
  )
  const keeper = matching[0]
  if (keeper?.id === undefined) {
    return false
  }

  for (const target of chatGptTargets) {
    if (target.id === undefined || target.id === keeper.id) {
      continue
    }
    await fetch(`http://127.0.0.1:9223/json/close/${encodeURIComponent(target.id)}`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)
  }

  await fetch(`http://127.0.0.1:9223/json/activate/${encodeURIComponent(keeper.id)}`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined)

  const refreshed = await readDebugJson<ChromeDebugTarget[]>('/json/list')
  if (refreshed === undefined) {
    return false
  }
  const remainingChatGpt = refreshed.filter(
    (target) => target.type === 'page' && chatGptConversationKey(target.url) !== undefined,
  )
  return (
    remainingChatGpt.length === 1 &&
    chatGptConversationKey(remainingChatGpt[0]?.url) === expectedKey
  )
}

export class AskBridgeBrain implements GuardianBrain {
  private readonly runner: AskBridgeCommandRunner
  private readonly timeoutMs: number
  private readonly command: string
  private readonly headless: boolean
  private readonly tabIsolator: AskBridgeTabIsolator
  private readonly taskConversationUrls = new Map<string, string>()
  private readonly reviewedTaskIds = new Set<string>()
  private readonly isolatedTaskIds = new Set<string>()

  constructor(private readonly options: AskBridgeBrainOptions = {}) {
    this.runner = options.commandRunner ?? defaultCommandRunner
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
    this.command = options.command ?? defaultAskBridgeCommand()
    this.headless = options.headless ?? process.platform !== 'win32'
    this.tabIsolator = options.tabIsolator ?? defaultTabIsolator
  }

  private conversationUrlForTask(taskId: string): string | undefined {
    return this.options.conversationUrl ?? this.taskConversationUrls.get(taskId)
  }

  private buildArgs(
    taskId: string,
    prompt: string,
    outputPath: string,
    reuseExistingTab: boolean,
  ): string[] {
    const args = ['--provider', 'chatgpt', `--headless=${String(this.headless)}`]
    const conversationUrl = this.conversationUrlForTask(taskId)
    const isFirstReview = !this.reviewedTaskIds.has(taskId)

    if (this.options.verbose === true) {
      args.push('--verbose')
    }
    if (isFirstReview && this.options.conversationUrl === undefined) {
      args.push('--new')
    } else if (conversationUrl !== undefined && !reuseExistingTab) {
      args.push('--session-url', conversationUrl)
    }
    if (this.options.model !== undefined && !reuseExistingTab) {
      args.push('--model', this.options.model)
    }
    if (this.options.reasoning !== undefined && !reuseExistingTab) {
      args.push('--reasoning', this.options.reasoning)
    }

    args.push('--timeout', String(Math.ceil(this.timeoutMs / 1000)), '--output', outputPath, prompt)
    return args
  }

  private rememberConversation(taskId: string, stdout: string): void {
    const expectedUrl = this.conversationUrlForTask(taskId)
    const returnedUrl = extractThreadLink(stdout)

    if (expectedUrl !== undefined && returnedUrl !== undefined && returnedUrl !== expectedUrl) {
      throw new Error(
        `ask-bridge switched ChatGPT conversation unexpectedly: expected ${expectedUrl}, got ${returnedUrl}`,
      )
    }

    if (this.options.conversationUrl === undefined && expectedUrl === undefined && returnedUrl !== undefined) {
      this.taskConversationUrls.set(taskId, returnedUrl)
    }
  }

  private async isolateTaskTab(task: GuardianTask): Promise<boolean> {
    if (this.options.conversationUrl !== undefined) {
      return false
    }
    const conversationUrl = this.conversationUrlForTask(task.id)
    if (conversationUrl === undefined) {
      return false
    }
    const startedAt = performance.now()
    const isolated = await this.tabIsolator({ conversationUrl }).catch(() => false)
    this.options.onTiming?.({
      phase: 'tab-isolation',
      taskId: task.id,
      iteration: task.iteration,
      durationMs: performance.now() - startedAt,
    })
    if (isolated) {
      this.isolatedTaskIds.add(task.id)
    } else {
      this.isolatedTaskIds.delete(task.id)
    }
    return isolated
  }

  async review(input: {
    task: GuardianTask
    report?: ExecutionReport
  }): Promise<DelegationPacket> {
    const taskId = input.task.id
    if (this.reviewedTaskIds.has(taskId) && this.conversationUrlForTask(taskId) === undefined) {
      throw new Error(
        `cannot continue Guardian task ${taskId}: first ChatGPT review did not expose a Thread Link`,
      )
    }

    let reuseExistingTab = false
    if (this.reviewedTaskIds.has(taskId) && this.isolatedTaskIds.has(taskId)) {
      reuseExistingTab = await this.isolateTaskTab(input.task)
    }

    const prompt = buildGuardianBrainPrompt(input)
    const outputPath = join(tmpdir(), `novawing-ask-bridge-${randomUUID()}.md`)
    const startedAt = performance.now()

    try {
      const result = await this.runner({
        executable: this.command,
        args: this.buildArgs(taskId, prompt, outputPath, reuseExistingTab),
        timeoutMs: this.timeoutMs + 15_000,
        ...(this.options.onDiagnostic === undefined ? {} : { onOutput: this.options.onDiagnostic }),
      })

      this.options.onTiming?.({
        phase: 'bridge-command',
        taskId,
        iteration: input.task.iteration,
        durationMs: performance.now() - startedAt,
      })

      if (result.exitCode !== 0) {
        throw new Error(`ask-bridge failed: ${failureDetails(result)}`)
      }

      this.rememberConversation(taskId, result.stdout)

      const response = await readBridgeOutput(outputPath, result.stdout)
      if (response.length === 0) {
        throw new Error(`ask-bridge returned empty response: ${failureDetails(result)}`)
      }

      const packet = parseDelegationPacket(response)
      this.reviewedTaskIds.add(taskId)
      await this.isolateTaskTab(input.task)
      return packet
    } finally {
      await unlink(outputPath).catch(() => {})
    }
  }
}
