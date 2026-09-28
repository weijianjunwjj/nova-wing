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
  | 'BRAIN_CONVERSATION_MISMATCH'
  | 'BRAIN_RESPONSE_INVALID'

export type GuardianBrainOperationKind = 'normal' | 'retry' | 'rotation'

export interface GuardianBrainTransportMetrics {
  promptChars: number
  inputMode: 'normal' | 'big-paste' | 'unknown'
  composerSettleMs?: number | undefined
  sendReadyWaitMs?: number | undefined
  pasteCount: number
  submitCount: number
  submissionReached: boolean
  reusedSubmission: boolean
  /** Whether this browser submission reused the same conversation or created a fresh one. */
  conversationReuse: 'same' | 'fresh' | 'unknown'
  /** True only when persisted submission state matched the current canonical conversation. */
  conversationIdentityMatched: boolean
  /** Monotonic browser submission generation within one logical Brain operation. */
  submissionGeneration: number
  /** Non-sensitive hash of the canonical/provisional conversation identity. */
  conversationIdentityHash?: string | undefined
}

export interface GuardianBrainAttempt {
  attempt: number
  operationKind: GuardianBrainOperationKind
  startedAt: string
  durationMs: number
  outcome: 'success' | 'failure'
  failureType: GuardianBrainFailureType | null
  fingerprint: string | null
  timeout: boolean
  /** Safe composer telemetry only; never prompt text or provider output. */
  transport?: GuardianBrainTransportMetrics | undefined
}

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
  /** Safe provider-operation facts for this one Brain Review; never raw provider output. */
  attemptTimeline?: readonly GuardianBrainAttempt[]
}

export type DelegationVerdict = 'proceed' | 'revise' | 'blocked' | 'done'

export interface DelegationPacket {
  verdict: DelegationVerdict
  goal: string
  instructions: readonly string[]
  constraints: readonly string[]
  verification: readonly string[]
  /** Golden implementation packets defer every deterministic verifier, including baseline diff checks, to VERIFY. */
  deferVerification?: boolean
  doNotDo: readonly string[]
  rationale?: string
}

export type VerificationStatus = 'passed' | 'failed' | 'skipped'

export interface VerificationExecutionStep {
  stepId: string
  command: string
  /** Repository-relative working directory. Legacy callers omit the step and keep repo-root behavior. */
  cwd: string
  originalCommand?: string
  admission?: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'UNSUPPORTED'
  admissionReason?: string
  /** Repository-relative package manifest used to prove a safe npm-script normalization. */
  sourceManifest?: string
  sourceScript?: string
  sourceFingerprint?: string
}

export type VerificationFailureClassification =
  | 'CODE_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'VERIFIER_CONFIGURATION_FAILURE'
  | 'UNRELATED_TEST_FAILURE'
  | 'EVIDENCE_MISSING'
  /** Legacy persisted values remain readable; new evidence uses the v0.2.7 names above. */
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
  stepId?: string
  command?: string
  cwd?: string
  admission?: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'UNSUPPORTED'
  status: VerificationStatus
  details?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
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

export interface WorkspaceMutationFailure {
  tool: string
  code: 'MUTATION_REJECTED'
}

export interface WorkspaceSatisfiedEvidence {
  reason: string
  files: readonly { path: string; sha256: string }[]
}

export interface WorkspaceExecutionEvidence {
  mutationFailures: readonly WorkspaceMutationFailure[]
  alreadySatisfied?: WorkspaceSatisfiedEvidence
}

export interface ExecutionReport {
  /** Host-owned execution outcome; does not replace verification or review. */
  workspaceExecution?: WorkspaceExecutionEvidence & {
    outcome: 'IMPLEMENTED' | 'ALREADY_SATISFIED' | 'EXECUTION_BLOCKED'
  }
  execution?: import('./coding-executor-config.js').CodingExecutionMetadata
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
  /** Workspace-relative rules; `.` denotes repository root. Legacy absolute rules are adapted at the Executor boundary. */
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
  /**
   * Runtime-owned, one-shot fact for the current Guardian run. It tells the
   * Reviewer that one exact deterministic verifier may proceed; it is neither
   * user_resume_input nor an Executor tool capability and is never checkpointed.
   */
  approvedVerificationCommand?: string
}

export interface GuardianRunResult {
  task: GuardianTask
  reports: readonly ExecutionReport[]
  /** Known failure boundary; avoids reconstructing source from provider text. */
  failureStage?: 'EXECUTOR' | 'VERIFICATION'
}
