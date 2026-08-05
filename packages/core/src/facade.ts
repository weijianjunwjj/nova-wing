import { randomUUID } from 'node:crypto'

import { NovaWingError } from './domain/errors.js'
import type {
  ApproveProposalInput,
  ApproveProposalResult,
  CreateProposalInput,
  EditPendingProposalInput,
  GetContextInput,
  ListProposalInput,
  MainlineContext,
  MainlineEntry,
  MainlineEntrySource,
  MemoryProposal,
  RejectProposalInput,
  UpdateDraftInput,
} from './domain/model.js'
import { MAINLINE_SCOPES } from './domain/model.js'
import {
  assertPending,
  assertProposalTransition,
  normalizeOptional,
  normalizeProposalInput,
  resolveFinalStatement,
  validateApprovalTarget,
  validateSubmissionTarget,
} from './domain/validation.js'
import type { NovaWingStore } from './ports/store.js'

export interface NovaWingFacadeOptions {
  clock?: () => string
  generateId?: () => string
}

export interface NovaWingFacade {
  getCurrentCoreRevision(): number
  getContext(input: GetContextInput): MainlineContext
  listCurrentMainline(): MainlineContext
  createProposal(input: CreateProposalInput): MemoryProposal
  createPendingProposal(input: CreateProposalInput): MemoryProposal
  updateDraft(input: UpdateDraftInput): MemoryProposal
  submitProposal(proposalId: string): MemoryProposal
  editPendingProposal(input: EditPendingProposalInput): MemoryProposal
  listProposals(input?: ListProposalInput): MemoryProposal[]
  getProposal(proposalId: string): MemoryProposal | null
  approveProposal(input: ApproveProposalInput): ApproveProposalResult
  rejectProposal(input: RejectProposalInput): MemoryProposal
  getEntrySource(entryId: string): MainlineEntrySource | null
}

function requiredProposal(proposal: MemoryProposal | null, proposalId: string): MemoryProposal {
  if (proposal === null) {
    throw new NovaWingError('PROPOSAL_NOT_FOUND', `proposal ${proposalId} was not found`)
  }
  return proposal
}

