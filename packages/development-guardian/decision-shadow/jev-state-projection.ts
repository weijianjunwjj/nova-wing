import { isRuntimeAcceptanceBinding } from '../work-session/completion-criteria.js'
import { canonicalVerificationFailure } from '../work-session/task-controller.js'
import type { ControllerRuntimeState } from '../work-session/task-controller.js'
import { approvalSatisfied, assessRisk, evidenceIsStale, reviewSatisfied, unmappedAcceptanceCriteria } from '../work-session/risk-evidence.js'
import type { TaskStateV2 } from '../work-session/task-state-v2.js'
import type { JevShadowStateProjection } from './jev-contract.js'

/** A scalar-only allowlist. No source text, paths, prompts, payloads, or raw evidence cross this boundary. */
export function buildJevShadowStateProjection(task: TaskStateV2, runtime: ControllerRuntimeState = {}): JevShadowStateProjection {
  const classifications: JevShadowStateProjection['verification']['classifications'] = {
    CODE_FAILURE: 0,
    ENVIRONMENT_FAILURE: 0,
    VERIFIER_CONFIGURATION_FAILURE: 0,
    UNRELATED_TEST_FAILURE: 0,
    EVIDENCE_MISSING: 0,
    UNKNOWN: 0,
  }
  for (const result of task.verificationState.results) {
    if (result.status === 'failed') classifications[canonicalVerificationFailure(result.classification)]++
  }
  const risk = assessRisk(task)
  let passedCount = 0
  let failedCount = 0
  let missingCount = 0
  let staleCount = 0
  let nonDeterministicCount = 0
  for (const evidence of task.completion.evidence) {
    if (evidence.source !== 'deterministic') nonDeterministicCount++
    if (evidence.status === 'FAILED') failedCount++
    else if (evidence.status === 'MISSING') missingCount++
    else if (evidence.status === 'STALE' || evidenceIsStale(evidence, task)) staleCount++
    else if (evidence.status === 'PASSED') passedCount++
  }
  const results = task.verificationState.results
  return {
    taskStatus: task.status,
    reconciliationRequired: runtime.reconciliationRequired === true,
    blockerCount: task.blockers.length,
    acceptanceCriteriaCount: task.acceptanceCriteria.length,
    unmappedAcceptanceCriteriaCount: unmappedAcceptanceCriteria(task).length,
    runtimeOnlyAcceptance: task.completion.bindings.length > 0 && task.completion.bindings.every(isRuntimeAcceptanceBinding),
    verifyOnly: task.humanConstraints?.verifyOnly === true,
    verification: {
      total: results.length,
      passed: results.filter((item) => item.status === 'passed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      classifications,
    },
    review: { exists: task.completion.review !== undefined, passed: reviewSatisfied(task) },
    approval: { requiredByBinding: task.completion.bindings.some((binding) => binding.requiresApproval === true), satisfied: approvalSatisfied(task) },
    risk: { level: risk.level, factorsCount: risk.factors.length },
    evidence: { passedCount, failedCount, missingCount, staleCount, nonDeterministicCount },
  }
}
