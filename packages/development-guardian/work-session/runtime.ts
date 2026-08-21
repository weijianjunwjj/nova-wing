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
} from './model.js'
import type { WorkSessionTaskRunner } from './task-runner.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import {
  finalizeCompletedTask,
  readCurrentHeadSha,
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
}

export interface ResumeInput {
  decision?: unknown
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
  currentTaskCheckpoint: z.any().optional(), // W003: GuardianTaskRecoveryCheckpoint
  checkpointCommits: z.record(z.string(), z.string()).optional(), // W004-A
  failureReason: z.string().optional(), // W004-A FINAL
  currentTaskBaseHeadSha: z.string().optional(), // W004-A FINAL
  createdAt: z.string(),
  updatedAt: z.string(),
})

type WorkflowState = z.infer<typeof WorkflowStateSchema>

export class WorkSessionRuntime {
  private mastra: Mastra
  private config: WorkSessionRuntimeConfig
  private workflowId: string
  private latestState?: WorkflowState

  constructor(config: WorkSessionRuntimeConfig) {
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

  async start(): Promise<WorkSessionDurableState> {
    const initialState: WorkflowState = {
      sessionId: this.config.definition.id,
      state: 'RUNNING',
      currentTaskIndex: 0,
      currentTaskId: null,
      completedTaskIds: [],
      checkpointCommits: {},
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
      return this.convertWorkflowStateToDurableState(this.latestState)
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
      return this.convertWorkflowStateToDurableState(this.latestState)
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
        decision: z.any().optional(),
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

        // 从当前 task index 开始
        for (let i = currentState.currentTaskIndex; i < tasks.length; i++) {
          const task = tasks[i]!

          // 如果这个任务已经完成，跳过（这是 Mastra 恢复语义的核心）
          if (currentState.completedTaskIds.includes(task.id)) {
            continue
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
          const checkpoint = currentState.currentTaskCheckpoint
          const result = await self.config.taskRunner.run(task, resumeData, checkpoint)

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
              } catch (error) {
                // Git checkpoint execution failure → Session FAILED，不是 DECISION_REQUIRED
                const failureReason =
                  error instanceof Error ? error.message : String(error)
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
              humanRequired: undefined,
              currentTaskCheckpoint: undefined,
              currentTaskBaseHeadSha: undefined,
              updatedAt: new Date().toISOString(),
            }
            await setState(completedState)
            currentState = completedState
            self.latestState = completedState
            continue
          }

          if (result.status === 'HUMAN_REQUIRED') {
            // 需要人工介入，suspend workflow
            const suspendedState: WorkflowState = {
              ...currentState,
              state: 'SUSPENDED',
              humanRequired: result.humanRequired,
              currentTaskCheckpoint: result.checkpoint, // W003: 持久化 checkpoint
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
              updatedAt: new Date().toISOString(),
            }
            await setState(failedState)
            self.latestState = failedState

            throw new Error(`Task ${task.id} failed: ${result.error || 'unknown error'}`)
          }
        }

        // 所有任务完成
        const finalState: WorkflowState = {
          ...currentState,
          state: 'COMPLETED',
          currentTaskId: null,
          humanRequired: undefined,
          currentTaskCheckpoint: undefined,
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
    // W003: 传递 checkpoint
    if (wfState.currentTaskCheckpoint) {
      result.currentTaskCheckpoint = wfState.currentTaskCheckpoint
    }
    // W004-A: 传递 checkpoint commits
    if (wfState.checkpointCommits !== undefined) {
      result.checkpointCommits = wfState.checkpointCommits
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
