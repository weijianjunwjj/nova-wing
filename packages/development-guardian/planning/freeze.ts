import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { planDraftSchema, type CustomerAnswer, type DevelopmentPlan, type PlanApproval } from './model.js'
import { validateDevelopmentPlan } from './validator.js'

const answerSchema = z.object({
  questionId: z.string().min(1), sourcePlanVersion: z.number().int().positive(),
  selectedOptionId: z.string().regex(/^option-[1-6]$/u), selectedOptionText: z.string().min(1),
  question: planDraftSchema.shape.customerQuestions.element,
  freeformAnswer: z.string().max(2_000).optional(), answeredAt: z.iso.datetime(),
  provenance: z.literal('customer_decision'),
}).strict()
const decisionContentSchema = answerSchema.omit({ answeredAt: true, sourcePlanVersion: true })

const contentSchema = planDraftSchema.extend({
  requirement: z.object({ text: z.string().min(20), revisionNotes: z.array(z.string()) }).strict(),
  dependencies: z.array(z.object({ fromTaskId: z.string(), toTaskId: z.string() }).strict()),
  coverage: z.array(z.object({
    requirementId: z.string(), taskIds: z.array(z.string()), acceptanceCriterionIds: z.array(z.string()),
    blockingAcceptanceCriterionIds: z.array(z.string()), assertionIds: z.array(z.string()), blockingAssertionIds: z.array(z.string()),
  }).strict()),
  semanticReview: z.object({ verdict: z.literal('PASS'), issues: z.tuple([]) }).strict(),
  customerAnswers: z.array(decisionContentSchema),
}).strict()

export type CanonicalPlanContent = z.infer<typeof contentSchema>

export interface PlanSnapshot {
  id: string
  sourcePlanId: string
  sourcePlanVersion: number
  content: CanonicalPlanContent
  /** Timestamp and source-version context is retained for audit, outside content identity. */
  answerAudit: CustomerAnswer[]
  planHash: { algorithm: 'sha256'; schemaVersion: 1; value: string }
  approval: PlanApproval
  frozenAt: string
  supersedesSnapshotId: string | null
}

