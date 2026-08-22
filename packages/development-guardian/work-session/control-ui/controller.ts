/**
 * W005-A WorkSessionControlController
 *
 * 窄 controller，职责：
 * - 持有当前被控制的 Work Session runtime（经 factory 注入）；
 * - 防重复 start、异步启动 runtime.start()；
 * - 暴露结构化 snapshot；
 * - 维护 recent events ring buffer；
 * - 给 SSE subscribers 广播事件与 snapshot；
 * - 通过轻量 polling 观察 WorkSessionDurableState 变化。
 *
 * 不是一个 generic event platform / job scheduler / multi-session orchestration。
 * MVP 只控制一个当前 Work Session。
 */

import type {
  WorkSessionDefinition,
  WorkSessionDurableState,
  HumanRequired,
} from '../model.js'
import type { GuardianProgressEvent, GuardianProgressObserver } from '../../progress.js'
import type {
  NotificationDeliveryObserver,
  NotificationDeliveryResult,
} from '../notifier.js'
import type {
  ControlEvent,
  ControlEventInput,
  WorkSessionControlSnapshot,
  WorkSessionControlRuntime,
  ControlSubscriber,
} from './events.js'

/** runtime factory：控制面注入 createRuntime(eventSink)，测试注入 fake runtime。 */
export type WorkSessionRuntimeFactory = (
  eventSink: GuardianProgressObserver,
  notificationSink: NotificationDeliveryObserver,
) => WorkSessionControlRuntime

export interface WorkSessionControlControllerOptions {
  createRuntime: WorkSessionRuntimeFactory
  /** state polling 间隔（毫秒）；缺省 250 */
  pollIntervalMs?: number
  /** recent events ring buffer 上限；缺省 100 */
  maxRecentEvents?: number
  /** W005-A remote closure：仅用于展示 active elapsed 的可测试 clock，缺省 Date.now。 */
  clock?: { now(): number }
}

const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_MAX_RECENT_EVENTS = 100
const SAFE_SESSION_FAILED_MESSAGE = 'Session failed. Check local diagnostics.'
const SAFE_POST_RESUME_HUMAN_REASON = 'Additional input is required. Check local diagnostics.'

export interface ControlResumeInput {
  decision?: string
  approval?: boolean
}

/** Guardian phase 快照：只保留结构化字段，绝不携带 raw detail / provider payload。 */
interface GuardianPhaseSnapshot {
  phase: string
  status: string
  iteration: number
  elapsedMs: number
}

export class WorkSessionControlController {
  private readonly runtime: WorkSessionControlRuntime
  private readonly pollIntervalMs: number
  private readonly maxRecentEvents: number
  private readonly clock: { now(): number } | undefined

  private started = false
  private closed = false

  private readonly recentEvents: ControlEvent[] = []
  private eventId = 0
  private readonly subscribers = new Set<ControlSubscriber>()

  private pollTimer: NodeJS.Timeout | undefined
  private prevState: WorkSessionDurableState | undefined
  private prevSignature: string | undefined
  /** 上一次向 SSE 广播的展示 active elapsed 秒桶；避免 250ms spam。 */
  private prevElapsedSecond: number | undefined
  /** 明确持有 runtime.start() 的 Promise，rejection 已被 catch，绝不产生 unhandled rejection。 */
  private startPromise: Promise<void> | undefined
  private resumePromise: Promise<void> | undefined
  /** Current Task whose user decision must never be echoed back by provider-derived reasons. */
  private resumeInputRedactionTaskId: string | undefined

  private guardianPhase: GuardianPhaseSnapshot | undefined
  private serverInfo: WorkSessionControlSnapshot['server'] = {
    host: '127.0.0.1',
    port: 0,
    url: '',
  }

  constructor(options: WorkSessionControlControllerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.maxRecentEvents = options.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS
    this.clock = options.clock
    // 注入的 factory 拿到 Guardian progress sink；controller 把 GuardianProgressEvent
    // 转成 GUARDIAN_PHASE recent event。生产 factory 把 sink 接到 runner.onProgress。
    this.runtime = options.createRuntime(
      (event) => this.onGuardianProgress(event),
      (result) => this.onNotificationDelivery(result),
    )
    // 持续观察 runtime state；未 start 时 state 为 undefined，poll 无副作用。
    this.startPolling()
  }