export function createNovaWingFacade(
  store: NovaWingStore,
  options: NovaWingFacadeOptions = {},
): NovaWingFacade {
  const clock = options.clock ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? randomUUID

  return {
    getCurrentCoreRevision(): number {
      return store.getCurrentCoreRevision()
    },

    getContext(input: GetContextInput): MainlineContext {
      const scopes = [...new Set(input.scopes)]
      if (scopes.some((scope) => !MAINLINE_SCOPES.includes(scope))) {
        throw new NovaWingError('INVALID_PROPOSAL', 'context scope is invalid')
      }
      return store.readMainlineContext(scopes)
    },

    listCurrentMainline(): MainlineContext {
      return store.readMainlineContext(['global', 'career'])
    },

    createProposal(input: CreateProposalInput): MemoryProposal {
      const normalized = normalizeProposalInput(input)
      const now = clock()
      const proposal: MemoryProposal = {
        id: generateId(),
        action: normalized.action,
        memoryKey: normalized.memoryKey,
        category: normalized.category,
        assertionType: normalized.assertionType,
        scope: normalized.scope,
        proposedStatement: normalized.proposedStatement ?? null,
        editedStatement: null,
        finalStatement: null,
        rationale: normalized.rationale,
        evidenceSummary: normalized.evidenceSummary,
        sourceType: normalized.sourceType,
        sourceSystem: normalized.sourceSystem ?? null,
        sourceRef: normalized.sourceRef ?? null,
        baseCoreRevision: null,
        baseTargetEntryId: null,
        status: 'draft',
        reviewNote: null,
        appliedCoreRevision: null,
        createdAt: now,
        updatedAt: now,
        reviewedAt: null,
      }
      store.withImmediateTransaction((transaction) => transaction.insertProposal(proposal))
      return proposal
    },

    createPendingProposal(input: CreateProposalInput): MemoryProposal {
      const normalized = normalizeProposalInput(input)
      return store.withImmediateTransaction((transaction) => {
        const now = clock()
        const latestEntry = transaction.findLatestByMemoryKey(normalized.memoryKey)
        const proposal: MemoryProposal = {
          id: generateId(),
          action: normalized.action,
          memoryKey: normalized.memoryKey,
          category: normalized.category,
          assertionType: normalized.assertionType,
          scope: normalized.scope,
          proposedStatement: normalized.proposedStatement ?? null,
          editedStatement: null,
          finalStatement: null,
          rationale: normalized.rationale,
          evidenceSummary: normalized.evidenceSummary,
          sourceType: normalized.sourceType,
          sourceSystem: normalized.sourceSystem ?? null,
          sourceRef: normalized.sourceRef ?? null,
          baseCoreRevision: transaction.getCurrentCoreRevision(),
          baseTargetEntryId: latestEntry?.id ?? null,
          status: 'pending',
          reviewNote: null,
          appliedCoreRevision: null,
          createdAt: now,
          updatedAt: now,
          reviewedAt: null,
        }
        validateSubmissionTarget(proposal, latestEntry)
        transaction.insertProposal(proposal)
        return proposal
      })
    },

    updateDraft(input: UpdateDraftInput): MemoryProposal {
      return store.withImmediateTransaction((transaction) => {
        const proposal = requiredProposal(transaction.getProposal(input.proposalId), input.proposalId)
        if (proposal.status !== 'draft') {
          throw new NovaWingError(
            'INVALID_PROPOSAL_TRANSITION',
            `only draft proposals can be fully edited; proposal is ${proposal.status}`,
          )
        }
        const normalized = normalizeProposalInput({
          action: input.changes.action ?? proposal.action,
          memoryKey: input.changes.memoryKey ?? proposal.memoryKey,
          category: input.changes.category ?? proposal.category,
          assertionType: input.changes.assertionType ?? proposal.assertionType,
          scope: input.changes.scope ?? proposal.scope,
          proposedStatement:
            'proposedStatement' in input.changes
              ? input.changes.proposedStatement
              : proposal.proposedStatement,
          rationale: input.changes.rationale ?? proposal.rationale,
          evidenceSummary: input.changes.evidenceSummary ?? proposal.evidenceSummary,
          sourceType: proposal.sourceType,
          sourceSystem: proposal.sourceSystem,
          sourceRef: 'sourceRef' in input.changes ? input.changes.sourceRef : proposal.sourceRef,
        })
        const updated = transaction.updateDraft({
          proposalId: proposal.id,
          action: normalized.action,
          memoryKey: normalized.memoryKey,
          category: normalized.category,
          assertionType: normalized.assertionType,
          scope: normalized.scope,
          proposedStatement: normalized.proposedStatement ?? null,
          rationale: normalized.rationale,
          evidenceSummary: normalized.evidenceSummary,
          sourceRef: normalized.sourceRef ?? null,
          updatedAt: clock(),
        })
        if (!updated) {
          throw new NovaWingError(
            'INVALID_PROPOSAL_TRANSITION',
            'proposal changed while the draft was being edited',
          )
        }
        return requiredProposal(transaction.getProposal(proposal.id), proposal.id)
      })
    },

    submitProposal(proposalId: string): MemoryProposal {
      return store.withImmediateTransaction((transaction) => {
        const proposal = requiredProposal(transaction.getProposal(proposalId), proposalId)
        assertProposalTransition(proposal.status, 'pending')
        const latestEntry = transaction.findLatestByMemoryKey(proposal.memoryKey)
        validateSubmissionTarget(proposal, latestEntry)
        const submitted = transaction.markPending({
          proposalId,
          baseCoreRevision: transaction.getCurrentCoreRevision(),
          baseTargetEntryId: latestEntry?.id ?? null,
          updatedAt: clock(),
        })
        if (!submitted) {
          throw new NovaWingError(
            'INVALID_PROPOSAL_TRANSITION',
            'proposal changed while it was being submitted',
          )
        }
        return requiredProposal(transaction.getProposal(proposalId), proposalId)
      })
    },

    editPendingProposal(input: EditPendingProposalInput): MemoryProposal {
      return store.withImmediateTransaction((transaction) => {
        const proposal = requiredProposal(transaction.getProposal(input.proposalId), input.proposalId)
        assertPending(proposal)
        if (proposal.action !== 'set') {
          throw new NovaWingError(
            'INVALID_PROPOSAL',
            'deprecate proposals do not have an editable statement',
          )
        }
        const statement = normalizeOptional(input.statement)
        if (statement === null || statement.length > 4_000) {
          throw new NovaWingError(
            'INVALID_PROPOSAL',
            'edited statement must contain between 1 and 4000 characters',
          )
        }
        if (!transaction.editPending(proposal.id, statement, clock())) {
          throw new NovaWingError(
            'PROPOSAL_CONCURRENTLY_REVIEWED',
            'proposal left pending state while it was being edited',
          )
        }
        return requiredProposal(transaction.getProposal(proposal.id), proposal.id)
      })
    },

    listProposals(input?: ListProposalInput): MemoryProposal[] {
      return store.listProposals(input)
    },

    getProposal(proposalId: string): MemoryProposal | null {
      return store.getProposal(proposalId)
    },

    approveProposal(input: ApproveProposalInput): ApproveProposalResult {
      return store.withImmediateTransaction((transaction) => {
        const proposal = requiredProposal(transaction.getProposal(input.proposalId), input.proposalId)
        assertPending(proposal)
        const currentRevision = transaction.getCurrentCoreRevision()
        const latestEntry = transaction.findLatestByMemoryKey(proposal.memoryKey)
        validateApprovalTarget(proposal, latestEntry)
        const finalStatement = resolveFinalStatement(proposal, input.finalStatement)
        const nextRevision = currentRevision + 1
        const now = clock()
        const entry: MainlineEntry = {
          id: generateId(),
          memoryKey: proposal.memoryKey,
          operation: proposal.action,
          category: proposal.category,
          assertionType: proposal.assertionType,
          scope: proposal.scope,
          statement: finalStatement,
          rationale: proposal.rationale,
          supersedesEntryId: latestEntry?.id ?? null,
          sourceProposalId: proposal.id,
          coreRevision: nextRevision,
          createdAt: now,
        }
        transaction.appendEntry(entry)
        const approved = transaction.markApproved({
          proposalId: proposal.id,
          finalStatement,
          reviewNote: normalizeOptional(input.reviewNote),
          appliedCoreRevision: nextRevision,
          reviewedAt: now,
        })
        if (!approved) {
          throw new NovaWingError(
            'PROPOSAL_CONCURRENTLY_REVIEWED',
            'proposal left pending state during approval',
          )
        }
        if (!transaction.compareAndSetCoreRevision(currentRevision, nextRevision, now)) {
          throw new NovaWingError(
            'CORE_REVISION_CONFLICT',
            'core revision changed during approval',
          )
        }
        return { proposalId: proposal.id, entryId: entry.id, coreRevision: nextRevision }
      })
    },

    rejectProposal(input: RejectProposalInput): MemoryProposal {
      return store.withImmediateTransaction((transaction) => {
        const proposal = requiredProposal(transaction.getProposal(input.proposalId), input.proposalId)
        assertPending(proposal)
        assertProposalTransition(proposal.status, 'rejected')
        if (!transaction.markRejected(proposal.id, normalizeOptional(input.reviewNote), clock())) {
          throw new NovaWingError(
            'PROPOSAL_CONCURRENTLY_REVIEWED',
            'proposal left pending state during rejection',
          )
        }
        return requiredProposal(transaction.getProposal(proposal.id), proposal.id)
      })
    },

    getEntrySource(entryId: string): MainlineEntrySource | null {
      const entry = store.findEntry(entryId)
      if (entry === null) {
        return null
      }
      const proposal = store.getProposal(entry.sourceProposalId)
      if (proposal === null) {
        throw new NovaWingError(
          'STORE_NOT_INITIALIZED',
          'mainline entry refers to a missing source proposal',
        )
      }
      return { entry, proposal }
    },
  }
}
