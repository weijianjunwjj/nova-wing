import type { WorkSessionDefinition, WorkSessionDurableState } from '../model.js'
import type { ExecutionLedgerEvent } from '../execution-ledger.js'
import type { CodingExecutionView, ControlEvent, ExecutionActivityView } from './events.js'
import { concreteRuntimeProvider } from '../direct-path.js'

export interface RuntimeOverview {
  taskId?: string
  status: string
  currentPhase?: string
  createdAt?: string
  startMode: 'immediate' | 'custom' | 'deepseek_off_peak'
  scheduledStartAt?: string
  startedAt?: string
  completedAt?: string
  totalElapsedMs: number
  executor: { provider?: string; model?: string; status: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING' }
  iteration: { current: number; maximum?: number }
  lastActivityAt?: string
}

export interface RuntimePresentationInput {
  definition: WorkSessionDefinition
  state?: WorkSessionDurableState | undefined
  ledger: readonly ExecutionLedgerEvent[]
  recentEvents: readonly ControlEvent[]
  executionActivities: readonly ExecutionActivityView[]
  codingExecutions?: readonly CodingExecutionView[] | undefined
  currentPhase?: string | undefined
  currentPhaseTaskId?: string | undefined
  hasActiveExecution: boolean
  displayState: string
  now: number
}

function iso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export function presentationTaskId(definition: WorkSessionDefinition, state?: WorkSessionDurableState): string | undefined {
  return state?.currentTaskId ?? (state?.state === 'COMPLETED'
    ? state.completedTaskIds.at(-1)
    : definition.tasks[state?.currentTaskIndex ?? 0]?.id)
}

/** A read-only view of execution cycles. VERIFY/REVIEW/Controller decisions never count. */
export function deriveRuntimeOverview(input: RuntimePresentationInput): RuntimeOverview {
  const { definition, state, now } = input
  const taskId = presentationTaskId(definition, state)
  const task = taskId === undefined ? undefined : state?.taskStatesV2?.[taskId]
  const events = taskId === undefined ? [] : state?.taskEventLogs?.[taskId] ?? []
  const ledger = input.ledger.filter(event => event.taskId === taskId)
  const phases = ledger.filter(event => 'phase' in event)
  const dispatches = events.filter(event => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE')
  const ledgerExecutions = phases.filter(event => event.eventType === 'PHASE_STARTED' && event.phase === 'EXECUTING')
  const ephemeral = input.executionActivities.filter(event => event.taskId === taskId)
  const recent = input.recentEvents.filter(event => event.data.taskId === taskId)
  const ephemeralCount = ephemeral.filter(event => event.phase === 'EXECUTING' && event.kind === 'PROVIDER_DISPATCHED').length
  let phaseCount = 0
  let executing = false
  for (const event of recent) {
    if (event.type !== 'TASK_PHASE' && event.type !== 'GUARDIAN_PHASE') continue
    const next = event.data.phase === 'EXECUTING' && event.data.status === 'active'
    if (next && !executing) phaseCount++
    executing = next
  }
  // Sources overlap; never add them. Ledger and TaskEventLog survive hydration.
  // V2 emits EXECUTING before selecting an available agent. Only a dispatch
  // proves entry into its Executor cycle; legacy V1 retains its phase evidence.
  const current = definition.controlPlane === 'v2'
    ? Math.max(dispatches.length, ephemeralCount)
    : Math.max(dispatches.length, ledgerExecutions.length, ephemeralCount, phaseCount)
  const execution = input.codingExecutions?.find(entry => entry.taskId === taskId)
  const lastExecutorEvent = events.filter(event => event.action === 'EXECUTE' &&
    ['AGENT_DISPATCHED', 'AGENT_COMPLETED', 'AGENT_FAILED'].includes(event.type)).at(-1)
  const lastExecutorPhase = phases.filter(event => event.phase === 'EXECUTING').at(-1)
  const provider = concreteRuntimeProvider(execution?.activeExecutor) ??
    concreteRuntimeProvider([...ephemeral].reverse().find(event => event.provider !== undefined)?.provider) ??
    concreteRuntimeProvider([...events].reverse().find(event => event.action === 'EXECUTE' && event.provider !== undefined)?.provider) ??
    concreteRuntimeProvider(task?.implementer?.provider)
  const terminal = state !== undefined && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state.state)
  const completedAt = iso(state?.completedAt) ?? (terminal
    ? input.ledger.filter(event => event.eventType === 'SESSION_COMPLETED' || event.eventType === 'SESSION_FAILED').at(-1)?.timestamp ?? iso(state?.updatedAt)
    : undefined)
  const startedAt = iso(state?.startedAt) ?? input.ledger.find(event => event.eventType === 'SESSION_STARTED')?.timestamp
  const end = terminal ? Date.parse(completedAt ?? '') : now
  const totalElapsedMs = startedAt !== undefined && Number.isFinite(end)
    ? Math.max(0, end - Date.parse(startedAt))
    : state?.activeElapsedMs ?? 0
  const currentPhase = state?.state === 'COMPLETED' ? 'COMPLETED'
    : input.currentPhaseTaskId === taskId && input.currentPhase !== undefined ? input.currentPhase
      : phases.at(-1)?.phase ?? ({ EXECUTE: 'EXECUTING', VERIFY: 'VERIFYING', REVIEW: 'REVIEWING', ANALYZE: 'PLANNING', COMPLETE: 'FINALIZING' }[task?.currentAction ?? ''] ?? 'PLANNING')
  const lastLiveExecutor = ephemeral.filter(event => event.phase === 'EXECUTING' &&
    ['PROVIDER_DISPATCHED', 'PROVIDER_COMPLETED', 'PROVIDER_FAILED'].includes(event.kind)).at(-1)
  const outcomes = [
    ...(lastExecutorEvent === undefined ? [] : [{ timestamp: lastExecutorEvent.timestamp, outcome: lastExecutorEvent.type === 'AGENT_DISPATCHED' ? 'running' : lastExecutorEvent.type === 'AGENT_FAILED' ? 'failed' : 'completed' }]),
    ...(lastExecutorPhase === undefined ? [] : [{ timestamp: lastExecutorPhase.timestamp, outcome: lastExecutorPhase.eventType === 'PHASE_STARTED' ? 'running' : lastExecutorPhase.eventType === 'PHASE_FAILED' ? 'failed' : 'completed' }]),
    ...(lastLiveExecutor === undefined ? [] : [{ timestamp: lastLiveExecutor.timestamp, outcome: lastLiveExecutor.kind === 'PROVIDER_DISPATCHED' ? 'running' : lastLiveExecutor.kind === 'PROVIDER_FAILED' ? 'failed' : 'completed' }]),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const executorFailed = outcomes.at(-1)?.outcome === 'failed'
  const executorCompleted = outcomes.at(-1)?.outcome === 'completed'
  const executorStatus: RuntimeOverview['executor']['status'] = current === 0 ? 'NOT_STARTED'
    : state?.state === 'COMPLETED' || task?.status === 'COMPLETED' ? 'COMPLETED'
      : currentPhase === 'EXECUTING' && input.hasActiveExecution && state?.state === 'RUNNING' && !executorCompleted && !executorFailed ? 'RUNNING'
        : executorFailed ? 'FAILED'
          : executorCompleted || ['VERIFYING', 'REVIEWING', 'FINALIZING'].includes(currentPhase) ? 'COMPLETED' : 'WAITING'
  const createdAt = iso(state?.createdAt ?? definition.createdAt)
  const lastActivityAt = terminal ? undefined : ephemeral.at(-1)?.timestamp ?? input.ledger.at(-1)?.timestamp
  return {
    ...(taskId === undefined ? {} : { taskId }), status: input.displayState, currentPhase,
    ...(createdAt === undefined ? {} : { createdAt }),
    startMode: state?.scheduleSource ?? definition.scheduleSource ?? 'immediate',
    ...((state?.scheduledStartAt ?? definition.scheduledStartAt) == null ? {} : { scheduledStartAt: (state?.scheduledStartAt ?? definition.scheduledStartAt)! }),
    ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }),
    totalElapsedMs,
    executor: { status: executorStatus, ...(provider === undefined ? {} : { provider }), ...(execution?.model === undefined ? {} : { model: execution.model }) },
    iteration: { current, ...(task?.execution?.path === 'GOLDEN' ? { maximum: 2 } : {}) },
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  }
}

