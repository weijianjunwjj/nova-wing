export const HOST_SNAPSHOT_LIFECYCLE_PHASES = [
  'stop-new-requests',
  'drain-active-operations',
  'close-writers',
  'open-dedicated-connection',
  'export-or-restore-candidate',
  'validate-component-manifests',
  'validate-host-manifest',
  'validate-components-after-restore',
  'atomically-replace-or-declare-success',
  'reopen-runtime-connections',
] as const

export type HostSnapshotLifecyclePhase = (typeof HOST_SNAPSHOT_LIFECYCLE_PHASES)[number]

export interface HostSnapshotLifecycleAdapter<DedicatedConnection, RestoreCandidate> {
  stopNewRequests(): Promise<void>
  drainActiveOperations(): Promise<void>
  closeAllWriterConnections(): Promise<void>
  openDedicatedConnection(mode: 'read-only-export' | 'isolated-restore'): Promise<DedicatedConnection>
  closeDedicatedConnection(connection: DedicatedConnection): Promise<void>
  createRestoreCandidate(): Promise<RestoreCandidate>
  atomicallyReplaceValidatedCandidate(candidate: RestoreCandidate): Promise<void>
  discardRestoreCandidate(candidate: RestoreCandidate): Promise<void>
  reopenRuntimeConnections(): Promise<void>
}

export interface HostSnapshotLifecycleGuarantees {
  readonly activeWritersDuringSnapshot: false
  readonly exportUsesExplicitConsistencyBoundary: true
  readonly restoreTargetsTemporaryDatabase: true
  readonly schemasBootstrapBeforeRows: true
  readonly replacementRequiresAllValidations: true
  readonly partialInPlaceProductionRestore: false
}

export const HOST_SNAPSHOT_LIFECYCLE_GUARANTEES: HostSnapshotLifecycleGuarantees = {
  activeWritersDuringSnapshot: false,
  exportUsesExplicitConsistencyBoundary: true,
  restoreTargetsTemporaryDatabase: true,
  schemasBootstrapBeforeRows: true,
  replacementRequiresAllValidations: true,
  partialInPlaceProductionRestore: false,
}
