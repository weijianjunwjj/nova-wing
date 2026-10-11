
export {
  guardianShellCommand,
  NativeGitBashUnavailableError,
  resolveWindowsGitBashExecutable,
  windowsGitBashShellContract,
  windowsGitBashCommand,
} from './shell-contract.js'
export type {
  GuardianShellCommand,
  GuardianShellContractOptions,
  WindowsGitBashShellContract,
} from './shell-contract.js'
export { ClaudeCodeExecutor } from './claude-code-executor.js'
export type {
  ClaudeCodeExecutorOptions,
  ClaudeCodeTimingEvent,
  ClaudeCodeTimingPhase,
  GuardianCommandRequest,
  GuardianCommandResult,
  GuardianCommandRunner,
} from './claude-code-executor.js'
export type {
  DelegationPacket,
  DelegationVerdict,
  ExecutionReport,
  GuardianBrainFailure,
  GuardianBrainFailureCategory,
  GuardianBrainFailureType,
  GuardianBrainAttempt,
  GuardianBrainTransportMetrics,
  GuardianBrainOperationKind,
  GuardianRunResult,
  GuardianTask,
  GuardianTaskState,
  VerificationResult,
  VerificationFailureClassification,
  VerificationFailurePhase,
  VerificationFirstFailure,
  VerificationStatus,
} from './model.js'
export type { GuardianBrain, GuardianExecutor } from './ports.js'
export type {
  GuardianPhase,
  GuardianProgressEvent,
  GuardianProgressObserver,
  GuardianProgressStatus,
} from './progress.js'
export * from './work-session/index.js'
export {
  buildVerificationResult,
  environmentVerificationFailure,
  persistVerificationOutput,
} from './verification-evidence.js'

export { platformPaths, resolveHostArgumentPath, workspacePathKey } from './platform/paths.js'
export { pythonRuntime } from './platform/executables.js'
