import type { GuardianBrain, GuardianExecutor } from './ports.js'
import type {
  DelegationPacket,
  ExecutionReport,
  GuardianRunResult,
  GuardianTask,
} from './model.js'

export class GuardianStopError extends Error {
  constructor(
    message: string,
    public readonly task: GuardianTask,
  ) {
    super(message)
    this.name = 'GuardianStopError'
  }
}

function hasFailedVerification(report: ExecutionReport): boolean {
  return report.verificationResults.some((result) => result.status === 'failed')
}

function requireExecutablePacket(packet: DelegationPacket): void {
  if ((packet.verdict === 'proceed' || packet.verdict === 'revise') && packet.instructions.length === 0) {
    throw new Error('executable delegation packet must include instructions')
  }
}

export async function runGuardianTask(options: {
  task: GuardianTask
  brain: GuardianBrain
  executor: GuardianExecutor
}): Promise<GuardianRunResult> {
  const reports: ExecutionReport[] = []
  let task = { ...options.task }

  while (true) {
    if (task.iteration >= task.maxIterations) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: `max iterations reached: ${task.maxIterations}`,
      }
      return { task, reports }
    }

    task = { ...task, state: 'REVIEWING' }
    const packet = await options.brain.review({
      task,
      ...(task.lastReport === undefined ? {} : { report: task.lastReport }),
    })
    requireExecutablePacket(packet)
    task = { ...task, lastPacket: packet }

    if (packet.verdict === 'blocked') {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: packet.rationale ?? 'brain reported blocked',
      }
      return { task, reports }
    }

    if (packet.verdict === 'done') {
      if (task.lastReport !== undefined && hasFailedVerification(task.lastReport)) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete with failed deterministic verification',
        }
        return { task, reports }
      }
      task = { ...task, state: 'COMPLETED' }
      return { task, reports }
    }

    task = {
      ...task,
      state: 'EXECUTING',
      iteration: task.iteration + 1,
    }

    let report: ExecutionReport
    try {
      report = await options.executor.execute({ task, packet })
    } catch (error) {
      task = {
        ...task,
        state: 'FAILED',
        stopReason: error instanceof Error ? error.message : 'executor failed',
      }
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
      return { task, reports }
    }
  }
}
