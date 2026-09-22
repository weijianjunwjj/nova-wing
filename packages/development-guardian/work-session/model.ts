/**
 * Work Session MVP Domain Model
 * W001 最小模型定义
 * W003 增加 checkpoint 支持
 */

import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import type { ScheduleSource } from './schedule-policy.js'
import type { TaskActorIdentity } from './task-state-v2.js'
import type { GuardianBrainFailure, VerificationResult } from '../model.js'
import type {
  WorkSessionFailureCategory,
  WorkSessionFailureStage,
} from './failure-classification.js'

export type WorkSessionState =
  | 'READY'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface WorkSessionTask {
  id: string
  goal: string
  /** V2 task facts; optional so existing Work Session definitions remain compatible. */
  constraints?: readonly string[]
  acceptanceCriteria?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
  /** Explicit criterion-to-evidence contract for the V2 completion gate. */
  acceptanceEvidenceBindings?: readonly import('./risk-evidence.js').AcceptanceEvidenceBinding[] | undefined
  /** Optional trusted risk declaration. Path names alone never elevate this value. */
  risk?: import('./risk-evidence.js').RiskLevel | undefined
}

export interface WorkSessionLimits {
  softMinutes: number
  hardMinutes: number
  maxTasks: number
}

/**
 * W004-B: Session 在 COMPLETED 状态下的结束原因。
 * 只有 state=COMPLETED 时使用；FAILED/SUSPENDED 不携带此字段。
 */
export type WorkSessionCompletionReason =
  | 'ALL_TASKS_COMPLETED'
  | 'SOFT_LIMIT'
  | 'HARD_LIMIT'
  | 'MAX_TASKS'

export type WorkSessionSuspensionReason = 'USER_PAUSED' | 'BRAIN_INFRASTRUCTURE_FAILED'
export type WorkSessionCancellationReason = 'STOP_AFTER_TASK'

export interface WorkSessionDefinition {
  id: string
  targetRepo: string
  branch: string
  tasks: readonly WorkSessionTask[]
  limits: WorkSessionLimits
  /** One creation starts an ordered task batch; the gate precedes its first Task. */
  scheduledStartAt?: string | null
  scheduleSource?: ScheduleSource
  createdAt?: string
  /** V2 makes TaskStateV2 authoritative; absent preserves established V1 behavior. */
  controlPlane?: 'v1' | 'v2'
  /** V2.8 kill switch. Omission is resolved by the production default. */
  directPath?: { enabled: boolean }
  /** v0.3.0 Golden Path default for ordinary LOW/MEDIUM tasks. Off unless enabled. */
  goldenPath?: { enabled: boolean }
}

export interface HumanRequired {
  category: string
  reason: string
}

/**
 * v0.4.0: 唯一允许在 Session 内闭环的人类动作类型。
 *
 * 刻意只覆盖纯业务决定。命令授权、凭据、修改范围扩张等权限类操作永远不会
 * 生成 pending action，因此不能借道同一个输入框获得授权。
 */
export type PendingHumanActionType = 'BUSINESS_DECISION'

/**
 * TaskRunner 侧的待处理人类动作请求。Runtime 在落库时补齐 sessionId /
 * taskId / generation 形成 [[PendingHumanAction]]，Runner 不自行编号。
 */
export interface PendingHumanActionRequest {
  type: PendingHumanActionType
  prompt: string
  /** 存在时 decision 必须精确等于其中一个选项；否则为自由文本。 */
  options?: readonly string[]
}

/**
 * 一个 task-/generation 绑定的结构化人类决定请求。
 *
 * generation 与 humanRequiredGeneration 必须一致，任何旧页面、重复提交或
 * 过期决定都会在授权层被拒绝，不会启动第二次恢复。
 */
export interface PendingHumanAction extends PendingHumanActionRequest {
  sessionId: string
  taskId: string
  generation: number
}

/**
 * v0.4.0: 一个已经由操作者在 Session 内回答、并与 task/generation 绑定的结构化
 * 人类动作。
 *
 * 它只从 Runtime 落库的 [[PendingHumanAction]] 派生 —— taskId/generation 已经由
 * Control UI 的提交路径校验过。因此诊断可以把它当作「已经成立的业务事实」，而
 * 不像 recovery instruction 字符串那样只是一条无从分辨来源的自由文本。
 */
export interface AnsweredHumanAction {
  type: PendingHumanActionType
  sessionId: string
  taskId: string
  generation: number
  /** 操作者提交的原值；Runtime 不做大小写或同义词归一化。 */
  decision: string
}

/** A durable, task-bound, exact-command approval request owned by the runtime. */
export interface PendingVerificationApproval {
  sessionId: string
  taskId: string
  /** Safe for the local control snapshot only; never copied to the ledger. */
  command: string
  commandFingerprint: string
  generation: number
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED'
}

/** Durable proof that a Runtime Repair selected an independent reviewer and resumed. */
export interface RuntimeRepairRecord {
  reasonCode: string
  chosenReviewer?: TaskActorIdentity
  appliedAt: string
  /** Runtime Repair never re-runs the Executor; this is a durable audit fact. */
  executorReran: boolean
}

