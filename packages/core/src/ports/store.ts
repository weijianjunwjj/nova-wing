import type {
  CoreRevision,
  ListProposalInput,
  MainlineContext,
  MainlineEntry,
  MainlineScope,
  MemoryProposal,
} from '../domain/model.js'

export interface ProposalDraftChanges {
  action: MemoryProposal['action']
  memoryKey: string
  category: MemoryProposal['category']
  assertionType: MemoryProposal['assertionType']
  scope: MemoryProposal['scope']
  proposedStatement: string | null
  rationale: string
  evidenceSummary: string
  sourceRef: string | null
  updatedAt: string
}

export interface ProposalSubmission {
  proposalId: string
  baseCoreRevision: CoreRevision
  baseTargetEntryId: string | null
  updatedAt: string
}

export interface ApprovedProposalUpdate {
  proposalId: string
  finalStatement: string | null
  reviewNote: string | null
  appliedCoreRevision: CoreRevision
  reviewedAt: string
}

export interface NovaWingTransaction {
  getCurrentCoreRevision(): CoreRevision
  compareAndSetCoreRevision(expected: CoreRevision, next: CoreRevision, updatedAt: string): boolean
  getProposal(proposalId: string): MemoryProposal | null
  insertProposal(proposal: MemoryProposal): void
  updateDraft(changes: ProposalDraftChanges & { proposalId: string }): boolean
  markPending(submission: ProposalSubmission): boolean
  editPending(proposalId: string, statement: string, updatedAt: string): boolean
  markApproved(update: ApprovedProposalUpdate): boolean
  markRejected(proposalId: string, reviewNote: string | null, reviewedAt: string): boolean
  findLatestByMemoryKey(memoryKey: string): MainlineEntry | null
  appendEntry(entry: MainlineEntry): void
}

export interface NovaWingStore extends NovaWingTransaction {
  withImmediateTransaction<T>(operation: (transaction: NovaWingTransaction) => T): T
  readMainlineContext(scopes: readonly MainlineScope[]): MainlineContext
  listCurrentMainline(scopes: readonly MainlineScope[]): MainlineEntry[]
  listProposals(input?: ListProposalInput): MemoryProposal[]
  findEntry(entryId: string): MainlineEntry | null
  findEntryBySourceProposal(proposalId: string): MainlineEntry | null
}
