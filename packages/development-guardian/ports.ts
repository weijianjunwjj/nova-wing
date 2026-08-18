import type { DelegationPacket, ExecutionReport, GuardianTask } from './model.js'

export interface GuardianBrain {
  review(input: {
    task: GuardianTask
    report?: ExecutionReport
  }): Promise<DelegationPacket>
}

export interface GuardianExecutor {
  execute(input: {
    task: GuardianTask
    packet: DelegationPacket
  }): Promise<ExecutionReport>
}
