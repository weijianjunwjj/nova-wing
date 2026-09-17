import type { WorkSessionDefinition, WorkSessionDurableState } from '../model.js'
import type { ExecutionLedgerEvent } from '../execution-ledger.js'
import type { TaskEventV2 } from '../task-observability.js'
import type { CodingExecutionView, ControlEvent, ExecutionActivityView } from './events.js'

export interface UserActivityView {
  id: string
  timestamp: string
  taskId?: string
  kind: string
  phase?: string
  status: 'running' | 'completed' | 'failed' | 'human_required'
  label: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  provider?: string
  model?: string
  /** Actual dispatch evidence; a Controller EXECUTING phase alone is insufficient. */
  executorDispatched?: true
  checkpointSha?: string
  changedFileCount?: number
  verifiers?: readonly { name: string; outcome: 'RUNNING' | 'PASSED' | 'FAILED'; durationMs?: number }[]
}

interface ActivityProjectionInput {
  definition: WorkSessionDefinition
  state?: WorkSessionDurableState
  ledger: readonly ExecutionLedgerEvent[]
  recentEvents: readonly ControlEvent[]
  executionActivities: readonly (ExecutionActivityView & { taskId?: string })[]
  codingExecutions?: readonly CodingExecutionView[]
}

type Source = 'task' | 'control' | 'ledger' | 'activity'
interface PhaseFact {
  source: Source
  taskId: string
  phase: string
  timestamp: string
  status: UserActivityView['status']
  provider?: string
  verifier?: string
  verifiers?: readonly string[]
  durationMs?: number
  /** Task dispatch identities distinguish a retry even without an intervening end. */
  dispatch?: boolean
}
interface PhaseActivity extends UserActivityView {
  sources: Set<Source>
}

const PHASE_KINDS: Record<string, string> = {
  EXECUTING: 'EXECUTE', VERIFYING: 'VERIFY', REVIEWING: 'REVIEW', FINAL_REVIEW: 'REVIEW',
  PREPARING: 'PREPARING', PLANNING: 'PLANNING', ANALYZING: 'ANALYZE',
  RECOVERING: 'RECOVERY', RECONCILING: 'RECONCILE', AI_REPAIR: 'AI_REPAIR', RUNTIME_REPAIR: 'RUNTIME_REPAIR',
}
const PHASE_LABELS: Record<string, readonly [string, string, string]> = {
  EXECUTE: ['Executor 开始执行', 'Executor 完成', 'Executor 执行失败'],
  VERIFY: ['正在验证', '验证通过', '验证失败'],
  REVIEW: ['正在审查', '审查通过', '审查失败'],
  PLANNING: ['正在规划', '规划完成', '规划失败'],
  PREPARING: ['正在准备', '准备完成', '准备失败'],
  ANALYZE: ['正在分析', '分析完成', '分析失败'],
  RECOVERY: ['正在恢复', '恢复完成', '恢复失败'],
  RECONCILE: ['正在核对仓库', '仓库核对完成', '仓库核对失败'],
  AI_REPAIR: ['正在修复', '修复完成', '修复失败'],
  RUNTIME_REPAIR: ['正在修复运行环境', '运行环境修复完成', '运行环境修复失败'],
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:/ -]{1,120}$/u.test(value) ? value : undefined
}
function safeProvider(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(value) ? value : undefined
}
function safeSha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/iu.test(value) ? value : undefined
}
function notificationLabel(kind: unknown, overall: unknown, channels: unknown, failed: boolean): string {
  const kindLabels: Record<string, string> = { HUMAN_REQUIRED: '需要人工处理', COMPLETED: '完成', FAILED: '失败', RECOVERY_REQUIRED: '需要恢复' }
  const channelLabels: Record<string, string> = { EMAIL: '邮件', DESKTOP: '桌面通知' }
  const statusLabels: Record<string, string> = { SENT: '已发送', FAILED: '发送失败', SKIPPED: '已跳过（不适用）' }
  const overallLabels: Record<string, string> = { ALL_SUCCEEDED: '全部成功', PARTIAL_SUCCESS: '部分成功', ALL_FAILED: '全部失败' }
  const parts: string[] = [typeof kind === 'string' && kindLabels[kind] !== undefined ? `${kindLabels[kind]}通知` : '通知']
  if (Array.isArray(channels)) {
    for (const entry of channels) {
      if (entry === null || typeof entry !== 'object') continue
      const channel = channelLabels[String((entry as Record<string, unknown>).channel)]
      const status = statusLabels[String((entry as Record<string, unknown>).status)]
      if (channel !== undefined && status !== undefined) parts.push(`${channel}：${status}`)
    }
  }
  parts.push(`总体：${typeof overall === 'string' && overallLabels[overall] !== undefined ? overallLabels[overall] : failed ? '发送失败' : '已发送'}`)
  return parts.join(' · ')
}
function dateString(value: Date | string | null | undefined): string | undefined {
  const text = value instanceof Date ? value.toISOString() : value
  return typeof text === 'string' && Number.isFinite(Date.parse(text)) ? text : undefined
}
function measuredDuration(start: string | undefined, end: string): number | undefined {
  if (start === undefined) return undefined
  const difference = Date.parse(end) - Date.parse(start)
  return Number.isFinite(difference) && difference >= 0 ? difference : undefined
}
function phaseLabel(item: Pick<UserActivityView, 'kind' | 'status'>): string {
  const labels = PHASE_LABELS[item.kind]!
  if (item.status === 'human_required') return `${labels[0]} · 等待人工处理`
  return labels[item.status === 'running' ? 0 : item.status === 'failed' ? 2 : 1]!
}
function assignDefined<T extends object>(target: T, key: keyof T, value: T[keyof T] | undefined): void {
  if (value !== undefined) target[key] = value
}
function addVerifier(item: UserActivityView, name: string | undefined, status: UserActivityView['status'], durationMs?: number): void {
  if (name === undefined) return
  const verifiers = [...(item.verifiers ?? [])]
  const index = verifiers.findIndex((entry) => entry.name === name)
  const previous = index < 0 ? undefined : verifiers[index]
  const next = { name, outcome: status === 'failed' ? 'FAILED' as const : status === 'running' ? 'RUNNING' as const : 'PASSED' as const,
    ...(durationMs === undefined ? {} : { durationMs }) }
  if (index < 0) verifiers.push(next)
  else if (next.outcome !== 'RUNNING' || previous?.outcome === 'RUNNING') verifiers[index] = { ...previous, ...next }
  item.verifiers = verifiers
}

