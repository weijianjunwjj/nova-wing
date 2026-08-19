export type GuardianPhase =
  | 'PREPARING'
  | 'REVIEWING'
  | 'EXECUTING'
  | 'RECOVERING'
  | 'VERIFYING'
  | 'FINAL_REVIEW'
  | 'COMPLETED'
  | 'HUMAN_REQUIRED'
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
    bounded: boolean
  }
  verification?: {
    command: string
    status: 'running' | 'passed' | 'failed'
    durationMs?: number
  }
}

export type GuardianProgressObserver = (event: GuardianProgressEvent) => void
