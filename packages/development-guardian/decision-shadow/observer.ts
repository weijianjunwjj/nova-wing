import type { DecisionReasonCode } from '../work-session/task-observability.js'
import type { TaskAction } from '../work-session/task-controller.js'
import type { DecisionClient } from './client.js'
import type { DecisionShadowStateProjection, DecisionShadowStatus } from './contract.js'
import { FileDecisionShadowStore, type DecisionShadowStore } from './store.js'

export interface ShadowDecisionObservation {
  sessionId: string
  taskId: string
  projection: DecisionShadowStateProjection
  reference: { action: TaskAction; reasonCode: DecisionReasonCode }
}

export interface ShadowDecisionObserver {
  /** Fire-and-forget only: this API deliberately cannot return or dispatch an action. */
  observe(input: ShadowDecisionObservation): void
}

export interface DecisionShadowRecord {
  schemaVersion: 1
  timestamp: string
  sessionId: string
  taskId: string
  decisionPoint: 'task-controller.next-action'
  reference: { action: TaskAction; reasonCode: DecisionReasonCode }
  shadow: {
    status: DecisionShadowStatus
    provider: string
    model: string
    action: TaskAction | null
    confidence: number | null
    probabilities: Partial<Record<TaskAction, number>> | null
    latencyMs: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
  match: boolean | null
  projection: DecisionShadowStateProjection
}

export interface DecisionShadowObserverOptions {
  enabled: boolean
  provider: string
  model?: string
  client?: DecisionClient
  store?: DecisionShadowStore
  now?: () => Date
}

export class DecisionShadowObserver implements ShadowDecisionObserver {
  private readonly model: string
  private readonly store: DecisionShadowStore
  private readonly now: () => Date
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly options: DecisionShadowObserverOptions) {
    this.model = options.model?.trim() || 'router'
    this.store = options.store ?? new FileDecisionShadowStore()
    this.now = options.now ?? (() => new Date())
  }

  observe(input: ShadowDecisionObservation): void {
    const work = this.capture(input).catch(() => undefined)
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
  }

  /** Test/CLI lifecycle hook; the task runner never waits on this. */
  async settled(): Promise<void> { await Promise.all([...this.pending]) }

  private base(input: ShadowDecisionObservation, status: DecisionShadowStatus): DecisionShadowRecord {
    return {
      schemaVersion: 1,
      timestamp: this.now().toISOString(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      decisionPoint: 'task-controller.next-action',
      reference: { ...input.reference },
      shadow: { status, provider: this.options.provider, model: this.model, action: null, confidence: null, probabilities: null, latencyMs: null, inputTokens: null, outputTokens: null },
      match: null,
      projection: input.projection,
    }
  }

  private async capture(input: ShadowDecisionObservation): Promise<void> {
    if (!this.options.enabled) { await this.store.append(this.base(input, 'disabled')); return }
    const client = this.options.client
    if (client === undefined) { await this.store.append(this.base(input, 'exception')); return }
    let outcome: Awaited<ReturnType<DecisionClient['decide']>>
    try { outcome = await client.decide(input.projection) } catch { outcome = { status: 'exception', latencyMs: 0 } }
    const record = this.base(input, outcome.status)
    if (outcome.status === 'ok') {
      record.shadow = {
        status: 'ok', provider: this.options.provider, model: outcome.decision.model, action: outcome.decision.action, confidence: outcome.decision.confidence,
        probabilities: outcome.decision.probabilities, latencyMs: outcome.latencyMs,
        inputTokens: outcome.decision.inputTokens, outputTokens: outcome.decision.outputTokens,
      }
      record.match = outcome.decision.action === input.reference.action
    } else record.shadow.latencyMs = outcome.latencyMs
    await this.store.append(record)
  }
}
