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
  createdAt: Date
  updatedAt: Date
}
