export type NovaWingErrorCode =
  | 'INVALID_MEMORY_KEY'
  | 'INVALID_PROPOSAL'
  | 'INVALID_PROPOSAL_TRANSITION'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_APPROVED'
  | 'PROPOSAL_ALREADY_REJECTED'
  | 'PROPOSAL_CONCURRENTLY_REVIEWED'
  | 'TARGET_MEMORY_NOT_FOUND'
  | 'TARGET_MEMORY_ALREADY_DEPRECATED'
  | 'STALE_PROPOSAL'
  | 'CORE_REVISION_CONFLICT'
  | 'STORE_BUSY'
  | 'TRANSACTION_OWNERSHIP_CONFLICT'
  | 'MIGRATION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'STORE_NOT_INITIALIZED'

export class NovaWingError extends Error {
  readonly code: NovaWingErrorCode
  override readonly cause?: unknown

  constructor(code: NovaWingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'NovaWingError'
    this.code = code
    if (options !== undefined && 'cause' in options) {
      this.cause = options.cause
    }
  }
}

export function isNovaWingError(error: unknown): error is NovaWingError {
  return error instanceof NovaWingError
}
