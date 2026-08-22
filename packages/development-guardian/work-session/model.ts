/**
 * Work Session MVP Domain Model
 * W001 最小模型定义
 * W003 增加 checkpoint 支持
 */

import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'

export type WorkSessionState =
  | 'READY'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface WorkSessionTask {
  id: string
  goal: string
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

export type WorkSessionSuspensionReason = 'USER_PAUSED'
export type WorkSessionCancellationReason = 'STOP_AFTER_TASK'

export interface WorkSessionDefinition {
  id: string
  targetRepo: string
  branch: string
  tasks: readonly WorkSessionTask[]
  limits: WorkSessionLimits
}

export interface HumanRequired {
  category: string
  reason: string
}

export interface WorkSessionDurableState {
  sessionId: string
  state: WorkSessionState
  currentTaskIndex: number
  currentTaskId: string | null
  completedTaskIds: readonly string[]
  humanRequired?: HumanRequired
  /** W006: 每次 autonomous execution 新进入 HUMAN_REQUIRED 时递增。 */
  humanRequiredGeneration?: number
  /** W006: 已执行过 bounded delivery attempt 的 generation（成功或失败）。 */
  lastNotificationAttemptGeneration?: number
  /** W006: 最近成功送达通知的 generation。 */
  lastNotifiedHumanRequiredGeneration?: number
  /** Completion email delivery claim; intentionally independent from HUMAN_REQUIRED generations. */
  completionNotificationAttempted?: boolean
  /** Completion email delivery succeeded after the durable attempt claim. */
  completionNotified?: boolean
  /** W003: 当前 Task 的 recovery checkpoint（仅当 SUSPENDED 时存在） */
  currentTaskCheckpoint?: GuardianTaskRecoveryCheckpoint
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
  createdAt: Date
  updatedAt: Date
}
