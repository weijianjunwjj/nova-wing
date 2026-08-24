/**
 * Work Session Task Runner 抽象
 * 允许 Work Session 注入不同的任务执行器（Fake 或真实 Guardian Adapter）
 */

import type { WorkSessionTask, HumanRequired } from './model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import type {
  DelegationVerdict,
  GuardianBrainFailure,
  VerificationResult,
} from '../model.js'
import type { GuardianProgressObserver } from '../progress.js'
import type {
  WorkSessionFailureCategory,
  WorkSessionFailureStage,
} from './failure-classification.js'

export type WorkSessionTaskResultStatus =
  | 'COMPLETED'
  | 'HUMAN_REQUIRED'
  | 'BRAIN_INFRASTRUCTURE_FAILED'
  | 'FAILED'
  | 'PAUSED'

/**
 * W004-A: Task 完成的结构化证据。
 *
 * WorkSession 不得靠 summary 文本猜测"这个 Task 好像完成了"。
 * Git checkpoint 的 commit gate 只认这份结构化证据，不读取 Guardian 内部对象。
 *
 * 仅包含 Git finalization 必要信息，不把完整 Guardian Task / ExecutionReport
 * 泄漏给 WorkSession。
 */
export interface TaskCompletionEvidence {
  /** Task 产生的 changed files（modified/new/deleted） */
  changedFiles: readonly string[]
  /** 要求执行的 deterministic verification 结果 */
  verificationResults: readonly VerificationResult[]
  /** blockers；真 COMPLETED 必须为 0 */
  blockers: readonly string[]
  /** final Reviewer verdict；允许 commit 只认 'done' */
  finalReviewerVerdict: DelegationVerdict
  /** 要求执行的 deterministic verification 命令（来自 final packet.verification） */
  requiredVerification: readonly string[]
  /** Executor 报告 incomplete 时非空；finalizer 据此 fail closed */
  incompleteReason?: string
}

export interface WorkSessionTaskResult {
  status: WorkSessionTaskResultStatus
  summary?: string
  humanRequired?: HumanRequired
  brainFailure?: GuardianBrainFailure
  error?: string
  failureStage?: WorkSessionFailureStage
  failureCategory?: WorkSessionFailureCategory
  /** W003: suspended result 可选的恢复 checkpoint */
  checkpoint?: GuardianTaskRecoveryCheckpoint
  /** W004-A: 真 COMPLETED 时的结构化 evidence（供 Git checkpoint 使用） */
  completionEvidence?: TaskCompletionEvidence
}

/**
 * W004-B: WorkSession 传给 TaskRunner 的执行上下文。
 * Runtime 不把 Mastra 直接耦合进 Guardian；这里只传最小 deadline 事实。
 */
export interface WorkSessionTaskRunContext {
  /** hard deadline 绝对时间（clock 帧内毫秒）；超过后不得启动新的 Reviewer/Executor iteration */
  hardDeadlineAtMs?: number
  /** W005-B: checked only at Guardian safe autonomous boundaries. */
  shouldPauseAutonomousWork?: () => boolean
  /** Additive safe structured progress sink used by the Execution Ledger. */
  onProgress?: GuardianProgressObserver
}

export interface WorkSessionTaskRunner {
  run(
    task: WorkSessionTask,
    resumeData?: any,
    checkpoint?: GuardianTaskRecoveryCheckpoint,
    context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult>
}
