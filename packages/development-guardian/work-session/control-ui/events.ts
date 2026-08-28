/**
 * W005-A Thin Local Control Surface — Control Event Model
 *
 * control 层的 recent events 只保存"有意义变化"的安全字段，
 * 不是 event sourcing，也不是 Work Session 的 durable source of truth。
 *
 * durable source of truth 仍是 WorkSessionDurableState。
 */

import type { WorkSessionDefinition, WorkSessionDurableState } from '../model.js'
import type { ExecutionLedgerEvent } from '../execution-ledger.js'
import type {
  WorkSessionDisplayState,
  WorkSessionRecoverySummary,
} from '../recoverability.js'

/**
 * recent event 类型。SSE 把 GUARDIAN_PHASE 映射为 `event: guardian`，
 * 其余映射为 `event: activity`。
 */
export type ControlEventType =
  | 'SESSION_STARTED'
  | 'SESSION_STATE_CHANGED'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'GUARDIAN_PHASE'
  | 'CHECKPOINT_COMMITTED'
  | 'CHECKPOINT_PUSHED'
  | 'HUMAN_REQUIRED'
  | 'BRAIN_INFRASTRUCTURE_FAILED'
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'PAUSE_REQUESTED'
  | 'SESSION_PAUSED'
  | 'STOP_AFTER_TASK_REQUESTED'
  | 'SESSION_RESUME_REQUESTED'
  | 'SESSION_RESUMED'
  | 'CHECKPOINT_RECOVERY_REQUESTED'
  | 'CHECKPOINT_RECOVERY_COMPLETED'
  | 'CHECKPOINT_RECOVERY_FAILED'
  | 'NOTIFICATION_SENT'
  | 'NOTIFICATION_FAILED'

/**
 * 单条 recent event。data 只包含展示需要的安全字段；
 * 不包含 control token、provider session、环境变量或任何 secret。
 */
export interface ControlEvent {
  id: number
  timestamp: string
  type: ControlEventType
  data: Record<string, unknown>
}

/** emit 前的事件输入（id/timestamp 由 controller 统一补齐） */
export interface ControlEventInput {
  type: ControlEventType
  data?: Record<string, unknown>
}

/**
 * 结构化只读 snapshot，直接作为 GET /api/status 与 SSE snapshot 的 payload。
 *
 * 刻意不包含：
 * - currentTaskCheckpoint（含 provider conversation URL / sessionId）；
 * - activeSegmentStartedAt / createdAt / updatedAt；
 * - failureReason / provider raw error；
 * - 任何 secret / control token / env。
 */
export interface WorkSessionControlSnapshot {
  server: {
    host: string
    port: number
    url: string
  }
  configuredSession: {
    id: string
    targetRepo: string
    branch: string
    limits: {
      softMinutes: number
      hardMinutes: number
      maxTasks: number
    }
    tasks: readonly { id: string; goal: string }[]
  }
  runtime: {
    started: boolean
    running: boolean
    /** T021: 当前进程内是否存在真正启动/恢复过执行的 Runtime Runner。 */
    hasActiveExecution?: boolean
    /** T021: 派生展示状态（持久化 state 与 runtime liveness 分离后的单一来源）。 */
    displayState?: WorkSessionDisplayState
    state?: string
    currentTaskId?: string | null
    completedTaskIds?: readonly string[]
    checkpointCommits?: Record<string, string>
    checkpointPushes?: Record<string, string>
    /** W005-A 展示值：RUNNING 时包含当前未 settle 的 active segment。 */
    activeElapsedMs?: number
    completionReason?: string
    humanRequired?: { category: string; reason: string }
    verificationFailure?: {
      command: string
      classification: string
      exitCode?: number | null
      durationMs?: number
      firstFailure?: {
        title: string
        exceptionType?: string
        tracebackSnippet: string
        phase: string
      }
      rawOutputRef?: string
      finalSummary?: string
      rootCauseCount?: number
      affectedTests?: number
    }
    pendingVerificationApproval?: {
      taskId: string
      command: string
      generation: number
    }
    brainFailure?: {
      stage: 'BRAIN_REVIEW'
      category: string
      adapter: string
      retryable: boolean
      degraded: boolean
      fingerprint: string
      requestedModel?: string
      requestedReasoning?: string
      safeMessage: string
    }
    suspensionReason?: string
    cancellationReason?: string
    recovery?: { available: boolean; kind: 'GIT_PUSH'; taskId: string }
    /** T021: 从持久化事实推导的恢复信息；仅 RECOVERABLE 展示状态时存在。 */
    recoverableSummary?: WorkSessionRecoverySummary
  }
  controls: {
    pauseRequested: boolean
    stopAfterTaskRequested: boolean
  }
  guardian: {
    phase?: string
    status?: string
    iteration?: number
    elapsedMs?: number
  }
  recentEvents: ControlEvent[]
  /** Durable SAFE PRODUCT DATA; never contains raw provider/error detail. */
  executionLedger?: readonly ExecutionLedgerEvent[]
}

/**
 * control 层依赖的窄 runtime 接口。真实 WorkSessionRuntime 结构化满足它；
 * 测试注入 deterministic fake runtime。
 */
export interface WorkSessionControlRuntime {
  loadPersistedState(): Promise<WorkSessionDurableState | undefined>
  start(): Promise<WorkSessionDurableState>
  resume(input: { decision?: string; approval?: boolean }): Promise<WorkSessionDurableState>
  approvePendingVerificationAndContinue?(): Promise<WorkSessionDurableState>
  recoverFailedGitCheckpoint?(): Promise<WorkSessionDurableState>
  /** T021: 当前进程内是否真正启动/恢复过执行；用于区分持久化 state 与 runtime liveness。 */
  hasActiveExecution?(): boolean
  /** T021: 显式恢复 crash-遗留的 RUNNING session（无 suspend step）。 */
  resumeInterrupted?(): Promise<WorkSessionDurableState>
  requestPause(): { accepted: boolean; reason?: string }
  requestStopAfterTask(): { accepted: boolean; reason?: string }
  getControlIntents(): { pauseRequested: boolean; stopAfterTaskRequested: boolean }
  getDurableState(): WorkSessionDurableState | undefined
  getDefinition(): WorkSessionDefinition
  readExecutionLedger?(): readonly ExecutionLedgerEvent[]
}

/** 单个 SSE subscriber 的回调：事件流 + snapshot 变化流。 */
export interface ControlSubscriber {
  onEvent(event: ControlEvent): void
  onSnapshot(snapshot: WorkSessionControlSnapshot): void
}
