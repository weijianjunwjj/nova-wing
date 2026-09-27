import { z } from 'zod'

const bounded = (max = 2_000) => z.string().trim().min(1).max(max)
const id = bounded(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u)

export const requirementClauseSchema = z.object({
  id,
  statement: bounded(),
  type: z.enum(['functional', 'business-rule', 'constraint', 'quality', 'delivery']),
  priority: z.enum(['must', 'should', 'could']),
  source: z.object({
    excerpt: bounded(1_000), location: bounded(200),
    origin: z.enum(['customer_requirement', 'customer_revision', 'derived_assumption']),
  }).strict(),
  ambiguity: z.object({ ambiguous: z.boolean(), note: z.string().max(1_000) }),
}).strict()

export const analysisSchema = z.object({
  productGoal: bounded(),
  summary: bounded(4_000),
  userRoles: z.array(z.object({ id, name: bounded(200), goals: z.array(bounded(500)).min(1) }).strict()).min(1).max(20),
  businessFlows: z.array(z.object({ id, title: bounded(200), steps: z.array(bounded(500)).min(2), requirementIds: z.array(id).min(1) }).strict()).min(1).max(50),
}).strict()

export const planDraftSchema = z.object({
  clauses: z.array(requirementClauseSchema).min(1).max(100),
  analysis: analysisSchema,
  productScope: z.object({ inScope: z.array(bounded()).min(1), outOfScope: z.array(bounded()).min(1) }).strict(),
  architecture: z.object({ summary: bounded(4_000), components: z.array(bounded(500)).min(1), decisions: z.array(bounded(500)) }).strict(),
  tasks: z.array(z.object({
    id, title: bounded(200), objective: bounded(), requirementIds: z.array(id).min(1),
    outputs: z.array(bounded(500)).min(1), dependencyIds: z.array(id), acceptanceCriterionIds: z.array(id).min(1),
    complexity: z.enum(['small', 'medium', 'large']),
  }).strict()).min(1).max(100),
  acceptancePlan: z.object({ strategy: bounded(4_000), criteria: z.array(z.object({
    id, requirementIds: z.array(id).min(1), description: bounded(),
    level: z.enum(['unit', 'integration', 'api', 'ui', 'platform', 'delivery']),
    expectedEvidence: bounded(), blocking: z.boolean(),
    assertions: z.array(z.object({
      id, requirementId: id,
      observableBehavior: bounded(1_000), expectedOutcome: bounded(1_000),
      expectedEvidence: bounded(1_000), blocking: z.boolean(),
    }).strict()).min(1).max(100),
  }).strict()).min(1).max(150) }).strict(),
  risks: z.array(z.object({ id, description: bounded(), mitigation: bounded() }).strict()),
  assumptions: z.array(z.object({ id, statement: bounded(), impactIfFalse: bounded() }).strict()),
  customerQuestions: z.array(z.object({
    id, question: bounded(500), reason: bounded(),
    decisionType: z.enum(['business_rule', 'scope', 'product_behavior']),
    options: z.array(bounded(500)).min(2).max(6), blocking: z.boolean(),
  }).strict()),
}).strict()

export type RequirementClause = z.infer<typeof requirementClauseSchema>
export type RequirementAnalysis = z.infer<typeof analysisSchema>
export type PlanDraft = z.infer<typeof planDraftSchema>
export type PlannedTask = PlanDraft['tasks'][number]
export type AcceptanceCriterion = PlanDraft['acceptancePlan']['criteria'][number]
export type AcceptanceAssertion = AcceptanceCriterion['assertions'][number]

