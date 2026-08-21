/**
 * Fake Task Runner for W001 testing
 * 用于模拟不同的任务执行结果，无需真实 Guardian
 */

import type {
  WorkSessionTaskRunner,
  WorkSessionTaskResult,
} from './task-runner.js'
import type { WorkSessionTask } from './model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'

export type FakeTaskBehavior =
  | { type: 'COMPLETED' }
  | { type: 'HUMAN_REQUIRED'; category: string; reason: string }
  | { type: 'FAILED'; error: string }
  | { type: 'CONDITIONAL'; checkResumeData: (resumeData: any) => FakeTaskBehavior }

export class FakeTaskRunner implements WorkSessionTaskRunner {
  private executionCounts: Map<string, number> = new Map()
  private behaviors: Map<string, FakeTaskBehavior>

  constructor(behaviors: Record<string, FakeTaskBehavior>) {
    this.behaviors = new Map(Object.entries(behaviors))
  }

  async run(
    task: WorkSessionTask,
    resumeData?: any,
    _checkpoint?: GuardianTaskRecoveryCheckpoint,
  ): Promise<WorkSessionTaskResult> {
    const count = this.executionCounts.get(task.id) ?? 0
    this.executionCounts.set(task.id, count + 1)

    let behavior = this.behaviors.get(task.id)
    if (!behavior) {
      return {
        status: 'FAILED',
        error: `no behavior defined for task ${task.id}`,
      }
    }

    // 如果是 CONDITIONAL，根据 resumeData 动态决定行为
    if (behavior.type === 'CONDITIONAL') {
      behavior = behavior.checkResumeData(resumeData)
    }

    // 模拟异步执行
    await new Promise((resolve) => setTimeout(resolve, 10))

    switch (behavior.type) {
      case 'COMPLETED':
        return {
          status: 'COMPLETED',
          summary: `Task ${task.id} completed`,
        }
      case 'HUMAN_REQUIRED':
        return {
          status: 'HUMAN_REQUIRED',
          humanRequired: {
            category: behavior.category,
            reason: behavior.reason,
          },
        }
      case 'FAILED':
        return {
          status: 'FAILED',
          error: behavior.error,
        }
      default:
        throw new Error(`Unknown behavior type`)
    }
  }

  getExecutionCount(taskId: string): number {
    return this.executionCounts.get(taskId) ?? 0
  }

  resetExecutionCounts(): void {
    this.executionCounts.clear()
  }

  setBehavior(taskId: string, behavior: FakeTaskBehavior): void {
    this.behaviors.set(taskId, behavior)
  }
}