/** Each source is paired independently before cross-source matching; wall-clock seconds are never dedupe keys. */
function phasesFromFacts(facts: readonly PhaseFact[]): PhaseActivity[] {
  const items: PhaseActivity[] = []
  const latest = new Map<string, PhaseActivity>()
  for (const fact of [...facts].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    const kind = PHASE_KINDS[fact.phase]
    if (kind === undefined) continue // FINALIZING/COMPLETED are represented by Task completion.
    const key = `${fact.taskId}:${fact.phase}`
    let item = latest.get(key)
    const newDispatch = fact.status === 'running' && fact.dispatch === true && item?.status === 'running'
    if (newDispatch && item !== undefined) {
      // A second durable dispatch is a real retry, even when the first no-op has no AGENT_FAILED event.
      item.status = 'failed'; item.completedAt = fact.timestamp
      assignDefined(item, 'durationMs', measuredDuration(item.startedAt, fact.timestamp))
      item.label = phaseLabel(item)
    }
    if (item === undefined || fact.status === 'running' && (item.status !== 'running' || newDispatch)) {
      item = { id: '', taskId: fact.taskId, kind, phase: fact.phase, timestamp: fact.timestamp,
        status: fact.status, label: '', sources: new Set([fact.source]),
        ...(fact.status === 'running' ? { startedAt: fact.timestamp } : { completedAt: fact.timestamp }) }
      items.push(item); latest.set(key, item)
    }
    if (fact.status !== 'running') {
      item.status = fact.status; item.completedAt = fact.timestamp; item.timestamp = fact.timestamp
      // cumulativeElapsedMs/Guardian elapsedMs are deliberately never treated as a phase duration.
      assignDefined(item, 'durationMs', measuredDuration(item.startedAt, fact.timestamp) ?? fact.durationMs)
    }
    assignDefined(item, 'provider', fact.provider)
    if (fact.phase === 'EXECUTING' && fact.dispatch === true) item.executorDispatched = true
    addVerifier(item, fact.verifier, fact.status, fact.durationMs)
    for (const verifier of fact.verifiers ?? []) addVerifier(item, verifier, fact.status)
    item.label = phaseLabel(item)
  }
  return items
}

