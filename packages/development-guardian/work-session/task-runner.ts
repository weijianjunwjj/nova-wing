/**
 * Work Session Task Runner 抽象
 * 允许 Work Session 注入不同的任务执行器（Fake 或真实 Guardian Adapter）
 */

import type { WorkSessionTask, HumanRequired } from './model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'

export type WorkSessionTaskResultStatus = 'COMPLETED' | 'HUMAN_REQUIRED' | 'FAILED'

export interface WorkSessionTaskResult {
  status: WorkSessionTaskResultStatus
  summary?: string
  humanRequired?: HumanRequired
  error?: string
  /** W003: HUMAN_REQUIRED 时可选的恢复 checkpoint */
  checkpoint?: GuardianTaskRecoveryCheckpoint
}

export interface WorkSessionTaskRunner {
  run(task: WorkSessionTask, resumeData?: any, checkpoint?: GuardianTaskRecoveryCheckpoint): Promise<WorkSessionTaskResult>
}
