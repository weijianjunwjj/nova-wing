import type { PathLike } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { NovaWingError, isNovaWingError } from 'nova-wing/core'
import type {
  ApprovedProposalUpdate,
  AssertionType,
  CoreRevision,
  ListProposalInput,
  MainlineCategory,
  MainlineContext,
  MainlineEntry,
  MainlineOperation,
  MainlineScope,
  MemoryProposal,
  ProposalSourceType,
  ProposalStatus,
  NovaWingStore,
  NovaWingTransaction,
  ProposalDraftChanges,
  ProposalSubmission,
} from 'nova-wing/core'
import { migrateNovaWing, verifyNovaWingConsistency } from './migrations/index.js'

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>

export interface SqliteNovaWingStoreOptions {
  busyRetries?: number | undefined
  busyRetryDelayMs?: number | undefined
  busyTimeoutMs?: number | undefined
}

export interface OpenSqliteNovaWingStoreOptions extends SqliteNovaWingStoreOptions {
  databasePath: PathLike
}

export type InjectedConnectionMigrationMode = 'apply' | 'validate'

export interface InjectedSqliteNovaWingStoreOptions extends SqliteNovaWingStoreOptions {
  connection: DatabaseSync
  migrationMode: InjectedConnectionMigrationMode
}

export interface SqliteNovaWingStore extends NovaWingStore {
  readonly connectionOwnership: 'owned' | 'injected'
  close(): void
}

interface InternalSqliteNovaWingStoreOptions extends SqliteNovaWingStoreOptions {
  connectionOwnership: SqliteNovaWingStore['connectionOwnership']
  migrationMode: InjectedConnectionMigrationMode
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new NovaWingError('STORE_NOT_INITIALIZED', `invalid string column ${key}`)
  }
  return value
}

function optionalString(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new NovaWingError('STORE_NOT_INITIALIZED', `invalid nullable string column ${key}`)
  }
  return value
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new NovaWingError('STORE_NOT_INITIALIZED', `invalid integer column ${key}`)
  }
  return value
}

function optionalNumber(row: SqlRow, key: string): number | null {
  const value = row[key]
  if (value === null) {
    return null
  }
  return requiredNumber(row, key)
}

function rowToProposal(row: SqlRow): MemoryProposal {
  return {
    id: requiredString(row, 'id'),
    action: requiredString(row, 'action') as MainlineOperation,
    memoryKey: requiredString(row, 'memory_key'),
    category: requiredString(row, 'category') as MainlineCategory,
    assertionType: requiredString(row, 'assertion_type') as AssertionType,
    scope: requiredString(row, 'scope') as MainlineScope,
    proposedStatement: optionalString(row, 'proposed_statement'),
    editedStatement: optionalString(row, 'edited_statement'),
    finalStatement: optionalString(row, 'final_statement'),
    rationale: requiredString(row, 'rationale'),
    evidenceSummary: requiredString(row, 'evidence_summary'),
    sourceType: requiredString(row, 'source_type') as ProposalSourceType,
    sourceSystem: optionalString(row, 'source_system'),
    sourceRef: optionalString(row, 'source_ref'),
    baseCoreRevision: optionalNumber(row, 'base_core_revision'),
    baseTargetEntryId: optionalString(row, 'base_target_entry_id'),
    status: requiredString(row, 'status') as ProposalStatus,
    reviewNote: optionalString(row, 'review_note'),
    appliedCoreRevision: optionalNumber(row, 'applied_core_revision'),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    reviewedAt: optionalString(row, 'reviewed_at'),
  }
}

