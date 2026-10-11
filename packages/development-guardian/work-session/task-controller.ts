import type { TaskStateV2 } from './task-state-v2.js'
import type { VerificationFailureClassification, VerificationResult } from '../model.js'
import type { DecisionReasonCode } from './task-observability.js'
import { assessRisk, completionGate, approvalSatisfied, reviewSatisfied, evidenceIsStale, unmappedAcceptanceCriteria } from './risk-evidence.js'
import { isRuntimeAcceptanceBinding } from './completion-criteria.js'

export type TaskAction = 'ANALYZE' | 'EXECUTE' | 'VERIFY' | 'REVIEW' | 'REQUEST_APPROVAL' | 'RECONCILE' | 'SUSPEND' | 'COMPLETE'
export interface ControllerRuntimeState { reconciliationRequired?: boolean }
/**
 * reasonCode 与该 action 同源产生，供 Dispatch Explanation 使用。
 * reason 文本只是 projection；真实事实是 action + reasonCode + factors。
 */
export interface TaskActionDecision { action: TaskAction; reason: string; reasonCode: DecisionReasonCode }
export interface TaskActionResult {
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED'
  workspaceExecution?: import('../model.js').ExecutionReport['workspaceExecution']
  summary?: string
  changedFiles?: readonly string[]
  verificationResults?: readonly VerificationResult[]
  blockers?: readonly string[]
  /** Repository Inspector facts supplied by the runner, never by an agent report. */
  repositoryChanged?: boolean
  implementationEvidenceAdded?: boolean
}

export type CanonicalVerificationFailure = 'CODE_FAILURE' | 'ENVIRONMENT_FAILURE' | 'VERIFIER_CONFIGURATION_FAILURE' | 'UNRELATED_TEST_FAILURE' | 'EVIDENCE_MISSING' | 'UNKNOWN'

