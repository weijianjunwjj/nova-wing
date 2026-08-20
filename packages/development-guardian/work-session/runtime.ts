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

export interface WorkSessionRuntimeConfig {
  definition: WorkSessionDefinition
  taskRunner: WorkSessionTaskRunner
  storageUrl: string
}

export interface ResumeInput {
  decision?: unknown
  approval?: boolean
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.latestState = initialState

    const workflow = this.mastra.getWorkflow(this.workflowId)
    if (!workflow) {
      throw new Error(`Workflow ${this.workflowId} not found after registration`)
    }

    try {
      // 使用 sessionId 作为 runId
      const run = await workflow.createRun({
        runId: this.config.definition.id,
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

          // 执行任务，传递 resumeData
          const result = await self.config.taskRunner.run(task, resumeData)

          if (result.status === 'COMPLETED') {
            // 任务完成，更新状态
            const completedState: WorkflowState = {
              ...currentState,
              completedTaskIds: [...currentState.completedTaskIds, task.id],
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
