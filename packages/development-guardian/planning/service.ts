import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { planDraftSchema, semanticReviewSchema, createDevelopmentPlan, type CustomerAnswer, type DevelopmentPlan, type PlanChangeRequest } from './model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, verifyPlanSnapshot, type PlanSnapshot } from './freeze.js'
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

  private path(id: string, suffix = ''): string { return join(this.directory, `${id}${suffix}.json`) }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, path)
    } finally {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async writeOnce(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync() }
    finally { await handle.close() }
  }

  async save(plan: DevelopmentPlan): Promise<void> {
    if (await this.getSnapshot(plan.id, plan.version)) throw new PlanningInputError('Frozen plan version cannot be overwritten.')
    const current = await this.get(plan.id)
    if (current?.status === 'frozen' && plan.version <= current.version) throw new PlanningInputError('Frozen plan cannot be overwritten.')
    if (current !== undefined && plan.version < current.version) throw new PlanningInputError('Older plan version cannot be overwritten.')
    await this.writeAtomic(this.path(plan.id, `.v${plan.version}.plan`), plan)
    await this.writeAtomic(this.path(plan.id), plan)
  }

  async saveFrozen(plan: DevelopmentPlan, snapshot: PlanSnapshot): Promise<void> {
    verifyPlanSnapshot(snapshot)
    if (plan.id !== snapshot.sourcePlanId || plan.version !== snapshot.sourcePlanVersion || plan.status !== 'frozen') {
      throw new PlanningInputError('Frozen plan and snapshot mismatch.')
    }
    await this.writeOnce(this.path(plan.id, `.v${plan.version}.snapshot`), snapshot)
    await this.writeAtomic(this.path(plan.id, `.v${plan.version}.plan`), plan)
    await this.writeAtomic(this.path(plan.id), plan)
  }

  async getSnapshot(id: string, version: number): Promise<PlanSnapshot | undefined> {
    if (!/^[a-f0-9-]{36}$/u.test(id) || !Number.isSafeInteger(version) || version < 1) return undefined
    const raw = await readFile(this.path(id, `.v${version}.snapshot`), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return undefined
    try { return verifyPlanSnapshot(JSON.parse(raw) as unknown) }
    catch { throw new Error('Plan snapshot integrity failure: unreadable or invalid snapshot.') }
  }

  private frozenView(plan: DevelopmentPlan, snapshot: PlanSnapshot | undefined): DevelopmentPlan {
    if (snapshot === undefined) {
      if (plan.status === 'frozen') throw new Error('Plan snapshot integrity failure: frozen record has no snapshot.')
      return plan
    }
    let contentHash: string
    try { contentHash = planContentHash(canonicalPlanContent(plan)) }
    catch { throw new Error('Plan snapshot integrity failure: current plan content is invalid.') }
    if (contentHash !== snapshot.planHash.value) throw new Error('Plan snapshot integrity failure: current plan content mismatch.')
    if (plan.status === 'ready_for_approval' && plan.approval === undefined) {
      // Exclusive snapshot creation committed before the mutable current-file update.
      // Recover the frozen read view after a process interruption in that window.
      return { ...plan, status: 'frozen', approval: snapshot.approval,
        approvedAt: snapshot.approval.approvedAt, frozenAt: snapshot.frozenAt, updatedAt: snapshot.frozenAt }
    }
    if (plan.status !== 'frozen' || JSON.stringify(plan.approval) !== JSON.stringify(snapshot.approval) ||
      plan.frozenAt !== snapshot.frozenAt) {
      throw new Error('Plan snapshot integrity failure: current plan record mismatch.')
    }
    return plan
  }

  async getVersion(id: string, version: number): Promise<DevelopmentPlan | undefined> {
    if (!/^[a-f0-9-]{36}$/u.test(id) || !Number.isSafeInteger(version) || version < 1) return undefined
    const raw = await readFile(this.path(id, `.v${version}.plan`), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return undefined
    const plan = JSON.parse(raw) as DevelopmentPlan
    const snapshot = await this.getSnapshot(id, version)
    const frozen = this.frozenView(plan, snapshot)
    if (snapshot === undefined) return frozen
    const current = await this.get(id)
    for (let next = version + 1; next <= (current?.version ?? version); next += 1) {
      if ((await this.getSnapshot(id, next))?.supersedesSnapshotId === snapshot.id) return { ...frozen, status: 'superseded' }
    }
    return frozen
  }

  async saveAnswers(id: string, version: number, answers: CustomerAnswer[]): Promise<void> {
    await this.writeOnce(this.path(id, `.v${version}.answers`), answers)
  }

  async getAnswers(id: string, version: number): Promise<CustomerAnswer[] | undefined> {
    const raw = await readFile(this.path(id, `.v${version}.answers`), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    return raw === undefined ? undefined : JSON.parse(raw) as CustomerAnswer[]
  }

  async saveChange(request: PlanChangeRequest): Promise<void> {
    await this.writeOnce(this.path(request.baseFrozenPlanId, `.change-${request.id}`), request)
  }

  async getChange(planId: string, changeId: string): Promise<PlanChangeRequest | undefined> {
    if (!/^[a-f0-9-]{36}$/u.test(changeId)) return undefined
    const raw = await readFile(this.path(planId, `.change-${changeId}`), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    return raw === undefined ? undefined : JSON.parse(raw) as PlanChangeRequest
  }

  async markChangeRevisionStarted(request: PlanChangeRequest): Promise<void> {
    const current = await this.getChange(request.baseFrozenPlanId, request.id)
    if (current === undefined || current.baseVersion !== request.baseVersion || current.status !== 'requested') {
      throw new PlanningInputError('Change request is no longer available for revision.')
    }
    await this.writeAtomic(this.path(request.baseFrozenPlanId, `.change-${request.id}`), { ...current, status: 'revision_started' })
  }

  async get(id: string): Promise<DevelopmentPlan | undefined> {
    if (!/^[a-f0-9-]{36}$/u.test(id)) return undefined
    const raw = await readFile(this.path(id), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return undefined
    const parsed = JSON.parse(raw) as DevelopmentPlan
    const plan = this.frozenView(parsed, await this.getSnapshot(id, parsed.version))
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

  async generate(text: string, revision?: { planId: string; feedback?: string; expectedVersion?: number; changeRequestId?: string }): Promise<{ plan: DevelopmentPlan; validation: PlanValidation }> {
    if (text.trim().length < 20 || text.length > MAX_REQUIREMENT_CHARS) throw new PlanningInputError('Requirement must be 20–20,000 characters.')
    if (revision?.feedback !== undefined && (revision.feedback.trim().length === 0 || revision.feedback.length > MAX_FEEDBACK_CHARS)) throw new PlanningInputError('Revision feedback must be 1–4,000 characters.')
    const previous = revision === undefined ? undefined : await this.store.get(revision.planId)
    if (revision !== undefined && previous === undefined) throw new PlanningInputError('Unknown plan to revise.')
    if (previous !== undefined && revision?.expectedVersion !== undefined && previous.version !== revision.expectedVersion) throw new PlanningInputError('Stale plan version for revision.')
    if (previous?.status === 'approved') throw new PlanningInputError('Legacy approved plan cannot be revised without a frozen snapshot.')
    if (previous !== undefined && previous.requirement.text !== text) throw new PlanningInputError('Revision must use the original requirement.')
    const pendingAnswers = previous === undefined ? undefined : await this.store.getAnswers(previous.id, previous.version)
    const change = previous?.status === 'frozen' && revision?.changeRequestId !== undefined
      ? await this.store.getChange(previous.id, revision.changeRequestId) : undefined
    if (previous?.status === 'frozen' && (change === undefined || change.baseVersion !== previous.version || change.status !== 'requested')) {
      throw new PlanningInputError('Frozen plan requires a matching change request.')
    }
    if (revision !== undefined && revision.feedback === undefined && pendingAnswers === undefined && change === undefined) {
      throw new PlanningInputError('Revision requires feedback, customer answers, or a change request.')
    }
    const id = previous?.id ?? randomUUID()
    if (this.activePlanIds.has(id)) throw new PlanningInputError('Planning session is busy.')
    this.activePlanIds.add(id)
    try {
      const decisionNotes = pendingAnswers?.map((answer) =>
        `Customer decision for ${answer.questionId}: ${answer.question.question} Selected: ${answer.selectedOptionText}${answer.freeformAnswer === undefined ? '' : `; ${answer.freeformAnswer}`}`) ?? []
      const revisionNotes = [...decisionNotes, ...(revision?.feedback === undefined ? [] : [revision.feedback]),
        ...(change === undefined ? [] : [`Customer change request: ${change.requestedChange}`])]
      const requirement = previous === undefined
        ? { id: randomUUID(), text, receivedAt: new Date().toISOString(), revisionNotes: [] }
        : { ...previous.requirement, revisionNotes: [...(previous.requirement.revisionNotes ?? []), ...revisionNotes] }
      const emit = (type: NovaWingEvent['type'], actorRole: NovaWingEvent['actorRole'], metadata: NovaWingEvent['metadata'] = {}): Promise<void> => this.events.append({ planningSessionId: id, type, actorRole, metadata })
      if (previous === undefined) await emit('requirement.received', 'customer')
      const revisionStartedAt = Date.now()
      const emitRevisionCompleted = (version: number): Promise<void> => previous === undefined ? Promise.resolve() : this.events.append({
        planningSessionId: id, type: 'plan.revision.completed', actorRole: 'planning',
        durationMs: Date.now() - revisionStartedAt, metadata: { planVersion: version },
      })
      await emit(previous === undefined ? 'planning.started' : 'plan.revision.started', 'planning', { planVersion: (previous?.version ?? 0) + 1 })
      let validationFeedback: string | undefined
      let priorDraft: string | undefined = previous === undefined ? undefined : JSON.stringify({
        clauses: previous.clauses, analysis: previous.analysis, productScope: previous.productScope,
        architecture: previous.architecture, tasks: previous.tasks, acceptancePlan: previous.acceptancePlan,
        risks: previous.risks, assumptions: previous.assumptions, customerQuestions: previous.customerQuestions,
      })
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
        plan.customerAnswers = [...(previous?.customerAnswers ?? []), ...(pendingAnswers ?? [])]
        plan.supersedesSnapshotId = previous?.status === 'frozen'
          ? (await this.store.getSnapshot(previous.id, previous.version))?.id ?? null
          : previous?.supersedesSnapshotId ?? null
        const validation = validateDevelopmentPlan(plan)
        if (previous !== undefined && pendingAnswers !== undefined && pendingAnswers.length > 0) {
          const businessContract = (item: DevelopmentPlan): string => JSON.stringify({
            clauses: item.clauses, analysis: item.analysis, productScope: item.productScope,
            architecture: item.architecture, tasks: item.tasks, acceptancePlan: item.acceptancePlan,
            risks: item.risks, assumptions: item.assumptions,
          })
          if (businessContract(plan) === businessContract(previous)) {
            validation.pass = false
            validation.issues.push({ code: 'CUSTOMER_DECISIONS_NOT_INCORPORATED', path: 'plan',
              message: 'Customer answers require a substantive revised planning contract before approval.' })
          }
        }
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
          if (change !== undefined) await this.store.markChangeRevisionStarted(change)
          await emitRevisionCompleted(plan.version)
          return { plan, validation }
        }
        await emit('planning.semantic_review.started', 'planning', { planVersion: plan.version })
        const reviewStarted = Date.now()
        try {
          const result = await this.semanticReviewer({ requirement: [text, ...requirement.revisionNotes].join('\n\n'), plan })
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
          if (change !== undefined) await this.store.markChangeRevisionStarted(change)
          await emitRevisionCompleted(plan.version)
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
        if (change !== undefined) await this.store.markChangeRevisionStarted(change)
        if (plan.status === 'needs_customer_input') await emit('customer_question.required', 'planning', { questionCount: plan.customerQuestions.filter((question) => question.blocking).length })
        await emitRevisionCompleted(plan.version)
        if (plan.status === 'ready_for_approval') await emit('plan.ready_for_approval', 'planning', { planVersion: plan.version })
        return { plan, validation }
      }
      throw new PlanningInputError('Planning could not produce a valid plan.')
    } finally {
      this.activePlanIds.delete(id)
    }
  }

  async answerQuestions(id: string, version: number, selections: Array<{ questionId: string; selectedOptionId: string; freeformAnswer?: string }>): Promise<CustomerAnswer[]> {
    if (this.activePlanIds.has(id)) throw new PlanningInputError('Planning session is busy.')
    this.activePlanIds.add(id)
    try {
      const plan = await this.store.get(id)
      if (plan === undefined || plan.version !== version || plan.status !== 'needs_customer_input') throw new PlanningInputError('Question belongs to a different or unavailable plan version.')
      const blocking = plan.customerQuestions.filter((question) => question.blocking)
      if (selections.length !== blocking.length || new Set(selections.map((answer) => answer.questionId)).size !== blocking.length) {
        throw new PlanningInputError('Every current blocking question must be answered exactly once.')
      }
      const answers = selections.map((selection): CustomerAnswer => {
        const question = blocking.find((item) => item.id === selection.questionId)
        const optionIndex = /^option-[1-6]$/u.test(selection.selectedOptionId) ? Number(selection.selectedOptionId.slice(7)) - 1 : -1
        if (question === undefined || optionIndex < 0 || question.options[optionIndex] === undefined ||
          (selection.freeformAnswer !== undefined && selection.freeformAnswer.length > 2_000)) {
          throw new PlanningInputError('Answer must select an option for an existing blocking question.')
        }
        return { questionId: question.id, sourcePlanVersion: version, selectedOptionId: selection.selectedOptionId,
          selectedOptionText: question.options[optionIndex]!, question, ...(selection.freeformAnswer === undefined ? {} : { freeformAnswer: selection.freeformAnswer }),
          answeredAt: new Date().toISOString(), provenance: 'customer_decision' }
      })
      const existing = await this.store.getAnswers(id, version)
      if (existing !== undefined) {
        if (JSON.stringify(existing.map(({ answeredAt: _at, ...answer }) => answer)) ===
          JSON.stringify(answers.map(({ answeredAt: _at, ...answer }) => answer))) return existing
        throw new PlanningInputError('Customer decisions for this version are already recorded.')
      }
      await this.store.saveAnswers(id, version, answers)
      for (const answer of answers) await this.events.append({ planningSessionId: id, type: 'customer_question.answered', actorRole: 'customer',
        metadata: { planVersion: version, questionCount: 1, questionId: answer.questionId, selectedOptionId: answer.selectedOptionId } })
      return answers
    } finally { this.activePlanIds.delete(id) }
  }

  async approve(id: string, version: number): Promise<DevelopmentPlan> {
    if (this.activePlanIds.has(id)) throw new PlanningInputError('Planning session is busy.')
    this.activePlanIds.add(id)
    try {
      const plan = await this.store.get(id)
      if (plan === undefined || plan.version !== version) throw new PlanningInputError('Plan or version is unavailable.')
      if (plan.status === 'frozen') {
        await this.store.getSnapshot(id, version)
        return plan
      }
      if (plan.status !== 'ready_for_approval' || !hasPassedApprovalGates(plan)) {
        throw new PlanningInputError('Plan is not ready for approval.')
      }
      const started = Date.now()
      const contentHash = planContentHash(canonicalPlanContent(plan))
      const approval = { planId: id, planVersion: version, approvedAt: new Date().toISOString(),
        actor: 'customer' as const, source: 'customer_mode' as const, contentHash }
      await this.events.append({ planningSessionId: id, type: 'plan.approved', actorRole: 'customer', metadata: { planVersion: version } })
      await this.events.append({ planningSessionId: id, type: 'plan.freeze.started', actorRole: 'planning', metadata: { planVersion: version } })
      try {
        const snapshot = createPlanSnapshot(plan, approval, plan.supersedesSnapshotId ?? null)
        plan.status = 'frozen'
        plan.approval = approval
        plan.approvedAt = approval.approvedAt
        plan.frozenAt = snapshot.frozenAt
        plan.updatedAt = snapshot.frozenAt
        await this.store.saveFrozen(plan, snapshot)
        await this.events.append({ planningSessionId: id, type: 'plan.frozen', actorRole: 'planning',
          durationMs: Date.now() - started, metadata: { planVersion: version } })
        if (snapshot.supersedesSnapshotId !== null) await this.events.append({ planningSessionId: id, type: 'plan.superseded', actorRole: 'planning', metadata: { planVersion: version } })
      } catch (error) {
        await this.events.append({ planningSessionId: id, type: 'plan.freeze_failed', actorRole: 'planning',
          durationMs: Date.now() - started, metadata: { planVersion: version } })
        throw error
      }
      return plan
    } finally {
      this.activePlanIds.delete(id)
    }
  }

  get(id: string): Promise<DevelopmentPlan | undefined> { return this.store.get(id) }
  list(): Promise<DevelopmentPlan[]> { return this.store.list() }
  getSnapshot(id: string, version: number): Promise<PlanSnapshot | undefined> { return this.store.getSnapshot(id, version) }
  getVersion(id: string, version: number): Promise<DevelopmentPlan | undefined> { return this.store.getVersion(id, version) }

  async requestChange(id: string, version: number, reason: string, requestedChange: string): Promise<PlanChangeRequest> {
    if (!reason.trim() || reason.length > 2_000 || !requestedChange.trim() || requestedChange.length > 4_000) throw new PlanningInputError('Change reason and requested change are required.')
    const plan = await this.store.get(id)
    if (plan === undefined || plan.version !== version || plan.status !== 'frozen' || await this.store.getSnapshot(id, version) === undefined) {
      throw new PlanningInputError('Change request requires the current frozen version.')
    }
    const request: PlanChangeRequest = { id: randomUUID(), baseFrozenPlanId: id, baseVersion: version,
      reason, requestedChange, createdAt: new Date().toISOString(), status: 'requested' }
    await this.store.saveChange(request)
    await this.events.append({ planningSessionId: id, type: 'plan.change_requested', actorRole: 'customer', metadata: { planVersion: version } })
    return request
  }
}
