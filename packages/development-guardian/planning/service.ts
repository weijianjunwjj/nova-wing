import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { planDraftSchema, semanticReviewSchema, createDevelopmentPlan, type DevelopmentPlan } from './model.js'
import { validateDevelopmentPlan, type PlanValidation } from './validator.js'
import { PlanningEventStore, type NovaWingEvent } from './telemetry.js'
import type { PlanningModelProvider } from './provider.js'
import type { PlanningSemanticReviewer } from './semantic-reviewer.js'

const MAX_REQUIREMENT_CHARS = 20_000
const MAX_FEEDBACK_CHARS = 4_000

export class PlanningInputError extends Error {}

function hasPassedApprovalGates(plan: DevelopmentPlan): boolean {
  return plan.semanticReview?.verdict === 'PASS' && plan.semanticReview.issues.length === 0 &&
    Array.isArray(plan.customerQuestions) && !plan.customerQuestions.some((question) => question.blocking) &&
    validateDevelopmentPlan(plan).pass
}

export class PlanningStore {
  constructor(readonly directory: string) {}

  async save(plan: DevelopmentPlan): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, `${plan.id}.json`)
    const temporary = join(this.directory, `.${plan.id}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, path)
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  async get(id: string): Promise<DevelopmentPlan | undefined> {
    if (!/^[a-f0-9-]{36}$/u.test(id)) return undefined
    const raw = await readFile(join(this.directory, `${id}.json`), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return undefined
    const plan = JSON.parse(raw) as DevelopmentPlan
    // A Phase 1 draft persisted before assertion/semantic gates must not keep a
    // historical ready-for-approval badge after the quality contract changes.
    if (plan.status === 'ready_for_approval' && !hasPassedApprovalGates(plan)) {
      return { ...plan, status: 'planning_failed' }
    }
    return plan
  }

  async list(): Promise<DevelopmentPlan[]> {
    const entries = await readdir(this.directory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    const plans = await Promise.all(entries.filter((entry) => /^[a-f0-9-]{36}\.json$/u.test(entry)).map((entry) => this.get(entry.slice(0, -5))))
    return plans.filter((plan): plan is DevelopmentPlan => plan !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

export class PlanningService {
  private readonly activePlanIds = new Set<string>()
  constructor(
    private readonly provider: PlanningModelProvider,
    private readonly store: PlanningStore,
    private readonly events: PlanningEventStore,
    private readonly semanticReviewer: PlanningSemanticReviewer,
  ) {}

  async generate(text: string, revision?: { planId: string; feedback: string }): Promise<{ plan: DevelopmentPlan; validation: PlanValidation }> {
    if (text.trim().length < 20 || text.length > MAX_REQUIREMENT_CHARS) throw new PlanningInputError('Requirement must be 20–20,000 characters.')
    if (revision !== undefined && (revision.feedback.trim().length === 0 || revision.feedback.length > MAX_FEEDBACK_CHARS)) throw new PlanningInputError('Revision feedback must be 1–4,000 characters.')
    const previous = revision === undefined ? undefined : await this.store.get(revision.planId)
    if (revision !== undefined && previous === undefined) throw new PlanningInputError('Unknown plan to revise.')
    if (previous?.status === 'approved') throw new PlanningInputError('An approved plan cannot be revised in Phase 1.')
    if (previous !== undefined && previous.requirement.text !== text) throw new PlanningInputError('Revision must use the original requirement.')
    const id = previous?.id ?? randomUUID()
    if (this.activePlanIds.has(id)) throw new PlanningInputError('Planning session is busy.')
    this.activePlanIds.add(id)
    try {
      const requirement = previous === undefined
        ? { id: randomUUID(), text, receivedAt: new Date().toISOString(), revisionNotes: [] }
        : { ...previous.requirement, revisionNotes: [...(previous.requirement.revisionNotes ?? []), ...(revision === undefined ? [] : [revision.feedback])] }
      const emit = (type: NovaWingEvent['type'], actorRole: NovaWingEvent['actorRole'], metadata: NovaWingEvent['metadata'] = {}): Promise<void> => this.events.append({ planningSessionId: id, type, actorRole, metadata })
      if (previous === undefined) await emit('requirement.received', 'customer')
      await emit('planning.started', 'planning', { planVersion: (previous?.version ?? 0) + 1 })
      let validationFeedback: string | undefined
      let priorDraft: string | undefined
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await emit('planning.repair.started', 'planning', { repairCount: attempt })
        const started = Date.now()
        const response = await this.provider({
          requirement: text,
          ...(requirement.revisionNotes.length === 0 ? {} : { revisionFeedback: requirement.revisionNotes.join('\n\n') }),
          ...(validationFeedback === undefined ? {} : { validationFeedback }),
          ...(priorDraft === undefined ? {} : { priorDraft }),
        })
        if (attempt > 0) await this.events.append({ planningSessionId: id, type: 'planning.repair.completed', actorRole: 'planning',
          durationMs: Date.now() - started, metadata: { repairCount: attempt } })
        const body = response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
        // A detailed assertion plan can exceed 64 KB. Truncating it would turn
        // the repair context into invalid JSON and encourage lossy regeneration.
        priorDraft = body
        let raw: unknown
        try { raw = JSON.parse(body) as unknown } catch {
          await emit('plan.validation_failed', 'validator', { issueCount: 1 })
          if (attempt < 2) { validationFeedback = 'Return one valid JSON object matching the required schema.'; continue }
          throw new PlanningInputError('Planning model returned invalid JSON after retry.')
        }
        const parsed = planDraftSchema.safeParse(raw)
        if (!parsed.success) {
          await emit('plan.validation_failed', 'validator', { issueCount: parsed.error.issues.length })
          if (attempt < 2) {
            validationFeedback = parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
            continue
          }
          throw new PlanningInputError('Planning model returned an invalid plan after retry.')
        }
        await emit('requirement.analyzed', 'planning', { clauseCount: parsed.data.clauses.length })
        const plan = createDevelopmentPlan(parsed.data, requirement, id, (previous?.version ?? 0) + 1)
        const validation = validateDevelopmentPlan(plan)
        await this.events.append({
          planningSessionId: id, type: 'development_plan.generated', actorRole: 'planning',
          ...(response.provider === undefined ? {} : { provider: response.provider }),
          ...(response.model === undefined ? {} : { model: response.model }),
          durationMs: Date.now() - started,
          ...(response.inputTokens === undefined && response.outputTokens === undefined && response.cachedTokens === undefined ? {} : { usage: {
            ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
            ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
            ...(response.cachedTokens === undefined ? {} : { cachedTokens: response.cachedTokens }),
          } }),
          ...(response.estimatedCost === undefined ? {} : { estimatedCost: response.estimatedCost }),
          metadata: { planVersion: plan.version, taskCount: plan.tasks.length },
        })
        await emit(validation.pass ? 'plan.validation_passed' : 'plan.validation_failed', 'validator', { issueCount: validation.issues.length })
        if (!validation.pass) {
          if (attempt < 2) {
            validationFeedback = validation.issues.slice(0, 30).map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('\n')
            continue
          }
          plan.status = 'planning_failed'
          await this.store.save(plan)
          return { plan, validation }
        }
        await emit('planning.semantic_review.started', 'planning', { planVersion: plan.version })
        const reviewStarted = Date.now()
        try {
          const result = await this.semanticReviewer({ requirement: text, plan })
          const reviewed = semanticReviewSchema.parse(result.review)
          if ((reviewed.verdict === 'PASS') !== (reviewed.issues.length === 0)) throw new Error('Contradictory planning review.')
          plan.semanticReview = reviewed
          await this.events.append({
            planningSessionId: id,
            type: result.review.verdict === 'PASS' ? 'planning.semantic_review.passed' : 'planning.semantic_review.failed',
            actorRole: 'planning',
            ...(result.provider === undefined ? {} : { provider: result.provider }),
            ...(result.model === undefined ? {} : { model: result.model }),
            durationMs: Date.now() - reviewStarted,
            ...(result.inputTokens === undefined && result.outputTokens === undefined && result.cachedTokens === undefined ? {} : { usage: {
              ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
              ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
              ...(result.cachedTokens === undefined ? {} : { cachedTokens: result.cachedTokens }),
            } }),
            ...(result.estimatedCost === undefined ? {} : { estimatedCost: result.estimatedCost }),
            metadata: { planVersion: plan.version, issueCount: result.review.issues.length },
          })
        } catch {
          plan.semanticReview = { verdict: 'REVISION_REQUIRED', issues: [{
            code: 'REVIEW_UNAVAILABLE', path: 'semanticReview',
            message: 'Planning semantic review was unavailable; approval is blocked.', sourceExcerpt: '',
          }] }
          await this.events.append({ planningSessionId: id, type: 'planning.semantic_review.failed', actorRole: 'planning',
            durationMs: Date.now() - reviewStarted, metadata: { issueCount: 1 } })
          plan.status = 'planning_failed'
          await this.store.save(plan)
          return { plan, validation }
        }
        if (plan.semanticReview.verdict === 'REVISION_REQUIRED' && attempt < 2) {
          validationFeedback = plan.semanticReview.issues.slice(0, 30).map((issue) =>
            `${issue.code} at ${issue.path}: ${issue.message}${issue.sourceExcerpt ? ` [source: ${issue.sourceExcerpt}]` : ''}`).join('\n')
          continue
        }
        plan.status = plan.semanticReview.verdict === 'PASS'
          ? plan.customerQuestions.some((question) => question.blocking) ? 'needs_customer_input' : 'ready_for_approval'
          : 'planning_failed'
        await this.store.save(plan)
        if (plan.status === 'needs_customer_input') await emit('customer_question.required', 'planning', { questionCount: plan.customerQuestions.filter((question) => question.blocking).length })
        return { plan, validation }
      }
      throw new PlanningInputError('Planning could not produce a valid plan.')
    } finally {
      this.activePlanIds.delete(id)
    }
  }

  async approve(id: string, version: number): Promise<DevelopmentPlan> {
    if (this.activePlanIds.has(id)) throw new PlanningInputError('Planning session is busy.')
    this.activePlanIds.add(id)
    try {
      const plan = await this.store.get(id)
      if (plan === undefined || plan.version !== version) throw new PlanningInputError('Plan or version is unavailable.')
      if (plan.status !== 'ready_for_approval' || !hasPassedApprovalGates(plan)) {
        throw new PlanningInputError('Plan is not ready for approval.')
      }
      plan.status = 'approved'
      plan.approvedAt = new Date().toISOString()
      plan.updatedAt = plan.approvedAt
      await this.store.save(plan)
      await this.events.append({ planningSessionId: id, type: 'plan.approved', actorRole: 'customer', metadata: { planVersion: version } })
      return plan
    } finally {
      this.activePlanIds.delete(id)
    }
  }

  get(id: string): Promise<DevelopmentPlan | undefined> { return this.store.get(id) }
  list(): Promise<DevelopmentPlan[]> { return this.store.list() }
}
