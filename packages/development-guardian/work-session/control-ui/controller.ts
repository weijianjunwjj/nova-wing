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
import {
  deriveDisplayState,
  deriveRecoverySummary,
  isTerminalWorkSessionState,
} from '../recoverability.js'
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
  ExecutionActivityView,
} from './events.js'
import { isExecutorProviderCredentialRecovery } from '../guardian-task-runner.js'
import { deriveRuntimeRepairReasonCode, isRuntimeRepairable } from '../runtime-repair.js'
import { deriveUserActivities } from './activity-projection.js'
import { deriveRuntimeOverview, projectTaskDiagnostics } from './runtime-overview.js'
import { projectTaskEta, type TaskEtaService } from './task-eta.js'
import { isAutonomousRecoveryCategory } from '../autonomous-diagnosis.js'
import { observeWorkSessionActivity, type WorkSessionActivityObserver, type WorkSessionActivityOperation } from '../activity.js'

/** runtime factory：控制面注入 createRuntime(eventSink)，测试注入 fake runtime。 */
export type WorkSessionRuntimeFactory = (
  eventSink: GuardianProgressObserver,
  notificationSink: NotificationDeliveryObserver,
) => WorkSessionControlRuntime

export interface WorkSessionControlControllerOptions {
  activityObserver?: WorkSessionActivityObserver
  /** Hosts opt into draining admitted work; the CLI default remains bounded. */
  shutdownMode?: 'strict' | 'bounded'
  taskEta?: Pick<TaskEtaService, 'project' | 'close'> & Partial<Pick<TaskEtaService, 'settled' | 'drain'>>
  readCodingExecutions?: () => NonNullable<WorkSessionControlSnapshot['codingExecutions']>
  createRuntime: WorkSessionRuntimeFactory
  /** Revalidates external dependencies immediately before a recoverable resume. */
  beforeResume?: () => Promise<void>
  /** state polling 间隔（毫秒）；缺省 250 */
  pollIntervalMs?: number
  /** recent events ring buffer 上限；缺省 100 */
  maxRecentEvents?: number
  /** W005-A remote closure：仅用于展示 active elapsed 的可测试 clock，缺省 Date.now。 */
  clock?: { now(): number }
}

const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_MAX_RECENT_EVENTS = 100
const SAFE_SESSION_FAILED_MESSAGE = 'Work Session 失败。请检查本地诊断信息。'
const SAFE_POST_RESUME_HUMAN_REASON = '需要补充信息。请检查本地诊断信息。'
const SAFE_BRAIN_FAILURE_MESSAGE =
  '无法完成 Brain transport/configuration。Brain 尚未完成 Review。当前执行进度已保留。'
const SAFE_EXECUTOR_CREDENTIAL_RECOVERY_REASON =
  'Executor Provider 凭据、余额或账户设置需要在 NovaWing 外完成。现有 repository checkpoint 将保留。'

function effectiveHumanRequired(state: WorkSessionDurableState): HumanRequired | undefined {
  const checkpoint = state.currentTaskCheckpoint
  if (
    checkpoint !== undefined &&
    isExecutorProviderCredentialRecovery(checkpoint.task)
  ) {
    return {
      category: 'CREDENTIAL_REQUIRED',
      reason: SAFE_EXECUTOR_CREDENTIAL_RECOVERY_REASON,
    }
  }
  return state.humanRequired
}

export type ControlResumeInput = import('../runtime.js').ResumeInput

/** Guardian phase 快照：只保留结构化字段，绝不携带 raw detail / provider payload。 */
interface GuardianPhaseSnapshot {
  phase: string
  status: string
  iteration: number
  elapsedMs: number
}

export class WorkSessionControlController {
  private readonly taskEta: WorkSessionControlControllerOptions['taskEta']
  private readonly readCodingExecutions: WorkSessionControlControllerOptions['readCodingExecutions']
  private readonly runtime: WorkSessionControlRuntime
  private readonly pollIntervalMs: number
  private readonly maxRecentEvents: number
  private readonly clock: { now(): number } | undefined
  private readonly beforeResume: (() => Promise<void>) | undefined
  private readonly shutdownMode: 'strict' | 'bounded'
  private readonly activityObserver: WorkSessionActivityObserver | undefined

  private started = false
  private scheduleCheckAt = 0
  private closed = false
  private closeOperation: Promise<void> | undefined
  private readonly acceptedOperations = new Set<Promise<unknown>>()
  private readonly admissionCleanupErrors: unknown[] = []

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
  private checkpointRecoveryPromise: Promise<void> | undefined
  /** Current Task whose user decision must never be echoed back by provider-derived reasons. */
  private resumeInputRedactionTaskId: string | undefined

  private guardianPhase: GuardianPhaseSnapshot | undefined
  private guardianPhaseTaskId: string | undefined
  private readonly executionActivities: ExecutionActivityView[] = []
  private executionActivityId = 0
  private executionActivityStartedAt: string | undefined
  private lastExecutionActivityAt: string | undefined
  private executionActivityProvider: string | undefined
  /** Last event identity after applying the same safe presentation rules as Recent Activity. */
  private lastGuardianPresentationKey: string | undefined
  private serverInfo: WorkSessionControlSnapshot['server'] = {
    host: '127.0.0.1',
    port: 0,
    url: '',
  }

