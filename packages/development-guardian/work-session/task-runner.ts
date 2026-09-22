/**
 * Work Session Task Runner 抽象
 * 允许 Work Session 注入不同的任务执行器（Fake 或真实 Guardian Adapter）
 */

import type { WorkSessionTask, HumanRequired, PendingHumanActionRequest, AnsweredHumanAction } from './model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import type {
  DelegationVerdict,
  GuardianBrainFailure,
  VerificationResult,
} from '../model.js'
import type { GuardianProgressObserver } from '../progress.js'
import type { TaskActorIdentity, TaskStateV2 } from './task-state-v2.js'
import type {
  WorkSessionFailureCategory,
  WorkSessionFailureStage,
} from './failure-classification.js'
import type { TaskEventLogV2, ProviderHealthRegistry } from './task-observability.js'

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
  /** Exact V2 repository authorization, rechecked before Git transport mutates it. */
  repositoryReality?: import('./reconciliation.js').RepositoryReality
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
  /**
   * v0.4.0: 只有纯业务决定才会提供；Runtime 补齐 sessionId/taskId/generation 后
   * 持久化。权限类 suspension 永远不携带此字段。
   */
  pendingHumanAction?: PendingHumanActionRequest
  /** Runtime validates and persists this exact command before it can be approved. */
  pendingVerificationCommand?: string
  brainFailure?: GuardianBrainFailure
  error?: string
  failureStage?: WorkSessionFailureStage
  failureCategory?: WorkSessionFailureCategory
  /** Product-safe evidence retained when verification suspends on the environment. */
  verificationFailure?: VerificationResult
  /** W003: suspended result 可选的恢复 checkpoint */
  checkpoint?: GuardianTaskRecoveryCheckpoint
  /** W004-A: 真 COMPLETED 时的结构化 evidence（供 Git checkpoint 使用） */
  completionEvidence?: TaskCompletionEvidence
  /** V2 controller runner returns the authoritative post-action task state. */
  taskStateV2?: TaskStateV2
}

/**
 * W004-B: WorkSession 传给 TaskRunner 的执行上下文。
 * Runtime 不把 Mastra 直接耦合进 Guardian；这里只传最小 deadline 事实。
 */
export interface WorkSessionTaskRunContext {
  /** Durable supplemental instructions for this exact Session and Task only. */
  recoveryInstructions?: readonly string[]
  /**
   * v0.4.0: 本轮 resume 正在回答的结构化人类动作（Runtime 落库的
   * pendingHumanAction）。它与 recoveryInstructions 分开，因为诊断必须能区分
   * 「已经被操作者回答的业务决定」和普通收窄指令。
   */
  answeredHumanAction?: AnsweredHumanAction
  /** hard deadline 绝对时间（clock 帧内毫秒）；超过后不得启动新的 Reviewer/Executor iteration */
  hardDeadlineAtMs?: number
  /** W005-B: checked only at Guardian safe autonomous boundaries. */
  shouldPauseAutonomousWork?: () => boolean
  /** Additive safe structured progress sink used by the Execution Ledger. */
  onProgress?: GuardianProgressObserver
  /** Runtime-owned one-shot capability; never comes from the browser. */
  approvedVerificationCommand?: string
  persistTaskStateV2?: (state: TaskStateV2) => Promise<void>
  /** Existing Work Session snapshot projection supplied to the V2 action loop. */
  taskStateV2?: TaskStateV2
  /** Runtime Repair-selected independent reviewer; trusted only after deterministic validation. */
  chosenReviewer?: TaskActorIdentity
  /** Optional V2 Task Event Log accumulator; history only, never semantic authority. */
  taskEventLog?: TaskEventLogV2
  /** Optional V2 Provider Health registry (last-known), projected from real observations. */
  providerHealth?: ProviderHealthRegistry
}

export interface WorkSessionTaskRunner {
  /** Optional shared preflight used by durable approval reconciliation. */
  verifyRecoveryCheckpoint?(
    checkpoint: GuardianTaskRecoveryCheckpoint,
  ): Promise<{ ok: boolean; reason?: string; category?: string }>
  run(
    task: WorkSessionTask,
    resumeData?: any,
    checkpoint?: GuardianTaskRecoveryCheckpoint,
    context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult>
}
