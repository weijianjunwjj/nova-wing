import type { GuardianPhase } from '../progress.js'
import type { CanonicalVerificationFailure, TaskAction } from './task-controller.js'
import type { AgentCapabilityProfile } from './v2-controller-task-runner.js'
import type { TaskStateV2 } from './task-state-v2.js'
import { verificationPlanFingerprintValid, type VerificationPlan } from './verification-planner.js'
import { assessRisk, unmappedAcceptanceCriteria } from './risk-evidence.js'

export interface DirectPathEligibility {
  eligible: boolean
  reasons: readonly string[]
}

/** Fixed-protocol eligibility gate. Every failed condition is explicit and fail-closed. */
export function assessDirectPathEligibility(input: {
  task: TaskStateV2
  plan: VerificationPlan
  agents: readonly AgentCapabilityProfile[]
  repositoryConsistent: boolean
  providerAvailable?: boolean
  unownedDirtyChanges?: boolean
  permissionSufficient?: boolean
  knownEnvironmentBlocker?: boolean
  destructiveAction?: boolean
  independentReviewRequired?: boolean
}): DirectPathEligibility {
  const { task, plan } = input
  const risk = assessRisk(task)
  const reasons: string[] = []
  if (task.acceptanceCriteria.length === 0) reasons.push('contract has no acceptance criteria')
  const everyCriterionMapped = task.acceptanceCriteria.every((criterion) =>
    plan.mappings.some((mapping) => mapping.criterion === criterion && mapping.evidence.length > 0))
  if (!verificationPlanFingerprintValid(plan) || plan.confidence === 'INSUFFICIENT' || plan.steps.length === 0 ||
      !everyCriterionMapped || unmappedAcceptanceCriteria(task).length > 0) reasons.push('verification plan is insufficient')
  if (plan.approvalRequired) reasons.push('verification plan requires approval')
  if (risk.level === 'HIGH' || risk.level === 'CRITICAL') reasons.push(`${risk.level} risk requires the Controller safety net`)
  if (!input.repositoryConsistent) reasons.push('repository is inconsistent with the task checkpoint')
  if (input.unownedDirtyChanges ?? task.gitState.changedFiles.length > 0) reasons.push('repository has unowned dirty changes')
  if (input.permissionSufficient === false || task.permissions.allowedPaths.length === 0) reasons.push('task permission is insufficient')
  if (input.knownEnvironmentBlocker === true) reasons.push('verification environment has a known blocker')
  const contractText = [task.goal, ...task.constraints].join(' ')
  if (input.destructiveAction === true || /\b(?:drop|destroy|force[ -]?push|delete\s+(?:all|database|schema))\b/iu.test(contractText)) reasons.push('destructive action requires Controller policy')
  if (input.independentReviewRequired === true) reasons.push('independent review is required')
  const implementer = input.agents.find((agent) => agent.available && !agent.degraded && !agent.quotaExhausted && agent.capabilities.coding === true && agent.capabilities.verification === true)
  if (input.providerAvailable === false || implementer === undefined) reasons.push('no sticky execute/verify provider is available')
  if (task.blockers.length > 0) reasons.push('task has a blocker')
  if (task.completion.bindings.some((binding) => binding.requiresApproval === true)) reasons.push('acceptance policy requires approval')
  return { eligible: reasons.length === 0, reasons }
}

export type ResumeTarget = 'EXECUTE' | 'VERIFY' | 'COMPLETE_OR_VERIFY' | 'SUSPEND'

export function resumeTargetForFailure(failure: CanonicalVerificationFailure): ResumeTarget {
  if (failure === 'CODE_FAILURE') return 'EXECUTE'
  if (failure === 'ENVIRONMENT_FAILURE' || failure === 'VERIFIER_CONFIGURATION_FAILURE') return 'VERIFY'
  if (failure === 'UNRELATED_TEST_FAILURE' || failure === 'EVIDENCE_MISSING') return 'COMPLETE_OR_VERIFY'
  return 'SUSPEND'
}

export function resumeTargetForRuntimeFailure(stage: 'EXECUTE' | 'VERIFY'): 'EXECUTE' | 'VERIFY' {
  return stage
}

/** Product phase projection: unknown actions remain UNKNOWN, never REVIEWING. */
export function phaseForAction(action: TaskAction | string | undefined, reviewerStarted = false): GuardianPhase {
  if (action === 'ANALYZE') return 'PLANNING'
  if (action === 'EXECUTE') return 'EXECUTING'
  if (action === 'VERIFY') return 'VERIFYING'
  if (action === 'REVIEW') return reviewerStarted ? 'REVIEWING' : 'WAITING'
  if (action === 'COMPLETE') return 'FINALIZING'
  if (action === 'SUSPEND') return 'WAITING'
  if (action === 'REQUEST_APPROVAL') return 'WAITING_FOR_APPROVAL'
  if (action === 'RECONCILE') return 'RECONCILING'
  return 'UNKNOWN'
}

export function phaseForHumanRequiredCategory(category: string): GuardianPhase {
  if (category === 'ENVIRONMENT_REQUIRED' || category === 'CREDENTIAL_REQUIRED') return 'WAITING_FOR_ENVIRONMENT'
  if (category === 'PERMISSION_REQUIRED' || category === 'CONFIGURATION_REQUIRED' || category === 'PLANNING_REQUIRED') return 'WAITING'
  if (category === 'APPROVAL_REQUIRED') return 'WAITING_FOR_APPROVAL'
  return 'WAITING'
}

/** Route profiles are debug facts; the product provider is the concrete runtime identity. */
export function concreteRuntimeProvider(provider: string | undefined): string | undefined {
  return provider === undefined || provider === 'codex-or-deepseek' || provider === 'executor-router' ? undefined : provider
}
