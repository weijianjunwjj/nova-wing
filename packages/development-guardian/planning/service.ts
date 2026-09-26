import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { planDraftSchema, createDevelopmentPlan, type DevelopmentPlan } from './model.js'
import { validateDevelopmentPlan, type PlanValidation } from './validator.js'
import { PlanningEventStore, type NovaWingEvent } from './telemetry.js'
import type { PlanningModelProvider } from './provider.js'

const MAX_REQUIREMENT_CHARS = 20_000
const MAX_FEEDBACK_CHARS = 4_000

export class PlanningInputError extends Error {}

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
    return raw === undefined ? undefined : JSON.parse(raw) as DevelopmentPlan
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
  constructor(private readonly provider: PlanningModelProvider, private readonly store: PlanningStore, private readonly events: PlanningEventStore) {}

  async generate(text: string, revision?: { planId: string; feedback: string }): Promise<{ plan: DevelopmentPlan; validation: PlanValidation }> {
    if (text.trim().length < 20 || text.length > MAX_REQUIREMENT_CHARS) throw new PlanningInputError('Requirement must be 20–20,000 characters.')
    if (revision !== undefined && (revision.feedback.trim().length === 0 || revision.feedback.length > MAX_FEEDBACK_CHARS)) throw new PlanningInputError('Revision feedback must be 1–4,000 characters.')
    const previous = revision === undefined ? undefined : await this.store.get(revision.planId)
    if (revision !== undefined && previous === undefined) throw new PlanningInputError('Unknown plan to revise.')
    if (previous?.status === 'approved') throw new PlanningInputError('An approved plan cannot be revised in Phase 1.')
    if (previous !== undefined && previous.requirement.text !== text) throw new PlanningInputError('Revision must use the original requirement.')
    const id = previous?.id ?? randomUUID()
    const requirement = previous === undefined
      ? { id: randomUUID(), text, receivedAt: new Date().toISOString(), revisionNotes: [] }
      : { ...previous.requirement, revisionNotes: [...(previous.requirement.revisionNotes ?? []), ...(revision === undefined ? [] : [revision.feedback])] }
    const emit = (type: NovaWingEvent['type'], actorRole: NovaWingEvent['actorRole'], metadata: NovaWingEvent['metadata'] = {}): Promise<void> => this.events.append({ planningSessionId: id, type, actorRole, metadata })
    if (previous === undefined) await emit('requirement.received', 'customer')
    await emit('planning.started', 'planning', { planVersion: (previous?.version ?? 0) + 1 })
    const started = Date.now()
    const response = await this.provider({ requirement: text, ...(requirement.revisionNotes.length === 0 ? {} : { revisionFeedback: requirement.revisionNotes.join('\n\n') }) })
    const body = response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    let raw: unknown
    try { raw = JSON.parse(body) as unknown } catch { throw new PlanningInputError('Planning model returned invalid JSON.') }
    const parsed = planDraftSchema.safeParse(raw)
    if (!parsed.success) throw new PlanningInputError(`Planning model returned an invalid plan: ${parsed.error.issues[0]?.path.join('.') ?? 'unknown field'}`)
    await emit('requirement.analyzed', 'planning', { clauseCount: parsed.data.clauses.length })
    // Keep source quotes exact. A model can double-escape line breaks or append
    // a later sentence while omitting an intervening one. In the latter case,
    // retain only a sufficiently long verbatim prefix; otherwise validation fails.
    const sources = [requirement.text, ...requirement.revisionNotes]
    for (const clause of parsed.data.clauses) {
      if (sources.some((source) => source.includes(clause.source.excerpt))) continue
      const normalized = clause.source.excerpt.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n')
      if (sources.some((source) => source.includes(normalized))) { clause.source.excerpt = normalized; continue }
      let longest = ''
      for (const source of sources) {
        const anchor = normalized.slice(0, Math.min(30, normalized.length))
        const start = source.indexOf(anchor)
        if (start < 0) continue
        let length = 0
        while (length < normalized.length && source[start + length] === normalized[length]) length += 1
        if (length > longest.length) longest = normalized.slice(0, length).trimEnd()
      }
      if (longest.length >= 60 && longest.length / normalized.length >= 0.75) clause.source.excerpt = longest
    }
    const plan = createDevelopmentPlan(parsed.data, requirement, id, (previous?.version ?? 0) + 1)
    const validation = validateDevelopmentPlan(plan)
    plan.status = validation.pass
      ? plan.customerQuestions.some((question) => question.blocking) ? 'needs_customer_input' : 'ready_for_approval'
      : 'draft'
    await this.store.save(plan)
    await this.events.append({
      planningSessionId: id, type: 'development_plan.generated', actorRole: 'planning',
      ...(response.provider === undefined ? {} : { provider: response.provider }),
      ...(response.model === undefined ? {} : { model: response.model }),
      durationMs: Date.now() - started,
      usage: { ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }), ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }), ...(response.cachedTokens === undefined ? {} : { cachedTokens: response.cachedTokens }) },
      ...(response.estimatedCost === undefined ? {} : { estimatedCost: response.estimatedCost }),
      metadata: { planVersion: plan.version, taskCount: plan.tasks.length },
    })
    await emit(validation.pass ? 'plan.validation_passed' : 'plan.validation_failed', 'validator', { issueCount: validation.issues.length })
    if (plan.status === 'needs_customer_input') await emit('customer_question.required', 'planning', { questionCount: plan.customerQuestions.filter((question) => question.blocking).length })
    return { plan, validation }
  }

  async approve(id: string, version: number): Promise<DevelopmentPlan> {
    const plan = await this.store.get(id)
    if (plan === undefined || plan.version !== version) throw new PlanningInputError('Plan or version is unavailable.')
    if (plan.status !== 'ready_for_approval' || !validateDevelopmentPlan(plan).pass) throw new PlanningInputError('Plan is not ready for approval.')
    plan.status = 'approved'
    plan.approvedAt = new Date().toISOString()
    plan.updatedAt = plan.approvedAt
    await this.store.save(plan)
    await this.events.append({ planningSessionId: id, type: 'plan.approved', actorRole: 'customer', metadata: { planVersion: version } })
    return plan
  }

  get(id: string): Promise<DevelopmentPlan | undefined> { return this.store.get(id) }
  list(): Promise<DevelopmentPlan[]> { return this.store.list() }
}
