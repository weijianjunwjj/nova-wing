import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

interface CapturedResponse {
  text: string
  markdown: string
  model?: string
  thinkingTime?: number
  truncated: boolean
}

interface DelegateResponse {
  ok: boolean
  id?: string | number
  action?: string
  response?: CapturedResponse
  error?: string
}

interface PendingRequest {
  resolve: (value: DelegateResponse) => void
  reject: (reason?: unknown) => void
  timer: NodeJS.Timeout
}

export interface ChatGptWebAdapterOptions {
  headed?: boolean
  timeoutMs?: number
  model?: string
}

export class ChatGptWebAdapter {
  readonly #options: Required<Pick<ChatGptWebAdapterOptions, 'headed' | 'timeoutMs'>> &
    Pick<ChatGptWebAdapterOptions, 'model'>
  #child: ChildProcessWithoutNullStreams | undefined
  #nextId = 1
  readonly #pending = new Map<number, PendingRequest>()

  constructor(options: ChatGptWebAdapterOptions = {}) {
    this.#options = {
      headed: options.headed ?? true,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.model ? { model: options.model } : {}),
    }
  }

  async start(): Promise<void> {
    if (this.#child) return

    const args = ['10x-chat@latest', 'delegate', 'chatgpt', '--timeout', String(this.#options.timeoutMs)]
    if (this.#options.headed) args.push('--headed')
    if (this.#options.model) args.push('--model', this.#options.model)

    const child = spawn('npx', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    this.#child = child

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.#handleLine(line))
    child.stderr.on('data', () => {})
    child.once('exit', (code, signal) => {
      const error = new Error(`10x-chat delegate exited: code=${String(code)} signal=${String(signal)}`)
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.#pending.clear()
      this.#child = undefined
    })

    const ready = await this.#waitForReady()
    if (!ready.ok) throw new Error(ready.error ?? 'ChatGPT delegate failed to start')
  }

  async chat(prompt: string): Promise<CapturedResponse> {
    await this.start()
    const response = await this.#request({ action: 'chat', prompt, timeoutMs: this.#options.timeoutMs })
    if (!response.ok || !response.response) {
      throw new Error(response.error ?? 'ChatGPT delegate returned no response')
    }
    if (response.response.truncated) {
      throw new Error('ChatGPT response was truncated; refusing to continue automatically')
    }
    return response.response
  }

  async goto(url: string): Promise<void> {
    await this.start()
    const response = await this.#request({ action: 'goto', url })
    if (!response.ok) throw new Error(response.error ?? 'Failed to navigate ChatGPT')
  }

  async close(): Promise<void> {
    if (!this.#child) return
    await this.#request({ action: 'close' }).catch(() => {})
    this.#child = undefined
  }

  #handleLine(line: string): void {
    let parsed: DelegateResponse
    try {
      parsed = JSON.parse(line) as DelegateResponse
    } catch {
      return
    }

    if (parsed.action === 'ready' && parsed.id === undefined) {
      const pending = this.#pending.get(0)
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(0)
      pending.resolve(parsed)
      return
    }

    if (typeof parsed.id !== 'number') return
    const pending = this.#pending.get(parsed.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(parsed.id)
    pending.resolve(parsed)
  }

  #waitForReady(): Promise<DelegateResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(0)
        reject(new Error('Timed out waiting for 10x-chat delegate readiness'))
      }, 60_000)
      this.#pending.set(0, { resolve, reject, timer })
    })
  }

  #request(payload: Record<string, unknown>): Promise<DelegateResponse> {
    const child = this.#child
    if (!child) return Promise.reject(new Error('ChatGPT delegate is not running'))

    const id = this.#nextId++
    const line = `${JSON.stringify({ id, ...payload })}\n`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Timed out waiting for delegate response: ${String(payload.action)}`))
      }, this.#options.timeoutMs + 30_000)
      this.#pending.set(id, { resolve, reject, timer })
      child.stdin.write(line)
    })
  }
}
