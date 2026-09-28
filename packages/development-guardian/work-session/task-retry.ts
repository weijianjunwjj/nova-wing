import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createTaskStateV2, type TaskStateV2 } from './task-state-v2.js'
import { TaskController } from './task-controller.js'
import type { WorkSessionDefinition } from './model.js'
import { bindingsFromVerificationPlan, verificationPlanFingerprintValid } from './verification-planner.js'

export const TASK_RETRY_REASON = 'RUNTIME_EXECUTION_RESULT_INVALIDATED' as const
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const taskRetryRequestSchema = z.object({
  sessionId: z.string().min(1), workflowRunId: z.string().min(1), taskId: z.string().min(1),
  expectedGeneration: z.number().int().nonnegative(),
  expectedWorkflowState: z.literal('SUSPENDED'), expectedTaskState: z.literal('SUSPENDED'),
  expectedCurrentAction: z.string().min(1),
  sourceSnapshotId: z.string().uuid(), sourcePlanHash: hash, runtimePlanHash: hash,
  targetBindingId: hash, targetBaselineCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  reasonCode: z.literal(TASK_RETRY_REASON),
}).strict()
export type TaskRetryRequest = z.infer<typeof taskRetryRequestSchema>
export const taskRetryReceiptSchema = z.object({
  receiptId: hash, sessionId: z.string().min(1), workflowRunId: z.string().min(1), taskId: z.string().min(1),
  previousAttemptId: hash, attemptId: hash, generation: z.number().int().positive(),
  reasonCode: z.literal(TASK_RETRY_REASON), timestamp: z.iso.datetime(), nextDecision: z.literal('EXECUTE'),
}).strict()
export type TaskRetryReceipt = z.infer<typeof taskRetryReceiptSchema>
export const taskRetryPendingSchema = z.object({ request: taskRetryRequestSchema, receipt: taskRetryReceiptSchema,
  phase: z.enum(['PENDING', 'RESUME_CLAIMED', 'RESUMED']) }).strict().superRefine((pending, context) => {
  const { request, receipt } = pending
  if (receipt.receiptId !== taskRetryRequestId(request) || receipt.attemptId !== receipt.receiptId ||
    receipt.sessionId !== request.sessionId || receipt.workflowRunId !== request.workflowRunId ||
    receipt.taskId !== request.taskId || receipt.generation !== request.expectedGeneration + 1) {
    context.addIssue({ code: 'custom', message: 'TASK_RETRY_RECEIPT_MISMATCH' })
  }
})
export type TaskRetryPending = z.infer<typeof taskRetryPendingSchema>
export interface TaskRetryAuthority {
  /** Validates fresh persisted frozen/runtime binding and the exact clean baseline. */
  validate(request: TaskRetryRequest, definition: WorkSessionDefinition): Promise<void>
  /** Cross-process session mutation lock; no timeout-based or PID-based theft. */
  acquireSession(): () => void
  /** Uses the same ownership namespace as every production Executor. */
  acquireWorkspace(): Promise<() => void>
}
export function taskRetryRequestId(request: TaskRetryRequest): string {
  return createHash('sha256').update('novawing-task-retry-v1\0').update(JSON.stringify(taskRetryRequestSchema.parse(request))).digest('hex')
}
export function legacyTaskAttemptId(sessionId: string, taskId: string, generation: number): string {
  return createHash('sha256').update('novawing-legacy-attempt-v1\0').update(JSON.stringify([sessionId, taskId, generation])).digest('hex')
}

export function retryTaskProjection(definition: WorkSessionDefinition, previous: TaskStateV2, attemptId: string): TaskStateV2 {
  const task = definition.tasks.find(item => item.id === previous.identity.taskId)
  if (!task || previous.identity.sessionId !== definition.id) throw new Error('TASK_RETRY_TASK_MISMATCH')
  const initial = createTaskStateV2(definition, task)
  const bindings = previous.verificationPlan !== undefined && verificationPlanFingerprintValid(previous.verificationPlan)
    ? bindingsFromVerificationPlan(previous.verificationPlan, { identity: 'step' }) : initial.completion.bindings
  const policy = (state: TaskStateV2, expectedBindings = state.completion.bindings) =>
    JSON.stringify([state.goal, state.constraints, state.acceptanceCriteria, state.permissions, expectedBindings, state.risk])
  if (policy(previous) !== policy(initial, bindings)) throw new Error('TASK_RETRY_POLICY_DRIFT')
  const budget = previous.actionBudget
  if (!budget || budget.recoveryExhausted || (budget.originalExhausted
    ? !budget.recoveryGranted || budget.recoveryConsumed >= budget.recoveryLimit
    : budget.originalConsumed >= budget.originalLimit)) throw new Error('TASK_RETRY_BUDGET_EXHAUSTED')
  const projected: TaskStateV2 = { ...initial, attemptId,
    gitState: previous.gitState,
    completion: { bindings: previous.completion.bindings, evidence: [] },
    ...(previous.verificationPlan === undefined ? {} : { verificationPlan: previous.verificationPlan }),
    ...(previous.humanConstraints === undefined ? {} : { humanConstraints: previous.humanConstraints }),
    actionBudget: { ...budget }, updatedAt: new Date().toISOString() }
  if (new TaskController().decide(projected).action !== 'EXECUTE') throw new Error('TASK_RETRY_NEXT_DECISION_NOT_EXECUTE')
  return projected
}
