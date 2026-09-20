export type GuardianState =
  | 'READY'
  | 'PLANNING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'NEED_HUMAN'
  | 'FAILED'

export type ReviewVerdict = 'proceed' | 'revise' | 'blocked' | 'done'

export interface TaskSpec {
  id: string
  goal: string
  workspace: string
  acceptance: string[]
  allowedScope?: string[]
  forbiddenScope?: string[]
  verificationCommands?: string[]
  maxIterations?: number
}

export interface DelegationPacket {
  verdict: ReviewVerdict
  goal: string
  instructions: string[]
  issues: string[]
  verification: string[]
  doNotDo: string[]
  reason?: string
}

export interface ExecutionReport {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
}

export interface VerificationReport {
  ok: boolean
  commands: Array<{
    command: string
    exitCode: number | null
    stdout: string
    stderr: string
  }>
}

export interface GuardianResult {
  state: GuardianState
  iterations: number
  lastReview?: DelegationPacket
  reason?: string
}
