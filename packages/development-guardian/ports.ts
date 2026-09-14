import type {
  DelegationPacket,
  ExecutionReport,
  GuardianBrainTransportMetrics,
  GuardianTask,
  VerificationExecutionStep,
} from './model.js'
import type { ProviderSessionState, RepositoryCheckpoint } from './work-session/checkpoint.js'

export interface GuardianBrain {
  review(input: {
    task: GuardianTask
    report?: ExecutionReport
    /** True only for a bounded retry after a wire-format protocol failure. */
    protocolRepair?: boolean
    /** Hard wall-clock allowance for this provider operation. */
    transportTimeoutMs?: number
  }): Promise<DelegationPacket>

  /**
   * Discard only this Task's replaceable provider conversation binding so the
   * next review starts a fresh provider session with the same Guardian evidence.
   */
  resetTaskReviewSession?(taskId: string): void

  /** Safe metrics from the most recent provider operation; never prompt content. */
  captureLastTransportMetrics?(): GuardianBrainTransportMetrics | undefined
}

export interface GuardianExecutor {
  /** Bounded, read-only workspace/runtime gate that must pass before EXECUTING. */
  preflight?(task: GuardianTask): Promise<void>

  execute(input: {
    task: GuardianTask
    packet: DelegationPacket
  }): Promise<ExecutionReport>

  /** Environment recovery path: rerun verification without invoking the code executor. */
  retryVerification?(input: {
    task: GuardianTask
    report: ExecutionReport
    verificationSteps?: readonly VerificationExecutionStep[]
  }): Promise<ExecutionReport>
}

/**
 * W003: 可恢复 Executor 显式契约
 *
 * 支持两级恢复能力的 Executor 必须实现此接口。
 * 不要通过 duck typing 或依赖 executor.options 实现恢复逻辑。
 */
export interface GuardianRecoverableExecutor extends GuardianExecutor {
  /** False means a timed-out local process may still write; retain the local ownership guard. */
  hasReleasedExecutionOwnership?(): boolean
  /**
   * 捕获 provider 会话状态（如 Claude sessionId、ChatGPT conversationUrl）
   */
  captureProviderState?(): ProviderSessionState

  /**
   * 恢复 provider 会话状态
   */
  restoreProviderState?(state: ProviderSessionState): void

  /**
   * 设置允许的 worktree checkpoint（用于 resume 验证）
   */
  setRecoveryCheckpoint?(checkpoint: RepositoryCheckpoint): void
}
