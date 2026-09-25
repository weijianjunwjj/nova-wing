import type { TaskAction } from '../work-session/task-controller.js'

export const TASK_ACTIONS = ['ANALYZE', 'EXECUTE', 'VERIFY', 'REVIEW', 'REQUEST_APPROVAL', 'RECONCILE', 'SUSPEND', 'COMPLETE'] as const satisfies readonly TaskAction[]

export type DecisionShadowStatus = 'ok' | 'disabled' | 'timeout' | 'http_error' | 'invalid_response' | 'exception'

export interface DecisionShadowStateProjection {
  taskStatus: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'FAILED'
  reconciliationRequired: boolean
  blockerCount: number
  acceptanceCriteriaCount: number
  unmappedAcceptanceCriteriaCount: number
  runtimeOnlyAcceptance: boolean
  verifyOnly: boolean
  verification: {
    total: number
    passed: number
    failed: number
    skipped: number
    classifications: Record<'CODE_FAILURE' | 'ENVIRONMENT_FAILURE' | 'VERIFIER_CONFIGURATION_FAILURE' | 'UNRELATED_TEST_FAILURE' | 'EVIDENCE_MISSING' | 'UNKNOWN', number>
  }
  review: { exists: boolean; passed: boolean }
  approval: { requiredByBinding: boolean; satisfied: boolean }
  risk: { level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; factorsCount: number }
  evidence: { passedCount: number; failedCount: number; missingCount: number; staleCount: number; nonDeterministicCount: number }
}

export interface DecisionChoice {
  model: string
  action: TaskAction
  confidence: number
  probabilities: Partial<Record<TaskAction, number>>
  inputTokens: number
  outputTokens: number
}

export interface SystemOneRequest {
  model?: string
  state: DecisionShadowStateProjection
  questions: {
    next_action: {
      type: 'choice'
      instructions: string
      criteria: Record<TaskAction, string>
    }
  }
}

const ACTION_SET = new Set<string>(TASK_ACTIONS)

export function isTaskAction(value: unknown): value is TaskAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

export const NEXT_ACTION_CRITERIA: Record<TaskAction, string> = {
  RECONCILE: 'Repository facts disagree with persisted task facts and must be reconciled before any other action.',
  SUSPEND: 'The task is failed, blocked, lacks an evidence binding, has an unsafe or unattributed verification failure, or a verify-only task requires implementation changes.',
  ANALYZE: 'Acceptance criteria have not yet been established.',
  EXECUTE: 'Implementation has not started, code-attributed verification failed, or an independent review requires an implementation revision.',
  VERIFY: 'Deterministic verification or fresh bound evidence is still missing, failed evidence has been repaired, or a pending verify-only task should skip implementation.',
  REVIEW: 'A high-risk implementation has valid deterministic evidence but still needs a passing independent review.',
  REQUEST_APPROVAL: 'The task is already suspended awaiting a human decision, or critical/binding policy requires approval that is not satisfied.',
  COMPLETE: 'All acceptance bindings have fresh deterministic passing evidence and every required review and approval is satisfied.',
}

export function buildSystemOneRequest(model: string | undefined, state: DecisionShadowStateProjection): SystemOneRequest {
  return {
    ...(model === undefined ? {} : { model }),
    state,
    questions: {
      next_action: {
        type: 'choice',
        instructions: 'Choose the safest and correct next action for this software task controller state. Apply safety gates before progress actions.',
        criteria: NEXT_ACTION_CRITERIA,
      },
    },
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Strictly validates the one response shape this experiment accepts. */
export function parseChoiceResponse(value: unknown): DecisionChoice | undefined {
  const response = object(value)
  const answers = object(response?.answers)
  const answer = object(answers?.next_action)
  const usage = object(response?.usage)
  if (typeof response?.model !== 'string' || response.model.length === 0 || answer?.type !== 'choice' || !isTaskAction(answer.choice)) return undefined
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return undefined
  const probabilities = object(answer.probabilities)
  if (probabilities === undefined || Object.keys(probabilities).length !== TASK_ACTIONS.length) return undefined
  let sum = 0
  const parsed: Partial<Record<TaskAction, number>> = {}
  for (const [key, probability] of Object.entries(probabilities)) {
    if (!isTaskAction(key) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return undefined
    parsed[key] = probability
    sum += probability
  }
  if (sum < 0.99 || sum > 1.01) return undefined
  const inputTokens = usage?.input_tokens
  const outputTokens = usage?.output_tokens
  if (!Number.isInteger(inputTokens) || (inputTokens as number) < 0 || !Number.isInteger(outputTokens) || (outputTokens as number) < 0) return undefined
  return { model: response.model, action: answer.choice, confidence: answer.confidence, probabilities: parsed, inputTokens: inputTokens as number, outputTokens: outputTokens as number }
}
