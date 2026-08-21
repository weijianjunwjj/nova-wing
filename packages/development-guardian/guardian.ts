import type { GuardianBrain, GuardianExecutor } from './ports.js'
import type {
  DelegationPacket,
  ExecutionReport,
  GuardianRunResult,
  GuardianTask,
} from './model.js'
import type { GuardianProgressObserver, GuardianProgressEvent } from './progress.js'

export class GuardianStopError extends Error {
  constructor(
    message: string,
    public readonly task: GuardianTask,
  ) {
    super(message)
    this.name = 'GuardianStopError'
  }
}

function hasNonPassingVerification(report: ExecutionReport): boolean {
  return report.verificationResults.some((result) => result.status !== 'passed')
}

function requireExecutablePacket(packet: DelegationPacket): void {
  if ((packet.verdict === 'proceed' || packet.verdict === 'revise') && packet.instructions.length === 0) {
    throw new Error('executable delegation packet must include instructions')
  }
}

function mergeUnique(...groups: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))]
}

function enforceTaskConstraints(task: GuardianTask, packet: DelegationPacket): DelegationPacket {
  return {
    ...packet,
    goal: task.goal,
    constraints: mergeUnique(task.constraints, packet.constraints),
    doNotDo: mergeUnique(task.doNotDo, packet.doNotDo),
  }
}

export async function runGuardianTask(options: {
  task: GuardianTask
  brain: GuardianBrain
  executor: GuardianExecutor
  onProgress?: GuardianProgressObserver
  /**
   * W004-B: 纯 additive optional hook。返回 true 时停止当前 Guardian autonomous loop，
   * 不再启动下一 provider operation（Reviewer / Executor），并以
   * WORK_SESSION_HARD_LIMIT_REACHED marker 进入 HUMAN_REQUIRED。
   * 未提供时现有 behavior 100% 不变。
   */
  shouldStopAutonomousWork?: () => boolean
}): Promise<GuardianRunResult> {
  const reports: ExecutionReport[] = []
  let task = { ...options.task }
  const startedAt = performance.now()

  const emitProgress = (
    phase: GuardianProgressEvent['phase'],
    status: GuardianProgressEvent['status'],
    detail?: string,
  ): void => {
    options.onProgress?.({
      phase,
      status,
      iteration: task.iteration,
      elapsedMs: performance.now() - startedAt,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** W004-B: hard boundary 到点 → HUMAN_REQUIRED + 精确 stop marker */
  const stopForHardLimit = (): boolean => {
    if (options.shouldStopAutonomousWork?.() !== true) {
      return false
    }
    task = {
      ...task,
      state: 'HUMAN_REQUIRED',
      stopReason: 'WORK_SESSION_HARD_LIMIT_REACHED',
    }
    emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
    return true
  }

  emitProgress('PREPARING', 'completed')

  while (true) {
    // W004-B checkpoint A：每次开始新的 Brain review 前。绝不 kill 正在 mutation 的 process。
    if (stopForHardLimit()) {
      return { task, reports }
    }

    if (task.iteration >= task.maxIterations) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: `max iterations reached: ${task.maxIterations}`,
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    task = { ...task, state: 'REVIEWING' }
    const reviewPhase = task.lastReport === undefined ? 'REVIEWING' : 'FINAL_REVIEW'
    emitProgress(reviewPhase, 'active')
    let packet: DelegationPacket
    try {
      packet = await options.brain.review({
        task,
        ...(task.lastReport === undefined ? {} : { report: task.lastReport }),
      })
      requireExecutablePacket(packet)
      emitProgress(reviewPhase, 'completed')
    } catch (error) {
      emitProgress(reviewPhase, 'failed', error instanceof Error ? error.message : String(error))
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: `brain review failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }
    task = { ...task, lastPacket: packet }

    if (packet.verdict === 'blocked') {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: packet.rationale ?? 'brain reported blocked',
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    if (packet.verdict === 'done') {
      if (task.lastReport === undefined) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete before any execution evidence',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      if (task.lastReport.verificationResults.length === 0) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete without deterministic verification evidence',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      if (hasNonPassingVerification(task.lastReport)) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete with non-passing deterministic verification',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      task = { ...task, state: 'COMPLETED' }
      delete task.stopReason
      emitProgress('COMPLETED', 'completed')
      return { task, reports }
    }

    // W004-B checkpoint B：Reviewer 已返回、但开始新的 Executor execute 前。
    // verdict 为 proceed/revise（blocked/done 已在上方 return），此处到点则不再启动 Executor。
    if (stopForHardLimit()) {
      return { task, reports }
    }

    const executionPacket = enforceTaskConstraints(task, packet)
    task = {
      ...task,
      state: 'EXECUTING',
      iteration: task.iteration + 1,
      lastPacket: executionPacket,
    }

    emitProgress('EXECUTING', 'active')
    let report: ExecutionReport
    try {
      report = await options.executor.execute({ task, packet: executionPacket })
      emitProgress('EXECUTING', 'completed')
    } catch (error) {
      emitProgress('EXECUTING', 'failed', error instanceof Error ? error.message : String(error))
      task = {
        ...task,
        state: 'FAILED',
        stopReason: error instanceof Error ? error.message : 'executor failed',
      }
      emitProgress('FAILED', 'completed', task.stopReason)
      return { task, reports }
    }

    reports.push(report)
    task = { ...task, lastReport: report }

    if (report.blockers.length > 0) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: report.blockers.join('; '),
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    // 如果有 incompleteReason 但没有 blockers，重新进入 REVIEWING
    // 让 Brain 根据当前进展判断是否 revise
    if (report.incompleteReason !== undefined) {
      emitProgress('EXECUTING', 'completed', report.incompleteReason)
      // 继续循环，重新进入 REVIEWING
      continue
    }
  }
}