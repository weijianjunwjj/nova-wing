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
  /** W003: 当前 Task 的 recovery checkpoint（仅当 SUSPENDED 时存在） */
  currentTaskCheckpoint?: GuardianTaskRecoveryCheckpoint
  /**
   * W004-A: 每个已完成 Task 对应的 commit SHA。
   * 连续 Task 需要区分 T1→sha1 / T2→sha2 / T3→sha3，故不保存单一 lastCommitSha。
   */
  checkpointCommits?: Record<string, string>
  /** W004-A FINAL: Git checkpoint/finalization 失败时的明确错误原因（仅 FAILED 时存在） */
  failureReason?: string
  /** W004-A FINAL: 当前 Task 开始时的 HEAD（仅 autoCommit=true 时使用） */
  currentTaskBaseHeadSha?: string
  createdAt: Date
  updatedAt: Date
}
