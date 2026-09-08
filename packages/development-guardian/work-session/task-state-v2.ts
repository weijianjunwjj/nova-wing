import type { VerificationResult } from '../model.js'
import type { WorkSessionDefinition, WorkSessionTask } from './model.js'
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
  repositoryIdentity?: string
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
  /** Provider transport details are not semantic recovery authority. */
  currentAgent?: string
  implementer?: TaskActorIdentity
  currentAction?: string
  risk: 'LOW' | 'NORMAL' | 'HIGH'
  status: TaskStateV2Status
  blockers: readonly string[]
  updatedAt: string
}

export interface TaskActorIdentity {
  agent: string
  provider: string
  runtimeIdentity: string
}

export function createTaskStateV2(
  session: Pick<WorkSessionDefinition, 'id' | 'branch'>,
  task: WorkSessionTask,
): TaskStateV2 {
  return {
    version: TASK_STATE_V2_VERSION,
    identity: { taskId: task.id, sessionId: session.id }, goal: task.goal,
    constraints: task.constraints ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    permissions: {
      allowedPaths: task.allowedPaths ?? [],
      forbiddenPaths: task.forbiddenPaths ?? [],
    },
    progress: { completedWork: [], pendingWork: [task.goal] },
    decisions: [], assumptions: [], openQuestions: [], artifacts: [],
    gitState: {
      branch: session.branch, changedFiles: [],
    },
    verificationState: { results: [] },
    completion: { evidence: [], bindings: task.acceptanceEvidenceBindings ?? [] },
    providerHistory: [], risk: 'NORMAL', status: 'PENDING', blockers: [], updatedAt: new Date().toISOString(),
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
