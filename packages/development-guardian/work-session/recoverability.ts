/**
 * T021 Recoverability — 单一来源判定路径
 *
 * 把「Session 持久化状态」与「当前进程 Runtime Runner 存活状态」明确分离：
 * - 持久化状态（WorkSessionDurableState.state）是 durable source of truth，永不被修改；
 * - runtime liveness（hasActiveExecution）只在当前进程内成立；
 * - 派生展示状态（deriveDisplayState）供 Launchpad 与 Work Session 控制台共同消费，
 *   避免两处各自推导导致状态不一致。
 *
 * 判定规则（严格 fail-closed，不伪造 checkpoint）：
 * - 无持久化状态            → READY（真正从未启动）
 * - COMPLETED/FAILED/CANCELLED → 终态原样，绝不 RECOVERABLE
 * - 非终态 + 有活动 runner   → 原状态（RUNNING / SUSPENDED）
 * - 非终态 + 无活动 runner   → RECOVERABLE（进程重启 / 异常退出后可手动继续）
 */

import type { WorkSessionDefinition, WorkSessionDurableState } from './model.js'
import type { ExecutionLedgerEvent } from './execution-ledger.js'

export type WorkSessionDisplayState =
  | 'READY'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'RECOVERABLE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

const TERMINAL_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

export function isTerminalWorkSessionState(state: string): boolean {
  return TERMINAL_STATES.has(state)
}

/**
 * 派生展示状态。`persistedState` 为 undefined 表示当前进程从未建立 durable state
 * （真正 READY）；`hasActiveExecution` 表示当前进程内是否存在真正启动/恢复过执行的
 * Runtime Runner。二者独立，禁止互相替代。
 */
export function deriveDisplayState(
  persistedState: WorkSessionDurableState | undefined,
  hasActiveExecution: boolean,
): WorkSessionDisplayState {
  if (persistedState === undefined) {
    return 'READY'
  }
  if (isTerminalWorkSessionState(persistedState.state)) {
    return persistedState.state as WorkSessionDisplayState
  }
  if (hasActiveExecution) {
    return persistedState.state === 'RUNNING' ? 'RUNNING' : 'SUSPENDED'
  }
  return 'RECOVERABLE'
}

/**
 * 从既有持久化事实（durable state + Execution Ledger）推导的恢复信息。
 * 任何字段都必须来自可证明的持久化事实；缺失事实时保持 unknown 或 fail-closed，
 * 绝不伪造 checkpoint。
 */
export interface WorkSessionRecoverySummary {
  /** 最后活动时间（优先取 durable updatedAt，其次取 ledger 最后一条 event 的 timestamp）。 */
  lastActivityAt?: string
  /** 最后完成的 Task id；从未完成任何 Task 时为 null。 */
  lastCompletedTaskId: string | null
  /** 当前 Task id；未 claim 任何 Task 时为 null。 */
  currentTaskId: string | null
  /** 最后可靠 checkpoint 的人类可读描述；无任何可靠 checkpoint 时为 undefined。 */
  lastReliableCheckpoint?: string
  /** 当前 execution phase（来自 ledger 最后一个 PHASE_* 事件）；未知时 undefined。 */
  currentPhase?: string
  /** 下一步恢复动作的人类可读描述。 */
  nextResumableAction: string
}

function shortSha(sha: string): string {
  return sha.length >= 8 ? sha.slice(0, 8) : sha
}

/**
 * 推导恢复信息。仅依赖：
 * - state.completedTaskIds / currentTaskId / currentTaskCheckpoint
 * - state.checkpointCommits / checkpointPushes
 * - ledger 中的 PHASE_* / TASK_COMPLETED / GIT_* 事件
 * 不使用任何 runtime liveness 或未持久化的进程内状态。
 */
