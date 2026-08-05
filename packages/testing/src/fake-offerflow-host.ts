import type {
  AssertionType,
  MainlineCategory,
  MainlineContext,
  MainlineOperation,
  MainlineScope,
  MemoryProposal,
  NovaWingFacade,
} from 'nova-wing/core'

export interface FakeHostProposalInput {
  action: MainlineOperation
  memoryKey: string
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  proposedStatement?: string | null
  rationale: string
  evidence: {
    summary: string
    sourceRef?: string | null
  }
}

/**
 * A contract test adapter only. It contains no real host code and intentionally
 * cannot approve proposals or write mainline entries directly.
 */
export class FakeOfferFlowHost {
  readonly #novaWing: NovaWingFacade

  constructor(novaWing: NovaWingFacade) {
    this.#novaWing = novaWing
  }

  submitMainlineProposal(input: FakeHostProposalInput): MemoryProposal {
    return this.#novaWing.createPendingProposal({
      action: input.action,
      memoryKey: input.memoryKey,
      category: input.category,
      assertionType: input.assertionType,
      scope: input.scope,
      rationale: input.rationale,
      evidenceSummary: input.evidence.summary,
      sourceType: 'host',
      sourceSystem: 'fake-offerflow-host',
      ...(input.proposedStatement === undefined
        ? {}
        : { proposedStatement: input.proposedStatement }),
      ...(input.evidence.sourceRef === undefined
        ? {}
        : { sourceRef: input.evidence.sourceRef }),
    })
  }

  readLatestMainline(scopes: readonly MainlineScope[] = ['global', 'career']): MainlineContext {
    return this.#novaWing.getContext({ scopes })
  }
}
