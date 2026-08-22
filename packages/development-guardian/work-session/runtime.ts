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
import type { WorkSessionTaskRunner, WorkSessionTaskRunContext } from './task-runner.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import {
  createHumanRequiredNotification,
  type NotificationDeliveryObserver,
  type NotificationDeliveryResult,
  type WorkSessionNotifier,
} from './notifier.js'
import {
  finalizeCompletedTask,
  readCurrentHeadSha,
  GitPushError,
  type GitCheckpointFinalizer,
  type GitCheckpointPolicy,
} from './git-checkpoint.js'

export interface WorkSessionGitCheckpointConfig {
  policy: GitCheckpointPolicy
  /** 可替换 finalizer；缺省使用内置 finalizeCompletedTask */
  finalizer?: GitCheckpointFinalizer
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
  humanRequiredGeneration: z.number().int().nonnegative().optional(),
  lastNotificationAttemptGeneration: z.number().int().nonnegative().optional(),
  lastNotifiedHumanRequiredGeneration: z.number().int().nonnegative().optional(),
  currentTaskCheckpoint: z.any().optional(), // W003: GuardianTaskRecoveryCheckpoint
  checkpointCommits: z.record(z.string(), z.string()).optional(), // W004-A
  checkpointPushes: z.record(z.string(), z.string()).optional(), // W004-B
  failureReason: z.string().optional(), // W004-A FINAL
  currentTaskBaseHeadSha: z.string().optional(), // W004-A FINAL
  activeElapsedMs: z.number().optional(), // W004-B
  activeSegmentStartedAt: z.number().optional(), // W004-B
  completionReason: z
    .enum(['ALL_TASKS_COMPLETED', 'SOFT_LIMIT', 'HARD_LIMIT', 'MAX_TASKS'])
    .optional(), // W004-B
  suspensionReason: z.enum(['USER_PAUSED']).optional(), // W005-B
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

  constructor(config: WorkSessionRuntimeConfig) {
    // W004-B: invalid limits 必须在任何 TaskRunner / provider / git mutation 前 fail-fast
    validateWorkSessionLimits(config.definition.limits)
    this.config = config
    // runId = sessionId，简化 identity 管理
    this.workflowId = `work-session-${config.definition.id}`

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
    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) {
      throw new Error(`Workflow ${this.workflowId} not found after registration`)
    }

    const persisted = await workflow.getWorkflowRunById(this.config.definition.id, {
      withNestedWorkflows: false,
    })
    if (persisted === null) {
      return undefined
    }
    if (persisted.initialState === undefined) {
      throw new Error(`Persisted work session ${this.config.definition.id} has no workflow state`)
    }

    const parsed = WorkflowStateSchema.safeParse(persisted.initialState)
    if (!parsed.success) {
      throw new Error(`Persisted work session ${this.config.definition.id} has invalid workflow state`)
    }
    if (parsed.data.sessionId !== this.config.definition.id) {
      throw new Error(
        `Persisted work session identity mismatch: expected ${this.config.definition.id}, got ${parsed.data.sessionId}`,
      )
    }

