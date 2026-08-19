/**
 * Work Session Runtime with Durable State Persistence
 * W001 持久化骨架实现 - 使用 LibSQL 直接存储状态
 */

import { LibSQLStore } from '@mastra/libsql'
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

const STATE_TABLE = 'work_session_states'

export class WorkSessionRuntime {
  private storage: LibSQLStore
  private config: WorkSessionRuntimeConfig
  private sessionId: string

  constructor(config: WorkSessionRuntimeConfig) {
    this.config = config
    this.sessionId = config.definition.id

    // 初始化 LibSQL 持久化存储
    this.storage = new LibSQLStore({
      id: `work-session-${this.sessionId}`,
      url: config.storageUrl,
    })
  }

  async start(): Promise<WorkSessionDurableState> {
    await this.ensureStateTable()

    const initialState: WorkSessionDurableState = {
      sessionId: this.sessionId,
      state: 'RUNNING',
      currentTaskIndex: 0,
      currentTaskId: null,
      completedTaskIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    await this.persistState(initialState)
    return await this.executeTasksSerially(initialState)
  }

  async resume(_resumeInput: ResumeInput): Promise<WorkSessionDurableState> {
    await this.ensureStateTable()

    // 从持久化存储加载状态
    const persistedState = await this.loadState()
    if (!persistedState) {
      throw new Error('No persisted state found to resume from')
    }

    // 更新状态为 RUNNING
    const resumeState: WorkSessionDurableState = {
      ...persistedState,
      state: 'RUNNING',
      updatedAt: new Date(),
    }

    await this.persistState(resumeState)
    return await this.executeTasksSerially(resumeState)
  }

  private async executeTasksSerially(
    state: WorkSessionDurableState,
  ): Promise<WorkSessionDurableState> {
    const tasks = this.config.definition.tasks
    const executedSet = new Set(state.completedTaskIds)

    try {
      // 从当前 task index 开始（支持 resume）
      for (let i = state.currentTaskIndex; i < tasks.length; i++) {
        const task = tasks[i]!

        // 如果这个任务已经完成，跳过
        if (executedSet.has(task.id)) {
          continue
        }

        state.currentTaskIndex = i
        state.currentTaskId = task.id
        state.updatedAt = new Date()
        await this.persistState(state)

        const result = await this.config.taskRunner.run(task)

        if (result.status === 'COMPLETED') {
          executedSet.add(task.id)
          state.completedTaskIds = Array.from(executedSet)
          state.updatedAt = new Date()
          await this.persistState(state)
          continue
        }

        if (result.status === 'HUMAN_REQUIRED') {
          state.state = 'SUSPENDED'
          if (result.humanRequired) {
            state.humanRequired = result.humanRequired
          }
          state.updatedAt = new Date()
          await this.persistState(state)
          return state
        }

        if (result.status === 'FAILED') {
          state.state = 'FAILED'
          state.updatedAt = new Date()
          await this.persistState(state)
          throw new Error(`Task ${task.id} failed: ${result.error}`)
        }
      }

      state.state = 'COMPLETED'
      state.currentTaskId = null
      state.updatedAt = new Date()
      await this.persistState(state)
      return state
    } catch (error) {
      // 确保错误状态被持久化
      if (state.state !== 'SUSPENDED' && state.state !== 'FAILED') {
        state.state = 'FAILED'
        state.updatedAt = new Date()
        await this.persistState(state)
      }
      throw error
    }
  }

  private async ensureStateTable(): Promise<void> {
    await this.storage.init()

    // 创建状态表（如果不存在）
    const client = (this.storage as any).client
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        current_task_index INTEGER NOT NULL,
        current_task_id TEXT,
        completed_task_ids TEXT NOT NULL,
        human_required TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  private async persistState(state: WorkSessionDurableState): Promise<void> {
    const client = (this.storage as any).client
    await client.execute({
      sql: `
        INSERT OR REPLACE INTO ${STATE_TABLE} (
          session_id,
          state,
          current_task_index,
          current_task_id,
          completed_task_ids,
          human_required,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        state.sessionId,
        state.state,
        state.currentTaskIndex,
        state.currentTaskId || null,
        JSON.stringify(state.completedTaskIds),
        state.humanRequired ? JSON.stringify(state.humanRequired) : null,
        state.createdAt.toISOString(),
        state.updatedAt.toISOString(),
      ],
    })
  }

  private async loadState(): Promise<WorkSessionDurableState | null> {
    const client = (this.storage as any).client
    const result = await client.execute({
      sql: `SELECT * FROM ${STATE_TABLE} WHERE session_id = ?`,
      args: [this.sessionId],
    })

    if (!result.rows || result.rows.length === 0) {
      return null
    }

    const row = result.rows[0] as any
    return {
      sessionId: row.session_id as string,
      state: row.state as any,
      currentTaskIndex: row.current_task_index as number,
      currentTaskId: row.current_task_id as string | null,
      completedTaskIds: JSON.parse(row.completed_task_ids as string),
      humanRequired: row.human_required ? JSON.parse(row.human_required as string) : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }
  }

  async close(): Promise<void> {
    await this.storage.close()
  }
}

