import type { GuardianTask } from '../model.js'

const REPO_DRIFT_PATTERNS: readonly RegExp[] = [
  /\bREPO_DRIFT\b/u,
  /\bpre-existing changes\b/iu,
  /\brepository checkpoint mismatch\b/iu,
  /\bbranch mismatch\b/iu,
  /\bHEAD mismatch\b/u,
  /\bworktree fingerprint mismatch\b/iu,
  /\bchanged[- ]file[- ]set mismatch\b/iu,
  /\bunexpected (?:repository|worktree) changes?\b/iu,
]

function isRepoDriftReason(reason: string): boolean {
  return REPO_DRIFT_PATTERNS.some((pattern) => pattern.test(reason))
}

const SCOPE_VIOLATION_PATTERNS: readonly RegExp[] = [
  /\bscope violation\b/iu,
  /\boutside (?:the )?allowed scope\b/iu,
  /\binside (?:the )?forbidden scope\b/iu,
  /\bforbidden (?:path|file|scope|operation|action)\b/iu,
]

function hasScopeViolationEvidence(task: GuardianTask, reason: string): boolean {
  const typedReason = /^(?:SCOPE_VIOLATION|SAFETY_BLOCKED):/u.test(reason) ? [reason] : []
  return [...typedReason, ...(task.lastReport?.blockers ?? [])]
    .some((item) => SCOPE_VIOLATION_PATTERNS.some((pattern) => pattern.test(item)))
}

function providerFailureEvidence(task: GuardianTask, reason: string): string {
  const report = task.lastReport
  if (report === undefined) {
    return reason
  }

  return [
    reason,
    report.summary,
    report.incompleteReason,
    ...report.blockers,
    ...report.verificationResults
      .filter((result) => result.status === 'failed')
      .map((result) => result.details),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('\n')
}

function hasProviderCredentialPrerequisite(evidence: string): boolean {
  const hasProviderAccountPrerequisite =
    /\binsufficient (?:account )?balance\b/iu.test(evidence) ||
    /\binsufficient (?:account )?credits?\b/iu.test(evidence) ||
    /\b(?:billing|account) quota (?:is )?(?:unavailable|exhausted)\b/iu.test(evidence)
  const hasProviderAuthPrerequisite =
    /\b(?:authentication required|provider credentials? required|unauthorized due to provider (?:credential|account) setup)\b/iu.test(
      evidence,
    )

  return hasProviderAccountPrerequisite || hasProviderAuthPrerequisite
}

export function isExecutorProviderCredentialRecovery(task: GuardianTask): boolean {
  const reason = task.stopReason ?? 'unknown'
  const evidence = providerFailureEvidence(task, reason)

  if (hasScopeViolationEvidence(task, reason) || isRepoDriftReason(reason)) {
    return false
  }
  if (task.lastReport?.execution?.activeExecutor === 'codex' &&
    ['quota_exhausted', 'auth_required', 'configuration_error', 'model_unavailable'].includes(task.lastReport.execution.lastErrorKind ?? '')) return true

  // Require the Executor context and credential prerequisite to occur in the
  // same structured evidence item. This avoids combining an unrelated Claude
  // mention in one field with an AskBridge credential failure in another.
  return evidence.split('\n').some((item) =>
    /\b(?:claude code|executor provider|model provider)\b/iu.test(item) &&
    hasProviderCredentialPrerequisite(item),
  )
}
