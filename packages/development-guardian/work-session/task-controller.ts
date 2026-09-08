import type { TaskStateV2 } from './task-state-v2.js'
import type { VerificationResult } from '../model.js'
import type { DecisionReasonCode } from './task-observability.js'
import { assessRisk, completionGate, approvalSatisfied, reviewSatisfied, evidenceIsStale } from './risk-evidence.js'

export type TaskAction = 'ANALYZE' | 'EXECUTE' | 'VERIFY' | 'REVIEW' | 'REQUEST_APPROVAL' | 'RECONCILE' | 'SUSPEND' | 'COMPLETE'
export interface ControllerRuntimeState { reconciliationRequired?: boolean }
/**
 * reasonCode 与该 action 同源产生，供 Dispatch Explanation 使用。
 * reason 文本只是 projection；真实事实是 action + reasonCode + factors。
 */
export interface TaskActionDecision { action: TaskAction; reason: string; reasonCode: DecisionReasonCode }
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
    if (runtime.reconciliationRequired) return { action: 'RECONCILE', reasonCode: 'REPOSITORY_RECONCILIATION_REQUIRED', reason: 'persisted task facts require repository reconciliation' }
    if (task.status === 'FAILED') return { action: 'SUSPEND', reasonCode: 'FAILED_TASK_RECOVERY', reason: 'failed task requires recovery' }
    if (task.blockers.length > 0) return { action: 'SUSPEND', reasonCode: 'BLOCKER_PRESENT', reason: 'unresolved blocker prevents completion' }
    if (task.status === 'SUSPENDED') return { action: 'REQUEST_APPROVAL', reasonCode: 'HUMAN_DECISION_REQUIRED', reason: 'task requires a human decision or approval' }
    if (task.acceptanceCriteria.length === 0) return { action: 'ANALYZE', reasonCode: 'ACCEPTANCE_ANALYSIS_REQUIRED', reason: 'acceptance criteria are not yet established' }
    if (task.status === 'PENDING') return { action: 'EXECUTE', reasonCode: 'TASK_NOT_STARTED', reason: 'task has not started execution' }
    const results = task.verificationState.results
    if (results.some((result) => result.status === 'failed')) return { action: 'EXECUTE', reasonCode: 'VERIFICATION_FAILED', reason: 'deterministic verification failed' }
    if (results.length === 0 || results.some((result) => result.status !== 'passed')) return { action: 'VERIFY', reasonCode: 'EVIDENCE_MISSING', reason: 'required deterministic evidence is missing' }
    const risk = assessRisk(task)
    const policy = task.completion
    if ((risk.level === 'CRITICAL' || policy.bindings.some((b) => b.requiresApproval)) && !approvalSatisfied(task)) return { action: 'REQUEST_APPROVAL', reasonCode: 'RISK_REQUIRES_APPROVAL', reason: `approval required: ${risk.factors.join(', ') || 'acceptance policy'}` }
    if (risk.level === 'HIGH' && !reviewSatisfied(task)) return { action: 'REVIEW', reasonCode: 'RISK_REQUIRES_REVIEW', reason: `independent review required: ${risk.factors.join(', ')}` }
    return completionGate({ task, ...policy, risk })
      ? { action: 'COMPLETE', reasonCode: 'COMPLETION_CRITERIA_SATISFIED', reason: 'completion gate passed' }
      : { action: 'VERIFY', reasonCode: task.completion.evidence.some((item) => item.status === 'STALE' || evidenceIsStale(item, task)) ? 'EVIDENCE_STALE' : 'EVIDENCE_MISSING', reason: 'required acceptance evidence is missing, failed, or stale' }
  }

  /** Normalizes adapter output into the only state that can drive the next action. */
  applyResult(task: TaskStateV2, action: TaskAction, result: TaskActionResult): TaskStateV2 {
    const mustBlock = result.status === 'BLOCKED' || (result.status === 'FAILED' &&
      (action !== 'VERIFY' || !result.verificationResults?.some((r) => r.status === 'failed')))
    const blockers = mustBlock && !result.blockers?.length
      ? [result.summary ?? `${action} failed`]
      : result.blockers ?? []
    const verified = action === 'VERIFY' ? result.verificationResults : undefined
    const verificationResults = verified ?? (action === 'EXECUTE' ? [] : task.verificationState.results)
    return {
      ...task,
      artifacts: result.changedFiles === undefined ? task.artifacts : [...new Set([...task.artifacts, ...result.changedFiles])],
      // Repository Inspector, not a provider report, owns git reality.
      gitState: task.gitState,
      verificationState: { ...task.verificationState, results: verificationResults },
      completion: verified === undefined ? task.completion : {
        ...task.completion,
        evidence: verified.map((item) => ({ type: item.name, status: item.status === 'passed' ? 'PASSED' as const : 'FAILED' as const, source: 'deterministic', ...(task.gitState.repositoryIdentity === undefined ? {} : { repositoryIdentity: task.gitState.repositoryIdentity }), ...(task.gitState.branch === undefined ? {} : { branch: task.gitState.branch }), ...(task.gitState.headSha === undefined ? {} : { headSha: task.gitState.headSha }), ...(task.gitState.worktreeFingerprint === undefined ? {} : { workspaceIdentity: task.gitState.worktreeFingerprint }), timestamp: new Date().toISOString() })),
        // Bindings come only from the trusted task definition; a passed verifier
        // must never be projected as evidence for every acceptance criterion.
        bindings: task.completion.bindings,
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
