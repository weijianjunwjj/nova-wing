export const MAINLINE_CATEGORIES = [
  'phase',
  'priority',
  'principle',
  'constraint',
  'decision',
] as const

export type MainlineCategory = (typeof MAINLINE_CATEGORIES)[number]

export const ASSERTION_TYPES = [
  'user_decision',
  'confirmed_fact',
  'working_hypothesis',
] as const

export type AssertionType = (typeof ASSERTION_TYPES)[number]

export const MAINLINE_SCOPES = ['global', 'career'] as const

export type MainlineScope = (typeof MAINLINE_SCOPES)[number]
export type MainlineOperation = 'set' | 'deprecate'
export type CoreRevision = number
export type ProposalStatus = 'draft' | 'pending' | 'approved' | 'rejected'
export type ProposalSourceType = 'host' | 'manual'

export interface MainlineEntry {
  id: string
  memoryKey: string
  operation: MainlineOperation
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  statement: string | null
  rationale: string
  supersedesEntryId: string | null
  sourceProposalId: string
  coreRevision: CoreRevision
  createdAt: string
}

export interface MemoryProposal {
  id: string
  action: MainlineOperation
  memoryKey: string
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  proposedStatement: string | null
  editedStatement: string | null
  finalStatement: string | null
  rationale: string
  evidenceSummary: string
  sourceType: ProposalSourceType
  sourceSystem: string | null
  sourceRef: string | null
  baseCoreRevision: CoreRevision | null
  baseTargetEntryId: string | null
  status: ProposalStatus
  reviewNote: string | null
  appliedCoreRevision: CoreRevision | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
}

export interface CreateProposalInput {
  action: MainlineOperation
  memoryKey: string
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  proposedStatement?: string | null
  rationale: string
  evidenceSummary: string
  sourceType: ProposalSourceType
  sourceSystem?: string | null
  sourceRef?: string | null
}

export interface UpdateDraftInput {
  proposalId: string
  changes: Partial<
    Pick<
      CreateProposalInput,
      | 'action'
      | 'memoryKey'
      | 'category'
      | 'assertionType'
      | 'scope'
      | 'proposedStatement'
      | 'rationale'
      | 'evidenceSummary'
      | 'sourceRef'
    >
  >
}

export interface EditPendingProposalInput {
  proposalId: string
  statement: string
}

export interface ApproveProposalInput {
  proposalId: string
  finalStatement?: string
  reviewNote?: string | null
}

export interface RejectProposalInput {
  proposalId: string
  reviewNote?: string | null
}

export interface ApproveProposalResult {
  proposalId: string
  entryId: string
  coreRevision: CoreRevision
}

export interface ListProposalInput {
  statuses?: readonly ProposalStatus[]
}

export interface GetContextInput {
  scopes: readonly MainlineScope[]
}

export interface MainlineContext {
  coreRevision: CoreRevision
  entries: MainlineEntry[]
}

export interface MainlineEntrySource {
  entry: MainlineEntry
  proposal: MemoryProposal
}