function taskPhaseFacts(events: readonly TaskEventV2[]): PhaseFact[] {
  const facts: PhaseFact[] = []
  for (const event of events) {
    let phase: string | undefined
    let status: PhaseFact['status'] = 'running'
    let dispatch = false
    if (event.type === 'TASK_CREATED') phase = 'PLANNING'
    else if (event.type === 'VERIFICATION_PLANNED') { phase = 'PLANNING'; status = 'completed' }
    else if (event.action === 'EXECUTE' && ['AGENT_DISPATCHED', 'AGENT_COMPLETED', 'AGENT_FAILED'].includes(event.type)) {
      phase = 'EXECUTING'; dispatch = event.type === 'AGENT_DISPATCHED'
      status = event.type === 'AGENT_DISPATCHED' ? 'running' : event.type === 'AGENT_FAILED' ? 'failed' : 'completed'
    } else if (['VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED'].includes(event.type)) {
      phase = 'VERIFYING'; status = event.type === 'VERIFICATION_STARTED' ? 'running' : event.type === 'VERIFICATION_FAILED' ? 'failed' : 'completed'
      dispatch = status === 'running'
    } else if (['REVIEW_STARTED', 'REVIEW_PASSED', 'REVIEW_FAILED'].includes(event.type)) {
      phase = 'REVIEWING'; status = event.type === 'REVIEW_STARTED' ? 'running' : event.type === 'REVIEW_FAILED' ? 'failed' : 'completed'
    } else if (event.action === 'REVIEW' && ['AGENT_DISPATCHED', 'AGENT_COMPLETED', 'AGENT_FAILED'].includes(event.type)) {
      phase = 'REVIEWING'; status = event.type === 'AGENT_DISPATCHED' ? 'running' : event.type === 'AGENT_FAILED' ? 'failed' : 'completed'
    } else {
      for (const prefix of ['AI_REPAIR', 'RUNTIME_REPAIR', 'RECONCILIATION']) {
        if (event.type === `${prefix}_STARTED` || event.type === `${prefix}_COMPLETED` || event.type === `${prefix}_FAILED`) {
          phase = prefix === 'RECONCILIATION' ? 'RECONCILING' : prefix
          status = event.type.endsWith('_STARTED') ? 'running' : event.type.endsWith('_FAILED') ? 'failed' : 'completed'
        }
      }
    }
    if (phase !== undefined) facts.push({ source: 'task', taskId: event.taskId, phase, timestamp: event.timestamp, status, dispatch,
      // Aggregate failure does not prove every verifier failed. Only a passed run
      // can assign a shared outcome; detailed failed outcomes come from verifier evidence.
      ...(phase !== 'VERIFYING' || status !== 'completed' || event.evidenceRefs === undefined ? {} : {
        verifiers: event.evidenceRefs.map((name) => safeIdentity(name)).filter((name): name is string => name !== undefined),
      }),
      ...(safeProvider(event.provider) === undefined ? {} : { provider: safeProvider(event.provider)! }) })
  }
  return facts
}

/** Match only the same Task + phase, one candidate per source, by its execution interval. */
function matchingPhase(items: readonly PhaseActivity[], incoming: PhaseActivity, source: Source): PhaseActivity | undefined {
  const start = Date.parse(incoming.startedAt ?? incoming.timestamp)
  const candidates = items.filter((item) => item.taskId === incoming.taskId && item.phase === incoming.phase && !item.sources.has(source))
  const distance = (item: PhaseActivity): number => incoming.startedAt === undefined && item.completedAt !== undefined
    ? Math.abs(Date.parse(item.completedAt) - Date.parse(incoming.completedAt ?? incoming.timestamp))
    : Math.abs(Date.parse(item.startedAt ?? item.timestamp) - start)
  return candidates.filter((item) => {
    if (incoming.startedAt === undefined && item.completedAt !== undefined) return distance(item) <= 2_000
    if (incoming.startedAt !== undefined && item.startedAt !== undefined) return distance(item) <= 2_000
    const end = Date.parse(item.completedAt ?? incoming.completedAt ?? incoming.timestamp)
    return start >= Date.parse(item.startedAt ?? item.timestamp) && start <= end
  }).sort((a, b) => distance(a) - distance(b))[0]
}

function mergePhase(target: PhaseActivity, incoming: PhaseActivity, source: Source): void {
  target.sources.add(source)
  if (incoming.executorDispatched === true) target.executorDispatched = true
  assignDefined(target, 'provider', target.provider ?? incoming.provider)
  assignDefined(target, 'startedAt', target.startedAt ?? incoming.startedAt)
  if (target.status === 'running' && incoming.status !== 'running') {
    target.status = incoming.status
    assignDefined(target, 'completedAt', incoming.completedAt)
    target.timestamp = incoming.timestamp
  }
  if (target.completedAt !== undefined) assignDefined(target, 'durationMs', measuredDuration(target.startedAt, target.completedAt) ?? incoming.durationMs)
  for (const verifier of incoming.verifiers ?? []) addVerifier(target, verifier.name,
    verifier.outcome === 'RUNNING' ? 'running' : verifier.outcome === 'FAILED' ? 'failed' : 'completed', verifier.durationMs)
  target.label = phaseLabel(target)
}