    this.latestState = parsed.data
    this.pauseRequested = false
    this.stopAfterTaskRequested = parsed.data.stopAfterTaskRequested === true
    return this.convertWorkflowStateToDurableState(parsed.data)
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
      this.scheduleHumanRequiredNotification(durableState, false)
      return durableState
    } catch (error) {
      throw error
    }
  }

  async resume(resumeInput: ResumeInput): Promise<WorkSessionDurableState> {
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
      await run.resume({
        step: suspendedStep.path,
        resumeData: resumeInput,
      })

      // 返回 latestState（已通过 setState 更新）
      if (!this.latestState) {
        throw new Error('Workflow state was not updated during resume')
      }
      const durableState = this.convertWorkflowStateToDurableState(this.latestState)
      this.scheduleHumanRequiredNotification(
        durableState,
        resumeInput.decision !== undefined,
      )
      return durableState
    } catch (error) {
      throw error
    }
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
          if (currentState.currentTaskId !== task.id) {
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
                stopAfterTaskRequested: undefined,
                ...self.settleActiveTime(currentState),
                updatedAt: new Date().toISOString(),
              }
              await setState(limitState)
              self.latestState = limitState
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
          const runContext: WorkSessionTaskRunContext = {
            hardDeadlineAtMs: self.computeHardDeadlineAtMs(currentState),
            shouldPauseAutonomousWork: () => self.pauseRequested,
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
              const failedState: WorkflowState = {
                ...currentState,
                state: 'FAILED',
                failureReason,
                humanRequired: undefined,
                currentTaskCheckpoint: undefined,
                updatedAt: new Date().toISOString(),
              }
              await setState(failedState)
              self.latestState = failedState
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
              } catch (error) {
                // Git checkpoint execution failure → Session FAILED，不是 DECISION_REQUIRED
                const failureReason =
                  error instanceof Error ? error.message : String(error)
                // W004-B: push 失败但 local commit 已成功 → 保留 commitSha（partial success 可见），
                // checkpointPushes 无对应 entry，completedTaskIds 不包含本 Task。
                const partialCommitSha = error instanceof GitPushError ? error.commitSha : undefined
                const failedState: WorkflowState = {
                  ...currentState,
                  state: 'FAILED',
                  failureReason,
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
              currentTaskBaseHeadSha: undefined,
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              updatedAt: new Date().toISOString(),
            }
            await setState(completedState)
            currentState = completedState
            self.latestState = completedState

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

          if (result.status === 'PAUSED') {
            self.pauseRequested = false
            const pausedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: undefined,
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
            const suspendedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: result.humanRequired,
              humanRequiredGeneration: (currentState.humanRequiredGeneration ?? 0) + 1,
              suspensionReason: undefined,
              currentTaskCheckpoint: result.checkpoint, // W003: 持久化 checkpoint
              stopAfterTaskRequested: self.stopAfterTaskRequested || undefined,
              ...self.settleActiveTime(currentState), // W004-B: 结算 active time，暂停不计时
              updatedAt: new Date().toISOString(),
            }
            await setState(suspendedState)
            self.latestState = suspendedState

            // 调用 suspend，Mastra 会持久化当前状态
            return await suspend(
              { reason: result.humanRequired?.reason || 'HUMAN_REQUIRED' },
              { resumeLabel: 'human-decision' },
            )
          }

          if (result.status === 'FAILED') {
            const failedState: WorkflowState = {
              ...currentState,
              state: 'FAILED',
              humanRequired: undefined,
              currentTaskCheckpoint: undefined,
              ...self.settleActiveTime(currentState), // W004-B
              updatedAt: new Date().toISOString(),
            }
            await setState(failedState)
            self.latestState = failedState

            throw new Error(`Task ${task.id} failed: ${result.error || 'unknown error'}`)
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
          stopAfterTaskRequested: undefined,
          ...self.settleActiveTime(currentState), // W004-B: 结算最后 segment
          updatedAt: new Date().toISOString(),
        }
        await setState(finalState)
        self.latestState = finalState

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
    if (wfState.humanRequiredGeneration !== undefined) {
      result.humanRequiredGeneration = wfState.humanRequiredGeneration
    }
    if (wfState.lastNotificationAttemptGeneration !== undefined) {
      result.lastNotificationAttemptGeneration = wfState.lastNotificationAttemptGeneration
    }
    if (wfState.lastNotifiedHumanRequiredGeneration !== undefined) {
      result.lastNotifiedHumanRequiredGeneration = wfState.lastNotifiedHumanRequiredGeneration
    }
    // W003: 传递 checkpoint
    if (wfState.currentTaskCheckpoint) {
      result.currentTaskCheckpoint = wfState.currentTaskCheckpoint
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
    if (wfState.currentTaskBaseHeadSha !== undefined) {
      result.currentTaskBaseHeadSha = wfState.currentTaskBaseHeadSha
    }
    return result
  }

  async close(): Promise<void> {
    await this.notificationPromise
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

  private observeNotification(result: NotificationDeliveryResult): void {
    this.lastNotificationDelivery = result
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
