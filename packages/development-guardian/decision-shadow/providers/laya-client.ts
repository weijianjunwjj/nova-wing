import type { DecisionClient, DecisionClientOutcome } from '../client.js'
import { buildSystemOneRequest, parseChoiceResponse, type DecisionShadowStateProjection } from '../contract.js'

export interface LayaClientOptions {
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

/** Local/self-hosted Laya adapter for its Jev-compatible SystemOne endpoint. */
export class LayaClient implements DecisionClient {
  private readonly model: string | undefined
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly request: typeof fetch
  private readonly now: () => number

  constructor(options: LayaClientOptions = {}) {
    this.model = options.model?.trim() || undefined
    this.baseUrl = (options.baseUrl?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/u, '')
    this.timeoutMs = options.timeoutMs ?? 2_000
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  async decide(state: DecisionShadowStateProjection): Promise<DecisionClientOutcome> {
    const started = this.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      const response = await this.request(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSystemOneRequest(this.model, state)),
        signal: controller.signal,
      })
      const latencyMs = Math.max(0, this.now() - started)
      if (!response.ok) return { status: 'http_error', latencyMs }
      let body: unknown
      try { body = await response.json() } catch { return { status: 'invalid_response', latencyMs } }
      const decision = parseChoiceResponse(body)
      return decision === undefined ? { status: 'invalid_response', latencyMs } : { status: 'ok', latencyMs, decision }
    } catch {
      return { status: timedOut ? 'timeout' : 'exception', latencyMs: Math.max(0, this.now() - started) }
    } finally {
      clearTimeout(timer)
    }
  }
}
