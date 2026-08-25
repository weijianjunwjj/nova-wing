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
    'ClaudeCodeExecutor',
    'EXECUTION_LEDGER_SCHEMA_VERSION',
    'ExecutionLedgerStore',
    'FakeTaskRunner',
    'GitCheckpointError',
    'GitPushError',
    'GuardianBrainInfrastructureError',
    'GuardianStopError',
    'GuardianWorkSessionTaskRunner',
    'LEGACY_PRE_EXISTING_DIRTY_REASON',
    'NativeGitBashUnavailableError',
    'NovaWingLaunchpad',
    'RemoteVerificationUnavailableError',
    'RetryableGuardianBrainError',
    'SmtpWorkSessionNotifier',
    'TEN_X_CHAT_PINNED_VERSION',
    'TenXChatBrain',
    'TenXChatBrainProtocolError',
    'WorkSessionRuntime',
    'adoptLegacyRecoveryCheckpoint',
    'adoptProductionLegacyWorkSession',
    'buildGuardianBrainPrompt',
    'classifyHumanRequired',
    'classifyWorkSessionFailure',
    'computeWorktreeFingerprint',
    'createDefaultTenXChatCommand',
    'createGuardianTask',
    'createNovaWingLaunchpad',
    'createProductionGitRunner',
    'createProductionWorkSessionUi',
    'createSmtpWorkSessionNotifierFromEnv',
    'createTenXChatProcessTransport',
    'defaultLocalSmtpSecretPath',
    'defaultTrustedConfigDirectory',
    'discoverTrustedWorkSessionConfigs',
    'executionLedgerPathFromStorageUrl',
    'finalizeCompletedTask',
    'findBrowserExecutable',
    'guardianBrainFailureFrom',
    'guardianShellCommand',
    'loadLocalSmtpSecrets',
    'normalizePath',
    'openLaunchpadInAppMode',
    'loadTrustedWorkSessionConfig',
    'normalizeAskBridgeDiagnostics',
    'parseDelegationPacket',
    'parseGitStatus',
    'pushCheckpointCommit',
    'readCurrentHeadSha',
    'readExecutionLedger',
    'recoverCheckpointPush',
    'resolveProductionSmtpEnvironment',
    'resolveWindowsGitBashExecutable',
    'runGuardianTask',
    'safeFailureMessage',
    'saveLocalSmtpSecrets',
    'smtpEnvironmentFrom',
    'validateSmtpSecrets',
    'verifyWorktreeCheckpoint',
    'validateTrustedWorkSessionConfig',
    'windowsGitBashCommand',
    'windowsGitBashShellContract',
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
