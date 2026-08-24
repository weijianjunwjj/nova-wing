import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { guardianShellCommand } from './shell-contract.js'

export const TEN_X_CHAT_PINNED_VERSION = 'latest'

export type TenXChatDelegateAction =
  | 'status'
  | 'goto'
  | 'selectModel'
  | 'attach'
  | 'submit'
  | 'capture'
  | 'chat'
  | 'eval'
  | 'close'

export interface TenXChatCapturedResponse {
  text: string
  markdown: string
  model?: string
  thinkingTime?: number
  truncated: boolean
}

export interface TenXChatDelegateRequest {
  action: TenXChatDelegateAction
  url?: string
  model?: string
  files?: readonly string[]
  prompt?: string
  timeoutMs?: number
  script?: string
}

export interface TenXChatDelegateResponse {
  ok: boolean
  id?: string | number
  action?: string
  provider?: string
  url?: string
  title?: string
  loggedIn?: boolean
  result?: unknown
  response?: TenXChatCapturedResponse
  error?: string
}

export interface TenXChatDelegateTransport {
  request(request: TenXChatDelegateRequest): Promise<TenXChatDelegateResponse>
  close(): Promise<void>
}

export interface TenXChatProcessTransportOptions {
  timeoutMs?: number
  command?: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Deployment override for the Windows native Git Bash executable. */
  gitBashPath?: string
  /** Internal platform seam; production defaults to process.platform. */
  platform?: NodeJS.Platform
}

interface PendingRequest {
  resolve(value: TenXChatDelegateResponse): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export function createDefaultTenXChatCommand(
  timeoutMs: number,
  options: Pick<TenXChatProcessTransportOptions, 'gitBashPath' | 'platform' | 'env'> = {},
): { command: string; args: string[]; nativeGitBash?: true } {
  if ((options.platform ?? process.platform) === 'win32') {
    const command = guardianShellCommand(
      `exec npx --yes 10x-chat@${TEN_X_CHAT_PINNED_VERSION} delegate chatgpt --headed --timeout ${timeoutMs}`,
      options,
    )
    return {
      command: command.executable,
      args: command.args,
      ...(command.nativeGitBash === true ? { nativeGitBash: true } : {}),
    }
  }

  return {
    command: 'npx',
    args: [
      '--yes',
      `10x-chat@${TEN_X_CHAT_PINNED_VERSION}`,
      'delegate',
      'chatgpt',
      '--headed',
      '--timeout',
      String(timeoutMs),
    ],
  }
}

function describeProcessFailure(stderr: string, fallback: string): Error {
  const details = stderr.trim()
  return new Error(details.length > 0 ? `${fallback}: ${details}` : fallback)
}

export function createTenXChatProcessTransport(
  options: TenXChatProcessTransportOptions = {},
): TenXChatDelegateTransport {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const defaults = createDefaultTenXChatCommand(timeoutMs, options)
  const command = options.command ?? defaults.command
  const args = [...(options.args ?? defaults.args)]
  const child = spawn(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
    shell: false,
  })

  const pending = new Map<string, PendingRequest>()
  let nextId = 1
  let closed = false
  let readySettled = false
  let stderr = ''
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return
    }

    let response: TenXChatDelegateResponse
    try {
      response = JSON.parse(trimmed) as TenXChatDelegateResponse
    } catch {
      return
    }

    if (response.action === 'ready' && !readySettled) {
      readySettled = true
      if (response.ok) {
        readyResolve()
      } else {
        readyReject(new Error(response.error ?? '10x-chat delegate failed to become ready'))
      }
      return
    }

    if (response.id === undefined && !readySettled && !response.ok) {
      readySettled = true
      readyReject(new Error(response.error ?? '10x-chat delegate failed before ready'))
      return
    }

    if (response.id === undefined) {
      return
    }

    const key = String(response.id)
    const entry = pending.get(key)
    if (entry === undefined) {
      return
    }

    pending.delete(key)
    clearTimeout(entry.timer)
    if (!response.ok) {
      entry.reject(new Error(response.error ?? `10x-chat delegate action failed: ${response.action ?? 'unknown'}`))
      return
    }
    entry.resolve(response)
  })

  child.once('error', (error) => {
    if (!readySettled) {
      readySettled = true
      readyReject(error)
    }
    rejectAll(error)
  })

  child.once('exit', (code, signal) => {
    closed = true
    const error = describeProcessFailure(
      stderr,
      `10x-chat delegate exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    )
    if (!readySettled) {
      readySettled = true
      readyReject(error)
    }
    rejectAll(error)
  })

  const transport: TenXChatDelegateTransport = {
    async request(request) {
      if (closed) {
        throw new Error('10x-chat delegate is closed')
      }
      await ready

      const id = nextId
      nextId += 1
      const key = String(id)
      const payload = { ...request, id }

      return new Promise<TenXChatDelegateResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key)
          reject(new Error(`10x-chat delegate request timed out: ${request.action}`))
        }, request.timeoutMs ?? timeoutMs)

        pending.set(key, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error === null || error === undefined) {
            return
          }
          const entry = pending.get(key)
          if (entry !== undefined) {
            pending.delete(key)
            clearTimeout(entry.timer)
            entry.reject(error)
          }
        })
      })
    },

    async close() {
      if (closed) {
        return
      }
      try {
        await transport.request({ action: 'close', timeoutMs: 10_000 })
      } catch {
        child.kill()
      } finally {
        closed = true
        rl.close()
      }
    },
  }

  return transport
}
