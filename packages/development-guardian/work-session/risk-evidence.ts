import type { TaskActorIdentity, TaskStateV2 } from './task-state-v2.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type EvidenceStatus = 'PASSED' | 'FAILED' | 'MISSING' | 'STALE'
export interface EvidenceV2 { type: string; status: EvidenceStatus; source: string; repositoryIdentity?: string; branch?: string; headSha?: string; workspaceIdentity?: string; timestamp: string; details?: string }
export interface ReviewEvidence { passed: boolean; findings: readonly string[]; severity: RiskLevel; blockingFindings: readonly string[]; reviewer: TaskActorIdentity; implementer: TaskActorIdentity; reviewedRepository?: string; reviewedBranch?: string; reviewedCommit?: string; reviewedWorkspace?: string; reviewedFiles: readonly string[]; timestamp: string }
export interface ApprovalEvidence { approved: boolean; repositoryIdentity?: string; branch?: string; workspaceIdentity: string; reviewedCommit?: string; risk: RiskLevel; riskContext?: string; timestamp: string }
export interface AcceptanceEvidenceBinding { criterion: string; requiredEvidence: readonly string[]; requiresApproval?: boolean | undefined }
export interface RiskAssessment { level: RiskLevel; factors: readonly string[] }

/** Criteria without one exact, non-empty trusted evidence contract. */
export function unmappedAcceptanceCriteria(task: Pick<TaskStateV2, 'acceptanceCriteria' | 'completion'>): readonly string[] {
  const counts = new Map<string, number>()
  for (const binding of task.completion.bindings) {
    counts.set(binding.criterion, (counts.get(binding.criterion) ?? 0) + 1)
  }
  return task.acceptanceCriteria.filter((criterion) => {
    const binding = task.completion.bindings.find((candidate) => candidate.criterion === criterion)
    return counts.get(criterion) !== 1 || binding === undefined || binding.requiredEvidence.length === 0
  })
}

export function assessRisk(task: TaskStateV2): RiskAssessment {
  const files = task.gitState.changedFiles
  const factors: string[] = []
  const contract = [task.goal, ...task.constraints, ...task.acceptanceCriteria].join(' ')
  if (task.risk === 'HIGH' || task.risk === 'CRITICAL') factors.push(`configured ${task.risk} risk`)
  if (task.risk === 'MEDIUM') factors.push('configured MEDIUM risk')
  const securityContract = /\b(?:authentication|authorization|credential|security boundary|permission model)\b/iu.test(contract)
  const migrationContract = /\b(?:migration|schema change|database migration|destructive)\b/iu.test(contract)
  const publicContract = /\b(?:public API|exported (?:surface|contract)|breaking change|compatibility)\b/iu.test(contract)
  if (securityContract) factors.push('security boundary contract')
  if (migrationContract) factors.push('database or migration contract')
  if (publicContract) factors.push('public compatibility contract')
  // A sensitive-looking path is a signal only. It cannot independently force HIGH.
  if (files.some((p) => /(?:auth|permission|security|secret|migration|schema|database|sqlite|public|api)/iu.test(p))) factors.push('sensitive path signal')
  if (files.length >= 10) factors.push(`${files.length} changed files signal`)
  if (task.verificationState.results.filter((r) => r.status === 'failed').length >= 2) factors.push('repeated verification failures')
  // Controller-only sessions retain the v0.2.7 conservative heuristic. The
  // Direct fast gate uses contract/export facts and treats a path as one signal.
  const legacyController = task.execution?.path !== 'DIRECT'
  const legacySecurityPath = legacyController && files.some((path) => /(?:auth|permission|security|secret)/iu.test(path))
  const legacyDataPath = legacyController && files.some((path) => /(?:migration|schema|database|sqlite)/iu.test(path))
  const legacyPublicPath = legacyController && files.some((path) => /(?:index|public|api)/iu.test(path))
  const critical = task.risk === 'CRITICAL' || (securityContract && migrationContract) || (legacySecurityPath && legacyDataPath)
  const high = task.risk === 'HIGH' || securityContract || migrationContract || publicContract || legacySecurityPath || legacyDataPath || legacyPublicPath || (legacyController && files.length >= 10)
  return { level: critical ? 'CRITICAL' : high ? 'HIGH' : factors.length ? 'MEDIUM' : 'LOW', factors }
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
export function completionGate(input: { task: TaskStateV2; evidence: readonly EvidenceV2[]; bindings: readonly AcceptanceEvidenceBinding[]; risk: RiskAssessment; review?: ReviewEvidence | undefined; approval?: ApprovalEvidence | undefined }): boolean {
  const { task, evidence, bindings, risk } = input
  if (task.blockers.length || task.acceptanceCriteria.length === 0 || bindings.length !== task.acceptanceCriteria.length || unmappedAcceptanceCriteria(task).length > 0) return false
  if (new Set(bindings.map((b) => b.criterion)).size !== bindings.length ||
      !task.acceptanceCriteria.every((criterion) => bindings.some((b) => b.criterion === criterion))) return false
  if (evidence.some((item) => item.source !== 'deterministic' || item.status !== 'PASSED' || evidenceIsStale(item, task))) return false
  if (!bindings.every((binding) => binding.requiredEvidence.length > 0 && binding.requiredEvidence.every((type) => evidence.some((item) => item.type === type && item.status === 'PASSED')))) return false
  if ((risk.level === 'CRITICAL' || bindings.some((b) => b.requiresApproval)) && !approvalSatisfied(task)) return false
  if (risk.level === 'HIGH' && !reviewSatisfied(task)) return false
  return true
}