function rowToEntry(row: SqlRow): MainlineEntry {
  return {
    id: requiredString(row, 'id'),
    memoryKey: requiredString(row, 'memory_key'),
    operation: requiredString(row, 'operation') as MainlineOperation,
    category: requiredString(row, 'category') as MainlineCategory,
    assertionType: requiredString(row, 'assertion_type') as AssertionType,
    scope: requiredString(row, 'scope') as MainlineScope,
    statement: optionalString(row, 'statement'),
    rationale: requiredString(row, 'rationale'),
    supersedesEntryId: optionalString(row, 'supersedes_entry_id'),
    sourceProposalId: requiredString(row, 'source_proposal_id'),
    coreRevision: requiredNumber(row, 'core_revision'),
    createdAt: requiredString(row, 'created_at'),
  }
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const sqliteError = error as Error & { errcode?: number; errstr?: string }
  return (
    sqliteError.errcode === 5 ||
    sqliteError.errstr === 'database is locked' ||
    /database is (?:locked|busy)/iu.test(error.message)
  )
}

function wait(milliseconds: number): void {
  if (milliseconds <= 0) {
    return
  }
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds)
}

function changesExactlyOne(changes: number | bigint): boolean {
  return changes === 1 || changes === 1n
}

class NodeSqliteNovaWingStore implements SqliteNovaWingStore {
  readonly #database: DatabaseSync
  readonly #busyRetries: number
  readonly #busyRetryDelayMs: number
  readonly connectionOwnership: SqliteNovaWingStore['connectionOwnership']
  #closed = false