export interface WorkSessionDurableState {
  /** User instructions are durable task-scoped input, never an authorization grant. */
  taskRecoveryInstructions?: Record<string, readonly {
    sessionId: string
    taskId: string
    generation: number
    instruction: string
    recordedAt: string
  }[]>
  sessionId: string
  state: WorkSessionState
  currentTaskIndex: number
  currentTaskId: string | null
  completedTaskIds: readonly string[]
  /**
   * V2 task-centric durable projection.  The Work Session snapshot remains the
   * single persistence boundary; this field deliberately does not introduce a
   * second workflow or a competing runtime state machine.
   */
  taskStatesV2?: Record<string, import('./task-state-v2.js').TaskStateV2>
  /**
   * V2 append-only Task Event Log projection (per taskId). History only; it is
   * never replayed into semantic decisions. Persisted inside the same session
   * snapshot as TaskStateV2 so restart restores it without a second store.
   */
  taskEventLogs?: Record<string, readonly import('./task-observability.js').TaskEventV2[]>
  /** V2 last-known Provider Health projection (per provider). Real observations override it. */
  providerHealth?: Record<string, import('./task-observability.js').ProviderHealthObservation>
  humanRequired?: HumanRequired
  /** v0.4.0: 结构化待处理人类动作；只有 BUSINESS_DECISION 会生成。 */
  pendingHumanAction?: PendingHumanAction
  pendingVerificationApproval?: PendingVerificationApproval
  /** v0.2.4: durable Runtime Repair record (chosen reviewer + audit facts). */
  runtimeRepair?: RuntimeRepairRecord
  /** Brain did not produce a verdict; distinct from a true human decision. */
  brainFailure?: GuardianBrainFailure
  /** W006: 每次 autonomous execution 新进入 HUMAN_REQUIRED 时递增。pendingHumanAction.generation 绑定此值。 */
  humanRequiredGeneration?: number
  /** W006: 已执行过 bounded delivery attempt 的 generation（成功或失败）。 */
  lastNotificationAttemptGeneration?: number
  /** W006: 最近成功送达通知的 generation。 */
  lastNotifiedHumanRequiredGeneration?: number
  /** Each independent Brain infrastructure suspension increments this durable identity. */
  recoveryRequiredGeneration?: number
  /** Bounded delivery was attempted for this recovery generation. */
  lastRecoveryNotificationAttemptGeneration?: number
  /** Recovery notification was delivered for this generation. */
  lastNotifiedRecoveryRequiredGeneration?: number
  /** Completion email delivery claim; intentionally independent from HUMAN_REQUIRED generations. */
  completionNotificationAttempted?: boolean
  /** Completion email delivery succeeded after the durable attempt claim. */
  completionNotified?: boolean
  /** FAILED email delivery claim; set only after the first bounded attempt has begun. */
  failureNotificationAttempted?: boolean
  /** FAILED email delivery succeeded after the durable attempt claim. */
  failureNotified?: boolean
  /** W003: 当前 Task 的 recovery checkpoint（仅当 SUSPENDED 时存在） */
  currentTaskCheckpoint?: GuardianTaskRecoveryCheckpoint
  /** Product-safe evidence retained for a suspended deterministic verifier. */
  verificationFailure?: VerificationResult
  /** Durable proof that the approved exact verifier actually produced a result. */
  verificationResults?: readonly VerificationResult[]
  /**
   * W004-A: 每个已完成 Task 对应的 commit SHA。
   * 连续 Task 需要区分 T1→sha1 / T2→sha2 / T3→sha3，故不保存单一 lastCommitSha。
   */
  checkpointCommits?: Record<string, string>
  /**
   * W004-B: 每个已完成 Task 的 push SHA（仅 autoPush=true 且远端验证通过时存在）。
   * 与 checkpointCommits（local commit SHA）区分：commit 成功但 push 失败时，
   * checkpointCommits 有值而 checkpointPushes 无对应 entry。
   */
  checkpointPushes?: Record<string, string>
  /** W004-B FINAL: 当前 Task 开始时的 HEAD（仅 autoCommit=true 时使用） */
  currentTaskBaseHeadSha?: string
  /** W004-B: 已结算的 active working time（毫秒）；suspend 期间不累积 */
  activeElapsedMs?: number
  /** W004-B: 当前 active segment 的开始时间（clock 帧内绝对毫秒）；SUSPEND/terminal 时清空 */
  activeSegmentStartedAt?: number
  /** W004-B: 正常结束原因（仅 COMPLETED 时存在） */
  completionReason?: WorkSessionCompletionReason
  /** W005-B: only present for a user-requested safe-boundary suspension. */
  suspensionReason?: WorkSessionSuspensionReason
  /** W005-B: only present when an explicit stop-after-task ends the session. */
  cancellationReason?: WorkSessionCancellationReason
  /** W005-B durability closure: pending stop intent survives a suspended process restart. */
  stopAfterTaskRequested?: boolean
  /** W004-A FINAL: Git checkpoint/finalization 失败时的明确错误原因（仅 FAILED 时存在） */
  failureReason?: string
  /** Stable product taxonomy for FAILED terminal state. */
  failureStage?: WorkSessionFailureStage
  /** Stable product taxonomy for FAILED terminal state. */
  failureCategory?: WorkSessionFailureCategory
  /** Sanitized product-safe failure presentation; never raw stderr/provider output. */
  safeFailureMessage?: string
  createdAt: Date
  scheduledStartAt?: string | null
  scheduleSource?: ScheduleSource
  startedAt?: Date
  completedAt?: Date
  updatedAt: Date
}
