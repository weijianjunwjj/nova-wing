export type GuardianTaskState =
  | 'READY'
  | 'EXECUTING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'HUMAN_REQUIRED'
  | 'FAILED'

export type DelegationVerdict = 'proceed' | 'revise' | 'blocked' | 'done'

export interface DelegationPacket {
  verdict: DelegationVerdict
  goal: string
  instructions: readonly string[]
  constraints: readonly string[]
  verification: readonly string[]
  doNotDo: readonly string[]
  rationale?: string
}

export type VerificationStatus = 'passed' | 'failed' | 'skipped'

export interface VerificationResult {
  name: string
  status: VerificationStatus
  details?: string
}

export interface ExecutionReport {
  summary: string
  changedFiles: readonly string[]
  commandsRun: readonly string[]
  verificationResults: readonly VerificationResult[]
  blockers: readonly string[]
  rawOutputRef?: string
  incompleteReason?: string
}

export interface GuardianTask {
  id: string
  goal: string
  state: GuardianTaskState
  iteration: number
  maxIterations: number
  constraints?: readonly string[]
  acceptanceCriteria?: readonly string[]
  doNotDo?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
  lastPacket?: DelegationPacket
  lastReport?: ExecutionReport
  stopReason?: string
}

export interface GuardianRunResult {
  task: GuardianTask
  reports: readonly ExecutionReport[]
}