  constructor(database: DatabaseSync, options: InternalSqliteNovaWingStoreOptions) {
    if (database.isTransaction) {
      throw new NovaWingError(
        'TRANSACTION_OWNERSHIP_CONFLICT',
        'NovaWing store requires an idle SQLite connection during initialization',
      )
    }
    this.#database = database
    this.#busyRetries = options.busyRetries ?? 3
    this.#busyRetryDelayMs = options.busyRetryDelayMs ?? 5
    this.connectionOwnership = options.connectionOwnership
    this.#database.exec('PRAGMA foreign_keys = ON')
    this.#database.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs ?? 50)}`)
    if (options.migrationMode === 'apply') {
      migrateNovaWing(this.#database)
    }
    try {
      verifyNovaWingConsistency(this.#database)
    } catch (error: unknown) {
      if (isNovaWingError(error)) {
        throw error
      }
      throw new NovaWingError(
        'STORE_NOT_INITIALIZED',
        'NovaWing schema validation failed',
        { cause: error },
      )
    }
  }

  close(): void {
    if (!this.#closed && this.connectionOwnership === 'owned') {
      this.#database.close()
    }
    this.#closed = true
  }

  withImmediateTransaction<T>(operation: (transaction: NovaWingTransaction) => T): T {
    this.#assertOpen()
    this.#assertTransactionIdle('write')
    let lastBusyError: unknown
    for (let attempt = 0; attempt <= this.#busyRetries; attempt += 1) {
      let began = false
      try {
        this.#database.exec('BEGIN IMMEDIATE')
        began = true
        const result = operation(this)
        this.#database.exec('COMMIT')
        return result
      } catch (error: unknown) {
        if (began) {
          try {
            this.#database.exec('ROLLBACK')
          } catch {
            // Preserve the domain or SQL error that caused the rollback.
          }
        }
        if (isNovaWingError(error)) {
          throw error
        }
        if (isBusyError(error)) {
          lastBusyError = error
          if (attempt < this.#busyRetries) {
            wait(this.#busyRetryDelayMs * (attempt + 1))
            continue
          }
          break
        }
        throw new NovaWingError('TRANSACTION_FAILED', 'SQLite transaction failed', {
          cause: error,
        })
      }
    }
    throw new NovaWingError('STORE_BUSY', 'SQLite store remained busy after retrying', {
      cause: lastBusyError,
    })
  }

  getCurrentCoreRevision(): CoreRevision {
    this.#assertOpen()
    const row = this.#database
      .prepare(`
        SELECT integer_value
        FROM nw_meta
        WHERE key = 'current_core_revision'
      `)
      .get() as SqlRow | undefined
    if (row === undefined) {
      throw new NovaWingError('STORE_NOT_INITIALIZED', 'current_core_revision is missing')
    }
    return requiredNumber(row, 'integer_value')
  }

  compareAndSetCoreRevision(
    expected: CoreRevision,
    next: CoreRevision,
    updatedAt: string,
  ): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_meta
        SET integer_value = $next, updated_at = $updatedAt
        WHERE key = 'current_core_revision' AND integer_value = $expected
      `)
      .run({ expected, next, updatedAt })
    return changesExactlyOne(result.changes)
  }

  getProposal(proposalId: string): MemoryProposal | null {
    this.#assertOpen()
    const row = this.#database
      .prepare('SELECT * FROM nw_proposals WHERE id = $proposalId')
      .get({ proposalId }) as SqlRow | undefined
    return row === undefined ? null : rowToProposal(row)
  }

  insertProposal(proposal: MemoryProposal): void {
    this.#database
      .prepare(`
        INSERT INTO nw_proposals (
          id, action, memory_key, category, assertion_type, scope,
          proposed_statement, edited_statement, final_statement,
          rationale, evidence_summary, source_type, source_system, source_ref,
          base_core_revision, base_target_entry_id, status, review_note,
          applied_core_revision, created_at, updated_at, reviewed_at
        ) VALUES (
          $id, $action, $memoryKey, $category, $assertionType, $scope,
          $proposedStatement, $editedStatement, $finalStatement,
          $rationale, $evidenceSummary, $sourceType, $sourceSystem, $sourceRef,
          $baseCoreRevision, $baseTargetEntryId, $status, $reviewNote,
          $appliedCoreRevision, $createdAt, $updatedAt, $reviewedAt
        )
      `)
      .run({
        id: proposal.id,
        action: proposal.action,
        memoryKey: proposal.memoryKey,
        category: proposal.category,
        assertionType: proposal.assertionType,
        scope: proposal.scope,
        proposedStatement: proposal.proposedStatement,
        editedStatement: proposal.editedStatement,
        finalStatement: proposal.finalStatement,
        rationale: proposal.rationale,
        evidenceSummary: proposal.evidenceSummary,
        sourceType: proposal.sourceType,
        sourceSystem: proposal.sourceSystem,
        sourceRef: proposal.sourceRef,
        baseCoreRevision: proposal.baseCoreRevision,
        baseTargetEntryId: proposal.baseTargetEntryId,
        status: proposal.status,
        reviewNote: proposal.reviewNote,
        appliedCoreRevision: proposal.appliedCoreRevision,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        reviewedAt: proposal.reviewedAt,
      })
  }

  updateDraft(changes: ProposalDraftChanges & { proposalId: string }): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_proposals
        SET action = $action,
            memory_key = $memoryKey,
            category = $category,
            assertion_type = $assertionType,
            scope = $scope,
            proposed_statement = $proposedStatement,
            rationale = $rationale,
            evidence_summary = $evidenceSummary,
            source_ref = $sourceRef,
            updated_at = $updatedAt
        WHERE id = $proposalId AND status = 'draft'
      `)
      .run({
        proposalId: changes.proposalId,
        action: changes.action,
        memoryKey: changes.memoryKey,
        category: changes.category,
        assertionType: changes.assertionType,
        scope: changes.scope,
        proposedStatement: changes.proposedStatement,
        rationale: changes.rationale,
        evidenceSummary: changes.evidenceSummary,
        sourceRef: changes.sourceRef,
        updatedAt: changes.updatedAt,
      })
    return changesExactlyOne(result.changes)
  }

  markPending(submission: ProposalSubmission): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_proposals
        SET status = 'pending',
            base_core_revision = $baseCoreRevision,
            base_target_entry_id = $baseTargetEntryId,
            updated_at = $updatedAt
        WHERE id = $proposalId AND status = 'draft'
      `)
      .run({
        proposalId: submission.proposalId,
        baseCoreRevision: submission.baseCoreRevision,
        baseTargetEntryId: submission.baseTargetEntryId,
        updatedAt: submission.updatedAt,
      })
    return changesExactlyOne(result.changes)
  }

  editPending(proposalId: string, statement: string, updatedAt: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_proposals
        SET edited_statement = $statement, updated_at = $updatedAt
        WHERE id = $proposalId AND status = 'pending' AND action = 'set'
      `)
      .run({ proposalId, statement, updatedAt })
    return changesExactlyOne(result.changes)
  }

  markApproved(update: ApprovedProposalUpdate): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_proposals
        SET status = 'approved',
            final_statement = $finalStatement,
            review_note = $reviewNote,
            applied_core_revision = $appliedCoreRevision,
            reviewed_at = $reviewedAt,
            updated_at = $reviewedAt
        WHERE id = $proposalId AND status = 'pending'
      `)
      .run({
        proposalId: update.proposalId,
        finalStatement: update.finalStatement,
        reviewNote: update.reviewNote,
        appliedCoreRevision: update.appliedCoreRevision,
        reviewedAt: update.reviewedAt,
      })
    return changesExactlyOne(result.changes)
  }

  markRejected(proposalId: string, reviewNote: string | null, reviewedAt: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE nw_proposals
        SET status = 'rejected',
            review_note = $reviewNote,
            reviewed_at = $reviewedAt,
            updated_at = $reviewedAt
        WHERE id = $proposalId AND status = 'pending'
      `)
      .run({ proposalId, reviewNote, reviewedAt })
    return changesExactlyOne(result.changes)
  }

  findLatestByMemoryKey(memoryKey: string): MainlineEntry | null {
    this.#assertOpen()
    const row = this.#database
      .prepare(`
        SELECT *
        FROM nw_mainline_entries
        WHERE memory_key = $memoryKey
        ORDER BY core_revision DESC
        LIMIT 1
      `)
      .get({ memoryKey }) as SqlRow | undefined
    return row === undefined ? null : rowToEntry(row)
  }

  appendEntry(entry: MainlineEntry): void {
    this.#database
      .prepare(`
        INSERT INTO nw_mainline_entries (
          id, memory_key, operation, category, assertion_type, scope,
          statement, rationale, supersedes_entry_id, source_proposal_id,
          core_revision, created_at
        ) VALUES (
          $id, $memoryKey, $operation, $category, $assertionType, $scope,
          $statement, $rationale, $supersedesEntryId, $sourceProposalId,
          $coreRevision, $createdAt
        )
      `)
      .run({
        id: entry.id,
        memoryKey: entry.memoryKey,
        operation: entry.operation,
        category: entry.category,
        assertionType: entry.assertionType,
        scope: entry.scope,
        statement: entry.statement,
        rationale: entry.rationale,
        supersedesEntryId: entry.supersedesEntryId,
        sourceProposalId: entry.sourceProposalId,
        coreRevision: entry.coreRevision,
        createdAt: entry.createdAt,
      })
  }

  readMainlineContext(scopes: readonly MainlineScope[]): MainlineContext {
    this.#assertOpen()
    this.#assertTransactionIdle('read')
    let began = false
    try {
      this.#database.exec('BEGIN')
      began = true
      const context = {
        coreRevision: this.getCurrentCoreRevision(),
        entries: this.listCurrentMainline(scopes),
      }
      this.#database.exec('COMMIT')
      return context
    } catch (error: unknown) {
      if (began) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Preserve the read error that caused the rollback.
        }
      }
      if (isNovaWingError(error)) {
        throw error
      }
      if (isBusyError(error)) {
        throw new NovaWingError('STORE_BUSY', 'SQLite store is busy during context read', {
          cause: error,
        })
      }
      throw new NovaWingError('TRANSACTION_FAILED', 'SQLite read transaction failed', {
        cause: error,
      })
    }
  }

  listCurrentMainline(scopes: readonly MainlineScope[]): MainlineEntry[] {
    this.#assertOpen()
    if (scopes.length === 0) {
      return []
    }
    const placeholders = scopes.map((_, index) => `$scope${String(index)}`)
    const parameters = Object.fromEntries(
      scopes.map((scope, index) => [`scope${String(index)}`, scope]),
    )
    const rows = this.#database
      .prepare(`
        WITH latest_entries AS (
          SELECT entry.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY memory_key
                   ORDER BY core_revision DESC
                 ) AS row_number
          FROM nw_mainline_entries AS entry
        )
        SELECT id, memory_key, operation, category, assertion_type, scope,
               statement, rationale, supersedes_entry_id, source_proposal_id,
               core_revision, created_at
        FROM latest_entries
        WHERE row_number = 1
          AND operation = 'set'
          AND scope IN (${placeholders.join(', ')})
        ORDER BY memory_key
      `)
      .all(parameters) as SqlRow[]
    return rows.map(rowToEntry)
  }

  listProposals(input?: ListProposalInput): MemoryProposal[] {
    this.#assertOpen()
    const statuses = input?.statuses
    if (statuses?.length === 0) {
      return []
    }
    if (statuses === undefined) {
      return (this.#database
        .prepare('SELECT * FROM nw_proposals ORDER BY created_at DESC, id DESC')
        .all() as SqlRow[]).map(rowToProposal)
    }
    const placeholders = statuses.map((_, index) => `$status${String(index)}`)
    const parameters = Object.fromEntries(
      statuses.map((status, index) => [`status${String(index)}`, status]),
    )
    return (this.#database
      .prepare(`
        SELECT *
        FROM nw_proposals
        WHERE status IN (${placeholders.join(', ')})
        ORDER BY created_at DESC, id DESC
      `)
      .all(parameters) as SqlRow[]).map(rowToProposal)
  }

  findEntry(entryId: string): MainlineEntry | null {
    this.#assertOpen()
    const row = this.#database
      .prepare('SELECT * FROM nw_mainline_entries WHERE id = $entryId')
      .get({ entryId }) as SqlRow | undefined
    return row === undefined ? null : rowToEntry(row)
  }

  findEntryBySourceProposal(proposalId: string): MainlineEntry | null {
    this.#assertOpen()
    const row = this.#database
      .prepare('SELECT * FROM nw_mainline_entries WHERE source_proposal_id = $proposalId')
      .get({ proposalId }) as SqlRow | undefined
    return row === undefined ? null : rowToEntry(row)
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new NovaWingError('STORE_NOT_INITIALIZED', 'SQLite store is closed')
    }
  }

  #assertTransactionIdle(operation: 'read' | 'write'): void {
    if (this.#database.isTransaction) {
      throw new NovaWingError(
        'TRANSACTION_OWNERSHIP_CONFLICT',
        `NovaWing ${operation} transaction cannot run inside an existing SQLite transaction`,
      )
    }
  }
}

export function openSqliteNovaWingStore(
  options: OpenSqliteNovaWingStoreOptions,
): SqliteNovaWingStore {
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
    timeout: options.busyTimeoutMs ?? 50,
  })
  try {
    return new NodeSqliteNovaWingStore(database, {
      ...options,
      connectionOwnership: 'owned',
      migrationMode: 'apply',
    })
  } catch (error: unknown) {
    database.close()
    throw error
  }
}

export function createInjectedSqliteNovaWingStore(
  options: InjectedSqliteNovaWingStoreOptions,
): SqliteNovaWingStore {
  return new NodeSqliteNovaWingStore(options.connection, {
    busyRetries: options.busyRetries,
    busyRetryDelayMs: options.busyRetryDelayMs,
    busyTimeoutMs: options.busyTimeoutMs,
    connectionOwnership: 'injected',
    migrationMode: options.migrationMode,
  })
}
