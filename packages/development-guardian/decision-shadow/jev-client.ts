import { buildJevSystemOneRequest, parseJevChoiceResponse, type JevChoiceDecision, type JevShadowStateProjection } from './jev-contract.js'

export type JevClientOutcome =
  | { status: 'ok'; latencyMs: number; decision: JevChoiceDecision }
  | { status: 'timeout' | 'http_error' | 'invalid_response' | 'exception'; latencyMs: number }

export interface JevDecisionClient {
  decide(state: JevShadowStateProjection): Promise<JevClientOutcome>
}

export interface JevClientOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

export class JevClient implements JevDecisionClient {
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly request: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: JevClientOptions) {
    this.model = options.model?.trim() || 'jev-latest'
    this.baseUrl = (options.baseUrl?.trim() || 'https://api.typesafe.ai').replace(/\/+$/u, '')
    this.timeoutMs = options.timeoutMs ?? 2_000
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  async decide(state: JevShadowStateProjection): Promise<JevClientOutcome> {
    const started = this.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      const response = await this.request(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildJevSystemOneRequest(this.model, state)),
        signal: controller.signal,
      })
      const latencyMs = Math.max(0, this.now() - started)
      if (!response.ok) return { status: 'http_error', latencyMs }
      let body: unknown
      try { body = await response.json() } catch { return { status: 'invalid_response', latencyMs } }
      const decision = parseJevChoiceResponse(body)
      return decision === undefined ? { status: 'invalid_response', latencyMs } : { status: 'ok', latencyMs, decision }
    } catch {
      return { status: timedOut ? 'timeout' : 'exception', latencyMs: Math.max(0, this.now() - started) }
    } finally {
      clearTimeout(timer)
    }
  }
}