  /** server listen 后回填真实 host/port/url。 */
  setServerInfo(host: string, port: number, url: string): void {
    this.serverInfo = { host, port, url }
  }

  getDefinition(): WorkSessionDefinition {
    return this.runtime.getDefinition()
  }

  getSubscriberCount(): number {
    return this.subscribers.size
  }

  getRecentEvents(): readonly ControlEvent[] {
    return this.recentEvents
  }

  /** 供测试观察启动 promise；rejection 已被 catch，await 不会抛出。 */
  getStartPromise(): Promise<void> | undefined {
    return this.startPromise
  }

  getResumePromise(): Promise<void> | undefined {
    return this.resumePromise
  }

  /**
   * Restore an existing durable session before the production HTTP listener opens.
   * Hydration is read-only and never starts or resumes autonomous work.
   */
  async loadPersistedState(): Promise<WorkSessionDurableState | undefined> {
    const state = await this.runtime.loadPersistedState()
    if (state === undefined) {
      return undefined
    }
    this.started = true
    this.prevState = state
    this.prevSignature = this.signatureOf(state)
    this.prevElapsedSecond = this.elapsedSecondOf(state)
    return state
  }

  /**
   * 启动 Session。防 duplicate：第二次调用返回 started=false。
   * runtime.start() 异步 fire-and-forget，不阻塞调用方（HTTP 202）。
   */
  start(): { started: boolean } {
    if (this.started || this.closed) {
      return { started: false }
    }
    this.started = true
    this.emit({ type: 'SESSION_STARTED' })

    // 异步启动；真正的运行结果经 polling + SSE 暴露，不 await 整场 Work Session。
    // 明确持有 rejection：fake/真实 runtime 的 start() 失败不得产生 unhandled rejection。
    // 原始 error.message 可能包含 credential/provider payload，因此绝不进入 Web event。
    this.startPromise = this.runtime
      .start()
      .then(() => {
        // 状态变化由 polling 观察，无需在此处理。
      })
      .catch(() => {
        this.emit({
          type: 'SESSION_FAILED',
          data: { message: SAFE_SESSION_FAILED_MESSAGE },
        })
        this.broadcastSnapshot()
      })

    return { started: true }
  }

  requestPause(): { accepted: boolean; reason?: string } {
    const result = this.runtime.requestPause()
    if (result.accepted) {
      this.emit({ type: 'PAUSE_REQUESTED', data: { control: 'pause' } })
      this.broadcastSnapshot()
    }
    return result
  }

  requestStopAfterTask(): { accepted: boolean; reason?: string } {
    const result = this.runtime.requestStopAfterTask()
    if (result.accepted) {
      this.emit({
        type: 'STOP_AFTER_TASK_REQUESTED',
        data: { control: 'stop-after-task' },
      })
      this.broadcastSnapshot()
    }
    return result
  }

  resume(input: ControlResumeInput): { accepted: boolean; reason?: string } {
    const state = this.runtime.getDurableState()
    if (state?.state !== 'SUSPENDED') {
      return { accepted: false, reason: 'session is not suspended' }
    }
    if (this.resumePromise !== undefined) {
      return { accepted: false, reason: 'resume already in progress' }
    }

    const validated = validateResumeForState(state, input)
    if (!validated.accepted) {
      return validated
    }

    const category = state.suspensionReason === 'USER_PAUSED'
      ? 'USER_PAUSED'
      : state.humanRequired?.category ?? 'UNKNOWN'
    const safeEventData = {
      taskId: state.currentTaskId,
      category,
    }
    if (validated.input?.decision !== undefined && state.currentTaskId !== null) {
      this.resumeInputRedactionTaskId = state.currentTaskId
    }
    this.emit({ type: 'SESSION_RESUME_REQUESTED', data: safeEventData })
    this.broadcastSnapshot()

    // W005-B: resume is background-owned just like start. The user's decision is
    // passed only to the runtime/provider path and never copied into events/status.
    this.resumePromise = this.runtime
      .resume(validated.input ?? {})
      .then(() => {
        this.emit({ type: 'SESSION_RESUMED', data: safeEventData })
        this.broadcastSnapshot()
      })
      .catch(() => {
        this.emit({
          type: 'SESSION_FAILED',
          data: { message: SAFE_SESSION_FAILED_MESSAGE },
        })
        this.broadcastSnapshot()
      })
      .finally(() => {
        this.resumePromise = undefined
      })

    return { accepted: true }
  }