export function deriveRecoverySummary(
  definition: WorkSessionDefinition,
  state: WorkSessionDurableState,
  ledger: readonly ExecutionLedgerEvent[],
): WorkSessionRecoverySummary {
  const completedTaskIds = state.completedTaskIds
  const lastCompletedTaskId = completedTaskIds.length > 0
    ? completedTaskIds[completedTaskIds.length - 1] ?? null
    : null
  const persistedCurrentTaskId = state.currentTaskId ?? null
  const currentTaskId =
    persistedCurrentTaskId !== null && !completedTaskIds.includes(persistedCurrentTaskId)
      ? persistedCurrentTaskId
      : null

  const lastLedgerActivity = ledger[ledger.length - 1]
  const lastActivityAt = state.updatedAt.toISOString() || lastLedgerActivity?.timestamp

  const currentPhase = lastGuardianPhase(ledger)

  const lastReliableCheckpoint = lastReliableCheckpointLabel(state)

  const nextResumableAction = nextResumableActionLabel(definition, state, currentTaskId)

  return {
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    lastCompletedTaskId,
    currentTaskId,
    ...(lastReliableCheckpoint === undefined ? {} : { lastReliableCheckpoint }),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    nextResumableAction,
  }
}

function lastGuardianPhase(ledger: readonly ExecutionLedgerEvent[]): string | undefined {
  for (let index = ledger.length - 1; index >= 0; index--) {
    const event = ledger[index]!
    if (
      (event.eventType === 'PHASE_STARTED' ||
        event.eventType === 'PHASE_COMPLETED' ||
        event.eventType === 'PHASE_FAILED') &&
      'phase' in event &&
      event.phase !== undefined
    ) {
      return event.phase
    }
  }
  return undefined
}

function lastReliableCheckpointLabel(state: WorkSessionDurableState): string | undefined {
  const currentTaskId = state.currentTaskId
  if (currentTaskId !== null && currentTaskId !== undefined) {
    const pushSha = state.checkpointPushes?.[currentTaskId]
    if (pushSha !== undefined) {
      return `Git Push ${shortSha(pushSha)}`
    }
    const commitSha = state.checkpointCommits?.[currentTaskId]
    if (commitSha !== undefined) {
      return `Git Commit ${shortSha(commitSha)}`
    }
    const guardianCheckpoint = state.currentTaskCheckpoint
    if (guardianCheckpoint !== undefined) {
      return `Guardian checkpoint（Task ${currentTaskId}，iteration ${guardianCheckpoint.task.iteration ?? 0}）`
    }
  }

  const completedTaskIds = state.completedTaskIds
  if (completedTaskIds.length > 0) {
    const lastCompleted = completedTaskIds[completedTaskIds.length - 1]
    const commitSha = lastCompleted !== undefined ? state.checkpointCommits?.[lastCompleted] : undefined
    const pushSha = lastCompleted !== undefined ? state.checkpointPushes?.[lastCompleted] : undefined
    if (pushSha !== undefined) {
      return `Task ${lastCompleted} 已 Push ${shortSha(pushSha)}`
    }
    if (commitSha !== undefined) {
      return `Task ${lastCompleted} 已 Commit ${shortSha(commitSha)}`
    }
  }

  return undefined
}

function nextResumableActionLabel(
  definition: WorkSessionDefinition,
  state: WorkSessionDurableState,
  currentTaskId: string | null,
): string {
  if (currentTaskId !== null) {
    const pushSha = state.checkpointPushes?.[currentTaskId]
    if (pushSha !== undefined) {
      return `继续 Task ${currentTaskId} 的 Final Review 或进入下一个 Task`
    }
    const commitSha = state.checkpointCommits?.[currentTaskId]
    if (commitSha !== undefined) {
      return `先 reconcile Task ${currentTaskId} 的 Git Push 状态，再继续`
    }
    if (state.currentTaskCheckpoint !== undefined) {
      return `从 Guardian checkpoint 恢复 Task ${currentTaskId} 的执行进度`
    }
    return `从 Task ${currentTaskId} 边界继续执行`
  }

  const completed = new Set(state.completedTaskIds)
  const nextTask = definition.tasks.find((task) => !completed.has(task.id))
  if (nextTask !== undefined) {
    return `继续执行 Task ${nextTask.id}`
  }
  return '继续后续工作'
}
