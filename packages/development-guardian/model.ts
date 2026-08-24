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
  failureStage?: 'EXECUTOR'
}
