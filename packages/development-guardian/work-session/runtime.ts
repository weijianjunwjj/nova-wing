/**
 * Work Session Runtime with Mastra Workflow Suspend/Resume
 * W001 持久化骨架实现 - 使用真正的 Mastra Workflow
 */

import { Mastra } from '@mastra/core'
import {
  createWorkflow,
  createStep,
  createWorkflowStateReader,
} from '@mastra/core/workflows'
import { LibSQLStore } from '@mastra/libsql'
import { z } from 'zod'
import type {
  WorkSessionDefinition,
  WorkSessionDurableState,
  WorkSessionCompletionReason,
} from './model.js'
import type { GuardianProgressEvent } from '../progress.js'
import type { WorkSessionTaskRunner, WorkSessionTaskRunContext } from './task-runner.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import {
  createWorkSessionCompletedNotification,
  createWorkSessionFailedNotification,
  createWorkSessionRecoveryRequiredNotification,
  createHumanRequiredNotification,
  type NotificationDeliveryObserver,
  type NotificationDeliveryResult,
  type WorkSessionNotifier,
} from './notifier.js'
import {
  classifyWorkSessionFailure,
  safeFailureMessage,
} from './failure-classification.js'
import {
  ExecutionLedgerStore,
  type ExecutionLedgerEvent,
  type ExecutionLedgerEventInput,
} from './execution-ledger.js'
import {
  finalizeCompletedTask,
  readCurrentHeadSha,
  GitPushError,
  RemoteVerificationUnavailableError,
  recoverCheckpointPush,
  type GitCheckpointFinalizer,
  type GitCheckpointCommandRunner,
  type GitCheckpointPolicy,
} from './git-checkpoint.js'
import { isTerminalWorkSessionState } from './recoverability.js'
import {
  isEligibleScopedVerificationCommand,
  VERIFICATION_APPROVAL_BLOCKER,
  verificationCommandFingerprint,
} from './verification-approval.js'

export interface WorkSessionGitCheckpointConfig {
  policy: GitCheckpointPolicy
  /** 可替换 finalizer；缺省使用内置 finalizeCompletedTask */
  finalizer?: GitCheckpointFinalizer
  /** Injectable only for deterministic recovery tests; normal use spawns git directly. */
  commandRunner?: GitCheckpointCommandRunner
}

export interface WorkSessionRuntimeConfig {
  definition: WorkSessionDefinition
  taskRunner: WorkSessionTaskRunner
  storageUrl: string
  /** W004-A: 可选 Git checkpoint 配置 */
  gitCheckpoint?: WorkSessionGitCheckpointConfig
  /** W004-B: 可注入 clock 用于 active-time / hard deadline（缺省 Date.now） */
  clock?: { now(): number }
  /** W006: alert-only port. Guardian/Brain/Executor never receive this capability. */
  notifier?: WorkSessionNotifier
  /** W006: safe structured delivery diagnostics for terminal/local control UI. */
  notificationObserver?: NotificationDeliveryObserver
  /** W006: optional safe local URL provider; runtime never depends on HTTP server types. */
  localControlUrl?: () => string | undefined
  /** W006: initial attempt + one retry; tests may inject a zero delay. */
  notificationRetryDelayMs?: number
  notificationWait?: (delayMs: number) => Promise<void>
  /** Opt-in completion emails; omission preserves the W006 HUMAN_REQUIRED-only behavior. */
  notifyOnCompleted?: boolean
}

export interface ResumeInput {
  decision?: string
  approval?: boolean
}

export interface RecoveryCheckpointResumeOptions {
  /** 目标 session id（必须等于本 runtime 的 definition.id） */
  sessionId: string
  /** 显式 Legacy Adoption 产生的恢复 checkpoint */
  checkpoint: GuardianTaskRecoveryCheckpoint
  /** 传给既有 resume path 的 resume data */
  resumeData?: ResumeInput
}

// Workflow state schema
const WorkflowStateSchema = z.object({
  sessionId: z.string(),
  state: z.enum(['READY', 'RUNNING', 'SUSPENDED', 'COMPLETED', 'FAILED', 'CANCELLED']),
  currentTaskIndex: z.number(),
  currentTaskId: z.string().nullable(),
  completedTaskIds: z.array(z.string()),
  humanRequired: z.object({
    category: z.string(),
    reason: z.string(),
  }).optional(),
  pendingVerificationApproval: z.object({
    sessionId: z.string(), taskId: z.string(), command: z.string(),
    commandFingerprint: z.string(), generation: z.number().int().positive(),
    status: z.enum(['REQUESTED', 'APPROVED']),
  }).optional(),
  brainFailure: z.object({
    stage: z.enum(['BRAIN_REVIEW', 'FINAL_REVIEW']),
    failureType: z.enum([
      'BRAIN_UNAVAILABLE', 'BRAIN_TRANSPORT_FAILED', 'BRAIN_CONFIGURATION_FAILED',
      'BRAIN_AUTH_REQUIRED', 'BRAIN_RATE_LIMITED', 'BRAIN_CONVERSATION_MISMATCH',
      'BRAIN_RESPONSE_INVALID',
    ]).optional(),
    safeMessage: z.string().optional(),
    category: z.enum(['CONFIGURATION', 'TRANSPORT', 'PROTOCOL', 'RESPONSE']),
    rootCause: z.string(),
    adapter: z.string(),
    requestedModel: z.string().optional(),
    requestedReasoning: z.string().optional(),
    availableOptions: z.array(z.string()).optional(),
    retryable: z.boolean(),
    degraded: z.boolean(),
    fingerprint: z.string(),
    rawError: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    timestamp: z.string().optional(),
    lastReliableCheckpoint: z.string().optional(),
    nextResumableAction: z.string().optional(),
    rawOutputRef: z.string().optional(),
    attemptTimeline: z.array(z.object({
      attempt: z.number().int().positive(),
      operationKind: z.enum(['normal', 'retry', 'rotation']),
      startedAt: z.string(),
      durationMs: z.number().nonnegative(),
      outcome: z.enum(['success', 'failure']),
      failureType: z.enum([
        'BRAIN_UNAVAILABLE', 'BRAIN_TRANSPORT_FAILED', 'BRAIN_CONFIGURATION_FAILED',
        'BRAIN_AUTH_REQUIRED', 'BRAIN_RATE_LIMITED', 'BRAIN_CONVERSATION_MISMATCH',
        'BRAIN_RESPONSE_INVALID',
      ]).nullable(),
      fingerprint: z.string().nullable(),
      timeout: z.boolean(),
      transport: z.object({
        promptChars: z.number().int().nonnegative(),
        inputMode: z.enum(['normal', 'big-paste', 'unknown']),
        composerSettleMs: z.number().nonnegative().optional(),
        sendReadyWaitMs: z.number().nonnegative().optional(),
        pasteCount: z.number().int().nonnegative(),
        submitCount: z.number().int().nonnegative(),
        submissionReached: z.boolean(),
        reusedSubmission: z.boolean(),
      }).strict().optional(),
    }).strict()).optional(),
  }).optional(),
  humanRequiredGeneration: z.number().int().nonnegative().optional(),
  lastNotificationAttemptGeneration: z.number().int().nonnegative().optional(),
  lastNotifiedHumanRequiredGeneration: z.number().int().nonnegative().optional(),
  recoveryRequiredGeneration: z.number().int().nonnegative().optional(),
  lastRecoveryNotificationAttemptGeneration: z.number().int().nonnegative().optional(),
  lastNotifiedRecoveryRequiredGeneration: z.number().int().nonnegative().optional(),
  completionNotificationAttempted: z.boolean().optional(),
  completionNotified: z.boolean().optional(),
  failureNotificationAttempted: z.boolean().optional(),
  failureNotified: z.boolean().optional(),
  currentTaskCheckpoint: z.any().optional(), // W003: GuardianTaskRecoveryCheckpoint
  verificationFailure: z.any().optional(),
  checkpointCommits: z.record(z.string(), z.string()).optional(), // W004-A
  checkpointPushes: z.record(z.string(), z.string()).optional(), // W004-B
  failureReason: z.string().optional(), // W004-A FINAL
  failureStage: z.enum([
    'REVIEWER', 'EXECUTOR', 'VERIFICATION', 'FINAL_REVIEW', 'GIT_COMMIT',
    'GIT_PUSH', 'RUNTIME', 'NOTIFICATION', 'UNKNOWN',
  ]).optional(),
  failureCategory: z.enum([
    'PROVIDER_ERROR', 'VERIFICATION_FAILED', 'GIT_COMMIT_FAILED', 'GIT_PUSH_FAILED',
    'REPO_DRIFT', 'PERMISSION', 'CREDENTIAL', 'BUDGET', 'PROTOCOL',
    'RUNTIME_ERROR', 'UNKNOWN',
  ]).optional(),
  safeFailureMessage: z.string().optional(),
  currentTaskBaseHeadSha: z.string().optional(), // W004-A FINAL
  activeElapsedMs: z.number().optional(), // W004-B
  activeSegmentStartedAt: z.number().optional(), // W004-B
  completionReason: z
    .enum(['ALL_TASKS_COMPLETED', 'SOFT_LIMIT', 'HARD_LIMIT', 'MAX_TASKS'])
    .optional(), // W004-B
  suspensionReason: z.enum(['USER_PAUSED', 'BRAIN_INFRASTRUCTURE_FAILED']).optional(),
  cancellationReason: z.enum(['STOP_AFTER_TASK']).optional(), // W005-B
  stopAfterTaskRequested: z.boolean().optional(), // W005-B durability closure
  createdAt: z.string(),
  updatedAt: z.string(),
})

type WorkflowState = z.infer<typeof WorkflowStateSchema>

/**
 * W004-B: 最小 fail-fast limits 校验。invalid definition 必须在任何
 * TaskRunner / provider / git mutation 前失败；不自动纠正用户 limits。
 */
function validateWorkSessionLimits(limits: WorkSessionDefinition['limits']): void {
  if (!Number.isInteger(limits.maxTasks) || limits.maxTasks < 1) {
    throw new Error('WorkSession limits.maxTasks must be an integer >= 1')
  }
  if (typeof limits.softMinutes !== 'number' || Number.isNaN(limits.softMinutes) || limits.softMinutes < 0) {
    throw new Error('WorkSession limits.softMinutes must be >= 0')
  }
  if (typeof limits.hardMinutes !== 'number' || Number.isNaN(limits.hardMinutes) || limits.hardMinutes <= 0) {
    throw new Error('WorkSession limits.hardMinutes must be > 0')
  }
  if (limits.hardMinutes < limits.softMinutes) {
    throw new Error('WorkSession limits.hardMinutes must be >= softMinutes')
  }
}

