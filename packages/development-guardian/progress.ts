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

export type ExecutionActivityKind =
  | 'CONTROLLER_PHASE_CHANGED'
  | 'PROVIDER_DISPATCHED'
  | 'PROVIDER_COMPLETED'
  | 'PROVIDER_FAILED'
  | 'VERIFIER_STARTED'
  | 'VERIFIER_COMPLETED'
  | 'REPOSITORY_CHANGED'
  | 'RUNTIME_REPAIR'

/** Observable tool/runtime fact only. Free-form model reasoning is deliberately absent. */
export interface ExecutionActivityFact {
  kind: ExecutionActivityKind
  provider?: string
  verifier?: string
  outcome?: 'PASSED' | 'FAILED' | 'COMPLETED'
  changedFileCount?: number
}

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
  activity?: ExecutionActivityFact
}

export type GuardianProgressObserver = (event: GuardianProgressEvent) => void