/** Preserve diagnostic structure without copying arbitrary provider payloads or user decisions. */
export function projectTaskDiagnostics(state: WorkSessionDurableState | undefined) {
  return {
    taskStates: Object.fromEntries(Object.entries(state?.taskStatesV2 ?? {}).map(([id, task]) => [id, {
      status: task.status, currentAction: task.currentAction, risk: task.risk,
      execution: task.execution, actionBudget: task.actionBudget, humanConstraints: task.humanConstraints,
      verificationPlan: task.verificationPlan,
      verificationResults: task.verificationState?.results.map(result => ({
        name: result.name, status: result.status, classification: result.classification,
        exitCode: result.exitCode, durationMs: result.durationMs, rawOutputRef: result.rawOutputRef,
      })),
    }])),
    taskEvents: Object.fromEntries(Object.entries(state?.taskEventLogs ?? {}).map(([id, events]) => [id, events.map(event => ({
      eventId: event.eventId, sessionId: event.sessionId, taskId: event.taskId, timestamp: event.timestamp,
      type: event.type, action: event.action, agent: event.agent, provider: event.provider,
      reasonCode: event.reasonCode, headSha: event.headSha, evidenceRefs: event.evidenceRefs,
    }))])),
    // The source remains available in the existing local durable state/ledger for full raw investigation.
    evidenceSource: 'WorkSessionDurableState.taskEventLogs / taskStatesV2; execution ledger; rawOutputRef',
  }
}