export class WorkSessionRuntime {
  private mastra: Mastra
  private config: WorkSessionRuntimeConfig
  private workflowId: string
  private latestState?: WorkflowState
  private pauseRequested = false
  private stopAfterTaskRequested = false
  private notificationPromise: Promise<void> | undefined
  private lastNotificationDelivery: NotificationDeliveryResult | undefined
  private ledger: ExecutionLedgerStore | undefined
  private failureNotificationScheduled = false
  private checkpointRecoveryPromise: Promise<WorkSessionDurableState> | undefined
  /** T021: 本进程内是否真正启动/恢复过 workflow 执行。loadPersistedState 只 hydrate，不置位。 */
  private executionStarted = false
  /** T021: 中断恢复的进程内幂等 guard，防止 repeated Resume 创建两个活动 Runner。 */
  private resumeInterruptedPromise: Promise<WorkSessionDurableState> | undefined
  /** Direct runtime idempotency guard; the control layer also rejects duplicate clicks. */
  private suspendedResumePromise: Promise<WorkSessionDurableState> | undefined
  /** Covers durable approval mutation as well as the resume it triggers. */
  private verificationApprovalPromise: Promise<WorkSessionDurableState> | undefined

  constructor(config: WorkSessionRuntimeConfig) {
    // W004-B: invalid limits 必须在任何 TaskRunner / provider / git mutation 前 fail-fast
    validateWorkSessionLimits(config.definition.limits)
    this.config = config
    // runId = sessionId，简化 identity 管理
    this.workflowId = `work-session-${config.definition.id}`

    try {
      this.ledger = new ExecutionLedgerStore(config.storageUrl)
    } catch {
      // Execution Ledger is an observability side channel. Failure to open it
      // must not mutate or fabricate the Work Session business outcome.
      this.ledger = undefined
    }

    // 初始化 Mastra 和 LibSQL 持久化存储
    const storage = new LibSQLStore({
      id: this.workflowId,
      url: config.storageUrl,
    })

    this.mastra = new Mastra({
      storage,
      workflows: {},
    })

    // 每个进程都必须重新注册 workflow definition
    this.createWorkflow()
  }

  /** W004-B: 当前 clock 帧内时间（毫秒） */
  private now(): number {
    return this.config.clock?.now() ?? Date.now()
  }

  /** W004-B: active working time（毫秒）。suspend 期间不累积。 */
  private activeElapsedMs(state: WorkflowState): number {
    const base = state.activeElapsedMs ?? 0
    if (state.activeSegmentStartedAt === undefined) {
      return base
    }
    return base + (this.now() - state.activeSegmentStartedAt)
  }

  /** W004-B: 结算当前 active segment，清空 segment start（用于 SUSPEND/terminal） */
  private settleActiveTime(state: WorkflowState): {
    activeElapsedMs: number
    activeSegmentStartedAt: undefined
  } {
    return {
      activeElapsedMs: this.activeElapsedMs(state),
      activeSegmentStartedAt: undefined,
    }
  }

  /**
   * W004-B: claim 新 Task 前的 limit 检查（优先级 hard > maxTasks > soft）。
   * 命中返回对应 completionReason；未命中返回 undefined。
   */
  private checkClaimLimits(state: WorkflowState): WorkSessionCompletionReason | undefined {
    const elapsed = this.activeElapsedMs(state)
    const limits = this.config.definition.limits
    if (elapsed >= limits.hardMinutes * 60_000) {
      return 'HARD_LIMIT'
    }
    if (state.completedTaskIds.length >= limits.maxTasks) {
      return 'MAX_TASKS'
    }
    if (elapsed >= limits.softMinutes * 60_000) {
      return 'SOFT_LIMIT'
    }
    return undefined
  }

  /** W004-B: 当前 active segment 的 hard deadline 绝对时间（clock 帧内毫秒） */
  private computeHardDeadlineAtMs(state: WorkflowState): number {
    const limits = this.config.definition.limits
    const hardMs = limits.hardMinutes * 60_000
    const accumulated = state.activeElapsedMs ?? 0
    const segmentStart = state.activeSegmentStartedAt ?? this.now()
    return segmentStart + hardMs - accumulated
  }

  /**
   * Restore the configured run's durable domain state without starting or
   * resuming the workflow. Missing sessions remain absent rather than becoming
   * a fabricated READY state.
   */
  async loadPersistedState(): Promise<WorkSessionDurableState | undefined> {
    const persisted = await this.readPersistedWorkflowSnapshot()
    if (persisted === undefined) return undefined

    let hydratedState = persisted.state
    if (persisted.state.state === 'FAILED') {
      const failedDeliveries = this.readExecutionLedger().filter(
        (event) =>
          (event.eventType === 'NOTIFICATION_SENT' || event.eventType === 'NOTIFICATION_FAILED') &&
          event.notificationKind === 'FAILED',
      )
      const ledgerSent = failedDeliveries.some(
        (event) => event.eventType === 'NOTIFICATION_SENT',
      )
      const notificationSent = persisted.state.failureNotified === true || ledgerSent
      // Durable success is authoritative because the Ledger is fail-open. Ledger
      // facts may strengthen durable state; their absence only clears an old
      // attempted-only pre-delivery claim so bounded delivery can resume.
      hydratedState = {
        ...persisted.state,
        failureNotificationAttempted:
          notificationSent || failedDeliveries.length > 0 || undefined,
        failureNotified: notificationSent || undefined,
      }
    }
    this.latestState = hydratedState
    this.pauseRequested = false
    this.stopAfterTaskRequested = hydratedState.stopAfterTaskRequested === true
    const durableState = this.convertWorkflowStateToDurableState(hydratedState)
    if (durableState.state === 'FAILED') this.scheduleFailedNotification(durableState)
    return durableState
  }

  async start(): Promise<WorkSessionDurableState> {
    const initialState: WorkflowState = {
      sessionId: this.config.definition.id,
      state: 'RUNNING',
      currentTaskIndex: 0,
      currentTaskId: null,
      completedTaskIds: [],
      checkpointCommits: {},
      activeElapsedMs: 0,
      activeSegmentStartedAt: this.now(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.latestState = initialState

    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) {
      throw new Error(`Workflow ${this.workflowId} not found after registration`)
    }

    // 检查 runId 是否已存在，fail-closed
    const runId = this.config.definition.id
    try {
      const existingRun = await workflow.getWorkflowRunById(runId)
      if (existingRun) {
        throw new Error(
          `Work session ${runId} already exists. Use resume() instead of start().`,
        )
      }
    } catch (error: any) {
      // 如果是 "not found" 错误，说明 runId 不存在，可以继续
      if (!error.message.includes('not found') && !error.message.includes('already exists')) {
        throw error
      }
      // 如果是 "already exists"，直接抛出
      if (error.message.includes('already exists')) {
        throw error
      }
    }

    try {
      // 使用 sessionId 作为 runId
      const run = await workflow.createRun({
        runId,
      })

      this.recordLedger({
        eventType: 'SESSION_STARTED',
        sessionId: runId,
        taskId: null,
        timestamp: this.ledgerTimestamp(),
        status: 'RUNNING',
        activeElapsedMs: 0,
      }, 'session-started')

      this.executionStarted = true
      const result = await run.start({
        inputData: {},
        initialState,
      })

      // 检查执行结果
      if (result.status === 'failed') {
        // Workflow 执行失败，抛出错误
        const errorMessage = result.error?.message || 'Workflow execution failed'
        throw new Error(errorMessage)
      }

      // 返回 latestState（已通过 setState 更新）
      if (!this.latestState) {
        throw new Error('Workflow state was not updated')
      }
      const durableState = this.convertWorkflowStateToDurableState(this.latestState)
      this.scheduleNotificationsForState(durableState, false)
      return durableState
    } catch (error) {
      const failedState = this.getDurableState()
      if (failedState?.state === 'FAILED') {
        try {
          await this.persistLatestFailedState()
        } catch {
          // Preserve the original Work Session failure if durable storage itself is unavailable.
        }
        this.scheduleNotificationsForState(failedState, false)
      }
      throw error
    }
  }

  async resume(resumeInput: ResumeInput): Promise<WorkSessionDurableState> {
    if (this.suspendedResumePromise !== undefined) {
      throw new Error('session resume already in progress')
    }
    this.suspendedResumePromise = this.doResume(resumeInput)
      .finally(() => { this.suspendedResumePromise = undefined })
    return this.suspendedResumePromise
  }

  private async doResume(resumeInput: ResumeInput): Promise<WorkSessionDurableState> {
    const runId = this.config.definition.id

    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) {
      throw new Error(`Workflow ${this.workflowId} not found`)
    }

    try {
      // 步骤 1: 从 storage 获取持久化的 workflow run state
      const persistedState = await workflow.getWorkflowRunById(runId)
      if (!persistedState) {
        throw new Error(`No persisted run found for runId=${runId}`)
      }

      // 步骤 2: 验证 snapshot 存在且状态正确
      if (persistedState.status !== 'suspended') {
        throw new Error(`Cannot resume run in status=${persistedState.status}`)
      }

      // 步骤 3: 使用 createWorkflowStateReader 验证 suspended step
      const reader = createWorkflowStateReader(persistedState)
      const suspendedStep = reader.getSuspendedStep()

      if (!suspendedStep) {
        throw new Error('No suspended step found in persisted state')
      }

      // 步骤 4: 用相同 runId 重建 Run instance
      const run = await workflow.createRun({
        runId,
      })

      // 步骤 5: resume，Mastra 会从 snapshot 恢复
      this.executionStarted = true
      await run.resume({
        step: suspendedStep.path,
        resumeData: resumeInput,
      })

      // 返回 latestState（已通过 setState 更新）
      if (!this.latestState) {
        throw new Error('Workflow state was not updated during resume')
      }
      const durableState = this.convertWorkflowStateToDurableState(this.latestState)
      this.scheduleNotificationsForState(
        durableState,
        resumeInput.decision !== undefined,
      )
      return durableState
    } catch (error) {
      const failedState = this.getDurableState()
      if (failedState?.state === 'FAILED') {
        try {
          await this.persistLatestFailedState()
        } catch {
          // Preserve the original Work Session failure if durable storage itself is unavailable.
        }
        this.scheduleNotificationsForState(failedState, false)
      }
      throw error
    }
  }

  /**
   * The browser supplies no command or identity. This method approves only the
   * durable request already bound to this runtime's session and current task.
   */
  async approvePendingVerificationAndContinue(): Promise<WorkSessionDurableState> {
    if (this.verificationApprovalPromise !== undefined) {
      throw new Error('verification approval already in progress')
    }
    this.verificationApprovalPromise = this.doApprovePendingVerificationAndContinue()
      .finally(() => { this.verificationApprovalPromise = undefined })
    return this.verificationApprovalPromise
  }

