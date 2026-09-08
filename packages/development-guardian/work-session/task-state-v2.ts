import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import type { VerificationResult } from '../model.js'
import type { WorkSessionDefinition, WorkSessionDurableState, WorkSessionTask } from './model.js'
import type { AcceptanceEvidenceBinding, ApprovalEvidence, EvidenceV2, ReviewEvidence } from './risk-evidence.js'

export const TASK_STATE_V2_VERSION = 2 as const

export type TaskStateV2Status = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'FAILED'

export interface TaskVerificationStateV2 {
  results: readonly VerificationResult[]
  /** Evidence is valid only for this exact repository revision/fingerprint. */
  evidenceHeadSha?: string
  evidenceWorktreeFingerprint?: string
}

export interface TaskGitStateV2 {
  branch?: string
  headSha?: string
  changedFiles: readonly string[]
  worktreeFingerprint?: string
}

/** A serializable, task-centric projection of the established Work Session facts. */
export interface TaskStateV2 {
  version: typeof TASK_STATE_V2_VERSION
  identity: { taskId: string; sessionId: string }
  goal: string
  constraints: readonly string[]
  acceptanceCriteria: readonly string[]
  permissions: { allowedPaths: readonly string[]; forbiddenPaths: readonly string[] }
  progress: { completedWork: readonly string[]; pendingWork: readonly string[] }
  decisions: readonly string[]
  assumptions: readonly string[]
  openQuestions: readonly string[]
  artifacts: readonly string[]
  gitState: TaskGitStateV2
  verificationState: TaskVerificationStateV2
  /** Completion facts are task-owned.  Legacy workflow snapshots only project them. */
  completion: {
    evidence: readonly EvidenceV2[]
    bindings: readonly AcceptanceEvidenceBinding[]
    review?: ReviewEvidence
    approval?: ApprovalEvidence
  }
  providerHistory: readonly string[]
  checkpoint?: GuardianTaskRecoveryCheckpoint
  currentAgent?: string
  currentAction?: string
  risk: 'LOW' | 'NORMAL' | 'HIGH'
  status: TaskStateV2Status
  blockers: readonly string[]
  updatedAt: string
}

export function createTaskStateV2(
  session: Pick<WorkSessionDefinition, 'id' | 'branch'>,
  task: WorkSessionTask,
  state?: WorkSessionDurableState,
): TaskStateV2 {
  const checkpoint = state?.currentTaskId === task.id ? state.currentTaskCheckpoint : undefined
  const report = checkpoint?.task.lastReport
  const completed = state?.completedTaskIds.includes(task.id) ?? false
  const suspended = state?.currentTaskId === task.id && state?.state === 'SUSPENDED'
  const status: TaskStateV2Status = completed ? 'COMPLETED'
    : state?.state === 'FAILED' && state.currentTaskId === task.id ? 'FAILED'
      : suspended ? 'SUSPENDED' : state?.currentTaskId === task.id ? 'ACTIVE' : 'PENDING'
  return {
    version: TASK_STATE_V2_VERSION,
    identity: { taskId: task.id, sessionId: session.id }, goal: task.goal,
    constraints: task.constraints ?? checkpoint?.task.constraints ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? checkpoint?.task.acceptanceCriteria ?? [],
    permissions: {
      allowedPaths: task.allowedPaths ?? checkpoint?.task.allowedPaths ?? [],
      forbiddenPaths: task.forbiddenPaths ?? checkpoint?.task.forbiddenPaths ?? [],
    },
    progress: { completedWork: completed ? [task.goal] : [], pendingWork: completed ? [] : [task.goal] },
    decisions: [], assumptions: [], openQuestions: [], artifacts: report?.changedFiles ?? [],
    gitState: {
      branch: checkpoint?.repo.branch ?? session.branch,
      ...(checkpoint?.repo.headSha === undefined ? {} : { headSha: checkpoint.repo.headSha }),
      changedFiles: checkpoint?.repo.changedFiles ?? report?.changedFiles ?? [],
      ...(checkpoint?.repo.worktreeFingerprint === undefined ? {} : { worktreeFingerprint: checkpoint.repo.worktreeFingerprint }),
    },
    verificationState: {
      results: state?.verificationResults ?? report?.verificationResults ?? [],
      ...(checkpoint?.repo.headSha === undefined ? {} : { evidenceHeadSha: checkpoint.repo.headSha }),
      ...(checkpoint?.repo.worktreeFingerprint === undefined ? {} : { evidenceWorktreeFingerprint: checkpoint.repo.worktreeFingerprint }),
    },
    completion: { evidence: [], bindings: (task.acceptanceCriteria ?? []).map((criterion) => ({ criterion, requiredEvidence: [] })) },
    providerHistory: checkpoint?.provider.codingExecution?.history ?? [],
    ...(checkpoint === undefined ? {} : { checkpoint }),
    risk: 'NORMAL', status,
    blockers: state?.humanRequired?.reason === undefined ? report?.blockers ?? [] : [state.humanRequired.reason],
    // Mastra restores workflow snapshots as JSON, so this boundary accepts the
    // runtime's ISO string as well as the public durable Date type.
    updatedAt: state?.updatedAt instanceof Date
      ? state.updatedAt.toISOString()
      : typeof state?.updatedAt === 'string'
        ? state.updatedAt
        : new Date().toISOString(),
  }
}

/** Version gate for persisted JSON. Future migrations have one explicit entry point. */
export function loadTaskStateV2(value: unknown): TaskStateV2 {
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== TASK_STATE_V2_VERSION) {
    throw new Error('unsupported Task State version')
  }
  const state = value as TaskStateV2
  if (!state.identity?.taskId || !state.identity.sessionId) throw new Error('invalid Task State identity')
  return state
}
