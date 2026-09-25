import type { DecisionReasonCode } from '../work-session/task-observability.js'
import type { TaskAction } from '../work-session/task-controller.js'
import type { JevDecisionClient } from './jev-client.js'
import { JevClient } from './jev-client.js'
import type { JevShadowStateProjection, JevShadowStatus } from './jev-contract.js'
import { FileJevShadowStore, type JevShadowStore } from './jev-shadow-store.js'

export interface ShadowDecisionObservation {
  sessionId: string
  taskId: string
  projection: JevShadowStateProjection
  reference: { action: TaskAction; reasonCode: DecisionReasonCode }
}

export interface ShadowDecisionObserver {
  /** Fire-and-forget only: this API deliberately cannot return or dispatch an action. */
  observe(input: ShadowDecisionObservation): void
}

export interface JevShadowRecord {
  schemaVersion: 1
  timestamp: string
  sessionId: string
  taskId: string
  decisionPoint: 'task-controller.next-action'
  reference: { action: TaskAction; reasonCode: DecisionReasonCode }
  shadow: {
    status: JevShadowStatus
    model: string
    action: TaskAction | null
    confidence: number | null
    probabilities: Partial<Record<TaskAction, number>> | null
    latencyMs: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
  match: boolean | null
  projection: JevShadowStateProjection
}

export interface JevShadowObserverOptions {
  enabled: boolean
  model?: string
  apiKey?: string
  client?: JevDecisionClient
  store?: JevShadowStore
  now?: () => Date
}

export class JevShadowObserver implements ShadowDecisionObserver {
  private readonly model: string
  private readonly store: JevShadowStore
  private readonly now: () => Date
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly options: JevShadowObserverOptions) {
    this.model = options.model?.trim() || 'jev-latest'
    this.store = options.store ?? new FileJevShadowStore()
    this.now = options.now ?? (() => new Date())
  }

  observe(input: ShadowDecisionObservation): void {
    const work = this.capture(input).catch(() => undefined)
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
  }

  /** Test/CLI lifecycle hook; the task runner never waits on this. */
  async settled(): Promise<void> { await Promise.all([...this.pending]) }

  private base(input: ShadowDecisionObservation, status: JevShadowStatus): JevShadowRecord {
    return {
      schemaVersion: 1,
      timestamp: this.now().toISOString(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      decisionPoint: 'task-controller.next-action',
      reference: { ...input.reference },
      shadow: { status, model: this.model, action: null, confidence: null, probabilities: null, latencyMs: null, inputTokens: null, outputTokens: null },
      match: null,
      projection: input.projection,
    }
  }

  private async capture(input: ShadowDecisionObservation): Promise<void> {
    if (!this.options.enabled) { await this.store.append(this.base(input, 'disabled')); return }
    if (!this.options.apiKey?.trim() && this.options.client === undefined) { await this.store.append(this.base(input, 'missing_api_key')); return }
    const client = this.options.client ?? new JevClient({ apiKey: this.options.apiKey!, model: this.model })
    let outcome: Awaited<ReturnType<JevDecisionClient['decide']>>
    try { outcome = await client.decide(input.projection) } catch { outcome = { status: 'exception', latencyMs: 0 } }
    const record = this.base(input, outcome.status)
    if (outcome.status === 'ok') {
      record.shadow = {
        status: 'ok', model: outcome.decision.model, action: outcome.decision.action, confidence: outcome.decision.confidence,
        probabilities: outcome.decision.probabilities, latencyMs: outcome.latencyMs,
        inputTokens: outcome.decision.inputTokens, outputTokens: outcome.decision.outputTokens,
      }
      record.match = outcome.decision.action === input.reference.action
    } else record.shadow.latencyMs = outcome.latencyMs
    await this.store.append(record)
  }
}

export function createJevShadowObserverFromEnv(options: { env?: NodeJS.ProcessEnv; store?: JevShadowStore; client?: JevDecisionClient } = {}): JevShadowObserver | undefined {
  const env = options.env ?? process.env
  if (env.NOVAWING_JEV_SHADOW !== '1') return undefined
  const model = env.NOVAWING_JEV_MODEL?.trim() || 'jev-latest'
  const apiKey = env.TYPESAFE_API_KEY?.trim() || undefined
  const client = options.client ?? (apiKey === undefined ? undefined : new JevClient({
    apiKey,
    model,
    baseUrl: env.NOVAWING_JEV_BASE_URL?.trim() || 'https://api.typesafe.ai',
  }))
  return new JevShadowObserver({ enabled: true, model, ...(apiKey === undefined ? {} : { apiKey }), ...(client === undefined ? {} : { client }), ...(options.store === undefined ? {} : { store: options.store }) })
}