  private async doApprovePendingVerificationAndContinue(): Promise<WorkSessionDurableState> {
    const runId = this.config.definition.id
    const storage = this.mastra.getStorage()
    const workflows = storage === undefined ? undefined : await storage.getStore('workflows')
    if (workflows === undefined) throw new Error('verification approval storage unavailable')
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: this.workflowId, runId })
    if (snapshot === null || snapshot.status !== 'suspended') {
      throw new Error('verification approval requires a suspended session')
    }
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (!parsed.success) throw new Error('verification approval state is invalid')
    const state = parsed.data
    const pending = state.pendingVerificationApproval
    if (
      state.state !== 'SUSPENDED' || state.humanRequired?.category !== 'DECISION_REQUIRED' ||
      pending === undefined || pending.status !== 'REQUESTED' ||
      pending.sessionId !== runId || pending.taskId !== state.currentTaskId ||
      pending.generation !== state.humanRequiredGeneration ||
      !isEligibleScopedVerificationCommand(pending.command, this.config.definition.targetRepo) ||
      pending.commandFingerprint !== verificationCommandFingerprint(pending.command)
    ) {
      throw new Error('verification approval is not available for the current task')
    }
    const approved: WorkflowState = {
      ...state,
      pendingVerificationApproval: { ...pending, status: 'APPROVED' },
      updatedAt: new Date().toISOString(),
    }
    snapshot.value = approved as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName: this.workflowId, runId, snapshot })
    this.latestState = approved
    this.recordLedger({
      eventType: 'VERIFICATION_APPROVED', sessionId: runId, taskId: pending.taskId,
      timestamp: this.ledgerTimestamp(), status: 'APPROVED',
      commandFingerprint: pending.commandFingerprint,
    }, `verification-approved:${pending.taskId}:${pending.generation}:${pending.commandFingerprint}`)
    return this.resume({})
  }

  /**
   * W003 FINAL: 显式 Legacy Recovery 入口。
   *
   * 把一个显式创建的 GuardianTaskRecoveryCheckpoint（例如 adoptLegacyRecoveryCheckpoint
   * 的结果）认领为指定 session 的恢复基线，然后走既有 Mastra resume path。
   *
   * 调用者不需要直接操作 Mastra raw snapshot：
   * - storage.getStore('workflows') / loadWorkflowSnapshot / persistWorkflowSnapshot
   * - 修改 rawSnapshot.value.currentTaskCheckpoint
   *
   * 本 API 内部负责：
   * - session 必须存在（否则 fail closed）；
   * - session 必须处于合法可恢复状态（SUSPENDED）；
   * - session 的 currentTaskId 必须与 checkpoint.task.id 一致（fail-closed identity gate）；
   * - 把 checkpoint 持久化为 currentTaskCheckpoint；
   * - 复用既有 resume path（repo identity 后续仍由 Runner 的 RepositoryCheckpoint gate 验证）。
   */
  async resumeFromRecoveryCheckpoint(
    options: RecoveryCheckpointResumeOptions,
  ): Promise<WorkSessionDurableState> {
    const runId = this.config.definition.id
    if (options.sessionId !== runId) {
      throw new Error(
        `recovery session mismatch: expected sessionId=${runId}, got ${options.sessionId}`,
      )
    }

    const workflowName = `work-session-${this.config.definition.id}`
    const storage = this.mastra.getStorage()
    if (storage === undefined) {
      throw new Error(`recovery failed: storage unavailable for ${workflowName}`)
    }
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) {
      throw new Error(
        `recovery failed: workflows storage domain unavailable for ${workflowName}`,
      )
    }

    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null) {
      throw new Error(`recovery failed: no resumable session found for ${runId}`)
    }
    if (snapshot.status !== 'suspended') {
      throw new Error(
        `recovery failed: session ${runId} is not resumable (status=${snapshot.status})`,
      )
    }

    const workflowState = snapshot.value as unknown as WorkflowState
    if (workflowState.currentTaskId !== options.checkpoint.task.id) {
      throw new Error(
        `recovery checkpoint task ${options.checkpoint.task.id} does not match session current task ${workflowState.currentTaskId ?? 'null'}`,
      )
    }

    // 持久化 checkpoint，交给既有 resume path；
    // repo identity（branch/HEAD/fingerprint）由 Runner 的 RepositoryCheckpoint gate 验证。
    snapshot.value = {
      ...workflowState,
      currentTaskCheckpoint: options.checkpoint,
      updatedAt: new Date().toISOString(),
    } as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })

    return this.resume(options.resumeData ?? {})
  }

  /** Narrow closure for a failed, already-committed Git push checkpoint only. */
  async recoverFailedGitCheckpoint(): Promise<WorkSessionDurableState> {
    if (this.checkpointRecoveryPromise !== undefined) {
      throw new Error('checkpoint recovery already in progress')
    }
    this.checkpointRecoveryPromise = this.doRecoverFailedGitCheckpoint()
      .finally(() => { this.checkpointRecoveryPromise = undefined })
    return this.checkpointRecoveryPromise
  }

  private async doRecoverFailedGitCheckpoint(): Promise<WorkSessionDurableState> {
    const state = this.latestState ?? await this.loadPersistedWorkflowStateForRecovery()
    const gitCheckpoint = this.config.gitCheckpoint
    const taskId = state.currentTaskId
    const commitSha = taskId === null ? undefined : state.checkpointCommits?.[taskId]
    const baseSha = state.currentTaskBaseHeadSha
    const remote = gitCheckpoint?.policy.pushRemote
    if (
      state.state !== 'FAILED' || state.failureStage !== 'GIT_PUSH' ||
      state.failureCategory !== 'GIT_PUSH_FAILED' || taskId === null ||
      commitSha === undefined || baseSha === undefined ||
      state.completedTaskIds.includes(taskId) || gitCheckpoint?.policy.autoCommit !== true ||
      gitCheckpoint.policy.autoPush !== true || remote === undefined
    ) {
      throw new Error('failed session is not eligible for checkpoint recovery')
    }

    const requestedKey = `checkpoint-recovery-requested:${taskId}:${commitSha}`
    this.recordLedger({
      eventType: 'CHECKPOINT_RECOVERY_REQUESTED', sessionId: state.sessionId, taskId,
      timestamp: this.ledgerTimestamp(), status: 'REQUESTED', recoveryKind: 'GIT_PUSH',
      recoveryAction: 'RETRY_PUSH', commitSha,
    }, requestedKey)

    let result
    try {
      result = await recoverCheckpointPush({
        repoPath: this.config.definition.targetRepo, expectedBranch: this.config.definition.branch,
        commitSha, baseSha, remote,
        ...(gitCheckpoint.commandRunner === undefined
          ? {}
          : { commandRunner: gitCheckpoint.commandRunner }),
      })
    } catch (error) {
      if (error instanceof RemoteVerificationUnavailableError) {
        this.recordCheckpointRecoveryFailed(state, taskId, commitSha, 'VERIFICATION_UNAVAILABLE')
      }
      throw error
    }
    if (result.action === 'REMOTE_DRIFT') {
      this.recordCheckpointRecoveryFailed(state, taskId, commitSha, 'REMOTE_DRIFT')
      throw new Error('remote drift during checkpoint recovery')
    }

    const recovered: WorkflowState = {
      ...state,
      state: 'RUNNING',
      currentTaskIndex: state.currentTaskIndex + 1,
      currentTaskId: null,
      completedTaskIds: [...state.completedTaskIds, taskId],
      checkpointPushes: { ...(state.checkpointPushes ?? {}), [taskId]: commitSha },
      failureReason: undefined, failureStage: undefined, failureCategory: undefined,
      safeFailureMessage: undefined, currentTaskCheckpoint: undefined,
      currentTaskBaseHeadSha: undefined,
      activeSegmentStartedAt: this.now(), updatedAt: new Date().toISOString(),
    }
    this.recordLedger({
      eventType: 'CHECKPOINT_RECOVERY_COMPLETED', sessionId: state.sessionId, taskId,
      timestamp: this.ledgerTimestamp(), status: 'COMPLETED', recoveryKind: 'GIT_PUSH',
      recoveryAction: result.action, commitSha,
    }, `checkpoint-recovery-completed:${taskId}:${commitSha}:${result.action}`)

    return this.restartRunFromState(recovered)
  }

  /**
   * T021: 显式恢复一个「持久化状态为 RUNNING 但当前进程无活动 Runner」的 Session。
   *
   * 与 resume()（Mastra status='suspended'）区分：进程异常退出时 workflow run 没有
   * suspend step，Mastra status 停留在 'running'，无法走 suspend/resume。这里从持久化
   * domain state 重建 run，execute step 会从 currentTaskIndex 继续并跳过 completedTaskIds，
   * 因此已完成 Task 不会重跑。若有 currentTaskCheckpoint，则照常传给 TaskRunner 走既有
   * RepositoryCheckpoint gate + provider restore，绝不从 Task 头部无脑重跑。
   *
   * 必须由用户显式调用；loadPersistedState 只发现、不自动恢复。
   */
  async resumeInterrupted(): Promise<WorkSessionDurableState> {
    if (this.resumeInterruptedPromise !== undefined) {
      throw new Error('interrupted resume already in progress')
    }
    this.resumeInterruptedPromise = this.doResumeInterrupted()
      .finally(() => { this.resumeInterruptedPromise = undefined })
    return this.resumeInterruptedPromise
  }

  private async doResumeInterrupted(): Promise<WorkSessionDurableState> {
    const runId = this.config.definition.id
    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (workflow === undefined) {
      throw new Error(`Workflow ${this.workflowId} not found`)
    }
    const persisted = await workflow.getWorkflowRunById(runId)
    if (persisted === null) {
      throw new Error(`No persisted session to recover for runId=${runId}`)
    }
    // SUSPENDED 走既有 resume()；此处只负责 crash-遗留的 running status。
    if (persisted.status === 'suspended') {
      throw new Error('use resume() for a suspended session')
    }

    const state = await this.loadPersistedWorkflowStateForRecovery()
    if (isTerminalWorkSessionState(state.state)) {
      throw new Error(`session is ${state.state} and cannot be recovered`)
    }

    const recovered: WorkflowState = {
      ...state,
      state: 'RUNNING',
      humanRequired: undefined,
      brainFailure: undefined,
      suspensionReason: undefined,
      pendingVerificationApproval: undefined,
      activeSegmentStartedAt: this.now(),
      updatedAt: new Date().toISOString(),
    }

    return this.restartRunFromState(recovered)
  }

  /**
   * 从给定 domain state 重建 workflow run 并开始执行。用于 Git checkpoint recovery
   * 与 T021 中断恢复：delete 旧 run → createRun → start(initialState)。
   */
  private async restartRunFromState(recovered: WorkflowState): Promise<WorkSessionDurableState> {
    const storage = this.mastra.getStorage()
    const workflows = storage === undefined ? undefined : await storage.getStore('workflows')
    if (workflows === undefined) throw new Error('workflow storage unavailable')
    await workflows.deleteWorkflowRunById({ workflowName: this.workflowId, runId: recovered.sessionId })
    this.latestState = recovered
    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) throw new Error(`Workflow ${this.workflowId} not found`)
    this.executionStarted = true
    const run = await workflow.createRun({ runId: recovered.sessionId })
    const runResult = await run.start({ inputData: {}, initialState: recovered })
    if (runResult.status === 'failed') throw new Error(runResult.error?.message ?? 'recovered workflow failed')
    if (this.latestState === undefined) throw new Error('recovered workflow did not update state')
    const durable = this.convertWorkflowStateToDurableState(this.latestState)
    this.scheduleNotificationsForState(durable, false)
    return durable
  }

  private async loadPersistedWorkflowStateForRecovery(): Promise<WorkflowState> {
    const snapshot = await this.readPersistedWorkflowSnapshot()
    if (snapshot === undefined) throw new Error('persisted checkpoint recovery state is missing')
    this.latestState = snapshot.state
    return snapshot.state
  }

  /**
   * T021: 从 workflow snapshot 读取最新持久化 domain state。
   *
   * Mastra 的 getWorkflowRunById().initialState 在 step 运行期间不会随 setState
   * 同步更新，只有 suspend/complete/fail 才 flush；RUNNING 异常退出时 initialState
   * 仍是 run.start 的初始值。snapshot.value 才是被 persistDurableState 显式维护的
   * 最新 domain state，因此读取以 snapshot 为准。
   */
  private async readPersistedWorkflowSnapshot(): Promise<{
    state: WorkflowState
    status: string
  } | undefined> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return undefined
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return undefined
    const snapshot = await workflows.loadWorkflowSnapshot({
      workflowName: this.workflowId,
      runId: this.config.definition.id,
    })
    if (snapshot === null) return undefined
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (!parsed.success) {
      throw new Error(`Persisted work session ${this.config.definition.id} has invalid workflow state`)
    }
    if (parsed.data.sessionId !== this.config.definition.id) {
      throw new Error(
        `Persisted work session identity mismatch: expected ${this.config.definition.id}, got ${parsed.data.sessionId}`,
      )
    }
    return { state: parsed.data, status: snapshot.status }
  }

  /**
   * T021: 显式持久化 workflow snapshot 为给定 domain state。
   * 在 execute step 的 Task claim / Task completed 边界调用，使 RUNNING 异常退出后
   * 也能恢复 last completed task 与 current task，而不从 Task 头部重跑。
   */
  private async persistDurableState(state: WorkflowState): Promise<void> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return
    const snapshot = await workflows.loadWorkflowSnapshot({
      workflowName: this.workflowId,
      runId: this.config.definition.id,
    })
    if (snapshot === null) return
    snapshot.value = state as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({
      workflowName: this.workflowId,
      runId: this.config.definition.id,
      snapshot,
    })
  }

  private recordCheckpointRecoveryFailed(
    state: WorkflowState, taskId: string, commitSha: string,
    recoveryAction: 'REMOTE_DRIFT' | 'VERIFICATION_UNAVAILABLE',
  ): void {
    this.recordLedger({
      eventType: 'CHECKPOINT_RECOVERY_FAILED', sessionId: state.sessionId, taskId,
      timestamp: this.ledgerTimestamp(), status: 'FAILED', recoveryKind: 'GIT_PUSH',
      recoveryAction, commitSha,
    }, `checkpoint-recovery-failed:${taskId}:${commitSha}:${recoveryAction}`)
  }

  private createWorkflow() {
    const self = this

    // 创建主执行 step
    const executeTasksStep = createStep({
      id: 'execute-tasks-serially',
      inputSchema: z.object({}),
      outputSchema: z.object({
        final: z.boolean(),
      }),
      stateSchema: WorkflowStateSchema,
      resumeSchema: z.object({
        decision: z.string().optional(),
        approval: z.boolean().optional(),
      }),
      suspendSchema: z.object({
        reason: z.string(),
      }),
      async execute(params) {
        const { state, setState, suspend, resumeData } = params
        const tasks = self.config.definition.tasks

        // 使用本地变量追踪最新状态
        let currentState = state

        // W004-B: 恢复（suspend 已清空 segment start）时重新开始 active segment。
        // 首次 start 已在 initialState 设置 segment start，此处不会重复触发。
        if (currentState.activeSegmentStartedAt === undefined) {
          const resumedState: WorkflowState = {
            ...currentState,
            state: 'RUNNING',
            humanRequired: undefined,
            brainFailure: undefined,
            verificationFailure: undefined,
            suspensionReason: undefined,
            activeSegmentStartedAt: self.now(),
            updatedAt: new Date().toISOString(),
          }
          await setState(resumedState)
          currentState = resumedState
          self.latestState = resumedState
        }

        // 从当前 task index 开始
        for (let i = currentState.currentTaskIndex; i < tasks.length; i++) {
          const task = tasks[i]!

          // 如果这个任务已经完成，跳过（这是 Mastra 恢复语义的核心）
          if (currentState.completedTaskIds.includes(task.id)) {
            continue
          }

          // W004-B: claim 新 Task 前检查 limits（resume 已 claim 的当前 Task 不截断）。
          const isNewTaskClaim = currentState.currentTaskId !== task.id
          if (isNewTaskClaim) {
            // W005-B: a pause received between Tasks suspends before claiming the next
            // Task. currentTaskId is deliberately left unchanged; no TASK_STARTED is
            // fabricated for work that has not begun.
            if (self.pauseRequested) {
              self.pauseRequested = false
              const pausedState: WorkflowState = {
                ...currentState,
                state: 'SUSPENDED',
                humanRequired: undefined,
                suspensionReason: 'USER_PAUSED',
                stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
                ...self.settleActiveTime(currentState),
                updatedAt: new Date().toISOString(),
              }
              await setState(pausedState)
              self.latestState = pausedState
              return await suspend(
                { reason: 'USER_PAUSED' },
                { resumeLabel: 'user-pause' },
              )
            }

            const limitReason = self.checkClaimLimits(currentState)
            if (limitReason !== undefined) {
              self.stopAfterTaskRequested = false
              const limitState: WorkflowState = {
                ...currentState,
                state: 'COMPLETED',
                currentTaskId: null,
                completionReason: limitReason,
                humanRequired: undefined,
                currentTaskCheckpoint: undefined,
                verificationFailure: undefined,
                pendingVerificationApproval: undefined,
                stopAfterTaskRequested: undefined,
                ...self.settleActiveTime(currentState),
                updatedAt: new Date().toISOString(),
              }
              await setState(limitState)
              self.latestState = limitState
              self.recordSessionCompleted(limitState)
              return { final: true }
            }
          }

          // 更新状态
          const updatedState: WorkflowState = {
            ...currentState,
            currentTaskIndex: i,
            currentTaskId: task.id,
            updatedAt: new Date().toISOString(),
          }
          await setState(updatedState)
          currentState = updatedState
          self.latestState = updatedState
          await self.persistDurableState(updatedState)
          if (isNewTaskClaim) {
            self.recordLedger({
              eventType: 'TASK_STARTED',
              sessionId: updatedState.sessionId,
              taskId: task.id,
              timestamp: self.ledgerTimestamp(),
              status: 'RUNNING',
              activeElapsedMs: self.activeElapsedMs(updatedState),
            }, `task-started:${task.id}`)
          }

          // W004-A FINAL: autoCommit=true 时，在第一次真正开始某 Task 前捕获 base HEAD。
          // suspend/resume 同一个 Task 时复用已保存 SHA，禁止重新采样。
          const gitCheckpoint = self.config.gitCheckpoint
          if (
            gitCheckpoint !== undefined &&
            gitCheckpoint.policy.autoCommit === true &&
            currentState.currentTaskBaseHeadSha === undefined
          ) {
            const baseHeadSha = await readCurrentHeadSha(self.config.definition.targetRepo)
            const baseHeadState: WorkflowState = {
              ...currentState,
              currentTaskBaseHeadSha: baseHeadSha,
              updatedAt: new Date().toISOString(),
            }
            await setState(baseHeadState)
            currentState = baseHeadState
            self.latestState = baseHeadState
          }

          // W003: 传递 checkpoint 给 TaskRunner
          // W004-B: 同时传递 hard deadline（clock 帧内），供 Guardian adapter 构造 stop hook
          const checkpoint = currentState.currentTaskCheckpoint
          const approvedVerification = currentState.pendingVerificationApproval
          const approvedVerificationCommand =
            approvedVerification?.status === 'APPROVED' &&
            approvedVerification.sessionId === currentState.sessionId &&
            approvedVerification.taskId === task.id &&
            approvedVerification.generation === currentState.humanRequiredGeneration &&
            approvedVerification.commandFingerprint === verificationCommandFingerprint(approvedVerification.command) &&
            isEligibleScopedVerificationCommand(approvedVerification.command, self.config.definition.targetRepo)
              ? approvedVerification.command
              : undefined
          // Consume before starting Guardian work. A crash/restart cannot turn a
          // persisted approval into a second execution of the command.
          if (approvedVerificationCommand !== undefined) {
            const consumedState: WorkflowState = {
              ...currentState,
              pendingVerificationApproval: undefined,
              updatedAt: new Date().toISOString(),
            }
            await setState(consumedState)
            currentState = consumedState
            self.latestState = consumedState
            self.recordLedger({
              eventType: 'VERIFICATION_APPROVAL_CONSUMED', sessionId: consumedState.sessionId,
              taskId: task.id, timestamp: self.ledgerTimestamp(), status: 'CONSUMED',
              commandFingerprint: approvedVerification!.commandFingerprint,
            }, `verification-consumed:${task.id}:${approvedVerification!.generation}:${approvedVerification!.commandFingerprint}`)
          }
          const runContext: WorkSessionTaskRunContext = {
            hardDeadlineAtMs: self.computeHardDeadlineAtMs(currentState),
            shouldPauseAutonomousWork: () => self.pauseRequested,
            onProgress: (event) => self.recordGuardianProgress(task.id, event),
            ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }),
          }
          const result = await self.config.taskRunner.run(task, resumeData, checkpoint, runContext)

          if (result.status === 'COMPLETED') {
            const completionEvidence = result.completionEvidence

            // W004-A REVIEW REVISE: autoCommit 开启时，真 COMPLETED 必须携带结构化 evidence。
            // 不允许"跳过 finalizer 直接把 Task 标 COMPLETED 并进入下一 Task"。
            if (
              gitCheckpoint !== undefined &&
              gitCheckpoint.policy.autoCommit === true &&
              completionEvidence === undefined
            ) {
              const failureReason = `completed task ${task.id} missing completion evidence`
              const failure = classifyWorkSessionFailure(failureReason, {
                failureStage: 'RUNTIME',
                failureCategory: 'PROTOCOL',
              })
              const failedState: WorkflowState = {
                ...currentState,
                state: 'FAILED',
                failureReason,
                failureStage: failure.failureStage,
                failureCategory: failure.failureCategory,
                safeFailureMessage: failure.safeMessage,
                humanRequired: undefined,
                currentTaskCheckpoint: undefined,
                pendingVerificationApproval: undefined,
                ...self.settleActiveTime(currentState),
                updatedAt: new Date().toISOString(),
              }
              await setState(failedState)
              self.latestState = failedState
              self.recordSessionFailed(failedState)
              throw new Error(failureReason)
            }

            // W004-A: 真 COMPLETED → 可选 safe git checkpoint（Task 边界）
            // checkpoint 必须先于"标记完成并进入下一 Task"完成；commit 本身失败
            // 则 Session FAILED，不得进入下一 Task。
            let checkpointCommitSha: string | undefined
            let checkpointPushSha: string | undefined
            if (
              completionEvidence !== undefined &&
              gitCheckpoint !== undefined &&
              gitCheckpoint.policy.autoCommit === true
            ) {
              const finalizer = gitCheckpoint.finalizer ?? finalizeCompletedTask
              try {
                const commitResult = await finalizer({
                  repoPath: self.config.definition.targetRepo,
                  expectedBranch: self.config.definition.branch,
                  task,
                  completionEvidence,
                  policy: gitCheckpoint.policy,
                  ...(currentState.currentTaskBaseHeadSha !== undefined
                    ? { expectedBaseHeadSha: currentState.currentTaskBaseHeadSha }
                    : {}),
                })
                checkpointCommitSha = commitResult.commitSha
                checkpointPushSha = commitResult.pushSha
                self.recordGitCommitCompleted(task.id, commitResult.commitSha, currentState)
                if (commitResult.pushSha !== undefined) {
                  self.recordGitPushCompleted(
                    task.id,
                    commitResult.commitSha,
                    commitResult.pushSha,
                    currentState,
                  )
                }
              } catch (error) {
                // Git checkpoint execution failure → Session FAILED，不是 DECISION_REQUIRED
                const failureReason =
                  error instanceof Error ? error.message : String(error)
                // W004-B: push 失败但 local commit 已成功 → 保留 commitSha（partial success 可见），
                // checkpointPushes 无对应 entry，completedTaskIds 不包含本 Task。
                const partialCommitSha = error instanceof GitPushError ? error.commitSha : undefined
                const failure = classifyWorkSessionFailure(error)
                if (partialCommitSha !== undefined) {
                  self.recordGitCommitCompleted(task.id, partialCommitSha, currentState)
                }
                const failedState: WorkflowState = {
                  ...currentState,
                  state: 'FAILED',
                  failureReason,
                  failureStage: failure.failureStage,
                  failureCategory: failure.failureCategory,
                  safeFailureMessage: failure.safeMessage,
                  humanRequired: undefined,
                  currentTaskCheckpoint: undefined,
                  ...(partialCommitSha !== undefined
                    ? {
                        checkpointCommits: {
                          ...(currentState.checkpointCommits ?? {}),
                          [task.id]: partialCommitSha,
                        },
                      }
                    : {}),
                  ...self.settleActiveTime(currentState),
                  updatedAt: new Date().toISOString(),
                }
                await setState(failedState)
                self.latestState = failedState
                self.recordSessionFailed(failedState)
                throw new Error(
                  `Git checkpoint failed for task ${task.id}: ${failureReason}`,
                )
              }
            }

            // 任务完成，更新状态，清除 humanRequired 和 checkpoint 以及 base HEAD
            const completedState: WorkflowState = {
              ...currentState,
              completedTaskIds: [...currentState.completedTaskIds, task.id],
              ...(checkpointCommitSha !== undefined
                ? {
                    checkpointCommits: {
                      ...(currentState.checkpointCommits ?? {}),
                      [task.id]: checkpointCommitSha,
                    },
                  }
                : {}),
              ...(checkpointPushSha !== undefined
                ? {
                    checkpointPushes: {
                      ...(currentState.checkpointPushes ?? {}),
                      [task.id]: checkpointPushSha,
                    },
                  }
                : {}),
              humanRequired: undefined,
              currentTaskCheckpoint: undefined,
              verificationFailure: undefined,
              pendingVerificationApproval: undefined,
              currentTaskBaseHeadSha: undefined,
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              updatedAt: new Date().toISOString(),
            }
            await setState(completedState)
            currentState = completedState
            self.latestState = completedState
            await self.persistDurableState(completedState)
            self.recordLedger({
              eventType: 'TASK_COMPLETED',
              sessionId: completedState.sessionId,
              taskId: task.id,
              timestamp: self.ledgerTimestamp(),
              status: 'COMPLETED',
              activeElapsedMs: self.activeElapsedMs(completedState),
            }, `task-completed:${task.id}`)

            // W005-B: stop-after-task is observed only after verification and the
            // full safe commit/push checkpoint path. Real queue completion wins.
            if (
              self.stopAfterTaskRequested &&
              completedState.completedTaskIds.length < tasks.length
            ) {
              self.stopAfterTaskRequested = false
              self.pauseRequested = false
              const cancelledState: WorkflowState = {
                ...completedState,
                state: 'CANCELLED',
                cancellationReason: 'STOP_AFTER_TASK',
                completionReason: undefined,
                suspensionReason: undefined,
                humanRequired: undefined,
                currentTaskCheckpoint: undefined,
                pendingVerificationApproval: undefined,
                stopAfterTaskRequested: undefined,
                ...self.settleActiveTime(completedState),
                updatedAt: new Date().toISOString(),
              }
              await setState(cancelledState)
              self.latestState = cancelledState
              return { final: true }
            }
            continue
          }

          if (result.status === 'BRAIN_INFRASTRUCTURE_FAILED') {
            const brainFailure = result.brainFailure
            if (brainFailure === undefined) {
              throw new Error('Brain infrastructure suspension requires structured failure data')
            }
            const nextRecoveryGeneration = (currentState.recoveryRequiredGeneration ?? 0) + 1
            const suspendedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: undefined,
              brainFailure: {
                stage: brainFailure.stage,
                category: brainFailure.category,
                rootCause: brainFailure.rootCause,
                adapter: brainFailure.adapter,
                retryable: brainFailure.retryable,
                degraded: brainFailure.degraded,
                fingerprint: brainFailure.fingerprint,
                ...(brainFailure.failureType === undefined ? {} : { failureType: brainFailure.failureType }),
                ...(brainFailure.safeMessage === undefined ? {} : { safeMessage: brainFailure.safeMessage }),
                ...(brainFailure.requestedModel === undefined
                  ? {}
                  : { requestedModel: brainFailure.requestedModel }),
                ...(brainFailure.requestedReasoning === undefined
                  ? {}
                  : { requestedReasoning: brainFailure.requestedReasoning }),
                ...(brainFailure.availableOptions === undefined
                  ? {}
                  : { availableOptions: [...brainFailure.availableOptions] }),
                ...(brainFailure.rawError === undefined
                  ? {}
                  : { rawError: brainFailure.rawError }),
                ...(brainFailure.attempt === undefined ? {} : { attempt: brainFailure.attempt }),
                ...(brainFailure.timestamp === undefined ? {} : { timestamp: brainFailure.timestamp }),
                ...(brainFailure.lastReliableCheckpoint === undefined ? {} : { lastReliableCheckpoint: brainFailure.lastReliableCheckpoint }),
                ...(brainFailure.nextResumableAction === undefined ? {} : { nextResumableAction: brainFailure.nextResumableAction }),
                ...(brainFailure.rawOutputRef === undefined ? {} : { rawOutputRef: brainFailure.rawOutputRef }),
                ...(brainFailure.attemptTimeline === undefined
                  ? {}
                  : { attemptTimeline: brainFailure.attemptTimeline.map((attempt) => ({ ...attempt })) }),
              },
              suspensionReason: 'BRAIN_INFRASTRUCTURE_FAILED',
              recoveryRequiredGeneration: nextRecoveryGeneration,
              currentTaskCheckpoint: result.checkpoint,
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              ...self.settleActiveTime(currentState),
              updatedAt: new Date().toISOString(),
            }
            await setState(suspendedState)
            self.latestState = suspendedState
            return await suspend(
              { reason: 'BRAIN_INFRASTRUCTURE_FAILED' },
              { resumeLabel: 'brain-infrastructure-recovery' },
            )
          }

          if (result.status === 'PAUSED') {
            self.pauseRequested = false
            const pausedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: undefined,
              brainFailure: undefined,
              suspensionReason: 'USER_PAUSED',
              currentTaskCheckpoint: result.checkpoint,
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              ...self.settleActiveTime(currentState),
              updatedAt: new Date().toISOString(),
            }
            await setState(pausedState)
            self.latestState = pausedState
            return await suspend(
              { reason: 'USER_PAUSED' },
              { resumeLabel: 'user-pause' },
            )
          }

          if (result.status === 'HUMAN_REQUIRED') {
            // 需要人工介入，suspend workflow
            const nextGeneration = (currentState.humanRequiredGeneration ?? 0) + 1
            const requestedCommand = result.pendingVerificationCommand
            const pendingVerificationApproval =
              requestedCommand !== undefined &&
              result.humanRequired?.category === 'DECISION_REQUIRED' &&
              result.humanRequired.reason.includes(VERIFICATION_APPROVAL_BLOCKER) &&
              isEligibleScopedVerificationCommand(requestedCommand, self.config.definition.targetRepo)
                ? {
                    sessionId: currentState.sessionId,
                    taskId: task.id,
                    command: requestedCommand,
                    commandFingerprint: verificationCommandFingerprint(requestedCommand),
                    generation: nextGeneration,
                    status: 'REQUESTED' as const,
                  }
                : undefined
            const suspendedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: result.humanRequired,
              brainFailure: undefined,
              humanRequiredGeneration: nextGeneration,
              pendingVerificationApproval,
              suspensionReason: undefined,
              currentTaskCheckpoint: result.checkpoint, // W003: 持久化 checkpoint
              verificationFailure: result.verificationFailure,
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              ...self.settleActiveTime(currentState), // W004-B: 结算 active time，暂停不计时
              updatedAt: new Date().toISOString(),
            }
            await setState(suspendedState)
            self.latestState = suspendedState
            self.recordLedger({
              eventType: 'HUMAN_REQUIRED',
              sessionId: suspendedState.sessionId,
              taskId: task.id,
              timestamp: self.ledgerTimestamp(),
              status: 'SUSPENDED',
              ...(suspendedState.activeElapsedMs === undefined
                ? {}
                : { activeElapsedMs: suspendedState.activeElapsedMs }),
              safeMessage: safeFailureMessage(result.humanRequired?.reason ?? 'human required'),
            }, `human-required:${task.id}:${suspendedState.humanRequiredGeneration ?? 0}`)
            if (pendingVerificationApproval !== undefined) {
              self.recordLedger({
                eventType: 'VERIFICATION_APPROVAL_REQUESTED', sessionId: suspendedState.sessionId,
                taskId: task.id, timestamp: self.ledgerTimestamp(), status: 'REQUESTED',
                commandFingerprint: pendingVerificationApproval.commandFingerprint,
              }, `verification-requested:${task.id}:${pendingVerificationApproval.generation}:${pendingVerificationApproval.commandFingerprint}`)
            }

            // 调用 suspend，Mastra 会持久化当前状态
            return await suspend(
              { reason: result.humanRequired?.reason || 'HUMAN_REQUIRED' },
              { resumeLabel: 'human-decision' },
            )
          }

          if (result.status === 'FAILED') {
            const failureReason = result.error ?? `Task ${task.id} failed`
            const failure = classifyWorkSessionFailure(failureReason, {
              ...(result.failureStage === undefined ? {} : { failureStage: result.failureStage }),
              ...(result.failureCategory === undefined ? {} : { failureCategory: result.failureCategory }),
            })
            const failedState: WorkflowState = {
              ...currentState,
              state: 'FAILED',
              failureReason,
              failureStage: failure.failureStage,
              failureCategory: failure.failureCategory,
              safeFailureMessage: failure.safeMessage,
              humanRequired: undefined,
              currentTaskCheckpoint: undefined,
              verificationFailure: undefined,
              pendingVerificationApproval: undefined,
              ...self.settleActiveTime(currentState), // W004-B
              updatedAt: new Date().toISOString(),
            }
            await setState(failedState)
            self.latestState = failedState
            self.recordSessionFailed(failedState)

            throw new Error(`Task ${task.id} failed: ${failureReason}`)
          }
        }

        // 所有任务完成
        self.stopAfterTaskRequested = false
        const finalState: WorkflowState = {
          ...currentState,
          state: 'COMPLETED',
          currentTaskId: null,
          completionReason: 'ALL_TASKS_COMPLETED',
          suspensionReason: undefined,
          cancellationReason: undefined,
          humanRequired: undefined,
          currentTaskCheckpoint: undefined,
          verificationFailure: undefined,
          pendingVerificationApproval: undefined,
          stopAfterTaskRequested: undefined,
          ...self.settleActiveTime(currentState), // W004-B: 结算最后 segment
          updatedAt: new Date().toISOString(),
        }
        await setState(finalState)
        self.latestState = finalState
        self.recordSessionCompleted(finalState)

        return { final: true }
      },
    })

    // 创建 workflow
    const workflow = createWorkflow({
      id: this.workflowId,
      inputSchema: z.object({}),
      outputSchema: z.object({
        final: z.boolean(),
      }),
      stateSchema: WorkflowStateSchema,
    })
      .then(executeTasksStep)
      .commit()

    // 注册到 Mastra
    this.mastra.addWorkflow(workflow)

    return workflow
  }

  private convertWorkflowStateToDurableState(wfState: WorkflowState): WorkSessionDurableState {
    const result: WorkSessionDurableState = {
      sessionId: wfState.sessionId,
      state: wfState.state as any,
      currentTaskIndex: wfState.currentTaskIndex,
      currentTaskId: wfState.currentTaskId,
      completedTaskIds: wfState.completedTaskIds,
      createdAt: new Date(wfState.createdAt),
      updatedAt: new Date(wfState.updatedAt),
    }
    if (wfState.humanRequired) {
      result.humanRequired = wfState.humanRequired
    }
    if (wfState.pendingVerificationApproval !== undefined) {
      result.pendingVerificationApproval = wfState.pendingVerificationApproval
    }
    if (wfState.brainFailure) {
      result.brainFailure = {
        stage: wfState.brainFailure.stage,
        category: wfState.brainFailure.category,
        rootCause: wfState.brainFailure.rootCause,
        adapter: wfState.brainFailure.adapter,
        retryable: wfState.brainFailure.retryable,
        degraded: wfState.brainFailure.degraded,
        fingerprint: wfState.brainFailure.fingerprint,
        ...(wfState.brainFailure.failureType === undefined ? {} : { failureType: wfState.brainFailure.failureType }),
        ...(wfState.brainFailure.safeMessage === undefined ? {} : { safeMessage: wfState.brainFailure.safeMessage }),
        ...(wfState.brainFailure.requestedModel === undefined
          ? {}
          : { requestedModel: wfState.brainFailure.requestedModel }),
        ...(wfState.brainFailure.requestedReasoning === undefined
          ? {}
          : { requestedReasoning: wfState.brainFailure.requestedReasoning }),
        ...(wfState.brainFailure.availableOptions === undefined
          ? {}
          : { availableOptions: wfState.brainFailure.availableOptions }),
        ...(wfState.brainFailure.rawError === undefined
          ? {}
          : { rawError: wfState.brainFailure.rawError }),
        ...(wfState.brainFailure.attempt === undefined ? {} : { attempt: wfState.brainFailure.attempt }),
        ...(wfState.brainFailure.timestamp === undefined ? {} : { timestamp: wfState.brainFailure.timestamp }),
        ...(wfState.brainFailure.lastReliableCheckpoint === undefined ? {} : { lastReliableCheckpoint: wfState.brainFailure.lastReliableCheckpoint }),
        ...(wfState.brainFailure.nextResumableAction === undefined ? {} : { nextResumableAction: wfState.brainFailure.nextResumableAction }),
        ...(wfState.brainFailure.rawOutputRef === undefined ? {} : { rawOutputRef: wfState.brainFailure.rawOutputRef }),
        ...(wfState.brainFailure.attemptTimeline === undefined
          ? {}
          : { attemptTimeline: wfState.brainFailure.attemptTimeline.map((attempt) => ({ ...attempt })) }),
      }
    }
    if (wfState.humanRequiredGeneration !== undefined) {
      result.humanRequiredGeneration = wfState.humanRequiredGeneration
    }
    if (wfState.lastNotificationAttemptGeneration !== undefined) {
      result.lastNotificationAttemptGeneration = wfState.lastNotificationAttemptGeneration
    }
    if (wfState.lastNotifiedHumanRequiredGeneration !== undefined) {
      result.lastNotifiedHumanRequiredGeneration = wfState.lastNotifiedHumanRequiredGeneration
    }
    if (wfState.recoveryRequiredGeneration !== undefined) {
      result.recoveryRequiredGeneration = wfState.recoveryRequiredGeneration
    }
    if (wfState.lastRecoveryNotificationAttemptGeneration !== undefined) {
      result.lastRecoveryNotificationAttemptGeneration = wfState.lastRecoveryNotificationAttemptGeneration
    }
    if (wfState.lastNotifiedRecoveryRequiredGeneration !== undefined) {
      result.lastNotifiedRecoveryRequiredGeneration = wfState.lastNotifiedRecoveryRequiredGeneration
    }
    if (wfState.completionNotificationAttempted !== undefined) {
      result.completionNotificationAttempted = wfState.completionNotificationAttempted
    }
    if (wfState.completionNotified !== undefined) {
      result.completionNotified = wfState.completionNotified
    }
    if (wfState.failureNotificationAttempted !== undefined) {
      result.failureNotificationAttempted = wfState.failureNotificationAttempted
    }
    if (wfState.failureNotified !== undefined) {
      result.failureNotified = wfState.failureNotified
    }
    // W003: 传递 checkpoint
    if (wfState.currentTaskCheckpoint) {
      result.currentTaskCheckpoint = wfState.currentTaskCheckpoint
    }
    if (wfState.verificationFailure !== undefined) {
      result.verificationFailure = wfState.verificationFailure
    }
    // W004-A: 传递 checkpoint commits
    if (wfState.checkpointCommits !== undefined) {
      result.checkpointCommits = wfState.checkpointCommits
    }
    // W004-B: 传递 checkpoint pushes / completionReason / active-time
    if (wfState.checkpointPushes !== undefined) {
      result.checkpointPushes = wfState.checkpointPushes
    }
    if (wfState.completionReason !== undefined) {
      result.completionReason = wfState.completionReason
    }
    if (wfState.suspensionReason !== undefined) {
      result.suspensionReason = wfState.suspensionReason
    }
    if (wfState.cancellationReason !== undefined) {
      result.cancellationReason = wfState.cancellationReason
    }
    if (wfState.stopAfterTaskRequested !== undefined) {
      result.stopAfterTaskRequested = wfState.stopAfterTaskRequested
    }
    if (wfState.activeElapsedMs !== undefined) {
      result.activeElapsedMs = wfState.activeElapsedMs
    }
    if (wfState.activeSegmentStartedAt !== undefined) {
      result.activeSegmentStartedAt = wfState.activeSegmentStartedAt
    }
    // W004-A FINAL: 传递 checkpoint failure 原因与 base HEAD
    if (wfState.failureReason !== undefined) {
      result.failureReason = wfState.failureReason
    }
    if (wfState.failureStage !== undefined) {
      result.failureStage = wfState.failureStage
    }
    if (wfState.failureCategory !== undefined) {
      result.failureCategory = wfState.failureCategory
    }
    if (wfState.safeFailureMessage !== undefined) {
      result.safeFailureMessage = wfState.safeFailureMessage
    }
    if (wfState.currentTaskBaseHeadSha !== undefined) {
      result.currentTaskBaseHeadSha = wfState.currentTaskBaseHeadSha
    }
    return result
  }

  async close(): Promise<void> {
    await this.notificationPromise
    this.ledger?.close()
    this.ledger = undefined
    const storage = this.mastra.getStorage()
    if (storage) {
      await storage.close()
    }
  }

  /**
   * 获取当前 session 的 runId（等于 sessionId）
   */
  getRunId(): string {
    return this.config.definition.id
  }

  /**
   * W005-A: 暴露 definition（project/branch/tasks/limits），供 local control UI 渲染。
   * 纯只读 additive，不改任何既有语义。
   */
  getDefinition(): WorkSessionDefinition {
    return this.config.definition
  }

  /** Durable, ordered, product-safe history for this configured session. */
  readExecutionLedger(): readonly ExecutionLedgerEvent[] {
    try {
      return this.ledger?.read(this.config.definition.id) ?? []
    } catch {
      return []
    }
  }

  requestPause(): { accepted: boolean; reason?: string } {
    if (this.latestState?.state !== 'RUNNING') {
      return { accepted: false, reason: 'session is not running' }
    }
    if (this.pauseRequested) {
      return { accepted: false, reason: 'pause already requested' }
    }
    this.pauseRequested = true
    return { accepted: true }
  }

  requestStopAfterTask(): { accepted: boolean; reason?: string } {
    if (this.latestState?.state !== 'RUNNING') {
      return { accepted: false, reason: 'session is not running' }
    }
    if (this.stopAfterTaskRequested) {
      return { accepted: false, reason: 'stop after task already requested' }
    }
    this.stopAfterTaskRequested = true
    return { accepted: true }
  }

  getControlIntents(): {
    pauseRequested: boolean
    stopAfterTaskRequested: boolean
  } {
    return {
      pauseRequested:
        this.latestState?.state === 'RUNNING' && this.pauseRequested,
      stopAfterTaskRequested:
        (this.latestState?.state === 'RUNNING' || this.latestState?.state === 'SUSPENDED') &&
        this.stopAfterTaskRequested,
    }
  }

  /**
   * T021: 当前进程内是否真正启动/恢复过 workflow 执行。
   * 持久化 session state（getDurableState）与 runtime liveness 是两回事；
   * 进程重启后新实例 loadPersistedState 只 hydrate，本方法仍返回 false。
   */
  hasActiveExecution(): boolean {
    return this.executionStarted
  }

  /**
   * W004-A FINAL: 读取当前 NovaWing durable domain state（含 FAILED 后的 failureReason）。
   * 用于在 checkpoint failure 后断言 domain state 已持久化为 FAILED，
   * 而不是只依赖 Mastra workflow status。
   */
  getDurableState(): WorkSessionDurableState | undefined {
    if (this.latestState === undefined) {
      return undefined
    }
    return this.convertWorkflowStateToDurableState(this.latestState)
  }

  /** W006: production owner/tests can explicitly hold the bounded delivery promise. */
  getNotificationPromise(): Promise<void> | undefined {
    return this.notificationPromise
  }

  getLastNotificationDelivery(): NotificationDeliveryResult | undefined {
    return this.lastNotificationDelivery === undefined
      ? undefined
      : { ...this.lastNotificationDelivery }
  }

  private ledgerTimestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private recordLedger(input: ExecutionLedgerEventInput, dedupeKey: string): void {
    try {
      this.ledger?.append(input, dedupeKey)
    } catch {
      // Fail open for observability: Ledger cannot change Work Session facts.
    }
  }

  private recordGuardianProgress(taskId: string, event: GuardianProgressEvent): void {
    if (event.status === 'pending') return
    const eventType = event.status === 'active'
      ? 'PHASE_STARTED'
      : event.status === 'completed' ? 'PHASE_COMPLETED' : 'PHASE_FAILED'
    const verificationCommand = event.verification === undefined
      ? undefined
      : safeFailureMessage(event.verification.command)
    const evidence = event.verification?.evidence
    this.recordLedger({
      eventType,
      sessionId: this.config.definition.id,
      taskId,
      timestamp: this.ledgerTimestamp(),
      phase: event.phase,
      status: event.status,
      iteration: event.iteration,
      ...(event.verification === undefined && event.recovery === undefined && Number.isFinite(event.elapsedMs)
        ? { cumulativeElapsedMs: event.elapsedMs }
        : {}),
      ...(event.verification?.durationMs !== undefined && Number.isFinite(event.verification.durationMs)
        ? { durationMs: event.verification.durationMs }
        : {}),
      ...(verificationCommand === undefined
        ? {}
        : {
            verificationCommand,
            verificationStatus: event.verification!.status,
            ...(event.verification!.index === undefined
              ? {}
              : { verificationIndex: event.verification!.index }),
          }),
      ...(event.recovery === undefined
        ? {}
        : {
            recoveryReason: event.recovery.reason,
            recoveryBounded: event.recovery.bounded,
          }),
      ...(evidence?.classification === undefined
        ? {}
        : { verificationClassification: evidence.classification }),
      ...(evidence?.rawOutputRef === undefined ? {} : { rawOutputRef: evidence.rawOutputRef }),
      ...(evidence?.firstFailure?.title === undefined
        ? {}
        : { firstFailureTitle: evidence.firstFailure.title }),
      ...(evidence?.firstFailure?.exceptionType === undefined
        ? {}
        : { exceptionType: evidence.firstFailure.exceptionType }),
      ...(evidence?.firstFailure?.phase === undefined
        ? {}
        : { failurePhase: evidence.firstFailure.phase }),
      ...(evidence?.finalSummary === undefined ? {} : { finalSummary: evidence.finalSummary }),
      ...(evidence?.rootCauseCount === undefined
        ? {}
        : { rootCauseCount: evidence.rootCauseCount }),
      ...(evidence?.affectedTests === undefined
        ? {}
        : { affectedTests: evidence.affectedTests }),
      ...(this.latestState === undefined
        ? {}
        : { activeElapsedMs: this.activeElapsedMs(this.latestState) }),
    }, event.verification !== undefined
      ? `verification:${taskId}:${event.iteration}:${
        event.verification.index ?? verificationCommand
      }:${event.verification.status}`
      : event.recovery !== undefined
        ? `recovery:${taskId}:${event.iteration}:${safeFailureMessage(event.recovery.reason)}`
        : `phase:${taskId}:${event.phase}:${event.status}:${event.iteration}`)
  }

  private recordGitCommitCompleted(
    taskId: string,
    commitSha: string,
    state: WorkflowState,
  ): void {
    this.recordLedger({
      eventType: 'GIT_COMMIT_COMPLETED',
      sessionId: state.sessionId,
      taskId,
      timestamp: this.ledgerTimestamp(),
      status: 'COMPLETED',
      commitSha,
      activeElapsedMs: this.activeElapsedMs(state),
    }, `git-commit-completed:${taskId}:${commitSha}`)
  }

  private recordGitPushCompleted(
    taskId: string,
    commitSha: string,
    pushSha: string,
    state: WorkflowState,
  ): void {
    this.recordLedger({
      eventType: 'GIT_PUSH_COMPLETED',
      sessionId: state.sessionId,
      taskId,
      timestamp: this.ledgerTimestamp(),
      status: 'COMPLETED',
      commitSha,
      pushSha,
      activeElapsedMs: this.activeElapsedMs(state),
    }, `git-push-completed:${taskId}:${pushSha}`)
  }

  private recordSessionFailed(state: WorkflowState): void {
    const failure = state.failureStage !== undefined && state.failureCategory !== undefined
      ? {
          failureStage: state.failureStage,
          failureCategory: state.failureCategory,
          safeMessage: safeFailureMessage(state.safeFailureMessage ?? state.failureReason),
        }
      : classifyWorkSessionFailure(state.failureReason ?? 'Work Session failed')
    const commitSha = state.currentTaskId === null
      ? undefined
      : state.checkpointCommits?.[state.currentTaskId]
    this.recordLedger({
      eventType: 'SESSION_FAILED',
      sessionId: state.sessionId,
      taskId: state.currentTaskId,
      timestamp: this.ledgerTimestamp(),
      status: 'FAILED',
      ...failure,
      ...(state.activeElapsedMs === undefined ? {} : { activeElapsedMs: state.activeElapsedMs }),
      ...(commitSha === undefined ? {} : { commitSha }),
    }, 'session-failed')
  }

  private recordSessionCompleted(state: WorkflowState): void {
    if (state.completionReason === undefined) return
    this.recordLedger({
      eventType: 'SESSION_COMPLETED',
      sessionId: state.sessionId,
      taskId: state.currentTaskId,
      timestamp: this.ledgerTimestamp(),
      status: 'COMPLETED',
      completionReason: state.completionReason,
      ...(state.activeElapsedMs === undefined ? {} : { activeElapsedMs: state.activeElapsedMs }),
    }, 'session-completed')
  }

  /**
   * Mastra keeps the failed workflow status, but a thrown step may retain the
   * pre-step state value. Persist NovaWing's already-confirmed FAILED domain
   * state explicitly so process restart observes the same terminal fact.
   */
  private async persistLatestFailedState(): Promise<void> {
    if (this.latestState?.state !== 'FAILED') return
    const storage = this.mastra.getStorage()
    if (storage === undefined) return
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return
    const workflowName = `work-session-${this.config.definition.id}`
    const runId = this.config.definition.id
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null) return
    snapshot.value = this.latestState as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })
  }

  private scheduleNotificationsForState(
    state: WorkSessionDurableState,
    forceSafeReason: boolean,
  ): void {
    this.scheduleHumanRequiredNotification(state, forceSafeReason)
    this.scheduleRecoveryRequiredNotification(state)
    this.scheduleCompletedNotification(state)
    this.scheduleFailedNotification(state)
  }

  private scheduleRecoveryRequiredNotification(state: WorkSessionDurableState): void {
    if (
      this.config.notifier?.notifyRecoveryRequired === undefined ||
      state.state !== 'SUSPENDED' ||
      state.suspensionReason !== 'BRAIN_INFRASTRUCTURE_FAILED' ||
      state.brainFailure === undefined ||
      state.recoveryRequiredGeneration === undefined ||
      state.lastRecoveryNotificationAttemptGeneration === state.recoveryRequiredGeneration
    ) {
      return
    }
    const previous = this.notificationPromise ?? Promise.resolve()
    this.notificationPromise = previous
      .then(() => this.deliverRecoveryRequiredNotification(state))
      .catch(() => {
        // Infrastructure alert delivery cannot change or discard the suspended checkpoint.
      })
  }

  private async deliverRecoveryRequiredNotification(state: WorkSessionDurableState): Promise<void> {
    const notifier = this.config.notifier
    const generation = state.recoveryRequiredGeneration
    if (notifier?.notifyRecoveryRequired === undefined || generation === undefined || state.brainFailure === undefined) {
      return
    }
    const localControlUrl = this.config.localControlUrl?.()
    const notification = createWorkSessionRecoveryRequiredNotification({
      definition: this.config.definition,
      state,
      generation,
      ...(localControlUrl === undefined ? {} : { localControlUrl }),
    })
    const claimed = await this.persistRecoveryNotificationGeneration(
      generation,
      'lastRecoveryNotificationAttemptGeneration',
    )
    if (!claimed) return

    let sent = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await notifier.notifyRecoveryRequired(notification)
        sent = true
        break
      } catch {
        if (attempt === 0) {
          await (this.config.notificationWait ?? defaultNotificationWait)(
            this.config.notificationRetryDelayMs ?? 1_000,
          )
        }
      }
    }
    if (sent) {
      try {
        await this.persistRecoveryNotificationGeneration(
          generation,
          'lastNotifiedRecoveryRequiredGeneration',
        )
      } catch {
        // The durable attempt marker remains authoritative for restart dedupe.
      }
    }
    this.observeNotification({
      status: sent ? 'SENT' : 'FAILED',
      notificationId: notification.notificationId,
      taskId: state.currentTaskId,
      category: state.brainFailure.category,
      kind: 'RECOVERY_REQUIRED',
    })
  }

  private scheduleHumanRequiredNotification(
    state: WorkSessionDurableState,
    forceSafeReason: boolean,
  ): void {
    if (
      this.config.notifier === undefined ||
      state.state !== 'SUSPENDED' ||
      state.humanRequired === undefined ||
      state.suspensionReason === 'USER_PAUSED' ||
      state.humanRequiredGeneration === undefined ||
      state.lastNotificationAttemptGeneration === state.humanRequiredGeneration
    ) {
      return
    }

    const previous = this.notificationPromise ?? Promise.resolve()
    this.notificationPromise = previous
      .then(() => this.deliverHumanRequiredNotification(state, forceSafeReason))
      .catch(() => {
        // Delivery is an alert side channel. Never reject start/resume/close or
        // create an unhandled rejection because local notification plumbing failed.
      })
  }

  private async deliverHumanRequiredNotification(
    state: WorkSessionDurableState,
    forceSafeReason: boolean,
  ): Promise<void> {
    const notifier = this.config.notifier
    const generation = state.humanRequiredGeneration
    if (notifier === undefined || generation === undefined || state.humanRequired === undefined) {
      return
    }
    const localControlUrl = this.config.localControlUrl?.()
    const notification = createHumanRequiredNotification({
      definition: this.config.definition,
      state,
      generation,
      ...(localControlUrl === undefined ? {} : { localControlUrl }),
      forceSafeReason,
    })
    const deliveryBase = {
      notificationId: notification.notificationId,
      taskId: state.currentTaskId,
      category: state.humanRequired.category,
    }

    try {
      const claimed = await this.persistNotificationGeneration(
        generation,
        'lastNotificationAttemptGeneration',
      )
      if (!claimed) return

      let sent = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await notifier.notifyHumanRequired(notification)
          sent = true
          break
        } catch {
          if (attempt === 0) {
            await (this.config.notificationWait ?? defaultNotificationWait)(
              this.config.notificationRetryDelayMs ?? 1_000,
            )
          }
        }
      }

      if (sent) {
        try {
          await this.persistNotificationGeneration(
            generation,
            'lastNotifiedHumanRequiredGeneration',
          )
        } catch {
          // The durable attempt marker already prevents restart spam. A failure
          // to persist the optional success marker must not misreport a sent email.
        }
      }
      this.observeNotification({
        status: sent ? 'SENT' : 'FAILED',
        ...deliveryBase,
      })
    } catch {
      this.observeNotification({ status: 'FAILED', ...deliveryBase })
    }
  }

  private scheduleCompletedNotification(state: WorkSessionDurableState): void {
    if (
      this.config.notifier?.notifyCompleted === undefined ||
      this.config.notifyOnCompleted !== true ||
      state.state !== 'COMPLETED' ||
      state.completionReason !== 'ALL_TASKS_COMPLETED' ||
      state.completionNotificationAttempted === true
    ) {
      return
    }
    const previous = this.notificationPromise ?? Promise.resolve()
    this.notificationPromise = previous
      .then(() => this.deliverCompletedNotification())
      .catch(() => {
        // Completion delivery is an alert side channel and must never change a completed session.
      })
  }

  private async deliverCompletedNotification(): Promise<void> {
    const notifier = this.config.notifier
    if (notifier?.notifyCompleted === undefined) return
    const claimed = await this.persistCompletionNotificationFlag('completionNotificationAttempted')
    if (!claimed) return

    const state = this.getDurableState()
    if (state === undefined || state.state !== 'COMPLETED' || state.completionReason !== 'ALL_TASKS_COMPLETED') {
      return
    }
    const notification = createWorkSessionCompletedNotification({
      definition: this.config.definition,
      state,
    })
    let sent = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await notifier.notifyCompleted(notification)
        sent = true
        break
      } catch {
        if (attempt === 0) {
          await (this.config.notificationWait ?? defaultNotificationWait)(
            this.config.notificationRetryDelayMs ?? 1_000,
          )
        }
      }
    }
    if (sent) {
      try {
        await this.persistCompletionNotificationFlag('completionNotified')
      } catch {
        // The durable attempt claim remains authoritative for restart dedupe.
      }
    }
    this.observeNotification({
      status: sent ? 'SENT' : 'FAILED',
      notificationId: notification.notificationId,
      taskId: null,
      category: 'ALL_TASKS_COMPLETED',
      kind: 'COMPLETED',
    })
  }

  private scheduleFailedNotification(state: WorkSessionDurableState): void {
    if (
      this.config.notifier?.notifyFailed === undefined ||
      state.state !== 'FAILED' ||
      state.failureStage === undefined ||
      state.failureCategory === undefined ||
      state.failureNotificationAttempted === true ||
      state.failureNotified === true ||
      this.failureNotificationScheduled
    ) {
      return
    }
    this.failureNotificationScheduled = true
    const previous = this.notificationPromise ?? Promise.resolve()
    this.notificationPromise = previous
      .then(() => this.deliverFailedNotification())
      .catch(() => {
        // FAILED delivery is an alert side channel and cannot change FAILED.
      })
  }

  private async deliverFailedNotification(): Promise<void> {
    const notifier = this.config.notifier
    if (notifier?.notifyFailed === undefined) return
    const state = this.getDurableState()
    if (
      state === undefined ||
      state.state !== 'FAILED' ||
      state.failureStage === undefined ||
      state.failureCategory === undefined
    ) {
      return
    }
    const localControlUrl = this.config.localControlUrl?.()
    const notification = createWorkSessionFailedNotification({
      definition: this.config.definition,
      state,
      ...(localControlUrl === undefined ? {} : { localControlUrl }),
    })
    let sent = false
    for (let attempt = 0; attempt < 2; attempt++) {
      let shouldRetry = false
      try {
        await notifier.notifyFailed(notification)
        sent = true
        break
      } catch {
        shouldRetry = attempt === 0
      } finally {
        if (attempt === 0) {
          try {
            await this.persistFailureNotificationFlag('failureNotificationAttempted')
          } catch {
            // Delivery has already begun. Persist failure must not interrupt the bounded retry.
          }
        }
      }
      if (shouldRetry) {
        await (this.config.notificationWait ?? defaultNotificationWait)(
          this.config.notificationRetryDelayMs ?? 1_000,
        )
      }
    }
    if (sent) {
      try {
        await this.persistFailureNotificationFlag('failureNotified')
      } catch {
        // The durable attempt claim remains authoritative for restart dedupe.
      }
      if (this.latestState?.state === 'FAILED') {
        this.latestState = { ...this.latestState, failureNotified: true }
      }
    }
    this.observeNotification({
      status: sent ? 'SENT' : 'FAILED',
      notificationId: notification.notificationId,
      taskId: state.currentTaskId,
      category: notification.failureCategory,
      kind: 'FAILED',
    })
  }

  private async persistCompletionNotificationFlag(
    field: 'completionNotificationAttempted' | 'completionNotified',
  ): Promise<boolean> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return false
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return false
    const workflowName = `work-session-${this.config.definition.id}`
    const runId = this.config.definition.id
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null) return false
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (
      !parsed.success ||
      parsed.data.state !== 'COMPLETED' ||
      parsed.data.completionReason !== 'ALL_TASKS_COMPLETED' ||
      parsed.data[field] === true
    ) {
      return false
    }
    const updated: WorkflowState = {
      ...parsed.data,
      [field]: true,
      updatedAt: new Date().toISOString(),
    }
    snapshot.value = updated as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })
    if (
      this.latestState?.state === 'COMPLETED' &&
      this.latestState.completionReason === 'ALL_TASKS_COMPLETED'
    ) {
      this.latestState = updated
    }
    return true
  }

  private async persistFailureNotificationFlag(
    field: 'failureNotificationAttempted' | 'failureNotified',
  ): Promise<boolean> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return false
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return false
    const workflowName = `work-session-${this.config.definition.id}`
    const runId = this.config.definition.id
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null) return false
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (!parsed.success || parsed.data.state !== 'FAILED' || parsed.data[field] === true) {
      return false
    }
    const updated: WorkflowState = {
      ...parsed.data,
      [field]: true,
      updatedAt: new Date().toISOString(),
    }
    snapshot.value = updated as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })
    if (this.latestState?.state === 'FAILED') this.latestState = updated
    return true
  }

  private async persistNotificationGeneration(
    generation: number,
    field: 'lastNotificationAttemptGeneration' | 'lastNotifiedHumanRequiredGeneration',
  ): Promise<boolean> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return false
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return false
    const workflowName = `work-session-${this.config.definition.id}`
    const runId = this.config.definition.id
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null || snapshot.status !== 'suspended') return false
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (
      !parsed.success ||
      parsed.data.state !== 'SUSPENDED' ||
      parsed.data.humanRequired === undefined ||
      parsed.data.humanRequiredGeneration !== generation
    ) {
      return false
    }
    if (parsed.data[field] === generation) return false
    const updated: WorkflowState = {
      ...parsed.data,
      [field]: generation,
      updatedAt: new Date().toISOString(),
    }
    snapshot.value = updated as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })
    if (
      this.latestState?.state === 'SUSPENDED' &&
      this.latestState.humanRequiredGeneration === generation
    ) {
      this.latestState = updated
    }
    return true
  }

  private async persistRecoveryNotificationGeneration(
    generation: number,
    field: 'lastRecoveryNotificationAttemptGeneration' | 'lastNotifiedRecoveryRequiredGeneration',
  ): Promise<boolean> {
    const storage = this.mastra.getStorage()
    if (storage === undefined) return false
    const workflows = await storage.getStore('workflows')
    if (workflows === undefined) return false
    const workflowName = `work-session-${this.config.definition.id}`
    const runId = this.config.definition.id
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId })
    if (snapshot === null || snapshot.status !== 'suspended') return false
    const parsed = WorkflowStateSchema.safeParse(snapshot.value)
    if (
      !parsed.success ||
      parsed.data.state !== 'SUSPENDED' ||
      parsed.data.suspensionReason !== 'BRAIN_INFRASTRUCTURE_FAILED' ||
      parsed.data.brainFailure === undefined ||
      parsed.data.recoveryRequiredGeneration !== generation ||
      parsed.data[field] === generation
    ) {
      return false
    }
    const updated: WorkflowState = {
      ...parsed.data,
      [field]: generation,
      updatedAt: new Date().toISOString(),
    }
    snapshot.value = updated as unknown as Record<string, string>
    await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot })
    if (
      this.latestState?.state === 'SUSPENDED' &&
      this.latestState.suspensionReason === 'BRAIN_INFRASTRUCTURE_FAILED' &&
      this.latestState.recoveryRequiredGeneration === generation
    ) {
      this.latestState = updated
    }
    return true
  }

  private observeNotification(result: NotificationDeliveryResult): void {
    this.lastNotificationDelivery = result
    const notificationKind = result.kind ?? 'HUMAN_REQUIRED'
    this.recordLedger({
      eventType: result.status === 'SENT' ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
      sessionId: this.config.definition.id,
      taskId: result.taskId,
      timestamp: this.ledgerTimestamp(),
      status: result.status,
      notificationKind,
      notificationId: result.notificationId,
      ...(result.status === 'FAILED' ? { safeMessage: '通知发送失败。' } : {}),
    }, `notification:${result.notificationId}:${result.status}`)
    try {
      this.config.notificationObserver?.(result)
    } catch {
      // Observer failures must not affect the suspended Work Session.
    }
  }

  /**
   * 验证 Mastra snapshot 是否存在
   * 用于测试验证持久化
   */
  async verifySnapshot(): Promise<{
    exists: boolean
    status?: string
    hasSuspendedStep?: boolean
    suspendedStepId?: string
  }> {
    const runId = this.config.definition.id
    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) {
      return { exists: false }
    }

    const persistedState = await workflow.getWorkflowRunById(runId)
    if (!persistedState) {
      return { exists: false }
    }

    const reader = createWorkflowStateReader(persistedState)
    const suspendedStep = reader.getSuspendedStep()

    const result: {
      exists: boolean
      status?: string
      hasSuspendedStep?: boolean
      suspendedStepId?: string
    } = {
      exists: true,
      status: persistedState.status,
      hasSuspendedStep: !!suspendedStep,
    }

    if (suspendedStep) {
      result.suspendedStepId = suspendedStep.stepId
    }

    return result
  }
}

function defaultNotificationWait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs))
}
