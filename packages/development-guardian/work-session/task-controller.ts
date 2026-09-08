import type { TaskStateV2 } from './task-state-v2.js'
import type { VerificationResult } from '../model.js'
import { assessRisk, completionGate } from './risk-evidence.js'

export type TaskAction = 'ANALYZE' | 'EXECUTE' | 'VERIFY' | 'REVIEW' | 'REQUEST_APPROVAL' | 'RECONCILE' | 'SUSPEND' | 'COMPLETE'
export interface ControllerRuntimeState { reconciliationRequired?: boolean }
export interface TaskActionDecision { action: TaskAction; reason: string }
export interface TaskActionResult {
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED'
  summary?: string
  changedFiles?: readonly string[]
  verificationResults?: readonly VerificationResult[]
  blockers?: readonly string[]
}

/**
 * Policy-only V2 controller. Provider selection, Git operations, and verifier
 * execution remain owned by the existing runtime ports.
 */
export class TaskController {
  /** The authoritative V2 next-action and completion gate. */
  decide(task: TaskStateV2, runtime: ControllerRuntimeState = {}): TaskActionDecision {
    if (runtime.reconciliationRequired) return { action: 'RECONCILE', reason: 'persisted task facts require repository reconciliation' }
    if (task.blockers.length > 0) return { action: 'SUSPEND', reason: 'unresolved blocker prevents completion' }
    if (task.status === 'SUSPENDED') return { action: 'REQUEST_APPROVAL', reason: 'task requires a human decision or approval' }
    if (task.acceptanceCriteria.length === 0) return { action: 'ANALYZE', reason: 'acceptance criteria are not yet established' }
    if (task.status === 'PENDING') return { action: 'EXECUTE', reason: 'task has not started execution' }
    const results = task.verificationState.results
    if (results.some((result) => result.status === 'failed')) return { action: 'EXECUTE', reason: 'deterministic verification failed' }
    if (results.length === 0 || results.some((result) => result.status !== 'passed')) return { action: 'VERIFY', reason: 'required deterministic evidence is missing' }
    const risk = assessRisk(task)
    const policy = task.completion
    if (risk.level === 'CRITICAL' && (policy.approval?.approved !== true || policy.approval.workspaceIdentity !== task.gitState.worktreeFingerprint || policy.approval.reviewedCommit !== task.gitState.headSha || policy.approval.risk !== risk.level)) return { action: 'REQUEST_APPROVAL', reason: `critical risk: ${risk.factors.join(', ') || 'policy'}` }
    if (risk.level === 'HIGH' && (policy.review?.passed !== true || policy.review.blockingFindings.length > 0 || policy.review.reviewerIdentity === policy.review.implementerIdentity || policy.review.reviewedWorkspace !== task.gitState.worktreeFingerprint || policy.review.reviewedCommit !== task.gitState.headSha)) return { action: 'REVIEW', reason: `independent review required: ${risk.factors.join(', ')}` }
    return completionGate({ task, ...policy, risk })
      ? { action: 'COMPLETE', reason: 'completion gate passed' }
      : { action: 'VERIFY', reason: 'required acceptance evidence is missing, failed, or stale' }
  }

  /** Normalizes adapter output into the only state that can drive the next action. */
  applyResult(task: TaskStateV2, action: TaskAction, result: TaskActionResult): TaskStateV2 {
    const blockers = result.status === 'BLOCKED'
      ? result.blockers ?? [result.summary ?? `${action} failed`]
      : result.blockers ?? []
    const verificationResults = result.verificationResults ?? task.verificationState.results
    return {
      ...task,
      artifacts: result.changedFiles === undefined ? task.artifacts : [...new Set([...task.artifacts, ...result.changedFiles])],
      gitState: result.changedFiles === undefined ? task.gitState : { ...task.gitState, changedFiles: result.changedFiles },
      verificationState: { ...task.verificationState, results: verificationResults },
      completion: result.verificationResults === undefined ? task.completion : {
        ...task.completion,
        evidence: result.verificationResults.map((item) => ({ type: item.name, status: item.status === 'passed' ? 'PASSED' as const : 'FAILED' as const, source: 'deterministic', ...(task.gitState.worktreeFingerprint === undefined ? {} : { workspaceIdentity: task.gitState.worktreeFingerprint }), timestamp: new Date().toISOString() })),
        bindings: task.acceptanceCriteria.map((criterion) => ({ criterion, requiredEvidence: result.verificationResults!.filter((item) => item.status === 'passed').map((item) => item.name) })),
      },
      blockers,
      currentAction: action,
      status: result.status === 'BLOCKED' ? 'SUSPENDED' : 'ACTIVE',
      // A repair invalidates failed evidence; the next Controller decision is VERIFY.
      ...(action === 'EXECUTE' && result.status === 'SUCCESS'
        ? { verificationState: { ...task.verificationState, results: verificationResults.filter((item) => item.status !== 'failed') } }
        : {}),
      updatedAt: new Date().toISOString(),
    }
  }
}
