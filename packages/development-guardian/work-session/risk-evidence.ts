import type { TaskStateV2 } from './task-state-v2.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type EvidenceStatus = 'PASSED' | 'FAILED' | 'MISSING' | 'STALE'
export interface EvidenceV2 { type: string; status: EvidenceStatus; source: string; workspaceIdentity?: string; timestamp: string; details?: string }
export interface ReviewEvidence { passed: boolean; findings: readonly string[]; severity: RiskLevel; blockingFindings: readonly string[]; reviewerIdentity: string; implementerIdentity: string; reviewerRuntimeIdentity: string; reviewedCommit?: string; reviewedWorkspace?: string; reviewedFiles: readonly string[]; timestamp: string }
export interface ApprovalEvidence { approved: boolean; workspaceIdentity: string; reviewedCommit?: string; risk: RiskLevel; timestamp: string }
export interface AcceptanceEvidenceBinding { criterion: string; requiredEvidence: readonly string[]; requiresApproval?: boolean }
export interface RiskAssessment { level: RiskLevel; factors: readonly string[] }

export function assessRisk(task: TaskStateV2): RiskAssessment {
  const files = task.gitState.changedFiles
  const factors: string[] = []
  if (files.some((p) => /(?:auth|permission|security|secret)/iu.test(p))) factors.push('security-sensitive path')
  if (files.some((p) => /(?:migration|schema|database|sqlite)/iu.test(p))) factors.push('database or migration path')
  if (files.some((p) => /(?:index|public|api)/iu.test(p))) factors.push('public API path')
  if (files.length >= 10) factors.push(`${files.length} changed files`)
  if (task.verificationState.results.filter((r) => r.status === 'failed').length >= 2) factors.push('repeated verification failures')
  const critical = factors.some((f) => f.includes('security')) && factors.some((f) => f.includes('database'))
  return { level: critical ? 'CRITICAL' : factors.some((f) => /security|database|public API|changed files/.test(f)) ? 'HIGH' : factors.length ? 'MEDIUM' : 'LOW', factors }
}

export function evidenceIsStale(evidence: EvidenceV2, task: TaskStateV2): boolean {
  return evidence.workspaceIdentity === undefined || task.gitState.worktreeFingerprint === undefined || evidence.workspaceIdentity !== task.gitState.worktreeFingerprint
}

/** Internal completion gate. TaskController.decide is the sole public decision entry point. */
export function completionGate(input: { task: TaskStateV2; evidence: readonly EvidenceV2[]; bindings: readonly AcceptanceEvidenceBinding[]; risk: RiskAssessment; review?: ReviewEvidence; approval?: ApprovalEvidence }): boolean {
  const { task, evidence, bindings, risk, review, approval } = input
  if (task.blockers.length || bindings.length !== task.acceptanceCriteria.length) return false
  if (evidence.some((item) => item.status !== 'PASSED' || evidenceIsStale(item, task))) return false
  if (!bindings.every((binding) => binding.requiredEvidence.length > 0 && binding.requiredEvidence.every((type) => evidence.some((item) => item.type === type && item.status === 'PASSED')))) return false
  if (risk.level === 'CRITICAL') return approval?.approved === true && approval.workspaceIdentity === task.gitState.worktreeFingerprint && approval.reviewedCommit === task.gitState.headSha && approval.risk === risk.level
  if (risk.level === 'HIGH') return review?.passed === true && review.blockingFindings.length === 0 && review.reviewerIdentity !== review.implementerIdentity && review.reviewedWorkspace === task.gitState.worktreeFingerprint && review.reviewedCommit === task.gitState.headSha
  return true
}