  constructor(options: WorkSessionControlControllerOptions) {
    this.taskEta = options.taskEta
    this.readCodingExecutions = options.readCodingExecutions
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.maxRecentEvents = options.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS
    this.clock = options.clock
    this.beforeResume = options.beforeResume
    this.shutdownMode = options.shutdownMode ?? 'bounded'
    this.activityObserver = options.activityObserver
    // Transport still uses the established progress value shape. Presentation
    // names V2 activity TASK_PHASE so the UI does not imply Guardian semantics.
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
   * Process-local operation liveness for owners such as Launchpad. This is
   * deliberately separate from durable state and from runtime recovery
   * eligibility: a settled/failed operation must not keep an owning config
   * permanently locked.
   */
  hasActiveOperation(): boolean {
    return this.acceptedOperations.size > 0 || this.startPromise !== undefined ||
      this.resumePromise !== undefined ||
      this.checkpointRecoveryPromise !== undefined
  }

  /**
   * Restore an existing durable session before the production HTTP listener opens.
   * Hydration is read-only and never starts or resumes autonomous work.
   */
  loadPersistedState(): Promise<WorkSessionDurableState | undefined> {
    if (this.closed) return Promise.reject(new Error('Controller is closing'))
    return this.trackOperation(this.runtime.loadPersistedState().then((state) => {
      if (state === undefined) return undefined
      this.started = state.state !== 'SCHEDULED'
      this.prevState = state
      this.prevSignature = this.signatureOf(state)
      this.prevElapsedSecond = this.elapsedSecondOf(state)
      return state
    }))
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
    const scheduled = this.runtime.getDurableState()?.state === 'SCHEDULED'
    if (!scheduled) this.emit({ type: 'SESSION_STARTED' })

    // 异步启动；真正的运行结果经 polling + SSE 暴露，不 await 整场 Work Session。
    // 明确持有 rejection：fake/真实 runtime 的 start() 失败不得产生 unhandled rejection。
    // 原始 error.message 可能包含 credential/provider payload，因此绝不进入 Web event。
    const due = scheduled && Date.parse(this.runtime.getDurableState()?.scheduledStartAt ?? '') <= (this.clock?.now() ?? Date.now())
    const startRuntime = () => this.runtime.startWithActivityObserver === undefined
      ? this.runtime.start() : this.runtime.startWithActivityObserver(this.activityObserver)
    const dispatch = () => due && this.beforeResume !== undefined
      ? Promise.resolve().then(() => this.beforeResume!()).then(() => {
          if (this.closed && this.shutdownMode !== 'strict') throw new Error('Controller closed before dispatch')
          return startRuntime()
        })
      : startRuntime()
    // Future schedules only persist/inspect their waiting state. A dispatched
    // execution owns verification, checkpoint and finalization until settlement.
    const scheduledAt = this.runtime.getDurableState()?.scheduledStartAt ?? this.runtime.getDefinition().scheduledStartAt
    const waiting = scheduledAt != null && Date.parse(scheduledAt) > (this.clock?.now() ?? Date.now())
    const operation = this.runtime.startWithActivityObserver !== undefined || waiting ? this.runOperation(dispatch)
      : this.runActivity(scheduled || scheduledAt != null ? 'scheduled-execution' : 'execution', dispatch)
    this.startPromise = operation
      .then(() => {
        // 状态变化由 polling 观察，无需在此处理。
      })
      .catch(() => {
        if (this.runtime.getDurableState()?.state === 'SCHEDULED') {
          // Dependency/storage unavailability is not execution failure or retry.
          this.scheduleCheckAt = (this.clock?.now() ?? Date.now()) + 30_000
          return
        }
        this.emit({
          type: 'SESSION_FAILED',
          data: { message: SAFE_SESSION_FAILED_MESSAGE },
        })
        this.broadcastSnapshot()
      })
      .finally(() => {
        this.startPromise = undefined
        if (this.runtime.getDurableState()?.state === 'SCHEDULED') this.started = false
      })

    return { started: true }
  }

  requestPause(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const result = this.runtime.requestPause()
    if (result.accepted) {
      this.emit({ type: 'PAUSE_REQUESTED', data: { control: 'pause' } })
      this.broadcastSnapshot()
    }
    return result
  }

  requestStopAfterTask(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const scheduled = this.runtime.getDurableState()?.state === 'SCHEDULED'
    const result = this.runtime.requestStopAfterTask()
    if (result.accepted) {
      this.emit({
        type: scheduled ? 'SCHEDULE_CANCELLED' : 'STOP_AFTER_TASK_REQUESTED',
        data: { control: 'stop-after-task' },
      })
      this.broadcastSnapshot()
    }
    return result
  }

  resume(input: ControlResumeInput): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
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
      : state.suspensionReason === 'BRAIN_INFRASTRUCTURE_FAILED'
        ? 'BRAIN_INFRASTRUCTURE_FAILED'
        : effectiveHumanRequired(state)?.category ?? 'UNKNOWN'
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
    const dispatchResume = (): Promise<WorkSessionDurableState> => {
      this.emit({ type: 'SESSION_RESUMED', data: safeEventData })
      this.broadcastSnapshot()
      return this.runtime.resume(validated.input ?? {})
    }
    const resumeOperation = this.runActivity('resume', () => this.beforeResume === undefined
      ? dispatchResume()
      : Promise.resolve()
          .then(() => this.beforeResume!())
          .then(dispatchResume))
    this.resumePromise = resumeOperation
      .then(() => {})
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

  /**
   * T021: 显式恢复一个 RECOVERABLE / INTERRUPTED Session。
   *
   * 分派：
   * - 持久化 state=SUSPENDED（正常 suspend，Mastra status='suspended'）→ 走既有 resume()；
   * - 持久化 state=RUNNING（进程异常退出遗留）→ 走 runtime.resumeInterrupted()。
   *
   * 必须由用户显式触发；loadPersistedState 只发现不恢复。idempotent：resumePromise
   * 保证同一 Session 最多只有一个活动恢复在途。
   */
  resumeRecoverable(input: ControlResumeInput): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const state = this.runtime.getDurableState()
    if (state === undefined || isTerminalWorkSessionState(state.state)) {
      return { accepted: false, reason: 'session is not recoverable' }
    }
    if (this.runtime.hasActiveExecution?.() ?? false) {
      return { accepted: false, reason: 'session already has an active runner' }
    }
    if (state.state === 'SUSPENDED') {
      if (this.runtime.canResumeWithDurableVerificationApproval?.() === true) {
        if (
          input.decision !== undefined || input.approval !== undefined ||
          this.runtime.resumeWithDurableVerificationApproval === undefined
        ) {
          return { accepted: false, reason: 'durable verification recovery accepts no decision data' }
        }
        if (this.resumePromise !== undefined) {
          return { accepted: false, reason: 'resume already in progress' }
        }
        const safeEventData = {
          taskId: state.currentTaskId,
          category: 'VERIFICATION_APPROVAL_RECOVERY',
        }
        this.emit({ type: 'SESSION_RESUME_REQUESTED', data: safeEventData })
        this.broadcastSnapshot()
        const resumeOperation = this.runActivity('verification', () => this.beforeResume === undefined
          ? this.runtime.resumeWithDurableVerificationApproval!()
          : Promise.resolve()
              .then(() => this.beforeResume!())
              .then(() => this.runtime.resumeWithDurableVerificationApproval!()))
        this.resumePromise = resumeOperation
          .then(() => {
            this.emit({ type: 'SESSION_RESUMED', data: safeEventData })
            this.broadcastSnapshot()
          })
          .catch(() => {
            this.emit({ type: 'SESSION_FAILED', data: { message: SAFE_SESSION_FAILED_MESSAGE } })
            this.broadcastSnapshot()
          })
          .finally(() => { this.resumePromise = undefined })
        return { accepted: true }
      }
      return this.resume(input)
    }
    if (this.runtime.resumeInterrupted === undefined) {
      return { accepted: false, reason: 'interrupted resume is unavailable' }
    }
    if (this.resumePromise !== undefined) {
      return { accepted: false, reason: 'resume already in progress' }
    }

    const safeEventData = { taskId: state.currentTaskId, category: 'RECOVERABLE' }
    this.emit({ type: 'SESSION_RESUME_REQUESTED', data: safeEventData })
    this.broadcastSnapshot()

    const resumeOperation = this.runActivity('resume', () => this.beforeResume === undefined
      ? this.runtime.resumeInterrupted!()
      : Promise.resolve()
          .then(() => this.beforeResume!())
          .then(() => this.runtime.resumeInterrupted!()))
    this.resumePromise = resumeOperation
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

  approvePendingVerificationAndContinue(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const state = this.runtime.getDurableState()
    const pending = state?.pendingVerificationApproval
    if (
      state?.state !== 'SUSPENDED' || !['DECISION_REQUIRED', 'APPROVAL_REQUIRED'].includes(state.humanRequired?.category ?? '') ||
      pending === undefined || pending.status !== 'REQUESTED' ||
      pending.sessionId !== state.sessionId || pending.taskId !== state.currentTaskId ||
      this.runtime.approvePendingVerificationAndContinue === undefined
    ) return { accepted: false, reason: 'verification approval is unavailable' }
    if (this.resumePromise !== undefined) return { accepted: false, reason: 'resume already in progress' }
    const safeEventData = { taskId: pending.taskId, category: 'VERIFICATION_APPROVAL' }
    this.emit({ type: 'SESSION_RESUME_REQUESTED', data: safeEventData })
    this.resumePromise = this.runActivity('verification', () => this.runtime.approvePendingVerificationAndContinue!())
      .then(() => { this.emit({ type: 'SESSION_RESUMED', data: safeEventData }); this.broadcastSnapshot() })
      .catch(() => { this.emit({ type: 'SESSION_FAILED', data: { message: SAFE_SESSION_FAILED_MESSAGE } }); this.broadcastSnapshot() })
      .finally(() => { this.resumePromise = undefined })
    return { accepted: true }
  }

  rejectPendingVerification(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const state = this.runtime.getDurableState()
    const pending = state?.pendingVerificationApproval
    if (state?.state !== 'SUSPENDED' || pending?.status !== 'REQUESTED' ||
        pending.taskId !== state.currentTaskId || pending.sessionId !== state.sessionId ||
        this.runtime.rejectPendingVerification === undefined) {
      return { accepted: false, reason: 'verification approval is unavailable' }
    }
    if (this.resumePromise !== undefined) return { accepted: false, reason: 'resume already in progress' }
    this.resumePromise = this.trackOperation(this.runtime.rejectPendingVerification())
      .then(() => { this.broadcastSnapshot() })
      .catch(() => { this.emit({ type: 'SESSION_FAILED', data: { message: SAFE_SESSION_FAILED_MESSAGE } }) })
      .finally(() => { this.resumePromise = undefined; this.broadcastSnapshot() })
    return { accepted: true }
  }

  /**
   * v0.2.4: Runtime AI Repair & Resume. The runtime diagnoses, classifies, applies a
   * safe mechanical repair (or refuses), and resumes the same Session. A legal repair
   * never re-runs the Executor.
   */
  repairRuntimeAndResume(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const state = this.runtime.getDurableState()
    const humanRequired = state === undefined ? undefined : effectiveHumanRequired(state)
    if (state?.state !== 'SUSPENDED' || humanRequired === undefined || !isRuntimeRepairable(humanRequired)) {
      return { accepted: false, reason: 'session is not eligible for runtime repair' }
    }
    if (this.runtime.repairRuntimeAndResume === undefined) {
      return { accepted: false, reason: 'runtime repair is unavailable' }
    }
    if (this.resumePromise !== undefined) {
      return { accepted: false, reason: 'resume already in progress' }
    }
    const safeEventData = { taskId: state.currentTaskId, category: 'RUNTIME_REPAIR' }
    this.emit({ type: 'SESSION_RESUME_REQUESTED', data: safeEventData })
    this.broadcastSnapshot()
    this.resumePromise = this.runActivity('runtime-repair', () => this.runtime.repairRuntimeAndResume!())
      .then(() => {
        this.emit({ type: 'SESSION_RESUMED', data: safeEventData })
        this.broadcastSnapshot()
      })
      .catch(() => {
        this.emit({ type: 'SESSION_FAILED', data: { message: SAFE_SESSION_FAILED_MESSAGE } })
        this.broadcastSnapshot()
      })
      .finally(() => { this.resumePromise = undefined })
    return { accepted: true }
  }

  recoverFailedCheckpoint(): { accepted: boolean; reason?: string } {
    if (this.closed) return { accepted: false, reason: 'Controller is closing' }
    const state = this.runtime.getDurableState()
    if (!isRecoverableGitPushFailure(state)) {
      return { accepted: false, reason: 'session is not eligible for checkpoint recovery' }
    }
    if (this.runtime.recoverFailedGitCheckpoint === undefined) {
      return { accepted: false, reason: 'checkpoint recovery is unavailable' }
    }
    if (this.checkpointRecoveryPromise !== undefined) {
      return { accepted: false, reason: 'checkpoint recovery already in progress' }
    }
    const data = { taskId: state.currentTaskId, kind: 'GIT_PUSH' }
    this.emit({ type: 'CHECKPOINT_RECOVERY_REQUESTED', data })
    this.broadcastSnapshot()
    this.checkpointRecoveryPromise = this.runActivity('checkpoint-recovery', () => this.runtime.recoverFailedGitCheckpoint!())
      .then(() => {
        this.emit({ type: 'CHECKPOINT_RECOVERY_COMPLETED', data })
        this.broadcastSnapshot()
      })
      .catch(() => {
        this.emit({ type: 'CHECKPOINT_RECOVERY_FAILED', data })
        this.broadcastSnapshot()
      })
      .finally(() => { this.checkpointRecoveryPromise = undefined })
    return { accepted: true }
  }

  /** 返回结构化 snapshot，不包含任何 secret / token / provider payload。 */
  getSnapshot(): WorkSessionControlSnapshot {
    const definition = this.runtime.getDefinition()
    const state = this.runtime.getDurableState()
    const runtimeRepairProjection = this.runtimeRepairProjection(state)
    const controls = this.runtime.getControlIntents()
    const hasActiveExecution = this.runtime.hasActiveExecution?.() ?? false
    const displayState = deriveDisplayState(state, hasActiveExecution)
    const fullLedger = this.runtime.readExecutionLedger?.()
    const executionLedger = fullLedger
    const recoverableSummary =
      displayState === 'RECOVERABLE' && state !== undefined
        ? deriveRecoverySummary(definition, state, fullLedger ?? [])
        : undefined
    const durableVerificationRecovery =
      state?.state === 'SUSPENDED' &&
      this.runtime.canResumeWithDurableVerificationApproval?.() === true
        ? {
            available: true as const,
            message: '已找到此前的验证授权，将从 checkpoint 继续，无需再次批准。',
          }
        : undefined
    const currentBudget = state?.currentTaskId === null || state?.currentTaskId === undefined
      ? undefined : state.taskStatesV2?.[state.currentTaskId]?.actionBudget
    const autonomousTask = state?.currentTaskId === null || state?.currentTaskId === undefined
      ? undefined : state.taskStatesV2?.[state.currentTaskId]?.autonomousRecovery
    const now = this.clock?.now() ?? Date.now()
    const codingExecutions = this.readCodingExecutions?.()
    const activities = deriveUserActivities({
      definition, ...(state === undefined ? {} : { state }), ledger: fullLedger ?? [],
      recentEvents: this.recentEvents, executionActivities: this.executionActivities,
      ...(codingExecutions === undefined ? {} : { codingExecutions }),
    })
    const runtimeOverview = deriveRuntimeOverview({
      definition, state, ledger: fullLedger ?? [], recentEvents: this.recentEvents,
      executionActivities: this.executionActivities, codingExecutions,
      currentPhase: this.guardianPhase?.phase, currentPhaseTaskId: this.guardianPhaseTaskId,
      hasActiveExecution, displayState, now,
    })
    runtimeOverview.iteration.current = Math.max(runtimeOverview.iteration.current,
      activities.filter(item => item.taskId === runtimeOverview.taskId && item.kind === 'EXECUTE' && item.executorDispatched).length)
    const etaInput = { definition, state, ledger: fullLedger, codingExecutions }
    let eta = projectTaskEta(etaInput)
    try { eta = this.taskEta?.project(etaInput) ?? eta } catch { /* Optional prediction cannot block status or runtime. */ }
    const lastActivityMs = this.lastExecutionActivityAt === undefined ? undefined : Date.parse(this.lastExecutionActivityAt)
    const activityStartedMs = this.executionActivityStartedAt === undefined ? undefined : Date.parse(this.executionActivityStartedAt)
    const idleMs = lastActivityMs === undefined ? undefined : Math.max(0, now - lastActivityMs)
    const activityEndMs = state !== undefined && state.state !== 'RUNNING'
      ? Date.parse(runtimeOverview.completedAt ?? state.updatedAt.toISOString()) : now
    const activityElapsedMs = activityStartedMs === undefined ? 0 : Math.max(0, activityEndMs - activityStartedMs)

    return {
      server: { ...this.serverInfo },
      ...(codingExecutions === undefined ? {} : { codingExecutions }),
      runtimeOverview, activities, debug: projectTaskDiagnostics(state),
      ...(eta === undefined ? {} : { eta }),
      configuredSession: {
        id: definition.id,
        targetRepo: definition.targetRepo,
        branch: definition.branch,
        ...(definition.controlPlane === undefined ? {} : { controlPlane: definition.controlPlane }),
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
        hasActiveExecution,
        displayState,
        ...(state !== undefined
          ? {
              state: state.state,
              createdAt: state.createdAt.toISOString(),
              scheduledStartAt: state.scheduledStartAt ?? null,
              scheduleSource: state.scheduleSource ?? 'immediate',
              startedAt: state.startedAt?.toISOString() ?? null,
              completedAt: state.completedAt?.toISOString() ?? null,
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
              ...(state.humanRequiredGeneration === undefined ? {} : { humanRequiredGeneration: state.humanRequiredGeneration }),
              recoveryInProgress: this.resumePromise !== undefined,
              ...(state.humanRequired === undefined || (!isAutonomousRecoveryCategory(state.humanRequired.category) &&
                !(state.humanRequired.category === 'ACTION_BUDGET_EXHAUSTED' && autonomousTask !== undefined)) ? {} : {
                autonomousRecovery: {
                  available: state.state === 'SUSPENDED' && !(currentBudget?.recoveryExhausted ?? false) &&
                    (currentBudget === undefined || currentBudget.recoveryConsumed < currentBudget.recoveryLimit),
                  exhausted: (currentBudget?.recoveryExhausted ?? false) ||
                    (currentBudget !== undefined && currentBudget.recoveryConsumed >= currentBudget.recoveryLimit),
                },
              }),
              ...(currentBudget === undefined ? {} : { actionBudgetRecovery: {
                available: currentBudget.originalExhausted && !currentBudget.recoveryGranted,
                originalLimit: currentBudget.originalLimit, originalConsumed: currentBudget.originalConsumed,
                recoveryLimit: currentBudget.recoveryLimit, recoveryConsumed: currentBudget.recoveryConsumed,
                terminal: currentBudget.recoveryExhausted,
              } }),
              ...(runtimeRepairProjection === undefined
                ? {}
                : { runtimeRepair: runtimeRepairProjection }),
              ...(state.verificationFailure === undefined
                ? {}
                : { verificationFailure: {
                    command: state.verificationFailure.name,
                    classification: state.verificationFailure.classification ?? 'UNKNOWN',
                    ...(state.verificationFailure.exitCode === undefined
                      ? {}
                      : { exitCode: state.verificationFailure.exitCode }),
                    ...(state.verificationFailure.durationMs === undefined
                      ? {}
                      : { durationMs: state.verificationFailure.durationMs }),
                    ...(state.verificationFailure.firstFailure === undefined
                      ? {}
                      : { firstFailure: { ...state.verificationFailure.firstFailure } }),
                    ...(state.verificationFailure.rawOutputRef === undefined
                      ? {}
                      : { rawOutputRef: state.verificationFailure.rawOutputRef }),
                    ...(state.verificationFailure.finalSummary === undefined
                      ? {}
                      : { finalSummary: state.verificationFailure.finalSummary }),
                    ...(state.verificationFailure.rootCauseCount === undefined
                      ? {}
                      : { rootCauseCount: state.verificationFailure.rootCauseCount }),
                    ...(state.verificationFailure.affectedTests === undefined
                      ? {}
                      : { affectedTests: state.verificationFailure.affectedTests }),
                  } }),
              ...(state.pendingVerificationApproval !== undefined &&
              state.pendingVerificationApproval.status !== 'APPROVED'
                ? { pendingVerificationApproval: {
                    taskId: state.pendingVerificationApproval.taskId,
                    command: state.pendingVerificationApproval.command,
                    generation: state.pendingVerificationApproval.generation,
                    status: state.pendingVerificationApproval.status,
                  } }
                : {}),
              ...(durableVerificationRecovery === undefined
                ? {}
                : { durableVerificationRecovery }),
              ...(state.brainFailure !== undefined
                ? { brainFailure: this.safeBrainFailure(state) }
                : {}),
              ...(state.suspensionReason !== undefined
                ? { suspensionReason: state.suspensionReason }
                : {}),
              ...(state.cancellationReason !== undefined
                ? { cancellationReason: state.cancellationReason }
                : {}),
              ...(isRecoverableGitPushFailure(state)
                ? { recovery: { available: true as const, kind: 'GIT_PUSH' as const, taskId: state.currentTaskId! } }
                : {}),
              // failureReason 是本地诊断事实，可能含 provider/credential 文本；
              // Web snapshot 只暴露 FAILED state，不复制 raw failureReason。
            }
          : {}),
        ...(recoverableSummary === undefined ? {} : { recoverableSummary }),
      },
      controls,
      guardian: this.guardianPhase !== undefined ? { ...this.guardianPhase } : {},
      executionActivity: {
        running: state?.state === 'RUNNING' && hasActiveExecution,
        ...(this.guardianPhase?.phase === undefined ? {} : { currentPhase: this.guardianPhase.phase }),
        ...(this.executionActivityProvider === undefined ? {} : { provider: this.executionActivityProvider }),
        ...(this.executionActivityStartedAt === undefined ? {} : { startedAt: this.executionActivityStartedAt }),
        elapsedMs: activityElapsedMs,
        ...(this.lastExecutionActivityAt === undefined ? {} : { lastActivityAt: this.lastExecutionActivityAt }),
        ...(idleMs === undefined ? {} : { idleMs }),
        idleStatus: idleMs === undefined || idleMs < 120_000 ? 'NORMAL' : idleMs < 300_000 ? 'QUIET' : 'LONG_QUIET',
        items: [...this.executionActivities],
      },
      recentEvents: [...this.recentEvents],
      ...(executionLedger === undefined ? {} : { executionLedger }),
    }
  }

  /** 订阅事件流 + snapshot 变化流；返回 unsubscribe。 */
  subscribe(subscriber: ControlSubscriber): () => void {
    if (this.closed) return () => {}
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /** Stop dispatch synchronously, before an owner waits for any other resource. */
  stopAdmission(): void {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    try { this.taskEta?.close() } catch (error) { this.admissionCleanupErrors.push(error) }
  }

  /** One close operation; strict owners wait for accepted control work to settle. */
  close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation
    const completion = Promise.withResolvers<void>()
    this.closeOperation = completion.promise
    // Publish ownership before a destructor can synchronously call close again.
    try { this.stopAdmission() } catch (error) { this.admissionCleanupErrors.push(error) }
    const accepted = [...this.acceptedOperations, this.startPromise, this.resumePromise, this.checkpointRecoveryPromise]
    if (this.shutdownMode === 'bounded') this.subscribers.clear()
    // A parent may already be inside stopAdmission's synchronous destructor;
    // collect its errors only after that stack has finished recording them.
    void Promise.resolve().then(async () => {
      const errors: unknown[] = [...this.admissionCleanupErrors]
      if (this.shutdownMode === 'strict') {
        for (const result of await Promise.allSettled(accepted)) {
          if (result.status === 'rejected') errors.push(result.reason)
        }
      }
      if (this.shutdownMode === 'strict') {
        try {
          if (this.taskEta?.drain !== undefined) await this.taskEta.drain()
          else await this.taskEta?.settled?.()
        } catch (error) { errors.push(error) }
      }
      this.subscribers.clear()
      if (errors.length > 0) throw new AggregateError(errors, 'Control controller shutdown failed')
    }).then(completion.resolve, completion.reject)
    return this.closeOperation
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.acceptedOperations.add(operation)
    void operation.then(
      () => { this.acceptedOperations.delete(operation) },
      () => { this.acceptedOperations.delete(operation) },
    )
    return operation
  }

  private runActivity<T>(operation: WorkSessionActivityOperation, dispatch: () => Promise<T>): Promise<T> {
    return this.runOperation(() => observeWorkSessionActivity(this.activityObserver, {
      operation, sessionId: this.runtime.getDefinition().id,
    }, dispatch))
  }

  private runOperation<T>(dispatch: () => Promise<T>): Promise<T> {
    // Publish drain ownership before the callback or dispatch can synchronously
    // reenter close(). The lease is released before this promise settles.
    const completion = Promise.withResolvers<T>()
    this.trackOperation(completion.promise)
    try { void dispatch().then(completion.resolve, completion.reject) } catch (error) { completion.reject(error) }
    return completion.promise
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
    const now = this.clock?.now() ?? Date.now()
    if (state.state === 'SCHEDULED' && !this.hasActiveOperation() && now >= this.scheduleCheckAt &&
      Date.parse(state.scheduledStartAt ?? '') <= now) {
      this.scheduleCheckAt = now + 1_000
      this.start()
    }
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
      state.verificationFailure === undefined
        ? null
        : [
            state.verificationFailure.name,
            state.verificationFailure.classification,
            state.verificationFailure.rawOutputRef,
          ],
      state.pendingVerificationApproval !== undefined
        ? [state.pendingVerificationApproval.taskId, state.pendingVerificationApproval.generation, state.pendingVerificationApproval.status]
        : null,
      state.brainFailure !== undefined
        ? [state.brainFailure.category, state.brainFailure.fingerprint]
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
      } else if (
        curr.state === 'SUSPENDED' &&
        curr.suspensionReason === 'BRAIN_INFRASTRUCTURE_FAILED'
      ) {
        events.push({
          type: 'BRAIN_INFRASTRUCTURE_FAILED',
          data: {
            taskId: curr.currentTaskId,
            stage: curr.brainFailure?.stage ?? 'BRAIN_REVIEW',
            category: curr.brainFailure?.category ?? 'TRANSPORT',
          },
        })
      }
    }