  /** 返回结构化 snapshot，不包含任何 secret / token / provider payload。 */
  getSnapshot(): WorkSessionControlSnapshot {
    const definition = this.runtime.getDefinition()
    const state = this.runtime.getDurableState()
    const controls = this.runtime.getControlIntents()

    return {
      server: { ...this.serverInfo },
      configuredSession: {
        id: definition.id,
        targetRepo: definition.targetRepo,
        branch: definition.branch,
        limits: {
          softMinutes: definition.limits.softMinutes,
          hardMinutes: definition.limits.hardMinutes,
          maxTasks: definition.limits.maxTasks,
        },
        tasks: definition.tasks.map((task) => ({ id: task.id, goal: task.goal })),
      },
      runtime: {
        started: this.started,
        running: state?.state === 'RUNNING',
        ...(state !== undefined
          ? {
              state: state.state,
              currentTaskId: state.currentTaskId,
              completedTaskIds: state.completedTaskIds,
              ...(state.checkpointCommits !== undefined
                ? { checkpointCommits: state.checkpointCommits }
                : {}),
              ...(state.checkpointPushes !== undefined
                ? { checkpointPushes: state.checkpointPushes }
                : {}),
              ...(state.activeElapsedMs !== undefined ||
              state.activeSegmentStartedAt !== undefined
                ? { activeElapsedMs: this.displayActiveElapsedMs(state) }
                : {}),
              ...(state.completionReason !== undefined
                ? { completionReason: state.completionReason }
                : {}),
              ...(state.humanRequired !== undefined
                ? { humanRequired: this.safeHumanRequired(state) }
                : {}),
              ...(state.suspensionReason !== undefined
                ? { suspensionReason: state.suspensionReason }
                : {}),
              ...(state.cancellationReason !== undefined
                ? { cancellationReason: state.cancellationReason }
                : {}),
              // failureReason 是本地诊断事实，可能含 provider/credential 文本；
              // Web snapshot 只暴露 FAILED state，不复制 raw failureReason。
            }
          : {}),
      },
      controls,
      guardian: this.guardianPhase !== undefined ? { ...this.guardianPhase } : {},
      recentEvents: [...this.recentEvents],
    }
  }

  /** 订阅事件流 + snapshot 变化流；返回 unsubscribe。 */
  subscribe(subscriber: ControlSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /** 关闭：清除 polling timer，释放 subscribers。 */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.subscribers.clear()
  }

  private now(): number {
    return this.clock?.now() ?? Date.now()
  }

  /**
   * W004 保持 durable active-time 语义不变；这里只计算浏览器展示值。
   * RUNNING 时加入当前尚未 settle 的 segment，SUSPENDED/terminal 只显示已结算基数。
   */
  private displayActiveElapsedMs(state: WorkSessionDurableState): number {
    const base = state.activeElapsedMs ?? 0
    if (state.state !== 'RUNNING' || state.activeSegmentStartedAt === undefined) {
      return base
    }
    return base + Math.max(0, this.now() - state.activeSegmentStartedAt)
  }

