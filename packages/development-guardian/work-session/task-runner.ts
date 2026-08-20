/**
 * Work Session Task Runner 抽象
 * 允许 Work Session 注入不同的任务执行器（Fake 或真实 Guardian Adapter）
 */

import type { WorkSessionTask, HumanRequired } from './model.js'

export type WorkSessionTaskResultStatus = 'COMPLETED' | 'HUMAN_REQUIRED' | 'FAILED'

export interface WorkSessionTaskResult {
  status: WorkSessionTaskResultStatus
  summary?: string
  humanRequired?: HumanRequired
  error?: string
}

export interface WorkSessionTaskRunner {
  run(task: WorkSessionTask, resumeData?: any): Promise<WorkSessionTaskResult>
}
