/**
 * W005-A Thin Local Control Surface — Control Event Model
 *
 * control 层的 recent events 只保存"有意义变化"的安全字段，
 * 不是 event sourcing，也不是 Work Session 的 durable source of truth。
 *
 * durable source of truth 仍是 WorkSessionDurableState。
 */

import type { WorkSessionDefinition, WorkSessionDurableState } from '../model.js'

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
  | 'SESSION_COMPLETED'
  | 'SESSION_FAILED'
  | 'PAUSE_REQUESTED'
  | 'SESSION_PAUSED'
  | 'STOP_AFTER_TASK_REQUESTED'
  | 'SESSION_RESUME_REQUESTED'
  | 'SESSION_RESUMED'

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
    state?: string
    currentTaskId?: string | null
    completedTaskIds?: readonly string[]
    checkpointCommits?: Record<string, string>
    checkpointPushes?: Record<string, string>
    /** W005-A 展示值：RUNNING 时包含当前未 settle 的 active segment。 */
    activeElapsedMs?: number
    completionReason?: string
    humanRequired?: { category: string; reason: string }
    suspensionReason?: string
    cancellationReason?: string
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
}

/**
 * control 层依赖的窄 runtime 接口。真实 WorkSessionRuntime 结构化满足它；
 * 测试注入 deterministic fake runtime。
 */
export interface WorkSessionControlRuntime {
  start(): Promise<WorkSessionDurableState>
  resume(input: { decision?: string; approval?: boolean }): Promise<WorkSessionDurableState>
  requestPause(): { accepted: boolean; reason?: string }
  requestStopAfterTask(): { accepted: boolean; reason?: string }
  getControlIntents(): { pauseRequested: boolean; stopAfterTaskRequested: boolean }
  getDurableState(): WorkSessionDurableState | undefined
  getDefinition(): WorkSessionDefinition
}

/** 单个 SSE subscriber 的回调：事件流 + snapshot 变化流。 */
export interface ControlSubscriber {
  onEvent(event: ControlEvent): void
  onSnapshot(snapshot: WorkSessionControlSnapshot): void
}