  private elapsedSecondOf(state: WorkSessionDurableState): number {
    return Math.floor(this.displayActiveElapsedMs(state) / 1000)
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.closed) {
      return
    }
    this.pollTimer = setInterval(() => {
      this.poll()
    }, this.pollIntervalMs)
    // 避免 interval 让 Node 进程悬挂（node --test 要求无 open handle）
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref()
    }
  }

  private poll(): void {
    if (this.closed) {
      return
    }
    const state = this.runtime.getDurableState()
    if (state === undefined) {
      this.prevState = undefined
      this.prevSignature = undefined
      this.prevElapsedSecond = undefined
      return
    }

    const prev = this.prevState
    this.prevState = state

    if (prev === undefined) {
      this.prevSignature = this.signatureOf(state)
      this.prevElapsedSecond = this.elapsedSecondOf(state)
      // runtime 首次建立 durable state 时主动广播，避免 UI 依赖下一次语义变化才更新。
      this.broadcastSnapshot()
      return
    }

    for (const event of this.diffEvents(prev, state)) {
      this.emit(event)
    }

    const signature = this.signatureOf(state)
    const elapsedSecond = this.elapsedSecondOf(state)
    const semanticChanged = signature !== this.prevSignature
    const elapsedSecondChanged = elapsedSecond !== this.prevElapsedSecond

    if (semanticChanged || elapsedSecondChanged) {
      this.prevSignature = signature
      this.prevElapsedSecond = elapsedSecond
      this.broadcastSnapshot()
    }
  }

  /**
   * 只比较“有意义”字段；展示 active elapsed 由独立秒桶控制，
   * 不写 recent event，且最多每跨 1 秒广播一次 snapshot。
   */
  private signatureOf(state: WorkSessionDurableState): string {
    return JSON.stringify([
      state.state,
      state.currentTaskId ?? null,
      state.completedTaskIds,
      state.humanRequired !== undefined
        ? [state.humanRequired.category, state.humanRequired.reason]
        : null,
      state.checkpointCommits ?? null,
      state.checkpointPushes ?? null,
      state.completionReason ?? null,
      state.suspensionReason ?? null,
      state.cancellationReason ?? null,
    ])
  }

  private diffEvents(
    prev: WorkSessionDurableState,
    curr: WorkSessionDurableState,
  ): ControlEventInput[] {
    const events: ControlEventInput[] = []

    if (prev.state !== curr.state) {
      events.push({
        type: 'SESSION_STATE_CHANGED',
        data: { from: prev.state, to: curr.state },
      })
      if (curr.state === 'COMPLETED') {
        events.push({
          type: 'SESSION_COMPLETED',
          data:
            curr.completionReason !== undefined
              ? { completionReason: curr.completionReason }
              : {},
        })
      } else if (curr.state === 'FAILED') {
        // raw failureReason 可能含 credential/provider output；Web recent event 只发安全文案。
        events.push({
          type: 'SESSION_FAILED',
          data: { message: SAFE_SESSION_FAILED_MESSAGE },
        })
      } else if (
        curr.state === 'SUSPENDED' &&
        curr.suspensionReason === 'USER_PAUSED'
      ) {
        events.push({
          type: 'SESSION_PAUSED',
          data: { taskId: curr.currentTaskId, control: 'pause' },
        })
      }
    }

    if (prev.humanRequired === undefined && curr.humanRequired !== undefined) {
      events.push({
        type: 'HUMAN_REQUIRED',
        data: humanRequiredData(this.safeHumanRequired(curr)),
      })
    }

    if ((prev.currentTaskId ?? null) !== (curr.currentTaskId ?? null)) {
      if (curr.currentTaskId != null) {
        events.push({ type: 'TASK_STARTED', data: { taskId: curr.currentTaskId } })
      }
    }

    const prevCompleted = new Set(prev.completedTaskIds)
    for (const taskId of curr.completedTaskIds) {
      if (!prevCompleted.has(taskId)) {
        events.push({ type: 'TASK_COMPLETED', data: { taskId } })
      }
    }

    const prevCommits = prev.checkpointCommits ?? {}
    const currCommits = curr.checkpointCommits ?? {}
    for (const [taskId, commitSha] of Object.entries(currCommits)) {
      if (prevCommits[taskId] !== commitSha) {
        events.push({ type: 'CHECKPOINT_COMMITTED', data: { taskId, commitSha } })
      }
    }

    const prevPushes = prev.checkpointPushes ?? {}
    const currPushes = curr.checkpointPushes ?? {}
    for (const [taskId, pushSha] of Object.entries(currPushes)) {
      if (prevPushes[taskId] !== pushSha) {
        events.push({ type: 'CHECKPOINT_PUSHED', data: { taskId, pushSha } })
      }
    }

    return events
  }

  private onGuardianProgress(event: GuardianProgressEvent): void {
    // W005-A FINAL: 只保留结构化字段。event.detail 可能含 provider raw output /
    // credential / stdout，绝不进入 snapshot / SSE / recentEvents / Debug。
    this.guardianPhase = {
      phase: event.phase,
      status: event.status,
      iteration: event.iteration,
      elapsedMs: event.elapsedMs,
    }
    this.emit({
      type: 'GUARDIAN_PHASE',
      data: {
        phase: event.phase,
        status: event.status,
        iteration: event.iteration,
        elapsedMs: event.elapsedMs,
      },
    })
    this.broadcastSnapshot()
  }

  private onNotificationDelivery(result: NotificationDeliveryResult): void {
    this.emit({
      type: result.status === 'SENT' ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
      data: {
        notificationId: result.notificationId,
        taskId: result.taskId,
        category: result.category,
      },
    })
    this.broadcastSnapshot()
  }

  private safeHumanRequired(state: WorkSessionDurableState): HumanRequired {
    const humanRequired = state.humanRequired
    if (humanRequired === undefined) {
      return { category: 'UNKNOWN', reason: SAFE_POST_RESUME_HUMAN_REASON }
    }
    if (
      state.currentTaskId !== null &&
      state.currentTaskId === this.resumeInputRedactionTaskId
    ) {
      return {
        category: humanRequired.category,
        reason: SAFE_POST_RESUME_HUMAN_REASON,
      }
    }
    return humanRequired
  }

  private emit(input: ControlEventInput): void {
    const event: ControlEvent = {
      id: ++this.eventId,
      timestamp: new Date().toISOString(),
      type: input.type,
      data: input.data ?? {},
    }
    this.recentEvents.push(event)
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift()
    }
    for (const subscriber of this.subscribers) {
      subscriber.onEvent(event)
    }
  }

  private broadcastSnapshot(): void {
    const snapshot = this.getSnapshot()
    for (const subscriber of this.subscribers) {
      subscriber.onSnapshot(snapshot)
    }
  }
}

