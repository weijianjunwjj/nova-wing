export type GuardianPhase =
  | 'PREPARING'
  | 'REVIEWING'
  | 'EXECUTING'
  | 'RECOVERING'
  | 'VERIFYING'
  | 'FINAL_REVIEW'
  | 'COMPLETED'
  | 'HUMAN_REQUIRED'
  | 'BRAIN_INFRASTRUCTURE_FAILED'
  | 'FAILED'

export type GuardianProgressStatus = 'pending' | 'active' | 'completed' | 'failed'

export interface GuardianProgressEvent {
  phase: GuardianPhase
  status: GuardianProgressStatus
  iteration: number
  elapsedMs: number
  detail?: string
  sessionId?: string
  recovery?: {
    reason: string
    sessionId: string
    bounded: boolean
  }
  verification?: {
    command: string
    status: 'running' | 'passed' | 'failed'
    /** Stable position in the Executor verification list for this iteration. */
    index?: number
    durationMs?: number
    evidence?: import('./model.js').VerificationResult
  }
}

export type GuardianProgressObserver = (event: GuardianProgressEvent) => void