    if (curr.humanRequired !== undefined && (prev.humanRequired === undefined ||
        prev.currentTaskId !== curr.currentTaskId || prev.humanRequiredGeneration !== curr.humanRequiredGeneration ||
        prev.humanRequired.category !== curr.humanRequired.category)) {
      events.push({
        type: 'HUMAN_REQUIRED',
        data: { ...humanRequiredData(this.safeHumanRequired(curr)), taskId: curr.currentTaskId,
          ...(curr.humanRequiredGeneration === undefined ? {} : { generation: curr.humanRequiredGeneration }) },
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
    const taskId = this.runtime.getDurableState()?.currentTaskId ?? undefined
    this.guardianPhaseTaskId = taskId
    this.guardianPhase = {
      phase: event.phase,
      status: event.status,
      iteration: event.iteration,
      elapsedMs: event.elapsedMs,
    }
    if (event.activity !== undefined) {
      const timestamp = new Date(this.clock?.now() ?? Date.now()).toISOString()
      if (this.executionActivityStartedAt === undefined) this.executionActivityStartedAt = timestamp
      this.lastExecutionActivityAt = timestamp
      if (event.activity.provider !== undefined && /^[A-Za-z0-9._-]{1,80}$/u.test(event.activity.provider)) {
        this.executionActivityProvider = event.activity.provider
      }
      const verifier = event.activity.verifier !== undefined && /^[A-Za-z0-9._:/ -]{1,120}$/u.test(event.activity.verifier)
        ? event.activity.verifier : undefined
      this.executionActivities.push({
        id: ++this.executionActivityId, timestamp, kind: event.activity.kind, phase: event.phase,
        ...(taskId === undefined ? {} : { taskId }),
        ...(this.executionActivityProvider === undefined ? {} : { provider: this.executionActivityProvider }),
        ...(verifier === undefined ? {} : { verifier }),
        ...(event.activity.outcome === undefined ? {} : { outcome: event.activity.outcome }),
        ...(event.activity.changedFileCount === undefined ? {} : { changedFileCount: Math.max(0, Math.trunc(event.activity.changedFileCount)) }),
      })
      if (this.executionActivities.length > 30) this.executionActivities.shift()
    }
    const data = {
      phase: event.phase,
      status: event.status,
      iteration: event.iteration,
      elapsedMs: event.elapsedMs,
      ...(taskId === undefined ? {} : { taskId }),
    }
    // Guardian deliberately emits a second EXECUTING/completed event when an
    // incompleteReason is present. Detail is intentionally not web-visible;
    // fold only consecutive events whose safe rendered fields are identical.
    const presentationKey = JSON.stringify([taskId, guardianPresentationKey(data)])
    if (presentationKey !== this.lastGuardianPresentationKey) {
      this.emit({ type: this.runtime.getDefinition().controlPlane === 'v2' ? 'TASK_PHASE' : 'GUARDIAN_PHASE', data })
      this.lastGuardianPresentationKey = presentationKey
    }
    this.broadcastSnapshot()
  }

  private onNotificationDelivery(result: NotificationDeliveryResult): void {
    this.emit({
      type: result.status === 'SENT' ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
      data: {
        notificationId: result.notificationId,
        taskId: result.taskId,
        category: result.category,
        ...(result.kind === undefined ? {} : { kind: result.kind }),
        // The overall event stays for existing consumers, but it always carries
        // the per-channel truth so a delivered channel is never reported failed.
        ...(result.overallStatus === undefined ? {} : { overallStatus: result.overallStatus }),
        ...(result.channels === undefined ? {} : { channels: result.channels }),
      },
    })
    this.broadcastSnapshot()
  }

  private runtimeRepairProjection(
    state: WorkSessionDurableState | undefined,
  ): NonNullable<WorkSessionControlSnapshot['runtime']['runtimeRepair']> | undefined {
    if (state === undefined || state.state !== 'SUSPENDED') return undefined
    const humanRequired = effectiveHumanRequired(state)
    if (humanRequired === undefined || !isRuntimeRepairable(humanRequired)) return undefined
    const reasonCode = deriveRuntimeRepairReasonCode(humanRequired)
    const outcome = this.runtime.getRuntimeRepairOutcome?.()
    return {
      available: this.runtime.repairRuntimeAndResume !== undefined,
      inProgress: this.resumePromise !== undefined,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      ...(outcome === undefined
        ? {}
        : {
            lastOutcome: {
              classification: outcome.classification,
              ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            },
          }),
    }
  }

  private safeHumanRequired(state: WorkSessionDurableState): HumanRequired {
    const humanRequired = effectiveHumanRequired(state)
    if (humanRequired === undefined) {
      return { category: 'UNKNOWN', reason: SAFE_POST_RESUME_HUMAN_REASON }
    }
    if (
      state.currentTaskId !== null &&
      (state.currentTaskId === this.resumeInputRedactionTaskId ||
        (state.taskRecoveryInstructions?.[state.currentTaskId]?.length ?? 0) > 0)
    ) {
      return {
        category: humanRequired.category,
        reason: SAFE_POST_RESUME_HUMAN_REASON,
      }
    }
    return humanRequired
  }

  private safeBrainFailure(state: WorkSessionDurableState): NonNullable<
    WorkSessionControlSnapshot['runtime']['brainFailure']
  > {
    const failure = state.brainFailure
    return {
      stage: failure?.stage ?? 'BRAIN_REVIEW',
      ...(failure?.failureType === undefined ? {} : { failureType: failure.failureType }),
      ...(failure?.attempt === undefined ? {} : { attempt: failure.attempt }),
      ...(failure?.timestamp === undefined ? {} : { timestamp: failure.timestamp }),
      ...(failure?.lastReliableCheckpoint === undefined ? {} : { lastReliableCheckpoint: failure.lastReliableCheckpoint }),
      ...(failure?.nextResumableAction === undefined ? {} : { nextResumableAction: failure.nextResumableAction }),
      category: failure?.category ?? 'TRANSPORT',
      adapter: failure?.adapter ?? 'guardian-brain',
      retryable: failure?.retryable ?? false,
      degraded: failure?.degraded ?? false,
      fingerprint: failure?.fingerprint ?? 'brain-transport:unknown',
      ...(failure?.requestedModel === undefined
        ? {}
        : { requestedModel: failure.requestedModel }),
      ...(failure?.requestedReasoning === undefined
        ? {}
        : { requestedReasoning: failure.requestedReasoning }),
      safeMessage: failure?.safeMessage ?? SAFE_BRAIN_FAILURE_MESSAGE,
    }
  }

  private emit(input: ControlEventInput): void {
    if (input.type !== 'GUARDIAN_PHASE' && input.type !== 'TASK_PHASE') {
      this.lastGuardianPresentationKey = undefined
    }
    const event: ControlEvent = {
      id: ++this.eventId,
      timestamp: new Date(this.now()).toISOString(),
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

function isRecoverableGitPushFailure(
  state: WorkSessionDurableState | undefined,
): state is WorkSessionDurableState & { currentTaskId: string } {
  const taskId = state?.currentTaskId
  return state?.state === 'FAILED' && state.failureStage === 'GIT_PUSH' &&
    state.failureCategory === 'GIT_PUSH_FAILED' && taskId !== null && taskId !== undefined &&
    state.checkpointCommits?.[taskId] !== undefined &&
    !state.completedTaskIds.includes(taskId)
}

function guardianPresentationKey(data: GuardianPhaseSnapshot): string {
  return JSON.stringify([
    data.phase,
    data.status,
    displayIterationForGuardianPhase(data.phase, data.iteration),
    elapsedPresentationBucket(data.elapsedMs),
  ])
}

/** Must stay aligned with the browser formatter: this is a display identity, not timing logic. */
function elapsedPresentationBucket(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const value = ms < 1_000 ? ms : ms < 60_000 ? ms / 1_000 : ms / 60_000
  const unit = ms < 1_000 ? '毫秒' : ms < 60_000 ? '秒' : '分钟'
  return `${Number((Math.round(value * 100) / 100).toFixed(2))} ${unit}`
}

/** Internal Reviewer starts at 0; Executor and its follow-on phases start at 1. */
function displayIterationForGuardianPhase(phase: string, iteration: number): number | undefined {
  if (phase === 'PREPARING') return undefined
  if (phase === 'REVIEWING') return iteration + 1
  return iteration > 0 ? iteration : undefined
}

function validateResumeForState(
  state: WorkSessionDurableState,
  input: ControlResumeInput,
): { accepted: boolean; reason?: string; input?: ControlResumeInput } {
  if ((input.taskId !== undefined && input.taskId !== state.currentTaskId) ||
      (input.generation !== undefined && input.generation !== state.humanRequiredGeneration)) {
    return { accepted: false, reason: 'the task or suspension has changed; refresh before continuing' }
  }
  if (state.pendingVerificationApproval !== undefined) {
    return { accepted: false, reason: 'verification approval must use its dedicated control' }
  }
  const decision = typeof input.decision === 'string' ? input.decision.trim() : undefined
  const hasDecision = decision !== undefined && decision.length >= 1 && decision.length <= 2_000
  const hasApproval = input.approval !== undefined

  const task = state.currentTaskId === null ? undefined : state.taskStatesV2?.[state.currentTaskId]
  if (isAutonomousRecoveryCategory(effectiveHumanRequired(state)?.category ?? '') ||
      (state.humanRequired?.category === 'ACTION_BUDGET_EXHAUSTED' && task?.autonomousRecovery !== undefined)) {
    if (input.taskId === undefined || input.generation === undefined) {
      return { accepted: false, reason: 'recovery requires the current taskId and suspension generation' }
    }
    if (hasApproval || (!hasDecision && input.recovery !== 'diagnose') || (hasDecision && input.recovery !== undefined)) {
      return { accepted: false, reason: 'a recovery instruction or diagnosis request is required' }
    }
    if (input.recovery === 'diagnose') {
      const budget = state.currentTaskId === null ? undefined : state.taskStatesV2?.[state.currentTaskId]?.actionBudget
      if (budget?.recoveryExhausted || (budget !== undefined && budget.recoveryConsumed >= budget.recoveryLimit)) {
        return { accepted: false, reason: 'automatic recovery budget is exhausted' }
      }
    }
    return { accepted: true, input: {
      ...(hasDecision ? { decision } : { recovery: 'diagnose' as const }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    } }
  }
  if (input.recovery !== undefined) return { accepted: false, reason: 'this decision requires its dedicated human control' }

  if (state.suspensionReason === 'USER_PAUSED') {
    if (input.decision !== undefined || input.approval !== undefined) {
      return { accepted: false, reason: 'user pause resume does not accept decision data' }
    }
    return { accepted: true, input: {} }
  }

  if (state.suspensionReason === 'BRAIN_INFRASTRUCTURE_FAILED') {
    if (input.decision !== undefined || input.approval !== undefined) {
      return { accepted: false, reason: 'Brain infrastructure recovery does not accept decision data' }
    }
    return { accepted: true, input: {} }
  }

  switch (effectiveHumanRequired(state)?.category) {
    case 'DECISION_REQUIRED':
    case 'STALLED':
      if (!hasDecision || hasApproval) {
        return { accepted: false, reason: 'a decision is required' }
      }
      return { accepted: true, input: { decision } }
    case 'ENVIRONMENT_REQUIRED':
    case 'CREDENTIAL_REQUIRED':
    case 'EXECUTOR_RETRY_REQUIRED':
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
    case 'ACTION_BUDGET_EXHAUSTED': {
      const taskState = state.currentTaskId === null ? undefined : state.taskStatesV2?.[state.currentTaskId]
      const budget = taskState?.actionBudget
      if (budget === undefined || !budget.originalExhausted || budget.recoveryGranted || budget.recoveryExhausted) {
        return { accepted: false, reason: 'controller recovery budget is unavailable or already consumed' }
      }
      if (!hasDecision || hasApproval) return { accepted: false, reason: 'a recovery decision is required' }
      return { accepted: true, input: { decision } }
    }
    case 'REVIEWER_PROTOCOL_FAILURE':
      return { accepted: false, reason: 'reviewer protocol failure requires a new session' }
    default:
      return { accepted: false, reason: 'unsupported suspension category' }
  }
}
