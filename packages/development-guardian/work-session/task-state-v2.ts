import { z } from 'zod'
import type { VerificationResult } from '../model.js'
import type { WorkSessionDefinition, WorkSessionTask } from './model.js'
import type { AcceptanceEvidenceBinding, ApprovalEvidence, EvidenceV2, ReviewEvidence } from './risk-evidence.js'
import type { VerificationPlan } from './verification-planner.js'

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

export interface ControllerDecisionTraceV2 {
  decisionKey: string
  realityKey: string
}

export interface TaskActionBudgetV2 {
  originalLimit: number
  originalConsumed: number
  originalExhausted: boolean
  recoveryLimit: number
  recoveryGranted: boolean
  recoveryConsumed: number
  recoveryExhausted: boolean
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
  verificationPlan?: VerificationPlan
  /** Completion facts are task-owned.  Legacy workflow snapshots only project them. */
  completion: {
    evidence: readonly EvidenceV2[]
    bindings: readonly AcceptanceEvidenceBinding[]
    review?: ReviewEvidence | undefined
    approval?: ApprovalEvidence | undefined
  }
  providerHistory: readonly string[]
  execution?: { path: 'DIRECT' | 'GOLDEN' | 'CONTROLLER'; escalated: boolean; startCheckpoint?: TaskGitStateV2 }
  humanConstraints?: { verifyOnly: boolean }
  /** Provider transport details are not semantic recovery authority. */
  currentAgent?: string
  implementer?: TaskActorIdentity
  currentAction?: string
  risk: 'LOW' | 'NORMAL' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  status: TaskStateV2Status
  blockers: readonly string[]
  /** Bounded canonical convergence memory; event logs remain audit-only. */
  controllerConvergence?: {
    recentDecisions: readonly ControllerDecisionTraceV2[]
  }
  /** Per-Task durable action accounting. At most one bounded recovery grant is legal. */
  actionBudget?: TaskActionBudgetV2
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
    providerHistory: [], risk: task.risk ?? 'NORMAL', status: 'PENDING', blockers: [], updatedAt: new Date().toISOString(),
    humanConstraints: { verifyOnly: false },
    controllerConvergence: { recentDecisions: [] },
    actionBudget: { originalLimit: 20, originalConsumed: 0, originalExhausted: false, recoveryLimit: 4, recoveryGranted: false, recoveryConsumed: 0, recoveryExhausted: false },
  }
}

const strings = z.array(z.string())
const actor = z.object({ agent: z.string().min(1), provider: z.string().min(1), runtimeIdentity: z.string().min(1) })
const riskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const persistedTask = z.object({
  version: z.literal(2), identity: z.object({ taskId: z.string().min(1), sessionId: z.string().min(1) }),
  goal: z.string(), constraints: strings, acceptanceCriteria: strings,
  permissions: z.object({ allowedPaths: strings, forbiddenPaths: strings }),
  progress: z.object({ completedWork: strings, pendingWork: strings }),
  decisions: strings, assumptions: strings, openQuestions: strings, artifacts: strings,
  gitState: z.object({ repositoryIdentity: z.string().min(1).optional(), branch: z.string().min(1).optional(), headSha: z.string().min(1).optional(), changedFiles: strings, worktreeFingerprint: z.string().min(1).optional() }),
  verificationState: z.object({ results: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'skipped']) }).passthrough()), evidenceHeadSha: z.string().optional(), evidenceWorktreeFingerprint: z.string().optional() }),
  verificationPlan: z.object({
    planId: z.string(), fingerprint: z.string(),
    mappings: z.array(z.object({ criterion: z.string(), evidence: strings, scope: z.enum(['FILE', 'PACKAGE', 'WORKSPACE', 'REPOSITORY']), reason: z.string() })),
    steps: z.array(z.object({ id: z.string(), command: z.string(), cwd: z.string(), scope: z.enum(['FILE', 'PACKAGE', 'WORKSPACE', 'REPOSITORY']), reason: z.string(), expectedCoverage: strings, environmentPrerequisites: strings, failureClassifications: strings })),
    escalationSequence: strings, estimatedScope: z.enum(['FILE', 'PACKAGE', 'WORKSPACE', 'REPOSITORY']), estimatedCost: z.enum(['LOW', 'MEDIUM', 'HIGH']), confidence: z.enum(['HIGH', 'MEDIUM', 'INSUFFICIENT']), approvalRequired: z.boolean(), invalidationConditions: strings, packageRoots: strings, explicitBindings: z.boolean(), rationale: strings,
  }).optional(),
  completion: z.object({
    bindings: z.array(z.object({ criterion: z.string(), requiredEvidence: strings, requiresApproval: z.boolean().optional() })),
    evidence: z.array(z.object({ type: z.string(), status: z.enum(['PASSED', 'FAILED', 'MISSING', 'STALE']), source: z.string(), repositoryIdentity: z.string().optional(), branch: z.string().optional(), headSha: z.string().optional(), workspaceIdentity: z.string().optional(), timestamp: z.string() }).passthrough()),
    review: z.object({ passed: z.boolean(), findings: strings, severity: riskLevel, blockingFindings: strings, reviewer: actor, implementer: actor, reviewedRepository: z.string().optional(), reviewedBranch: z.string().optional(), reviewedCommit: z.string().optional(), reviewedWorkspace: z.string().optional(), reviewedFiles: strings, timestamp: z.string() }).optional(),
    approval: z.object({ approved: z.boolean(), repositoryIdentity: z.string().optional(), branch: z.string().optional(), workspaceIdentity: z.string(), reviewedCommit: z.string().optional(), risk: riskLevel, riskContext: z.string().optional(), timestamp: z.string() }).optional(),
  }),
  providerHistory: strings,
  execution: z.object({ path: z.enum(['DIRECT', 'GOLDEN', 'CONTROLLER']), escalated: z.boolean(), startCheckpoint: z.object({ repositoryIdentity: z.string().optional(), branch: z.string().optional(), headSha: z.string().optional(), changedFiles: strings, worktreeFingerprint: z.string().optional() }).optional() }).optional(),
  humanConstraints: z.object({ verifyOnly: z.boolean() }).optional(),
  currentAgent: z.string().optional(), implementer: actor.optional(), currentAction: z.string().optional(),
  risk: z.enum(['LOW', 'NORMAL', 'MEDIUM', 'HIGH', 'CRITICAL']), status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'FAILED']), blockers: strings, updatedAt: z.string(),
  controllerConvergence: z.object({ recentDecisions: z.array(z.object({ decisionKey: z.string(), realityKey: z.string() })).max(12) }).optional(),
  actionBudget: z.object({
    originalLimit: z.number().int().positive(), originalConsumed: z.number().int().nonnegative(), originalExhausted: z.boolean(),
    recoveryLimit: z.number().int().positive(), recoveryGranted: z.boolean(), recoveryConsumed: z.number().int().nonnegative(), recoveryExhausted: z.boolean(),
  }).optional(),
})

/** Validate every semantic field before persisted JSON may enter the controller. */
export function loadTaskStateV2(value: unknown): TaskStateV2 {
  const result = persistedTask.safeParse(value)
  if (!result.success) throw new Error('invalid or unsupported Task State V2')
  return result.data as TaskStateV2
}
