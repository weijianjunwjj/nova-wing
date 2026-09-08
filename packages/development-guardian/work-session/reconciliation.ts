import type { TaskStateV2 } from './task-state-v2.js'

export interface RepositoryReality { repositoryIdentity: string; branch: string; headSha: string; changedFiles: readonly string[]; worktreeFingerprint: string }
export interface ReconciliationResult { reconciled: boolean; reasons: readonly string[]; state: TaskStateV2 }

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join('\n') === [...new Set(right)].sort().join('\n')
}

/** Deterministic reality check: repository facts always outrank persisted state and agent reports. */
export function reconcileTaskState(task: TaskStateV2, reality: RepositoryReality): ReconciliationResult {
  const reasons: string[] = []
  if (task.gitState.repositoryIdentity !== undefined && task.gitState.repositoryIdentity !== reality.repositoryIdentity) reasons.push('repository identity mismatch')
  if (task.gitState.branch !== undefined && task.gitState.branch !== reality.branch) reasons.push('branch mismatch')
  if (task.gitState.headSha !== undefined && task.gitState.headSha !== reality.headSha) reasons.push('HEAD mismatch')
  if (!sameFiles(task.gitState.changedFiles, reality.changedFiles)) reasons.push('changed-file set mismatch')
  if (task.gitState.worktreeFingerprint !== undefined && task.gitState.worktreeFingerprint !== reality.worktreeFingerprint) reasons.push('workspace changed since checkpoint')
  if (task.verificationState.evidenceHeadSha !== undefined && task.verificationState.evidenceHeadSha !== reality.headSha) reasons.push('verification evidence belongs to an older commit')
  if (task.verificationState.evidenceWorktreeFingerprint !== undefined && task.verificationState.evidenceWorktreeFingerprint !== reality.worktreeFingerprint) reasons.push('verification evidence belongs to an older workspace')
  const reconciled = reasons.length === 0
  return {
    reconciled, reasons,
    state: {
      ...task,
      gitState: { repositoryIdentity: reality.repositoryIdentity, branch: reality.branch, headSha: reality.headSha, changedFiles: reality.changedFiles, worktreeFingerprint: reality.worktreeFingerprint },
      ...(reconciled ? {} : { blockers: [...task.blockers, ...reasons], status: 'SUSPENDED' as const, currentAction: 'RECONCILE' }),
      updatedAt: new Date().toISOString(),
    },
  }
}
