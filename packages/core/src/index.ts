export { NovaWingError, isNovaWingError } from './domain/errors.js'
export type { NovaWingErrorCode } from './domain/errors.js'
export type {
  ApproveProposalInput,
  ApproveProposalResult,
  AssertionType,
  CoreRevision,
  CreateProposalInput,
  EditPendingProposalInput,
  GetContextInput,
  ListProposalInput,
  MainlineCategory,
  MainlineContext,
  MainlineEntry,
  MainlineEntrySource,
  MainlineOperation,
  MainlineScope,
  MemoryProposal,
  ProposalSourceType,
  ProposalStatus,
  RejectProposalInput,
  UpdateDraftInput,
} from './domain/model.js'
export { createNovaWingFacade } from './facade.js'
export type { NovaWingFacade, NovaWingFacadeOptions } from './facade.js'
export type {
  ApprovedProposalUpdate,
  NovaWingStore,
  NovaWingTransaction,
  ProposalDraftChanges,
  ProposalSubmission,
} from './ports/store.js'
