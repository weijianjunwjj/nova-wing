/**
 * Guardian Work Session Adapter
 * W002 - 桥接 Guardian 和 Work Session
 */

import type { GuardianTask } from '../model.js'
import type { GuardianBrain, GuardianExecutor } from '../ports.js'
import { runGuardianTask } from '../guardian.js'
import type { WorkSessionTask, HumanRequired } from './model.js'
import type {
  WorkSessionTaskRunner,
  WorkSessionTaskResult,
} from './task-runner.js'

export interface GuardianTaskBuilderOptions {
  maxIterations?: number
  constraints?: readonly string[]
  acceptanceCriteria?: readonly string[]
  doNotDo?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
}

/**
 * 从 Work Session Task 构造 Guardian Task
 */
export function createGuardianTask(
  workSessionTask: WorkSessionTask,
  options: GuardianTaskBuilderOptions = {},
): GuardianTask {
  return {
    id: workSessionTask.id,
    goal: workSessionTask.goal,
    state: 'READY',
    iteration: 0,
    maxIterations: options.maxIterations ?? 10,
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    ...(options.acceptanceCriteria !== undefined ? { acceptanceCriteria: options.acceptanceCriteria } : {}),
    ...(options.doNotDo !== undefined ? { doNotDo: options.doNotDo } : {}),
    ...(options.allowedPaths !== undefined ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.forbiddenPaths !== undefined ? { forbiddenPaths: options.forbiddenPaths } : {}),
  }
}

/**
 * 分类 HumanRequired 类别
 */
export function classifyHumanRequired(task: GuardianTask): HumanRequired {
  const reason = task.stopReason ?? 'unknown'

  // Max iterations reached
  if (reason.includes('max iterations')) {
    return {
      category: 'STALLED',
      reason,
    }
  }

  // Pre-existing worktree / repo mismatch
  if (reason.includes('pre-existing changes') || reason.includes('worktree')) {
    return {
      category: 'REPO_DRIFT',
      reason,
    }
  }

  // Scope violation
  if (reason.includes('scope violation') || reason.includes('forbidden') || reason.includes('allowed scope')) {
    return {
      category: 'SAFETY_BLOCKED',
      reason,
    }
  }

  // Permission required (capability 不足)
  // 不依赖英文关键词，根据结构化证据判断
  if (
    task.lastReport?.permissionDenials !== undefined &&
    task.lastReport.permissionDenials.length > 0 &&
    task.lastReport.blockers.length === 0 &&
    task.lastPacket?.verdict === 'blocked'
  ) {
    return {
      category: 'PERMISSION_REQUIRED',
      reason,
    }
  }

  // Verification 需要额外授权
  if (reason.includes('verification') && reason.includes('approval')) {
    return {
      category: 'PERMISSION_REQUIRED',
      reason,
    }
  }

  // 默认为需要人决策
  return {
    category: 'DECISION_REQUIRED',
    reason,
  }
}

export interface GuardianWorkSessionTaskRunnerOptions {
  brain: GuardianBrain
  createExecutor: (task: WorkSessionTask, resumeData?: unknown) => GuardianExecutor
  createGuardianTask?: (task: WorkSessionTask, resumeData?: unknown) => GuardianTask
  taskBuilder?: GuardianTaskBuilderOptions
}

/**
 * Guardian Work Session Task Runner
 * 桥接 runGuardianTask 和 Work Session Runtime
 */
export class GuardianWorkSessionTaskRunner implements WorkSessionTaskRunner {
  constructor(private readonly options: GuardianWorkSessionTaskRunnerOptions) {}

  async run(
    workSessionTask: WorkSessionTask,
    resumeData?: any,
  ): Promise<WorkSessionTaskResult> {
    // 从 Work Session Task 构造 Guardian Task
    const guardianTask = this.options.createGuardianTask
      ? this.options.createGuardianTask(workSessionTask, resumeData)
      : createGuardianTask(workSessionTask, this.options.taskBuilder)

    // 为每个 Work Session Task 创建新的 Executor instance
    const executor = this.options.createExecutor(workSessionTask, resumeData)

    // 运行 Guardian
    const result = await runGuardianTask({
      task: guardianTask,
      brain: this.options.brain,
      executor,
    })

    // 映射结果
    if (result.task.state === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        ...(result.task.lastReport?.summary !== undefined
          ? { summary: result.task.lastReport.summary }
          : {}),
      }
    }

    if (result.task.state === 'FAILED') {
      return {
        status: 'FAILED',
        ...(result.task.stopReason !== undefined
          ? { error: result.task.stopReason }
          : {}),
      }
    }

    if (result.task.state === 'HUMAN_REQUIRED') {
      return {
        status: 'HUMAN_REQUIRED',
        ...(result.task.lastReport?.summary !== undefined
          ? { summary: result.task.lastReport.summary }
          : {}),
        humanRequired: classifyHumanRequired(result.task),
      }
    }

    // 不应该到达这里
    return {
      status: 'FAILED',
      error: `unexpected Guardian state: ${result.task.state}`,
    }
  }
}
