/* global console */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
)
const expectedSubpaths = [
  './core',
  './development-guardian',
  './host-snapshot',
  './sqlite',
  './testing',
]
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
  'nova-wing/core': ['NovaWingError', 'createNovaWingFacade', 'isNovaWingError'],
  'nova-wing/development-guardian': [
    'AskBridgeBrain',
    'BRAIN_REVIEW_BUDGET_EXHAUSTED_MESSAGE',
    'CONTROLLED_QUOTA_INJECTION_FLAG',
    'ClaudeCodeExecutor',
    'DEFAULT_BRAIN_REVIEW_ATTEMPT_TIMEOUT_MS',
    'DEFAULT_BRAIN_REVIEW_TOTAL_BUDGET_MS',
    'DependencyPreflightError',
    'EXECUTION_LEDGER_SCHEMA_VERSION',
    'EXPECTED_GIT_BASH_EXECUTABLE',
    'ExecutionLedgerStore',
    'FakeTaskRunner',
    'GitCheckpointError',
    'GitPushError',
    'GuardianBrainInfrastructureError',
    'GuardianStopError',
    'GuardianWorkSessionTaskRunner',
    'LEGACY_PRE_EXISTING_DIRTY_REASON',
    'MAX_COMPOSER_TASK_GOAL_CHARS',
    'MAX_TASK_BRIEF_CHARS',
    'MINIMUM_BRAIN_REVIEW_ATTEMPT_BUDGET_MS',
    'NativeGitBashUnavailableError',
    'NovaWingLaunchpad',
    'RemoteVerificationUnavailableError',
    'RetryableGuardianBrainError',
    'SmtpWorkSessionNotifier',
    'TASK_STATE_V2_VERSION',
    'TEN_X_CHAT_PINNED_VERSION',
    'TaskController',
    'V2ControllerTaskRunner',
    'TenXChatBrain',
    'TenXChatBrainProtocolError',
    'WorkSessionRuntime',
    'adoptLegacyRecoveryCheckpoint',
    'adoptProductionLegacyWorkSession',
    'assessRisk',
    'analyzeTaskBrief',
    'buildGuardianBrainPrompt',
    'buildVerificationResult',
    'classifyHumanRequired',
    'classifyWorkSessionFailure',
    'computeWorktreeFingerprint',
    'createAskBridgeCommandRunner',
    'createDefaultTenXChatCommand',
    'createGuardianTask',
    'createNovaWingLaunchpad',
    'createProductionGitRunner',
    'createProductionWorkSessionUi',
    'createTaskStateV2',
    'createStructuredHandoff',
    'createSmtpWorkSessionNotifierFromEnv',
    'createTenXChatProcessTransport',
    'defaultLocalSmtpSecretPath',
    'defaultStorageUrl',
    'defaultTrustedConfigDirectory',
    'deriveDisplayState',
    'deriveRecoverySummary',
    'discoverTrustedWorkSessionConfigs',
    'environmentVerificationFailure',
    'evidenceIsStale',
    'executionLedgerPathFromStorageUrl',
    'extractAskBridgeSubmissionMetrics',
    'finalizeCompletedTask',
    'findBrowserExecutable',
    'guardianBrainFailureFrom',
    'guardianShellCommand',
    'isExecutorProviderCredentialRecovery',
    'isTerminalWorkSessionState',
    'loadLocalSmtpSecrets',
    'loadTaskStateV2',
    'normalizePath',
    'openLaunchpadInAppMode',
    'loadTrustedWorkSessionConfig',
    'normalizeAskBridgeDiagnostics',
    'parseDelegationPacket',
    'parseGitStatus',
    'pendingVerificationCommand',
    'persistComposedTrustedWorkSessionConfig',
    'persistVerificationOutput',
    'pushCheckpointCommit',
    'readCurrentHeadSha',
    'readExecutionLedger',
    'reconcileTaskState',
    'redactSensitiveText',
    'recoverCheckpointPush',
    'requestControlledCodexQuotaExhaustion',
    'requireDependencyPreflightReady',
    'resolveAskBridgeExecutable',
    'resolveProductionSmtpEnvironment',
    'resolveWindowsGitBashExecutable',
    'selectAgent',
    'runGuardianTask',
    'runProductionDependencyPreflight',
    'SHELL_ENVIRONMENT_INVALID',
    'safeFailureMessage',
    'saveLocalSmtpSecrets',
    'smtpEnvironmentFrom',
    'terminateAskBridgeProcessTree',
    'validateSmtpSecrets',
    'verifyWorktreeCheckpoint',
    'validateTrustedWorkSessionConfig',
    'classifyRepairErrorCode',
    'createDeterministicRepairAgent',
    'createFileRepairAuditSink',
    'createWindowsToastRepairNotifier',
    'defaultRepairAuditPath',
    'isKnownMechanicalIssue',
    'LLM_REPAIRABLE_ISSUE_CODES',
    'normalizedCriterionIdentity',
    'parseEffectiveRepairContract',
    'validateMechanicalRepair',
    'REPAIR_DEFAULT_MODEL',
    'REPAIR_DEFAULT_REASONING_EFFORT',
    'REPAIR_DEFAULT_TIMEOUT_MS',
    'REPAIR_SYSTEM_PROMPT',
    'RepairProviderUnavailableError',
    'createCodexRepairModelRunner',
    'createLlmRepairAgent',
    'hasLlmRepairableIssue',
    'isCodexRepairRuntimeAvailable',
    'parseRepairProposalJson',
    'protectedVerifierCommands',
    'windowsGitBashCommand',
    'windowsGitBashShellContract',
    'LLM_RUNTIME_REPAIRABLE_REASON_CODES',
    'RUNTIME_REPAIR_AUDIT_EVENTS',
    'createDeterministicRuntimeRepairAgent',
    'createFileRuntimeRepairAuditSink',
    'createLlmRuntimeRepairAgent',
    'createRecordingRuntimeRepairAuditSink',
    'createRecordingRuntimeRepairNotifier',
    'createRuntimeRepairEngine',
    'createWindowsToastRuntimeRepairNotifier',
    'defaultRuntimeRepairAuditPath',
    'deriveRuntimeRepairReasonCode',
    'discoverIndependentReviewer',
    'hasLlmRuntimeRepairableReason',
    'isRuntimeRepairable',
    'parseLlmRuntimeRepairDraft',
    'runtimeRepairCompletionNotification',
    'runtimeRepairNotificationFrom',
    'validateRuntimeRepairProposal',
    'REVIEWER_ALLOWED_TOOLS',
    'REVIEWER_SYSTEM_PROMPT',
    'REVIEW_DEFAULT_MODEL',
    'REVIEW_DEFAULT_TIMEOUT_MS',
    'ReviewerRuntimeRegistry',
    'agentIdentityOf',
    'buildReviewPrompt',
    'classifyReviewerProviderFailure',
    'createCodexReviewerRuntime',
    'createDeepSeekReviewerRuntime',
    'createReviewDispatcher',
    'implementerProvidersOf',
    'isIndependentReviewerCandidate',
    'parseReviewVerdict',
    'refreshReviewerAvailability',
    'reviewerProviderOf',
    'trustedAgents',
    'validateReviewerIndependence',
    'REVIEW_DEFAULT_MAX_TURNS',
  ],
  'nova-wing/sqlite': [
    'NOVAWING_AUTHORITATIVE_TABLE_NAMES',
    'NOVAWING_AUTHORITATIVE_TABLES',
    'NOVAWING_SCHEMA_VERSION',
    'NOVAWING_SNAPSHOT_FORMAT',
    'NOVAWING_SNAPSHOT_VERSION',
    'NovaWingSnapshotError',
    'createInjectedSqliteNovaWingStore',
    'inspectNovaWingMigration',
    'migrateNovaWing',
    'openSqliteNovaWingStore',
    'validateNovaWingSnapshotManifest',
    'verifyNovaWingAfterSnapshotRestore',
    'verifyNovaWingBeforeSnapshotExport',
  ],
  'nova-wing/testing': ['FakeOfferFlowHost'],
  'nova-wing/host-snapshot': [
    'HOST_SNAPSHOT_LIFECYCLE_GUARANTEES',
    'HOST_SNAPSHOT_LIFECYCLE_PHASES',
    'HOST_SNAPSHOT_V3_FORMAT',
    'HOST_SNAPSHOT_V3_VERSION',
    'HostSnapshotError',
    'HostSnapshotRegistry',
    'createComponentSnapshotManifest',
    'createHostSnapshotV3Manifest',
    'createNovaWingSnapshotComponent',
    'createRegisteredHostSnapshotManifest',
    'digestSnapshotValue',
    'validateComponentSnapshotManifest',
    'validateHostSnapshotV3Manifest',
    'validateRegisteredHostSnapshotManifest',
    'verifyRegisteredComponentsAfterRestore',
  ],
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
