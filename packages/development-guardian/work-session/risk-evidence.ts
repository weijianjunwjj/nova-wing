import type { TaskActorIdentity, TaskStateV2 } from './task-state-v2.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type EvidenceStatus = 'PASSED' | 'FAILED' | 'MISSING' | 'STALE'
export interface EvidenceV2 { type: string; status: EvidenceStatus; source: string; repositoryIdentity?: string; branch?: string; headSha?: string; workspaceIdentity?: string; timestamp: string; details?: string }
export interface ReviewEvidence { passed: boolean; findings: readonly string[]; severity: RiskLevel; blockingFindings: readonly string[]; reviewer: TaskActorIdentity; implementer: TaskActorIdentity; reviewedRepository?: string; reviewedBranch?: string; reviewedCommit?: string; reviewedWorkspace?: string; reviewedFiles: readonly string[]; timestamp: string }
export interface ApprovalEvidence { approved: boolean; repositoryIdentity?: string; branch?: string; workspaceIdentity: string; reviewedCommit?: string; risk: RiskLevel; riskContext?: string; timestamp: string }
export interface AcceptanceEvidenceBinding { criterion: string; requiredEvidence: readonly string[]; requiresApproval?: boolean | undefined }
export interface RiskAssessment { level: RiskLevel; factors: readonly string[] }

export function assessRisk(task: TaskStateV2): RiskAssessment {
  const files = task.gitState.changedFiles
  const factors: string[] = []
  if (task.risk === 'HIGH') factors.push('configured HIGH risk')
  if (files.some((p) => /(?:auth|permission|security|secret)/iu.test(p))) factors.push('security-sensitive path')
  if (files.some((p) => /(?:migration|schema|database|sqlite)/iu.test(p))) factors.push('database or migration path')
  if (files.some((p) => /(?:index|public|api)/iu.test(p))) factors.push('public API path')
  if (files.length >= 10) factors.push(`${files.length} changed files`)
  if (task.verificationState.results.filter((r) => r.status === 'failed').length >= 2) factors.push('repeated verification failures')
  const critical = factors.some((f) => f.includes('security')) && factors.some((f) => f.includes('database'))
  return { level: critical ? 'CRITICAL' : factors.some((f) => /security|database|public API|changed files|configured HIGH/.test(f)) ? 'HIGH' : factors.length ? 'MEDIUM' : 'LOW', factors }
}

export function evidenceIsStale(evidence: EvidenceV2, task: TaskStateV2): boolean {
  return evidence.repositoryIdentity === undefined || evidence.branch === undefined || evidence.headSha === undefined || evidence.workspaceIdentity === undefined ||
    task.gitState.repositoryIdentity === undefined || task.gitState.branch === undefined || task.gitState.headSha === undefined || task.gitState.worktreeFingerprint === undefined ||
    evidence.repositoryIdentity !== task.gitState.repositoryIdentity || evidence.branch !== task.gitState.branch || evidence.headSha !== task.gitState.headSha || evidence.workspaceIdentity !== task.gitState.worktreeFingerprint
}

/** Stable policy context also binds explicit criterion approval requirements. */
export function approvalContext(task: TaskStateV2): string {
  return JSON.stringify({ risk: assessRisk(task), bindings: task.completion.bindings, criteria: task.acceptanceCriteria })
}
export function approvalSatisfied(task: TaskStateV2): boolean {
  const a = task.completion.approval
  return a?.approved === true && a.repositoryIdentity === task.gitState.repositoryIdentity &&
    a.branch === task.gitState.branch && a.reviewedCommit === task.gitState.headSha &&
    a.workspaceIdentity === task.gitState.worktreeFingerprint && a.risk === assessRisk(task).level &&
    a.riskContext === approvalContext(task)
}
export function reviewSatisfied(task: TaskStateV2): boolean {
  const r = task.completion.review
  const i = task.implementer
  return r?.passed === true && r.blockingFindings.length === 0 && i !== undefined &&
    [i.agent, i.provider, i.runtimeIdentity, r.reviewer.agent, r.reviewer.provider, r.reviewer.runtimeIdentity].every(Boolean) &&
    r.implementer.agent === i.agent && r.implementer.provider === i.provider && r.implementer.runtimeIdentity === i.runtimeIdentity &&
    r.reviewer.runtimeIdentity !== i.runtimeIdentity &&
    r.reviewedRepository === task.gitState.repositoryIdentity && r.reviewedBranch === task.gitState.branch &&
    r.reviewedCommit === task.gitState.headSha && r.reviewedWorkspace === task.gitState.worktreeFingerprint &&
    task.gitState.changedFiles.every((file) => r.reviewedFiles.includes(file))
}

/** Internal helper; TaskController.decide is the authoritative decision entry. */
export function completionGate(input: { task: TaskStateV2; evidence: readonly EvidenceV2[]; bindings: readonly AcceptanceEvidenceBinding[]; risk: RiskAssessment; review?: ReviewEvidence; approval?: ApprovalEvidence }): boolean {
  const { task, evidence, bindings, risk } = input
  if (task.blockers.length || task.acceptanceCriteria.length === 0 || bindings.length !== task.acceptanceCriteria.length) return false
  if (new Set(bindings.map((b) => b.criterion)).size !== bindings.length ||
      !task.acceptanceCriteria.every((criterion) => bindings.some((b) => b.criterion === criterion))) return false
  if (evidence.some((item) => item.source !== 'deterministic' || item.status !== 'PASSED' || evidenceIsStale(item, task))) return false
  if (!bindings.every((binding) => binding.requiredEvidence.length > 0 && binding.requiredEvidence.every((type) => evidence.some((item) => item.type === type && item.status === 'PASSED')))) return false
  if ((risk.level === 'CRITICAL' || bindings.some((b) => b.requiresApproval)) && !approvalSatisfied(task)) return false
  if (risk.level === 'HIGH' && !reviewSatisfied(task)) return false
  return true
}
