export {
  inspectNovaWingMigration,
  migrateNovaWing,
  NOVAWING_SCHEMA_VERSION,
} from './migrations/index.js'
export type { NovaWingMigrationDescriptor } from './migrations/index.js'
export {
  createInjectedSqliteNovaWingStore,
  openSqliteNovaWingStore,
} from './sqlite-nova-wing-store.js'
export type {
  InjectedConnectionMigrationMode,
  InjectedSqliteNovaWingStoreOptions,
  OpenSqliteNovaWingStoreOptions,
  SqliteNovaWingStore,
  SqliteNovaWingStoreOptions,
} from './sqlite-nova-wing-store.js'
export {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  NOVAWING_AUTHORITATIVE_TABLES,
} from './snapshot/registry.js'
export type {
  NovaWingAuthoritativeTableDescriptor,
  NovaWingAuthoritativeTableName,
} from './snapshot/registry.js'
export {
  NOVAWING_SNAPSHOT_FORMAT,
  NOVAWING_SNAPSHOT_VERSION,
  NovaWingSnapshotError,
  validateNovaWingSnapshotManifest,
  verifyNovaWingAfterSnapshotRestore,
  verifyNovaWingBeforeSnapshotExport,
} from './snapshot/contract.js'
export type {
  NovaWingSnapshotErrorCode,
  NovaWingSnapshotManifest,
  NovaWingSnapshotTableManifest,
} from './snapshot/contract.js'
