/* global console */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
)
const expectedSubpaths = ["./development-guardian"]
if (JSON.stringify(Object.keys(packageJson.exports).sort()) !== JSON.stringify(expectedSubpaths)) {
  throw new Error('package exports must contain only the documented subpaths')
}
for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
  if (
    typeof conditions !== 'object' ||
    conditions === null ||
    !conditions.types.startsWith('./dist/') ||
    !conditions.import.startsWith('./dist/')
  ) {
    throw new Error(`${subpath} must resolve runtime and declarations from dist`)
  }
}

const expectedRuntimeExports = {
  "nova-wing/development-guardian": [
    "createDesktopRepairNotifier",
    "createDesktopRuntimeRepairNotifier",
    "createDesktopTaskRunNotifier",
    "platformPaths",
    "resolveHostArgumentPath",
    "workspacePathKey",
    "pythonRuntime",
    "CONTROLLED_QUOTA_INJECTION_FLAG",
    "ClaudeCodeExecutor",
    "DependencyPreflightError",
    "EXECUTION_LEDGER_SCHEMA_VERSION",
    "EXPECTED_GIT_BASH_EXECUTABLE",
    "ExecutionLedgerStore",
    "FakeTaskRunner",
    "GitCheckpointError",
    "GitPushError",
    "LEGACY_PRE_EXISTING_DIRTY_REASON",
    "MAX_COMPOSER_TASK_GOAL_CHARS",
    "MAX_TASK_BRIEF_CHARS",
    "NativeGitBashUnavailableError",
    "NovaWingLaunchpad",
    "RemoteVerificationUnavailableError",
    "SmtpWorkSessionNotifier",
    "TASK_STATE_V2_VERSION",
    "TaskController",
    "V2ControllerTaskRunner",
    "WorkSessionRuntime",
    "adoptLegacyRecoveryCheckpoint",
    "assessRisk",
    "analyzeTaskBrief",
    "buildVerificationResult",
    "canonicalVerificationFailure",
    "classifyWorkSessionFailure",
    "computeWorktreeFingerprint",
    "createNovaWingLaunchpad",
    "createProductionGitRunner",
    "createProductionWorkSessionUi",
    "createTaskStateV2",
    "createStructuredHandoff",
    "createSmtpWorkSessionNotifierFromEnv",
    "defaultLocalSmtpSecretPath",
    "defaultStorageUrl",
    "defaultTrustedConfigDirectory",
    "deriveDisplayState",
    "deriveRecoverySummary",
    "discoverTrustedWorkSessionConfigs",
    "environmentVerificationFailure",
    "evidenceIsStale",
    "executionLedgerPathFromStorageUrl",
    "finalizeCompletedTask",
    "findBrowserExecutable",
    "guardianShellCommand",
    "isExecutorProviderCredentialRecovery",
    "isTerminalWorkSessionState",
    "loadLocalSmtpSecrets",
    "loadTaskStateV2",
    "normalizePath",
    "openLaunchpadInAppMode",
    "loadTrustedWorkSessionConfig",
    "parseGitStatus",
    "persistComposedTrustedWorkSessionConfig",
    "persistVerificationOutput",
    "pushCheckpointCommit",
    "readCurrentHeadSha",
    "readExecutionLedger",
    "reconcileTaskState",
    "redactSensitiveText",
    "recoverCheckpointPush",
    "requestControlledCodexQuotaExhaustion",
    "requireDependencyPreflightReady",
    "resolveProductionSmtpEnvironment",
    "resolveWindowsGitBashExecutable",
    "selectAgent",
    "runProductionDependencyPreflight",
    "SHELL_ENVIRONMENT_INVALID",
    "safeFailureMessage",
    "saveLocalSmtpSecrets",
    "smtpEnvironmentFrom",
    "validateSmtpSecrets",
    "verifyWorktreeCheckpoint",
    "validateTrustedWorkSessionConfig",
    "classifyRepairErrorCode",
    "createDeterministicRepairAgent",
    "createFileRepairAuditSink",
    "createWindowsToastRepairNotifier",
    "defaultRepairAuditPath",
    "isKnownMechanicalIssue",
    "LLM_REPAIRABLE_ISSUE_CODES",
    "AUTO_REPAIRABLE_ISSUE_CODES",
    "AUTO_REPAIR_EXHAUSTED",
    "MAX_AUTO_REPAIR_CYCLES",
    "isAutoRepairableIssueSet",
    "NOTIFICATION_FAILURE_REASON",
    "NOTIFICATION_KINDS",
    "WINDOWS_TOAST_HOST",
    "buildWindowsToastCommand",
    "deliverNotificationToChannels",
    "invokeNotificationDelivery",
    "overallNotificationStatus",
    "supportsNotificationKind",
    "normalizedCriterionIdentity",
    "parseEffectiveRepairContract",
    "validateMechanicalRepair",
    "REPAIR_DEFAULT_MODEL",
    "REPAIR_DEFAULT_REASONING_EFFORT",
    "REPAIR_DEFAULT_TIMEOUT_MS",
    "REPAIR_SYSTEM_PROMPT",
    "RepairProviderUnavailableError",
    "createCodexRepairModelRunner",
    "createLlmRepairAgent",
    "hasLlmRepairableIssue",
    "isCodexRepairRuntimeAvailable",
    "parseRepairProposalJson",
    "protectedVerifierCommands",
    "windowsGitBashCommand",
    "windowsGitBashShellContract",
    "LLM_RUNTIME_REPAIRABLE_REASON_CODES",
    "RUNTIME_REPAIR_AUDIT_EVENTS",
    "createDeterministicRuntimeRepairAgent",
    "createFileRuntimeRepairAuditSink",
    "createLlmRuntimeRepairAgent",
    "createRecordingRuntimeRepairAuditSink",
    "createRecordingRuntimeRepairNotifier",
    "createRuntimeRepairEngine",
    "createWindowsToastRuntimeRepairNotifier",
    "defaultRuntimeRepairAuditPath",
    "deriveRuntimeRepairReasonCode",
    "discoverIndependentReviewer",
    "hasLlmRuntimeRepairableReason",
    "isRuntimeRepairable",
    "parseLlmRuntimeRepairDraft",
    "runtimeRepairCompletionNotification",
    "runtimeRepairNotificationFrom",
    "validateRuntimeRepairProposal",
    "REVIEWER_ALLOWED_TOOLS",
    "REVIEWER_SYSTEM_PROMPT",
    "REVIEW_DEFAULT_MODEL",
    "REVIEW_DEFAULT_TIMEOUT_MS",
    "ReviewerRuntimeRegistry",
    "agentIdentityOf",
    "buildReviewPrompt",
    "classifyReviewerProviderFailure",
    "createCodexReviewerRuntime",
    "createDeepSeekReviewerRuntime",
    "createReviewDispatcher",
    "implementerProvidersOf",
    "isIndependentReviewerCandidate",
    "parseReviewVerdict",
    "refreshReviewerAvailability",
    "reviewerProviderOf",
    "trustedAgents",
    "validateReviewerIndependence",
    "REVIEW_DEFAULT_MAX_TURNS",
    "ProviderHealthRegistry",
    "TaskEventLogV2",
    "TaskRunAnalyticsProjector",
    "TaskRunAnalyticsStore",
    "backfillTaskRunAnalytics",
    "combineWorkSessionNotifiers",
    "createWindowsTaskRunNotifier",
    "defaultTaskRunAnalyticsPath",
    "deriveProviderSwitches",
    "detectCyclicNoProgress",
    "dispatchMessage",
    "formatDurationZh",
    "projectTaskRun",
    "providerOf",
    "providerSwitchReasonCode",
    "renderChineseTaskRunReport",
    "repositoryFacts",
    "selectionReasonCode",
    "assessDirectPathEligibility",
    "bindingsFromVerificationPlan",
    "concreteRuntimeProvider",
    "phaseForAction",
    "phaseForHumanRequiredCategory",
    "planVerification",
    "resumeTargetForFailure",
    "resumeTargetForRuntimeFailure",
    "validateVerificationPlanAfterExecution",
    "verificationCommandsForEvidence",
    "verificationPlanApprovalSatisfied",
    "verificationPlanFingerprintValid",
    "GoldenPathTaskRunner",
    "assessGoldenPathEligibility",
    "assessGoldenVerification",
    "agentIdentity",
    "completionEvidence",
    "isConfirmedNoOp",
    "NO_OP_AUTO_RETRY"
  ]
}

for (const [specifier, expected] of Object.entries(expectedRuntimeExports)) {
  const module = await import(specifier)
  const actual = Object.keys(module).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${specifier} exposed unexpected runtime keys: ${actual.join(', ')}`)
  }
}

for (const forbidden of [
  'nova-wing/packages/core/src/index.js',
  'nova-wing/core/domain/errors',
  'nova-wing/packages/sqlite/src/sqlite-nova-wing-store.js',
  'nova-wing/sqlite/migrations/index',
  'nova-wing/host-snapshot/registry',
  'nova-wing/development-guardian/guardian',
]) {
  try {
    await import(forbidden)
    throw new Error(`deep package import unexpectedly succeeded: ${forbidden}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error
    }
  }
}

console.log(
  JSON.stringify({
    publicSubpaths: expectedSubpaths,
    rejectedDeepImports: 6,
    status: 'ok',
  }),
)
