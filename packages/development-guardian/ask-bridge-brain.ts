import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DelegationPacket, ExecutionReport, GuardianTask } from './model.js'
import type { GuardianBrain } from './ports.js'
import { buildGuardianBrainPrompt, parseDelegationPacket } from './tenx-chat-brain.js'

export type AskBridgeReasoning = 'auto' | 'instant' | 'medium' | 'high'

export interface AskBridgeCommandRequest {
  executable: string
  args: readonly string[]
  timeoutMs: number
}

export interface AskBridgeCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type AskBridgeCommandRunner = (
  request: AskBridgeCommandRequest,
) => Promise<AskBridgeCommandResult>

export interface AskBridgeBrainOptions {
  command?: string
  conversationUrl?: string
  model?: string
  reasoning?: AskBridgeReasoning
  timeoutMs?: number
  commandRunner?: AskBridgeCommandRunner
}

function defaultAskBridgeCommand(): string {
  return process.platform === 'win32'
    ? join(homedir(), '.local', 'bin', 'ask-bridge.exe')
    : 'ask-bridge'
}

function defaultCommandRunner(request: AskBridgeCommandRequest): Promise<AskBridgeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnAskBridge(request)
    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-100_000)
    })

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill()
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
      reject(error)
    })

    child.once('exit', (exitCode) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

function spawnAskBridge(request: AskBridgeCommandRequest) {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')
  return spawn(request.executable, [...request.args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
}

function failureDetails(result: AskBridgeCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit=${String(result.exitCode)}`).slice(-4_000)
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

  constructor(private readonly options: AskBridgeBrainOptions = {}) {
    this.runner = options.commandRunner ?? defaultCommandRunner
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
    this.command = options.command ?? defaultAskBridgeCommand()
  }

  private buildArgs(prompt: string, outputPath: string): string[] {
    const args = ['--provider', 'chatgpt']

    if (this.options.conversationUrl !== undefined) {
      args.push('--session-url', this.options.conversationUrl)
    }
    if (this.options.model !== undefined) {
      args.push('--model', this.options.model)
    }
    if (this.options.reasoning !== undefined) {
      args.push('--reasoning', this.options.reasoning)
    }

    args.push('--timeout', String(Math.ceil(this.timeoutMs / 1000)), '--output', outputPath, prompt)
    return args
  }

  async review(input: {
    task: GuardianTask
    report?: ExecutionReport
  }): Promise<DelegationPacket> {
    const prompt = buildGuardianBrainPrompt(input)
    const outputPath = join(tmpdir(), `novawing-ask-bridge-${randomUUID()}.md`)

    try {
      const result = await this.runner({
        executable: this.command,
        args: this.buildArgs(prompt, outputPath),
        timeoutMs: this.timeoutMs + 15_000,
      })

      if (result.exitCode !== 0) {
        throw new Error(`ask-bridge failed: ${failureDetails(result)}`)
      }

      const response = await readBridgeOutput(outputPath, result.stdout)
      if (response.length === 0) {
        throw new Error(`ask-bridge returned empty response: ${failureDetails(result)}`)
      }

      return parseDelegationPacket(response)
    } finally {
      await unlink(outputPath).catch(() => {})
    }
  }
}
