export type GuardianTaskState =
  | 'READY'
  | 'EXECUTING'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'HUMAN_REQUIRED'
  | 'BRAIN_INFRASTRUCTURE_FAILED'
  | 'FAILED'

export type GuardianBrainFailureCategory =
  | 'CONFIGURATION'
  | 'TRANSPORT'
  | 'PROTOCOL'
  | 'RESPONSE'

export type GuardianBrainFailureType =
  | 'BRAIN_UNAVAILABLE'
  | 'BRAIN_TRANSPORT_FAILED'
  | 'BRAIN_CONFIGURATION_FAILED'
  | 'BRAIN_AUTH_REQUIRED'
  | 'BRAIN_RATE_LIMITED'
  | 'BRAIN_RESPONSE_INVALID'

/**
 * Provider-neutral Brain infrastructure failure. This is deliberately separate
 * from HUMAN_REQUIRED: no Reviewer decision exists when transport/configuration
 * did not complete.
 */
export interface GuardianBrainFailure {
  stage: 'BRAIN_REVIEW' | 'FINAL_REVIEW'
  /** Present for all newly-classified failures; optional only for legacy checkpoints. */
  failureType?: GuardianBrainFailureType
  /** Stable, redacted presentation text; optional only for legacy checkpoints. */
  safeMessage?: string
  category: GuardianBrainFailureCategory
  rootCause: string
  adapter: string
  requestedModel?: string
  requestedReasoning?: string
  availableOptions?: readonly string[]
  retryable: boolean
  degraded: boolean
  fingerprint: string
  /** Bounded, normalized local diagnostic; never an unbounded stderr dump. */
  rawError?: string
  attempt?: number
  timestamp?: string
  lastReliableCheckpoint?: string
  nextResumableAction?: string
  rawOutputRef?: string
}

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

export type VerificationFailureClassification =
  | 'CODE_VERIFICATION_FAILED'
  | 'ENVIRONMENT_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'REPOSITORY_DRIFT'
  | 'UNKNOWN'

export type VerificationFailurePhase =
  | 'setup/session fixture'
  | 'setup/module fixture'
  | 'setup/fixture'
  | 'collection'
  | 'import'
  | 'migration/bootstrap'
  | 'test'
  | 'unknown'

export interface VerificationFirstFailure {
  title: string
  exceptionType?: string
  /** Redacted and bounded; the complete redacted output lives at rawOutputRef. */
  tracebackSnippet: string
  phase: VerificationFailurePhase
}

export interface VerificationResult {
  name: string
  status: VerificationStatus
  details?: string
  exitCode?: number | null
  durationMs?: number
  firstFailure?: VerificationFirstFailure
  classification?: VerificationFailureClassification
  rawOutputRef?: string
  finalSummary?: string
  /** Number of distinct root-cause signatures after deterministic collapse. */
  rootCauseCount?: number
  /** Number of tests/items fanned out from the collapsed root cause. */
  affectedTests?: number
}

/**
 * 安全的 Permission Denial 证据
 * 从外部 Executor 输出中提取，必须做 redaction 和长度限制
 */
export interface PermissionDenialEvidence {
  tool?: string
  operation?: string
  summary: string
}

export interface ExecutionReport {
  summary: string
  changedFiles: readonly string[]
  commandsRun: readonly string[]
  verificationResults: readonly VerificationResult[]
  blockers: readonly string[]
  rawOutputRef?: string
  incompleteReason?: string
  permissionDenials?: readonly PermissionDenialEvidence[]
  executorCapabilities?: readonly string[]
  /**
   * Guardian 可在 Claude 执行后独立完成的 deterministic verification 命令。
   * 与 executorCapabilities 区分：这些不是给 Claude 的工具权限，
   * 而是 Guardian executor 自身能运行的验证命令（MVP allowlist）。
   * Reviewer 据此判断：denied verification command 不必由 Claude 直接执行。
   */
  deterministicVerificationCapabilities?: readonly string[]
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
  /** Present only when Brain infrastructure failed before a valid verdict. */
  brainFailure?: GuardianBrainFailure
  /**
   * W003: 本次 run() 是否携带并成功验证了 GuardianTaskRecoveryCheckpoint。
   * 这是 recovery continuation 的唯一 source of truth；
   * 不由 lastPacket / lastReport / sessionId / conversationUrl 推断。
   */
  recoveryContinuation?: boolean
  /**
   * W005-B: one trusted, explicit continuation input submitted by the user.
   * It never changes task boundaries or tool capabilities.
   */
  resumeInput?: {
    decision?: string
    approval?: boolean
  }
}

export interface GuardianRunResult {
  task: GuardianTask
  reports: readonly ExecutionReport[]
  /** Known failure boundary; avoids reconstructing source from provider text. */
  failureStage?: 'EXECUTOR' | 'VERIFICATION'
}