const snapshotSchema = z.object({
  id: z.string().uuid(), sourcePlanId: z.string().uuid(), sourcePlanVersion: z.number().int().positive(),
  content: contentSchema,
  answerAudit: z.array(answerSchema),
  planHash: z.object({ algorithm: z.literal('sha256'), schemaVersion: z.literal(1), value: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  approval: z.object({ planId: z.string(), planVersion: z.number().int().positive(), approvedAt: z.iso.datetime(),
    actor: z.literal('customer'), source: z.enum(['customer_mode', 'planning_service']), contentHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  frozenAt: z.iso.datetime(), supersedesSnapshotId: z.string().uuid().nullable(),
}).strict()

/** Object keys are lexical; arrays retain their documented sequence (tasks, clauses, dependencies, assertions and decisions are ordered). */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`).join(',')}}`
  }
  throw new Error('Plan content contains an unsupported or undefined value.')
}

/** Explicit projection excludes createdAt, updatedAt, approvedAt, answeredAt, provider usage and all runtime metadata. */
export function canonicalPlanContent(plan: DevelopmentPlan): CanonicalPlanContent {
  return contentSchema.parse({
    clauses: plan.clauses, analysis: plan.analysis, productScope: plan.productScope,
    architecture: plan.architecture, tasks: plan.tasks, acceptancePlan: plan.acceptancePlan,
    risks: plan.risks, assumptions: plan.assumptions, customerQuestions: plan.customerQuestions,
    requirement: { text: plan.requirement.text, revisionNotes: plan.requirement.revisionNotes ?? [] },
    dependencies: plan.dependencies, coverage: plan.coverage,
    semanticReview: plan.semanticReview,
    customerAnswers: (plan.customerAnswers ?? []).map(({ answeredAt: _answeredAt, sourcePlanVersion: _sourcePlanVersion, ...decision }) => decision),
  })
}

export function planContentHash(content: CanonicalPlanContent): string {
  return createHash('sha256').update('novawing-plan-content-v1\0').update(canonicalSerialize(content)).digest('hex')
}

export function createPlanSnapshot(plan: DevelopmentPlan, approval: PlanApproval, supersedesSnapshotId: string | null): PlanSnapshot {
  const content = canonicalPlanContent(plan)
  const hash = planContentHash(content)
  if (approval.planId !== plan.id || approval.planVersion !== plan.version || approval.contentHash !== hash) {
    throw new Error('Approval is not bound to this exact plan content and version.')
  }
  const snapshot: PlanSnapshot = {
    id: randomUUID(), sourcePlanId: plan.id, sourcePlanVersion: plan.version, content,
    answerAudit: plan.customerAnswers ?? [],
    planHash: { algorithm: 'sha256', schemaVersion: 1, value: hash }, approval,
    frozenAt: new Date().toISOString(), supersedesSnapshotId,
  }
  verifyPlanSnapshot(snapshot)
  return snapshot
}

/** Throws an integrity failure. Call on every frozen read, including after restart. */
export function verifyPlanSnapshot(input: unknown): PlanSnapshot {
  const parsed = snapshotSchema.safeParse(input)
  if (!parsed.success) throw new Error('Plan snapshot integrity failure: invalid schema.')
  const snapshot = parsed.data
  if (planContentHash(snapshot.content) !== snapshot.planHash.value || snapshot.approval.contentHash !== snapshot.planHash.value) {
    throw new Error('Plan snapshot integrity failure: content hash mismatch.')
  }
  if (snapshot.approval.planId !== snapshot.sourcePlanId || snapshot.approval.planVersion !== snapshot.sourcePlanVersion) {
    throw new Error('Plan snapshot integrity failure: approval version mismatch.')
  }
  const answers = snapshot.answerAudit
  const projectedAnswers = answers.map(({ answeredAt: _answeredAt, sourcePlanVersion: _sourcePlanVersion, ...decision }) => decision)
  if (canonicalSerialize(projectedAnswers) !== canonicalSerialize(snapshot.content.customerAnswers)) {
    throw new Error('Plan snapshot integrity failure: customer answer audit mismatch.')
  }
  const unique = new Set<string>()
  for (const answer of answers) {
    const key = `${answer.sourcePlanVersion}:${answer.questionId}`
    const index = Number(answer.selectedOptionId.slice('option-'.length)) - 1
    if (unique.has(key) || answer.sourcePlanVersion >= snapshot.sourcePlanVersion ||
      answer.question.id !== answer.questionId || !answer.question.blocking || answer.question.options[index] !== answer.selectedOptionText) {
      throw new Error('Plan snapshot integrity failure: invalid customer decision.')
    }
    unique.add(key)
  }
  const content = snapshot.content
  const reconstructed: DevelopmentPlan = {
    ...content, id: snapshot.sourcePlanId, version: snapshot.sourcePlanVersion, status: 'frozen',
    requirement: { id: snapshot.sourcePlanId, text: content.requirement.text, receivedAt: snapshot.frozenAt,
      revisionNotes: content.requirement.revisionNotes },
    semanticReview: { verdict: 'PASS', issues: [] }, frozenAt: snapshot.frozenAt,
    createdAt: snapshot.frozenAt, updatedAt: snapshot.frozenAt, approvedAt: snapshot.approval.approvedAt,
    customerAnswers: answers as CustomerAnswer[], approval: snapshot.approval,
  }
  if (content.customerQuestions.some((question) => question.blocking) || !validateDevelopmentPlan(reconstructed).pass) {
    throw new Error('Plan snapshot integrity failure: planning gates do not pass.')
  }
  const expectedDependencies = content.tasks.flatMap((task) => task.dependencyIds.map((id) => ({ fromTaskId: id, toTaskId: task.id })))
  if (canonicalSerialize(expectedDependencies) !== canonicalSerialize(content.dependencies)) {
    throw new Error('Plan snapshot integrity failure: dependency graph mismatch.')
  }
  return snapshot
}