export const semanticReviewIssueCodeSchema = z.enum([
  'MISSING_EXPLICIT_REQUIREMENT', 'INVENTED_BUSINESS_SCOPE', 'WEAK_ACCEPTANCE',
  'UNSUPPORTED_BUSINESS_ASSUMPTION', 'INAPPROPRIATE_CUSTOMER_QUESTION',
  'MISSING_CUSTOMER_QUESTION', 'TASK_TOO_VAGUE', 'TASK_REQUIREMENT_MISMATCH',
  'ACCEPTANCE_REQUIREMENT_MISMATCH', 'UNSUPPORTED_PROVENANCE',
  'REVIEW_UNAVAILABLE',
])
export const semanticReviewSchema = z.object({
  verdict: z.enum(['PASS', 'REVISION_REQUIRED']),
  issues: z.array(z.object({
    code: semanticReviewIssueCodeSchema, path: bounded(200),
    message: bounded(1_000), sourceExcerpt: z.string().max(1_000).default(''),
  })).max(100),
})
export type SemanticReview = z.infer<typeof semanticReviewSchema>

export interface RequirementInput {
  id: string
  text: string
  receivedAt: string
  /** Customer feedback is part of requirement provenance for later plan versions. */
  revisionNotes?: string[]
}

export interface RequirementCoverage {
  requirementId: string
  taskIds: string[]
  acceptanceCriterionIds: string[]
  blockingAcceptanceCriterionIds: string[]
  assertionIds: string[]
  blockingAssertionIds: string[]
}

export type DevelopmentPlanStatus = 'draft' | 'planning_failed' | 'needs_customer_input' | 'ready_for_approval' | 'approved' | 'frozen' | 'superseded'

export interface CustomerAnswer {
  questionId: string
  sourcePlanVersion: number
  selectedOptionId: string
  selectedOptionText: string
  question: PlanDraft['customerQuestions'][number]
  freeformAnswer?: string | undefined
  answeredAt: string
  provenance: 'customer_decision'
}

export interface PlanApproval {
  planId: string
  planVersion: number
  approvedAt: string
  actor: 'customer'
  source: 'customer_mode' | 'planning_service'
  contentHash: string
}

export interface PlanChangeRequest {
  id: string
  baseFrozenPlanId: string
  baseVersion: number
  reason: string
  requestedChange: string
  createdAt: string
  status: 'requested' | 'revision_started'
}

export interface DevelopmentPlan extends PlanDraft {
  id: string
  version: number
  status: DevelopmentPlanStatus
  requirement: RequirementInput
  dependencies: Array<{ fromTaskId: string; toTaskId: string }>
  coverage: RequirementCoverage[]
  semanticReview: SemanticReview | null
  customerAnswers?: CustomerAnswer[]
  approval?: PlanApproval | null
  supersedesSnapshotId?: string | null
  /** Reserved for a later explicit Plan Freeze implementation. */
  frozenAt: string | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
}

export function buildCoverage(draft: PlanDraft): RequirementCoverage[] {
  return draft.clauses.map((clause) => ({
    requirementId: clause.id,
    taskIds: draft.tasks.filter((task) => task.requirementIds.includes(clause.id)).map((task) => task.id),
    acceptanceCriterionIds: draft.acceptancePlan.criteria.filter((criterion) => criterion.requirementIds.includes(clause.id)).map((criterion) => criterion.id),
    blockingAcceptanceCriterionIds: draft.acceptancePlan.criteria.filter((criterion) => criterion.blocking &&
      criterion.assertions.some((assertion) => assertion.blocking && assertion.requirementId === clause.id)).map((criterion) => criterion.id),
    assertionIds: draft.acceptancePlan.criteria.flatMap((criterion) => criterion.assertions.filter((assertion) => assertion.requirementId === clause.id).map((assertion) => assertion.id)),
    blockingAssertionIds: draft.acceptancePlan.criteria.flatMap((criterion) => criterion.blocking
      ? criterion.assertions.filter((assertion) => assertion.requirementId === clause.id && assertion.blocking).map((assertion) => assertion.id)
      : []),
  }))
}

export function createDevelopmentPlan(draft: PlanDraft, requirement: RequirementInput, planId: string, version = 1, now = new Date()): DevelopmentPlan {
  return {
    ...draft,
    id: planId,
    version,
    status: 'draft',
    requirement,
    dependencies: draft.tasks.flatMap((task) => task.dependencyIds.map((dependencyId) => ({ fromTaskId: dependencyId, toTaskId: task.id }))),
    coverage: buildCoverage(draft),
    semanticReview: null,
    frozenAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvedAt: null,
  }
}
