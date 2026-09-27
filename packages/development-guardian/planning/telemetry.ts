import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export type PlanningEventType =
  | 'requirement.received' | 'planning.started' | 'requirement.analyzed'
  | 'development_plan.generated' | 'plan.validation_failed' | 'plan.validation_passed'
  | 'customer_question.required' | 'plan.approved'
  | 'planning.semantic_review.started' | 'planning.semantic_review.passed' | 'planning.semantic_review.failed'
  | 'planning.repair.started' | 'planning.repair.completed'

export interface ModelInvocation {
  purpose: 'development_planning'
  provider: string
  model: string
  startedAt: string
  endedAt: string
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  estimatedCost?: number
  outcome: 'completed' | 'failed'
}

export interface NovaWingEvent {
  id: string
  timestamp: string
  planningSessionId: string
  type: PlanningEventType
  actorRole: 'customer' | 'planning' | 'validator'
  provider?: string
  model?: string
  durationMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  estimatedCost?: number
  /** Closed, numeric metadata only. Requirement text and provider diagnostics never enter this field. */
  metadata: { planVersion?: number; clauseCount?: number; taskCount?: number; issueCount?: number; questionCount?: number; repairCount?: number }
}

export class PlanningEventStore {
  constructor(readonly path: string) {}

  async append(event: Omit<NovaWingEvent, 'id' | 'timestamp'>): Promise<void> {
    // Only registered provider names and model ID grammars may enter long-lived
    // telemetry. Arbitrary runner strings can contain credentials or diagnostics.
    const safeProvider = (value: string | undefined): string | undefined =>
      value !== undefined && /^(?:codex|openai|deepseek|anthropic)$/u.test(value) ? value : undefined
    const safeModel = (value: string | undefined): string | undefined =>
      value !== undefined && /^(?:gpt-[0-9]+(?:\.[0-9]+)?-[a-z][a-z0-9-]*|o[0-9]+(?:-[a-z0-9-]+)?|deepseek-[a-z0-9-]+|claude-[a-z0-9-]+)$/u.test(value) && value.length <= 80 ? value : undefined
    const safeCount = (value: number | undefined): number | undefined =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const safeMoney = (value: number | undefined): number | undefined =>
      value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
    const safeEvent: NovaWingEvent = {
      id: randomUUID(), timestamp: new Date().toISOString(), planningSessionId: event.planningSessionId,
      type: event.type, actorRole: event.actorRole,
      ...(safeProvider(event.provider) === undefined ? {} : { provider: safeProvider(event.provider)! }),
      ...(safeModel(event.model) === undefined ? {} : { model: safeModel(event.model)! }),
      ...(safeCount(event.durationMs) === undefined ? {} : { durationMs: safeCount(event.durationMs)! }),
      ...(event.usage === undefined ? {} : { usage: {
        ...(safeCount(event.usage.inputTokens) === undefined ? {} : { inputTokens: safeCount(event.usage.inputTokens)! }),
        ...(safeCount(event.usage.outputTokens) === undefined ? {} : { outputTokens: safeCount(event.usage.outputTokens)! }),
        ...(safeCount(event.usage.cachedTokens) === undefined ? {} : { cachedTokens: safeCount(event.usage.cachedTokens)! }),
      } }),
      ...(safeMoney(event.estimatedCost) === undefined ? {} : { estimatedCost: safeMoney(event.estimatedCost)! }),
      metadata: {
        ...(safeCount(event.metadata.planVersion) === undefined ? {} : { planVersion: safeCount(event.metadata.planVersion)! }),
        ...(safeCount(event.metadata.clauseCount) === undefined ? {} : { clauseCount: safeCount(event.metadata.clauseCount)! }),
        ...(safeCount(event.metadata.taskCount) === undefined ? {} : { taskCount: safeCount(event.metadata.taskCount)! }),
        ...(safeCount(event.metadata.issueCount) === undefined ? {} : { issueCount: safeCount(event.metadata.issueCount)! }),
        ...(safeCount(event.metadata.questionCount) === undefined ? {} : { questionCount: safeCount(event.metadata.questionCount)! }),
        ...(safeCount(event.metadata.repairCount) === undefined ? {} : { repairCount: safeCount(event.metadata.repairCount)! }),
      },
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const handle = await open(this.path, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(safeEvent)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  }
}
