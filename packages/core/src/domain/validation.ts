import { NovaWingError } from './errors.js'
import { ASSERTION_TYPES, MAINLINE_CATEGORIES, MAINLINE_SCOPES } from './model.js'
import type {
  CreateProposalInput,
  MainlineEntry,
  MainlineScope,
  MemoryProposal,
  ProposalStatus,
} from './model.js'

const MEMORY_KEY_PATTERN = /^(global|career)\.[a-z0-9][a-z0-9_-]{1,79}$/u

function normalizedRequired(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new NovaWingError(
      'INVALID_PROPOSAL',
      `${field} must contain between 1 and ${String(maxLength)} characters`,
    )
  }
  return normalized
}

export function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized
}

export function validateMemoryKey(memoryKey: string): string {
  const normalized = memoryKey.trim()
  if (!MEMORY_KEY_PATTERN.test(normalized) || normalized.length > 100) {
    throw new NovaWingError(
      'INVALID_MEMORY_KEY',
      'memoryKey must use the global or career namespace and a stable lowercase name',
    )
  }
  return normalized
}

export function normalizeProposalInput(input: CreateProposalInput): CreateProposalInput {
  if (!( ['set', 'deprecate'] as readonly string[]).includes(input.action)) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposal action is invalid')
  }
  if (!(MAINLINE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposal category is invalid')
  }
  if (!(ASSERTION_TYPES as readonly string[]).includes(input.assertionType)) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposal assertion type is invalid')
  }
  if (!(MAINLINE_SCOPES as readonly string[]).includes(input.scope)) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposal scope is invalid')
  }
  if (!( ['host', 'manual'] as readonly string[]).includes(input.sourceType)) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposal source type is invalid')
  }
  const memoryKey = validateMemoryKey(input.memoryKey)
  const keyScope = memoryKey.slice(0, memoryKey.indexOf('.')) as MainlineScope
  if (keyScope !== input.scope) {
    throw new NovaWingError('INVALID_PROPOSAL', 'memoryKey namespace must match scope')
  }

  const proposedStatement = normalizeOptional(input.proposedStatement)
  if (input.action === 'set' && proposedStatement === null) {
    throw new NovaWingError('INVALID_PROPOSAL', 'set proposals require a statement')
  }
  if (proposedStatement !== null && proposedStatement.length > 4_000) {
    throw new NovaWingError('INVALID_PROPOSAL', 'proposed statement exceeds 4000 characters')
  }
  if (input.action === 'deprecate' && proposedStatement !== null) {
    throw new NovaWingError('INVALID_PROPOSAL', 'deprecate proposals cannot contain a statement')
  }

  const sourceSystem =
    input.sourceType === 'host' && input.sourceSystem !== null && input.sourceSystem !== undefined
      ? normalizedRequired(input.sourceSystem, 'sourceSystem', 100)
      : normalizeOptional(input.sourceSystem)
  if (input.sourceType === 'host' && sourceSystem === null) {
    throw new NovaWingError('INVALID_PROPOSAL', 'host proposals require sourceSystem')
  }
  if (input.sourceType === 'manual' && sourceSystem !== null) {
    throw new NovaWingError('INVALID_PROPOSAL', 'manual proposals cannot name a host system')
  }

  return {
    ...input,
    memoryKey,
    proposedStatement,
    rationale: normalizedRequired(input.rationale, 'rationale', 2_000),
    evidenceSummary: normalizedRequired(input.evidenceSummary, 'evidenceSummary', 4_000),
    sourceSystem,
    sourceRef: normalizeOptional(input.sourceRef),
  }
}

const LEGAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: [],
}

export function assertProposalTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new NovaWingError(
      'INVALID_PROPOSAL_TRANSITION',
      `proposal cannot transition from ${from} to ${to}`,
    )
  }
}

export function assertPending(proposal: MemoryProposal): void {
  if (proposal.status === 'approved') {
    throw new NovaWingError(
      'PROPOSAL_ALREADY_APPROVED',
      `proposal was already applied at revision ${String(proposal.appliedCoreRevision)}`,
    )
  }
  if (proposal.status === 'rejected') {
    throw new NovaWingError('PROPOSAL_ALREADY_REJECTED', 'proposal was already rejected')
  }
  if (proposal.status !== 'pending') {
    throw new NovaWingError(
      'INVALID_PROPOSAL_TRANSITION',
      `proposal must be pending, but is ${proposal.status}`,
    )
  }
}

export function validateSubmissionTarget(
  proposal: MemoryProposal,
  latestEntry: MainlineEntry | null,
): void {
  if (proposal.action === 'deprecate') {
    if (latestEntry === null) {
      throw new NovaWingError('TARGET_MEMORY_NOT_FOUND', 'cannot deprecate a missing memory')
    }
    if (latestEntry.operation === 'deprecate') {
      throw new NovaWingError(
        'TARGET_MEMORY_ALREADY_DEPRECATED',
        'cannot deprecate an inactive memory',
      )
    }
  }
}

export function validateApprovalTarget(
  proposal: MemoryProposal,
  latestEntry: MainlineEntry | null,
): void {
  const latestId = latestEntry?.id ?? null
  if (proposal.baseTargetEntryId !== latestId) {
    throw new NovaWingError(
      'STALE_PROPOSAL',
      'the target memory changed after this proposal was submitted',
    )
  }
  validateSubmissionTarget(proposal, latestEntry)
}

export function resolveFinalStatement(
  proposal: MemoryProposal,
  explicitStatement: string | undefined,
): string | null {
  if (proposal.action === 'deprecate') {
    if (normalizeOptional(explicitStatement) !== null) {
      throw new NovaWingError(
        'INVALID_PROPOSAL',
        'deprecate approvals cannot contain a final statement',
      )
    }
    return null
  }

  const statement =
    normalizeOptional(explicitStatement) ??
    normalizeOptional(proposal.editedStatement) ??
    normalizeOptional(proposal.proposedStatement)

  if (statement === null) {
    throw new NovaWingError('INVALID_PROPOSAL', 'set approvals require a final statement')
  }
  if (statement.length > 4_000) {
    throw new NovaWingError('INVALID_PROPOSAL', 'final statement exceeds 4000 characters')
  }
  return statement
}