function humanRequiredData(hr: HumanRequired): Record<string, unknown> {
  return { category: hr.category, reason: hr.reason }
}

function validateResumeForState(
  state: WorkSessionDurableState,
  input: ControlResumeInput,
): { accepted: boolean; reason?: string; input?: ControlResumeInput } {
  const decision = typeof input.decision === 'string' ? input.decision.trim() : undefined
  const hasDecision = decision !== undefined && decision.length >= 1 && decision.length <= 2_000
  const hasApproval = input.approval !== undefined

  if (state.suspensionReason === 'USER_PAUSED') {
    if (input.decision !== undefined || input.approval !== undefined) {
      return { accepted: false, reason: 'user pause resume does not accept decision data' }
    }
    return { accepted: true, input: {} }
  }

  switch (state.humanRequired?.category) {
    case 'DECISION_REQUIRED':
    case 'STALLED':
      if (!hasDecision || hasApproval) {
        return { accepted: false, reason: 'a decision is required' }
      }
      return { accepted: true, input: { decision } }
    case 'ENVIRONMENT_REQUIRED':
    case 'CREDENTIAL_REQUIRED':
      if (input.approval !== true || input.decision !== undefined) {
        return { accepted: false, reason: 'resolved acknowledgement is required' }
      }
      return { accepted: true, input: { approval: true } }
    case 'PERMISSION_REQUIRED':
      return { accepted: false, reason: 'trusted project permissions must be updated first' }
    case 'SAFETY_BLOCKED':
      return { accepted: false, reason: 'safety block cannot be generically resumed' }
    case 'REPO_DRIFT':
      return { accepted: false, reason: 'repository drift requires recovery or adoption' }
    case 'BUDGET_EXHAUSTED':
      return { accepted: false, reason: 'session limits are exhausted' }
    default:
      return { accepted: false, reason: 'unsupported suspension category' }
  }
}