export function canonicalVerificationFailure(value: VerificationFailureClassification | undefined): CanonicalVerificationFailure {
  if (value === 'CODE_FAILURE' || value === 'CODE_VERIFICATION_FAILED') return 'CODE_FAILURE'
  if (value === 'ENVIRONMENT_FAILURE' || value === 'ENVIRONMENT_REQUIRED') return 'ENVIRONMENT_FAILURE'
  if (value === 'VERIFIER_CONFIGURATION_FAILURE') return value
  if (value === 'UNRELATED_TEST_FAILURE') return value
  if (value === 'EVIDENCE_MISSING') return value
  return 'UNKNOWN'
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
    if (task.acceptanceCriteria.length === 0) return { action: 'ANALYZE', reasonCode: 'ACCEPTANCE_ANALYSIS_REQUIRED', reason: 'acceptance criteria are not yet established' }
    const unmapped = unmappedAcceptanceCriteria(task)
    if (unmapped.length > 0) return { action: 'SUSPEND', reasonCode: 'ACCEPTANCE_EVIDENCE_BINDING_MISSING', reason: `Acceptance criterion ${unmapped[0]} has no evidence binding` }
    if (task.status === 'PENDING') return task.humanConstraints?.verifyOnly === true
      ? { action: 'VERIFY', reasonCode: 'EVIDENCE_MISSING', reason: 'durable VERIFY ONLY constraint skips implementation execution' }
      : { action: 'EXECUTE', reasonCode: 'TASK_NOT_STARTED', reason: 'task has not started execution' }
    const results = task.verificationState.results
    const failed = results.filter((result) => result.status === 'failed')
    if (failed.length > 0) {
      const classifications = failed.map((result) => canonicalVerificationFailure(result.classification))
      if (classifications.includes('ENVIRONMENT_FAILURE')) return { action: 'SUSPEND', reasonCode: 'VERIFICATION_ENVIRONMENT_FAILURE', reason: 'verification requires environment/runtime recovery' }
      if (classifications.includes('VERIFIER_CONFIGURATION_FAILURE')) return { action: 'SUSPEND', reasonCode: 'VERIFIER_CONFIGURATION_FAILURE', reason: 'verifier or Task Contract configuration requires repair' }
      if (classifications.includes('UNRELATED_TEST_FAILURE')) return { action: 'SUSPEND', reasonCode: 'UNRELATED_TEST_FAILURE', reason: 'an audited pre-existing failure is unrelated to the Task; task-local disposition is required' }
      if (classifications.every((item) => item === 'CODE_FAILURE')) return task.humanConstraints?.verifyOnly === true
        ? { action: 'SUSPEND', reasonCode: 'HUMAN_DECISION_REQUIRED', reason: 'CODE_FAILURE requires implementation, but durable VERIFY ONLY forbids re-execution' }
        : { action: 'EXECUTE', reasonCode: 'VERIFICATION_FAILED', reason: 'deterministic evidence attributes the failure to the Task implementation' }
      return { action: 'SUSPEND', reasonCode: 'VERIFICATION_UNKNOWN', reason: 'verification failure cannot be safely attributed to the Task implementation' }
    }
    if (task.status === 'SUSPENDED') return { action: 'REQUEST_APPROVAL', reasonCode: 'HUMAN_DECISION_REQUIRED', reason: 'task requires a human decision or approval' }
    const runtimeOnly = task.completion.bindings.every(isRuntimeAcceptanceBinding)
    if ((results.length === 0 && !runtimeOnly) || results.some((result) => result.status !== 'passed')) return { action: 'VERIFY', reasonCode: 'EVIDENCE_MISSING', reason: 'required deterministic evidence is missing' }
    const risk = assessRisk(task)
    // A failed independent review is a verdict on the implementation, so the
    // Controller sends the work back for revision. The reviewer never edits code.
    if (task.completion.review !== undefined && task.completion.review.passed !== true) {
      return task.humanConstraints?.verifyOnly === true
        ? { action: 'SUSPEND', reasonCode: 'HUMAN_DECISION_REQUIRED', reason: 'review requires implementation revision, but durable VERIFY ONLY forbids re-execution' }
        : { action: 'EXECUTE', reasonCode: 'REVIEW_FAILED', reason: 'independent review found blocking issues' }
    }
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
    const implementationProgress = action !== 'EXECUTE' || result.repositoryChanged === true || result.implementationEvidenceAdded === true
    const verificationResults = verified ?? (action === 'EXECUTE' && implementationProgress ? [] : task.verificationState.results)
    return {
      ...task,
      artifacts: result.changedFiles === undefined ? task.artifacts : [...new Set([...task.artifacts, ...result.changedFiles])],
      // Repository Inspector, not a provider report, owns git reality.
      gitState: task.gitState,
      verificationState: { ...task.verificationState, results: verificationResults },
      completion: verified === undefined
        ? (action === 'EXECUTE' && result.status === 'SUCCESS' && implementationProgress
            // A revision invalidates the previous review; it was a verdict on code
            // that no longer exists. The Controller must ask for REVIEW again.
            ? { ...task.completion, review: undefined }
            : task.completion)
        : {
        ...task.completion,
        evidence: verified.map((item) => ({ type: item.stepId ?? item.name, status: item.status === 'passed' ? 'PASSED' as const : 'FAILED' as const, source: 'deterministic', ...(task.gitState.repositoryIdentity === undefined ? {} : { repositoryIdentity: task.gitState.repositoryIdentity }), ...(task.gitState.branch === undefined ? {} : { branch: task.gitState.branch }), ...(task.gitState.headSha === undefined ? {} : { headSha: task.gitState.headSha }), ...(task.gitState.worktreeFingerprint === undefined ? {} : { workspaceIdentity: task.gitState.worktreeFingerprint }), timestamp: new Date().toISOString() })),
        // Bindings come only from the trusted task definition; a passed verifier
        // must never be projected as evidence for every acceptance criterion.
        bindings: task.completion.bindings,
      },
      blockers,
      currentAction: action,
      status: result.status === 'BLOCKED' ? 'SUSPENDED' : 'ACTIVE',
      // A repair invalidates failed evidence; the next Controller decision is VERIFY.
      ...(action === 'EXECUTE' && result.status === 'SUCCESS' && implementationProgress
        ? { verificationState: { ...task.verificationState, results: verificationResults.filter((item) => item.status !== 'failed') } }
        : {}),
      updatedAt: new Date().toISOString(),
    }
  }
}