/** Pure, non-authoritative presentation. Inputs retain every durable event and evidence field unchanged. */
export function deriveUserActivities(input: ActivityProjectionInput): UserActivityView[] {
  const sessionId = input.definition.id
  const taskEvents = Object.values(input.state?.taskEventLogs ?? {}).flat()
    .filter((event) => event.sessionId === sessionId && dateString(event.timestamp) !== undefined)
  const ledger = input.ledger.filter((event) => event.sessionId === sessionId && dateString(event.timestamp) !== undefined)
  const defaultTaskId = input.state?.currentTaskId ?? input.state?.completedTaskIds.at(-1) ?? input.definition.tasks[0]?.id ?? 'task'
  const sourceFacts: Record<Source, PhaseFact[]> = { task: taskPhaseFacts(taskEvents), ledger: [], control: [], activity: [] }
  const verifierLedger: ExecutionLedgerEvent[] = []
  for (const event of ledger) {
    if (event.eventType !== 'PHASE_STARTED' && event.eventType !== 'PHASE_COMPLETED' && event.eventType !== 'PHASE_FAILED') continue
    if (event.verificationCommand !== undefined) { verifierLedger.push(event); continue }
    sourceFacts.ledger.push({ source: 'ledger', taskId: event.taskId, phase: event.phase, timestamp: event.timestamp,
      status: event.eventType === 'PHASE_STARTED' ? 'running' : event.eventType === 'PHASE_FAILED' ? 'failed' : 'completed',
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) })
  }
  let controlTaskId = defaultTaskId
  for (const event of input.recentEvents) {
    if (typeof event.data.taskId === 'string') controlTaskId = event.data.taskId
    if ((event.type !== 'TASK_PHASE' && event.type !== 'GUARDIAN_PHASE') || dateString(event.timestamp) === undefined) continue
    if (typeof event.data.phase !== 'string' || event.data.status === 'pending') continue
    sourceFacts.control.push({ source: 'control', taskId: controlTaskId, phase: event.data.phase, timestamp: event.timestamp,
      status: event.data.status === 'active' ? 'running' : event.data.status === 'failed' ? 'failed' : event.data.status === 'suspended' || event.data.status === 'human_required' ? 'human_required' : 'completed' })
  }
  for (const event of input.executionActivities) {
    if (event.kind === 'CONTROLLER_PHASE_CHANGED' || event.kind === 'REPOSITORY_CHANGED' || event.kind === 'RUNTIME_REPAIR') continue
    sourceFacts.activity.push({ source: 'activity', taskId: event.taskId ?? defaultTaskId, phase: event.phase, timestamp: event.timestamp,
      ...(event.kind === 'PROVIDER_DISPATCHED' && event.phase === 'EXECUTING' ? { dispatch: true } : {}),
      status: event.kind.endsWith('_STARTED') || event.kind === 'PROVIDER_DISPATCHED' ? 'running' : event.outcome === 'FAILED' || event.kind === 'PROVIDER_FAILED' ? 'failed' : 'completed',
      ...(safeProvider(event.provider) === undefined ? {} : { provider: safeProvider(event.provider)! }),
      ...(safeIdentity(event.verifier) === undefined ? {} : { verifier: safeIdentity(event.verifier)! }) })
  }

  const phases: PhaseActivity[] = []
  for (const source of ['task', 'control', 'ledger', 'activity'] as const) {
    for (const candidate of phasesFromFacts(sourceFacts[source])) {
      const match = matchingPhase(phases, candidate, source)
      if (match === undefined) phases.push(candidate)
      else mergePhase(match, candidate, source)
    }
  }
  // Terminal durable state wins over a missing process-local end callback. A
  // known following phase is the tighter boundary; otherwise use the Task or
  // Session's recorded terminal timestamp, never a moving read-time clock.
  for (const phase of phases) {
    if (phase.status !== 'running') continue
    const start = Date.parse(phase.startedAt ?? phase.timestamp)
    const next = phases.filter((candidate) => candidate.taskId === phase.taskId && candidate.startedAt !== undefined && Date.parse(candidate.startedAt) > start)
      .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0]
    const task = input.state?.taskStatesV2?.[phase.taskId!]
    const terminalTaskEvent = taskEvents.find((event) => event.taskId === phase.taskId && Date.parse(event.timestamp) >= start &&
      (event.type === 'TASK_COMPLETED' || event.type === 'TASK_FAILED' || event.type === 'HUMAN_REQUIRED'))
    const terminalLedger = ledger.find((event) => event.taskId === phase.taskId && Date.parse(event.timestamp) >= start &&
      (event.eventType === 'TASK_COMPLETED' || event.eventType === 'HUMAN_REQUIRED'))
    const terminal = input.state?.state === 'COMPLETED' || task?.status === 'COMPLETED' || terminalTaskEvent?.type === 'TASK_COMPLETED' || terminalLedger?.eventType === 'TASK_COMPLETED'
      ? 'completed' : input.state?.state === 'FAILED' || task?.status === 'FAILED' || terminalTaskEvent?.type === 'TASK_FAILED'
        ? 'failed' : input.state?.state === 'SUSPENDED' || task?.status === 'SUSPENDED' || terminalTaskEvent?.type === 'HUMAN_REQUIRED' || terminalLedger?.eventType === 'HUMAN_REQUIRED' ? 'human_required' : undefined
    const end = next?.startedAt ?? terminalTaskEvent?.timestamp ?? terminalLedger?.timestamp ?? (terminal === undefined ? undefined
      : dateString(input.state?.completedAt) ?? dateString(task?.updatedAt) ?? dateString(input.state?.updatedAt))
    if (end === undefined || measuredDuration(phase.startedAt, end) === undefined) {
      if (terminal !== undefined) { phase.status = terminal; phase.label = phaseLabel(phase) }
      continue
    }
    phase.status = next === undefined ? terminal ?? 'completed' : 'completed'
    phase.completedAt = end; phase.timestamp = end
    phase.durationMs = measuredDuration(phase.startedAt, end)!
    phase.label = phaseLabel(phase)
  }
  // Per-verifier ledger evidence enriches its verification activity; independent verifiers remain separate facts.
  for (const event of verifierLedger) {
    if (!('verificationCommand' in event)) continue
    const time = Date.parse(event.timestamp)
    const item = phases.filter((phase) => phase.taskId === event.taskId && phase.kind === 'VERIFY' &&
      time >= Date.parse(phase.startedAt ?? phase.timestamp) && (phase.completedAt === undefined || time <= Date.parse(phase.completedAt)))
      .sort((a, b) => Date.parse(b.startedAt ?? b.timestamp) - Date.parse(a.startedAt ?? a.timestamp))[0]
    if (item !== undefined) addVerifier(item, safeIdentity(event.verificationCommand), event.verificationStatus === 'running' ? 'running' : event.verificationStatus === 'failed' ? 'failed' : 'completed', event.durationMs)
  }
  const counts = new Map<string, number>()
  phases.sort((a, b) => Date.parse(a.startedAt ?? a.timestamp) - Date.parse(b.startedAt ?? b.timestamp))
  for (const phase of phases) {
    const key = `${sessionId}:${phase.taskId}:${phase.phase}`
    const occurrence = (counts.get(key) ?? 0) + 1; counts.set(key, occurrence)
    phase.id = `${key}:${occurrence}`
    const coding = input.codingExecutions?.find((entry) => entry.taskId === phase.taskId)
    if (phase.kind === 'EXECUTE') {
      assignDefined(phase, 'provider', phase.provider ?? safeProvider(coding?.activeExecutor) ?? safeProvider(input.state?.taskStatesV2?.[phase.taskId!]?.implementer?.provider))
      assignDefined(phase, 'model', safeIdentity(coding?.model))
      if (input.definition.controlPlane === 'v2' && phase.executorDispatched !== true && (phase.status === 'running' || phase.status === 'human_required')) {
        phase.label = phase.status === 'human_required' ? '等待 Executor · 需要人工处理' : '等待 Executor'
      }
    }
  }
  for (const event of input.executionActivities) {
    if (event.kind !== 'REPOSITORY_CHANGED' || !Number.isFinite(event.changedFileCount)) continue
    const item = [...phases].reverse().find((phase) => phase.taskId === (event.taskId ?? defaultTaskId) && phase.kind === 'EXECUTE' &&
      Date.parse(phase.startedAt ?? phase.timestamp) <= Date.parse(event.timestamp))
    if (item !== undefined) item.changedFileCount = Math.max(0, Math.trunc(event.changedFileCount!))
  }
  for (const [taskId, task] of Object.entries(input.state?.taskStatesV2 ?? {})) {
    const item = [...phases].reverse().find((phase) => phase.taskId === taskId && phase.kind === 'VERIFY')
    if (item === undefined || item.status === 'running') continue
    for (const verifier of task.verificationState?.results ?? []) {
      if (verifier.status !== 'skipped') addVerifier(item, safeIdentity(verifier.name), verifier.status === 'passed' ? 'completed' : 'failed', verifier.durationMs)
    }
  }

  const activities = new Map<string, UserActivityView>()
  const repeatableFacts: Array<{ source: Source; eventId: string; kind: string; timestamp: string; taskId?: string; category?: string; reason?: string }> = []
  const put = (kind: string, timestamp: string | undefined, taskId?: string, suffix = '', extra: Partial<UserActivityView> = {}): void => {
    if (timestamp === undefined) return
    const id = `${sessionId}:${taskId ?? 'session'}:${kind}${suffix === '' ? '' : `:${suffix}`}`
    if (activities.has(id)) return
    const labels: Record<string, string> = {
      SESSION_STARTED: 'Work Session 已开始', TASK_STARTED: `Task ${taskId ?? ''} 已开始`, TASK_COMPLETED: `Task ${taskId ?? ''} 已完成`,
      CHECKPOINT: '已创建 checkpoint', CHECKPOINT_PUSHED: 'checkpoint 已推送', SESSION_COMPLETED: 'Work Session 已完成',
      HUMAN_REQUIRED: '需要人工处理', SESSION_FAILED: 'Work Session 失败', TASK_FAILED: `Task ${taskId ?? ''} 失败`,
      SESSION_PAUSED: 'Work Session 已暂停', PAUSE_REQUESTED: '已请求暂停', SESSION_RESUMED: 'Work Session 已恢复',
      SESSION_RESUME_REQUESTED: '已请求恢复', STOP_AFTER_TASK_REQUESTED: '当前 Task 完成后停止', SCHEDULE_CANCELLED: '计划已取消',
      CHECKPOINT_RECOVERY_REQUESTED: '正在恢复 checkpoint', CHECKPOINT_RECOVERY_COMPLETED: 'checkpoint 恢复完成', CHECKPOINT_RECOVERY_FAILED: 'checkpoint 恢复失败',
      VERIFICATION_APPROVAL_REQUESTED: '需要验证授权', VERIFICATION_APPROVED: '验证已获授权',
      BRAIN_INFRASTRUCTURE_FAILED: 'Brain 暂时不可用', PROVIDER_SWITCHED: 'Executor 已切换 Provider',
      GOLDEN_EXHAUSTED: 'Golden 执行额度已用完', AUTONOMOUS_DIAGNOSIS: '开始 AI 自主诊断', ADVANCED_RECOVERY: '进入受限 Advanced Recovery',
    }
    activities.set(id, { id, timestamp, kind, status: kind === 'HUMAN_REQUIRED' || kind === 'VERIFICATION_APPROVAL_REQUESTED' ? 'human_required' : kind.endsWith('_FAILED') ? 'failed' : 'completed',
      label: labels[kind] ?? kind, ...(taskId === undefined ? {} : { taskId }), ...extra })
  }
  for (const event of ledger) {
    const taskId = event.taskId ?? undefined
    if (event.eventType === 'NOTIFICATION_SENT' || event.eventType === 'NOTIFICATION_FAILED') {
      put('NOTIFICATION', event.timestamp, taskId, event.notificationId, {
        label: notificationLabel(event.notificationKind, event.notificationOverall, event.notificationChannels, event.eventType === 'NOTIFICATION_FAILED'),
        status: event.notificationOverall === 'PARTIAL_SUCCESS' || event.notificationOverall === 'ALL_SUCCEEDED' || event.eventType === 'NOTIFICATION_SENT' ? 'completed' : 'failed',
      })
    } else if (event.eventType === 'GIT_COMMIT_COMPLETED' || event.eventType === 'GIT_PUSH_COMPLETED') {
      const sha = safeSha(event.eventType === 'GIT_COMMIT_COMPLETED' ? event.commitSha : event.pushSha)
      put(event.eventType === 'GIT_COMMIT_COMPLETED' ? 'CHECKPOINT' : 'CHECKPOINT_PUSHED', event.timestamp, taskId, sha, sha === undefined ? {} : { checkpointSha: sha })
    } else if (['SESSION_STARTED', 'TASK_STARTED', 'TASK_COMPLETED', 'SESSION_FAILED', 'HUMAN_REQUIRED', 'VERIFICATION_APPROVAL_REQUESTED', 'VERIFICATION_APPROVED'].includes(event.eventType)) {
      if (event.eventType === 'HUMAN_REQUIRED') {
        repeatableFacts.push({ source: 'ledger', eventId: String(event.eventId), kind: event.eventType, timestamp: event.timestamp, ...(taskId === undefined ? {} : { taskId }), reason: event.safeMessage })
      } else put(event.eventType, event.timestamp, event.eventType.startsWith('SESSION_') ? undefined : taskId,
        event.eventType.startsWith('VERIFICATION_APPROV') ? `ledger:${event.eventId}` : '')
    } else if (event.eventType.startsWith('CHECKPOINT_RECOVERY_')) {
      repeatableFacts.push({ source: 'ledger', eventId: String(event.eventId), kind: event.eventType, timestamp: event.timestamp, ...(taskId === undefined ? {} : { taskId }) })
    }
  }
  for (const event of taskEvents) {
    if (event.type === 'HUMAN_REQUIRED') {
      const category = safeIdentity(event.metadata?.category)
      repeatableFacts.push({ source: 'task', eventId: event.eventId, kind: event.type, timestamp: event.timestamp, taskId: event.taskId, ...(category === undefined ? {} : { category }) })
    } else if (event.type === 'TASK_COMPLETED' || event.type === 'TASK_FAILED') put(event.type, event.timestamp, event.taskId)
    else if (event.type === 'GOLDEN_EXHAUSTED' || event.type === 'AUTONOMOUS_DIAGNOSIS' || event.type === 'ADVANCED_RECOVERY') {
      put(event.type, event.timestamp, event.taskId, event.eventId)
    }
    if (event.type === 'PROVIDER_SWITCHED') put(event.type, event.timestamp, event.taskId, event.eventId,
      safeProvider(event.provider) === undefined ? {} : { provider: safeProvider(event.provider)! })
  }
  for (const event of input.recentEvents) {
    const taskId = typeof event.data.taskId === 'string' ? event.data.taskId : event.type === 'HUMAN_REQUIRED' ? defaultTaskId : undefined
    if (event.type === 'NOTIFICATION_SENT' || event.type === 'NOTIFICATION_FAILED') {
      const notificationId = typeof event.data.notificationId === 'string' ? event.data.notificationId : String(event.id)
      put('NOTIFICATION', event.timestamp, taskId, notificationId, {
        label: notificationLabel(event.data.kind, event.data.overallStatus, event.data.channels, event.type === 'NOTIFICATION_FAILED'),
        status: event.data.overallStatus === 'PARTIAL_SUCCESS' || event.data.overallStatus === 'ALL_SUCCEEDED' || event.type === 'NOTIFICATION_SENT' ? 'completed' : 'failed',
      })
    } else if (event.type === 'CHECKPOINT_COMMITTED' || event.type === 'CHECKPOINT_PUSHED') {
      const sha = safeSha(event.type === 'CHECKPOINT_COMMITTED' ? event.data.commitSha : event.data.pushSha)
      put(event.type === 'CHECKPOINT_COMMITTED' ? 'CHECKPOINT' : 'CHECKPOINT_PUSHED', event.timestamp, taskId, sha, sha === undefined ? {} : { checkpointSha: sha })
    } else if (!['TASK_PHASE', 'GUARDIAN_PHASE', 'SESSION_STATE_CHANGED', 'SESSION_COMPLETED', 'NOTIFICATION_SENT', 'NOTIFICATION_FAILED'].includes(event.type)) {
      const eventTask = event.type.startsWith('SESSION_') ? undefined : taskId
      if (event.type === 'HUMAN_REQUIRED' || event.type.startsWith('CHECKPOINT_RECOVERY_')) {
        const category = safeIdentity(event.data.category)
        const reason = typeof event.data.reason === 'string' ? event.data.reason : undefined
        repeatableFacts.push({ source: 'control', eventId: String(event.id), kind: event.type, timestamp: event.timestamp,
          ...(eventTask === undefined ? {} : { taskId: eventTask }), ...(category === undefined ? {} : { category }), ...(reason === undefined ? {} : { reason }) })
      } else {
        const repeatable = ['PAUSE_REQUESTED', 'SESSION_PAUSED', 'SESSION_RESUME_REQUESTED', 'SESSION_RESUMED', 'STOP_AFTER_TASK_REQUESTED', 'BRAIN_INFRASTRUCTURE_FAILED'].includes(event.type)
        put(event.type, event.timestamp, eventTask, repeatable ? `control:${event.id}` : '')
      }
    }
  }
  // Human-required identity is Session + Task + category + recovery interval.
  // Delivery latency and source-specific reason wording never create a second
  // user decision. Durable resume boundaries distinguish a genuinely new request.
  // Checkpoint recovery retains its separate action-occurrence matching contract.
  const repeats: Array<(typeof repeatableFacts)[number] & { sources: Set<Source> }> = []
  const priority: Record<Source, number> = { task: 0, ledger: 1, control: 2, activity: 3 }
  const boundaryBetween = (kind: string, taskId: string | undefined, left: string, right: string): boolean => {
    const lower = Math.min(Date.parse(left), Date.parse(right)); const upper = Math.max(Date.parse(left), Date.parse(right))
    const inRange = (timestamp: string): boolean => Date.parse(timestamp) >= lower && Date.parse(timestamp) <= upper
    if (kind === 'HUMAN_REQUIRED') return taskEvents.some((event) => event.taskId === taskId &&
      ['TASK_RESUMED', 'HUMAN_ACTION_RECORDED', 'HUMAN_DECISION_RECORDED'].includes(event.type) && inRange(event.timestamp)) ||
      input.recentEvents.some((event) => ['SESSION_RESUME_REQUESTED', 'SESSION_RESUMED'].includes(event.type) &&
        (event.data.taskId === undefined || event.data.taskId === taskId) && inRange(event.timestamp))
    return [...ledger.map((event) => ({ kind: event.eventType, taskId: event.taskId, timestamp: event.timestamp })),
      ...input.recentEvents.map((event) => ({ kind: event.type, taskId: event.data.taskId, timestamp: event.timestamp }))].some((event) =>
      event.taskId === taskId && event.kind.startsWith('CHECKPOINT_RECOVERY_') && event.kind !== kind && inRange(event.timestamp))
  }
  for (const fact of repeatableFacts.sort((a, b) => priority[a.source] - priority[b.source] || Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    const humanRequired = fact.kind === 'HUMAN_REQUIRED'
    const match = repeats.filter((entry) => entry.kind === fact.kind && entry.taskId === fact.taskId && (humanRequired || !entry.sources.has(fact.source)) &&
      (entry.category === undefined || fact.category === undefined || entry.category === fact.category) &&
      (humanRequired || (entry.reason === undefined || fact.reason === undefined || entry.reason === fact.reason) &&
        Math.abs(Date.parse(entry.timestamp) - Date.parse(fact.timestamp)) <= 2_000) &&
      !boundaryBetween(fact.kind, fact.taskId, entry.timestamp, fact.timestamp))
      .sort((a, b) => Math.abs(Date.parse(a.timestamp) - Date.parse(fact.timestamp)) - Math.abs(Date.parse(b.timestamp) - Date.parse(fact.timestamp)))[0]
    if (match === undefined) repeats.push({ ...fact, sources: new Set([fact.source]) })
    else {
      match.sources.add(fact.source)
      if (match.category === undefined && fact.category !== undefined) match.category = fact.category
      if (match.reason === undefined && fact.reason !== undefined) match.reason = fact.reason
    }
  }
  for (const fact of repeats) put(fact.kind, fact.timestamp, fact.taskId,
    `${fact.kind === 'HUMAN_REQUIRED' ? `${fact.category ?? 'UNKNOWN'}:` : ''}${fact.source}:${fact.eventId}`)
  put('SESSION_STARTED', dateString(input.state?.startedAt))
  for (const [taskId, shaValue] of Object.entries(input.state?.checkpointCommits ?? {})) {
    const sha = safeSha(shaValue)
    if (sha !== undefined) put('CHECKPOINT', dateString(input.state?.taskStatesV2?.[taskId]?.updatedAt) ?? dateString(input.state?.completedAt), taskId, sha, { checkpointSha: sha })
  }
  for (const taskId of input.state?.completedTaskIds ?? []) put('TASK_COMPLETED', dateString(input.state?.completedAt) ?? dateString(input.state?.taskStatesV2?.[taskId]?.updatedAt), taskId)
  if (![...activities.values()].some((item) => item.kind === 'TASK_COMPLETED')) {
    const completion = ledger.find((event) => event.eventType === 'SESSION_COMPLETED')?.timestamp
      ?? input.recentEvents.find((event) => event.type === 'SESSION_COMPLETED')?.timestamp ?? dateString(input.state?.completedAt)
    put('SESSION_COMPLETED', completion)
  }
  const result: UserActivityView[] = phases.map(({ sources: _sources, ...item }) => item)
  result.push(...activities.values())
  return result.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id))
}
