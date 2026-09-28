import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { scopedNodeTestPath } from '../verification-command-policy.js'
import { type PlanSnapshot, verifyPlanSnapshot } from '../planning/freeze.js'
import type { WorkSessionDefinition } from '../work-session/model.js'
import { collectCommandEvidence, collectFilesystemEvidence, collectHttpEvidence, collectProcessEvidence, collectScopeReviewEvidence,
  verifyCapabilityEvidence, type CapabilityEvidence, type ProviderAvailability } from './capability-layer.js'
import { assessCustomerDeliveryCompletion, bindProvisionedVerifier, taskCompletionGate, verifyBindingTransition,
  type AssertionCompletionEvidence, type VerificationBindingTransition } from './staged-verification.js'
import {
  admitRuntimePlan, bindDeliveryTarget, compileRuntimePlan, inspectDeliveryTarget, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity,
  workSessionDefinitionFor, type CompiledRuntimePlan, type DeliveryTargetBinding, type RuntimeAdmission,
  type VerificationCapabilityResolver,
} from './runtime-plan.js'
import { generateScopeManifest, inspectAtCommit, readRepositoryReviewMaterial } from './repo-capability-inspector.js'
import { verifyApprovedBlueprint, type ApprovedVerificationBlueprint } from './verification-blueprint.js'

export interface WorkSessionPlanBinding {
  workSessionId: string
  sourceSnapshotId: string
  sourcePlanHash: string
  runtimePlanId: string
  runtimePlanHash: string
  targetBindingId: string
  targetBaselineCommit: string
  compilerVersion: string
  createdAt: string
  status: 'STARTING' | 'STARTED'
}

export type DeliveryEventType = 'delivery.target_bound' | 'runtime_plan.compile_started' |
  'runtime_plan.compile_completed' | 'runtime_plan.compile_failed' | 'runtime_plan.admission_passed' |
  'runtime_plan.admission_blocked' | 'delivery.start_requested' | 'delivery.started' | 'work_session.created' |
  'verification_blueprint.plan_started' | 'verification_blueprint.generated' |
  'verification_blueprint.validation_failed' | 'verification_blueprint.review_failed' |
  'verification_blueprint.approved' | 'verification_blueprint.unresolved'

/** Closed event projection: paths, requirement text, prompts, responses and secrets cannot enter the file. */
export class DeliveryEventStore {
  constructor(readonly path: string) {}
  async append(type: DeliveryEventType, fields: { snapshotId: string; runtimePlanHash?: string;
    taskCount?: number; assertionCount?: number; blockerCount?: number; durationMs?: number;
    blueprintCount?: number; issueCount?: number; attempt?: number; hashPrefix?: string }): Promise<void> {
    const event = { id: randomUUID(), at: new Date().toISOString(), type,
      snapshotId: /^[a-f0-9-]{36}$/u.test(fields.snapshotId) ? fields.snapshotId : 'invalid',
      ...(fields.runtimePlanHash && /^[a-f0-9]{64}$/u.test(fields.runtimePlanHash)
        ? { runtimePlanHashPrefix: fields.runtimePlanHash.slice(0, 12) } : {}),
      ...(fields.hashPrefix && /^[a-f0-9]{12}$/u.test(fields.hashPrefix) ? { blueprintHashPrefix: fields.hashPrefix } : {}),
      ...Object.fromEntries((['taskCount', 'assertionCount', 'blockerCount', 'durationMs',
        'blueprintCount', 'issueCount', 'attempt'] as const)
        .filter((key) => Number.isSafeInteger(fields[key]) && fields[key]! >= 0).map((key) => [key, fields[key]])),
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600)
    try { await file.writeFile(`${JSON.stringify(event)}\n`) } finally { await file.close() }
  }
}

export class DeliveryStore {
  private readonly git = promisify(execFile)
  constructor(readonly directory: string) {}
  private obligationCommitKey(obligationId: string, commit: string): string {
    return createHash('sha256').update(`novawing-obligation-commit-v2\0${obligationId}\0${commit}`).digest('hex')
  }
  private path(kind: 'binding' | 'plan' | 'session' | 'evidence' | 'transition' | 'blueprint' |
    'local-completion' | 'local-completion-index', id: string): string {
    if (!/^[a-z0-9-]{36,120}$/u.test(id)) throw new Error('Invalid delivery artifact ID.')
    return join(this.directory, `${kind}-${id}.json`)
  }
  private async writeOnce(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
  }
  private async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  private async read<T>(path: string): Promise<T | undefined> {
    const raw = await readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    return raw === undefined ? undefined : JSON.parse(raw) as T
  }
  async saveBinding(binding: DeliveryTargetBinding): Promise<void> { await this.writeOnce(this.path('binding', binding.id), binding) }
  async getBinding(id: string): Promise<DeliveryTargetBinding | undefined> { return this.read(this.path('binding', id)) }
  async savePlan(plan: CompiledRuntimePlan): Promise<void> {
    verifyRuntimePlanIdentity(plan)
    const existing = await this.getPlan(plan.id)
    if (existing !== undefined) { verifyRuntimePlanIdentity(existing); return }
    await this.writeOnce(this.path('plan', plan.id), plan)
  }
  async getPlan(id: string): Promise<CompiledRuntimePlan | undefined> {
    const plan = await this.read<CompiledRuntimePlan>(this.path('plan', id))
    if (plan !== undefined) verifyRuntimePlanIdentity(plan)
    return plan
  }
  async saveCapabilityEvidence(plan: CompiledRuntimePlan, item: CapabilityEvidence): Promise<void> {
    verifyRuntimePlanIdentity(plan)
    verifyCapabilityEvidence(item)
    if (!plan.acceptanceBindings.some((binding) => binding.assertionId === item.assertionId &&
      binding.verificationCapability.family === item.family &&
      binding.verificationCapability.providerId === item.providerId &&
      binding.verificationCapability.providerVersion === item.providerVersion)) {
      throw new Error('Evidence does not belong to a compiled assertion capability.')
    }
    const path = this.path('evidence', createHash('sha256').update(`${plan.id}\0${item.id}`).digest('hex'))
    const existing = await this.read<{ runtimePlanHash: string; evidence: CapabilityEvidence }>(path)
    if (existing !== undefined) {
      if (existing.runtimePlanHash !== plan.runtimePlanHash || JSON.stringify(existing.evidence) !== JSON.stringify(item))
        throw new Error('Persisted capability evidence identity collision.')
      return
    }
    await this.writeOnce(path, { runtimePlanHash: plan.runtimePlanHash, evidence: item })
  }
  async getCapabilityEvidence(plan: CompiledRuntimePlan, id: string): Promise<CapabilityEvidence | undefined> {
    verifyRuntimePlanIdentity(plan)
    const key = createHash('sha256').update(`${plan.id}\0${id}`).digest('hex')
    const stored = await this.read<{ runtimePlanHash: string; evidence: CapabilityEvidence }>(this.path('evidence', key))
    if (stored === undefined) return undefined
    verifyCapabilityEvidence(stored.evidence)
    if (stored.runtimePlanHash !== plan.runtimePlanHash || stored.evidence.id !== id) {
      throw new Error('Capability evidence is bound to another RuntimePlan.')
    }
    return stored.evidence
  }
  async bindProvisionedVerifier(plan: CompiledRuntimePlan, assertionId: string,
    runtimeTaskId: string, blueprint: ApprovedVerificationBlueprint): Promise<VerificationBindingTransition> {
    verifyRuntimePlanIdentity(plan)
    const obligation = plan.acceptanceBindings.find((binding) => binding.assertionId === assertionId &&
      binding.runtimeTaskId === runtimeTaskId && binding.blocking && binding.ownership === 'OWNER')?.stagedVerification.obligation
    if (obligation === undefined) throw new Error('No exact blocking verification obligation exists.')
    const facts = await inspectAtCommit(plan.targetBinding, blueprint.implementationCommit ?? '')
    const criterion = plan.acceptanceCriteria.find((item) => item.id === obligation.criterionId)!
    const assertion = criterion.assertions.find((item) => item.id === assertionId)!
    const verifier = blueprint.plannedVerifier
    if (!verifier) throw new Error('Approved blueprint has no exact verifier.')
    const paths = verifier.family === 'command' ? [scopedNodeTestPath(verifier.command)!] :
      verifier.family === 'scope_review' && verifier.command ? [scopedNodeTestPath(verifier.command)!] :
      verifier.family === 'process' ? [verifier.relativeEntry] : []
    const reviewMaterial = await readRepositoryReviewMaterial(plan.targetBinding, facts, paths)
    verifyApprovedBlueprint(blueprint, { assertion, criterion, runtimeTaskId, target: plan.targetBinding,
      obligation, implementationCommit: facts.implementationCommit,
      artifactSources: Object.fromEntries(reviewMaterial.map((item) => [item.path, item.source])),
      scopeManifestHash: generateScopeManifest(facts).sha256 })
    if (Object.entries(blueprint.artifactHashes ?? {}).some(([path, hash]) =>
      (path === 'NOVAWING_SCOPE_MANIFEST' ? generateScopeManifest(facts).sha256 : facts.artifactHashes[path]) !== hash))
      throw new Error('Blueprint artifact hash changed.')
    const transition = bindProvisionedVerifier({ runtimePlanHash: plan.runtimePlanHash, obligation,
      approvedBlueprint: blueprint, implementationCommit: facts.implementationCommit,
      artifactHashes: blueprint.artifactHashes ?? {} })
    if (verifier.family === 'command' || verifier.family === 'process' ||
      (verifier.family === 'scope_review' && verifier.command)) {
      const relativePath = verifier.family === 'command' ? scopedNodeTestPath(verifier.command)! :
        verifier.family === 'scope_review' ? scopedNodeTestPath(verifier.command!)! : verifier.relativeEntry
      const path = join(plan.targetBinding.canonicalPath, relativePath)
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink() || await realpath(path) !== path)
        throw new Error('Exact verifier artifact is not an ordinary repository file.')
    }
    const commitKey = this.obligationCommitKey(obligation.obligationId, transition.implementationCommit)
    const path = this.path('transition', commitKey)
    const existing = await this.read<VerificationBindingTransition>(path)
    if (existing !== undefined) {
      verifyBindingTransition(existing, obligation, plan.runtimePlanHash, blueprint)
      if (existing.id !== transition.id) throw new Error('Provisioning contract already bound to a different verifier.')
      return existing
    }
    const blueprintPath = this.path('blueprint', commitKey)
    const previousBlueprint = await this.read<ApprovedVerificationBlueprint>(blueprintPath)
    if (previousBlueprint && previousBlueprint.blueprintHash !== blueprint.blueprintHash)
      throw new Error('Verification obligation already has a different approved blueprint.')
    if (!previousBlueprint) await this.writeOnce(blueprintPath, blueprint)
    try { await this.writeOnce(path, transition) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        const raced = await this.read<VerificationBindingTransition>(path)
        if (raced && raced.id === transition.id) return raced
      }
      throw error
    }
    return transition
  }
  async getBindingTransition(plan: CompiledRuntimePlan, assertionId: string,
    runtimeTaskId: string): Promise<VerificationBindingTransition | undefined> {
    verifyRuntimePlanIdentity(plan)
    const obligation = plan.acceptanceBindings.find((binding) => binding.assertionId === assertionId &&
      binding.runtimeTaskId === runtimeTaskId && binding.blocking && binding.ownership === 'OWNER')?.stagedVerification.obligation
    if (obligation === undefined) return undefined
    const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
    if (!current.clean) throw new Error('Implementation repository is not clean.')
    const commitKey = this.obligationCommitKey(obligation.obligationId, current.baselineCommit)
    const transition = await this.read<VerificationBindingTransition>(this.path('transition', commitKey))
    const blueprint = await this.read<ApprovedVerificationBlueprint>(this.path('blueprint', commitKey))
    if (transition !== undefined) {
      if (!blueprint) throw new Error('Provisioned blueprint is missing.')
      verifyBindingTransition(transition, obligation, plan.runtimePlanHash, blueprint)
    }
    return transition
  }
  async collectProvisionedEvidence(plan: CompiledRuntimePlan, assertionId: string,
    runtimeTaskId: string): Promise<CapabilityEvidence> {
    const transition = await this.getBindingTransition(plan, assertionId, runtimeTaskId)
    if (transition === undefined) throw new Error('Verifier has not been provisioned.')
    const facts = await inspectAtCommit(plan.targetBinding, transition.implementationCommit)
    const manifestHash = generateScopeManifest(facts).sha256
    if (Object.entries(transition.artifactHashes).some(([path, hash]) =>
      (path === 'NOVAWING_SCOPE_MANIFEST' ? manifestHash : facts.artifactHashes[path]) !== hash))
      throw new Error('INVALIDATED_ARTIFACT_HASH')
    const verifier = transition.verifier
    let observed: CapabilityEvidence
    switch (verifier.family) {
      case 'http_api': observed = await collectHttpEvidence({ assertionId, port: verifier.port, route: verifier.route,
        expectedStatus: verifier.expectedStatus, expectedJsonPointer: verifier.expectedJsonPointer,
        expectedJsonValue: verifier.expectedJsonValue, timeoutMs: verifier.timeoutMs }); break
      case 'filesystem': observed = await collectFilesystemEvidence({ target: plan.targetBinding, assertionId,
        relativePath: verifier.relativePath, expectation: verifier.expectation,
        ...(verifier.contains === undefined ? {} : { contains: verifier.contains }) }); break
      case 'process': observed = await collectProcessEvidence({ target: plan.targetBinding, assertionId,
        relativeEntry: verifier.relativeEntry, expectedExitCode: verifier.expectedExitCode,
        timeoutMs: verifier.timeoutMs }); break
      case 'command': observed = await collectCommandEvidence({ target: plan.targetBinding, assertionId,
        command: verifier.command }); break
      case 'scope_review': observed = await collectScopeReviewEvidence({ target: plan.targetBinding, assertionId,
        manifestHash, trackedArtifactCount: Object.keys(facts.artifactHashes).length,
        ...(verifier.command ? { command: verifier.command } : {}) }); break
    }
    await this.saveCapabilityEvidence(plan, observed)
    return observed
  }
  private completionKey(plan: CompiledRuntimePlan, taskId: string, commit: string): string {
    return createHash('sha256').update(`${plan.runtimePlanHash}\0${taskId}\0${commit}`).digest('hex')
  }
  private completionIndexKey(plan: CompiledRuntimePlan, taskId: string): string {
    return createHash('sha256').update(`${plan.runtimePlanHash}\0${taskId}`).digest('hex')
  }
  async recordLocalTaskCompletion(plan: CompiledRuntimePlan, taskId: string,
    transitions: VerificationBindingTransition[], evidence: AssertionCompletionEvidence[]): Promise<void> {
    verifyRuntimePlanIdentity(plan)
    const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === taskId && item.blocking && item.ownership === 'OWNER')
    if (taskCompletionGate(bindings, transitions, evidence) !== 'LOCALLY_VERIFIED')
      throw new Error('Task completion has no exact local verification proof.')
    const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
    if (!current.clean || transitions.some((item) => item.implementationCommit !== current.baselineCommit))
      throw new Error('Task completion implementation commit drifted.')
    for (const transition of transitions) {
      const stored = await this.getBindingTransition(plan, transition.assertionId, transition.runtimeTaskId)
      if (stored?.id !== transition.id) throw new Error('Task completion transition was not persisted.')
      const facts = await inspectAtCommit(plan.targetBinding, transition.implementationCommit)
      if (Object.entries(transition.artifactHashes).some(([path, hash]) =>
        (path === 'NOVAWING_SCOPE_MANIFEST' ? generateScopeManifest(facts).sha256 : facts.artifactHashes[path]) !== hash))
        throw new Error('INVALIDATED_ARTIFACT_HASH')
    }
    for (const item of evidence) if (item.reviewerVerdict !== 'DEFERRED') {
      const observed = await this.getCapabilityEvidence(plan, item.evidenceId)
      if (!observed || observed.assertionId !== item.assertionId || observed.providerId !== item.providerId ||
        observed.result !== 'OBSERVED' || observed.facts.observedMatch !== true)
        throw new Error('Task completion evidence was not persisted or did not match.')
    }
    const path = this.path('local-completion', this.completionKey(plan, taskId, current.baselineCommit))
    const record = { runtimePlanHash: plan.runtimePlanHash, taskId, commit: current.baselineCommit,
      transitions, evidence }
    const existing = await this.read<typeof record>(path)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Local completion identity collision.')
    } else await this.writeOnce(path, record)
    await this.writeAtomic(this.path('local-completion-index', this.completionIndexKey(plan, taskId)),
      { runtimePlanHash: plan.runtimePlanHash, taskId, commit: current.baselineCommit })
  }
  async customerAssessment(planId: string): Promise<ReturnType<typeof assessCustomerDeliveryCompletion>> {
    const plan = await this.getPlan(planId)
    if (!plan) throw new Error('Runtime plan does not exist.')
    const completed = new Set<string>()
    const transitions: VerificationBindingTransition[] = []
    const evidence: AssertionCompletionEvidence[] = []
    const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath).catch(() => undefined)
    const facts = current?.clean ? await inspectAtCommit(plan.targetBinding, current.baselineCommit).catch(() => undefined) : undefined
    for (const task of plan.tasks) {
      if (!facts || !current) break
      const index = await this.read<{ runtimePlanHash: string; taskId: string; commit: string }>(
        this.path('local-completion-index', this.completionIndexKey(plan, task.id)))
      if (!index || index.runtimePlanHash !== plan.runtimePlanHash || index.taskId !== task.id ||
        !/^[a-f0-9]{40}$/u.test(index.commit)) continue
      const record = await this.read<{ runtimePlanHash: string; taskId: string; commit: string;
        transitions: VerificationBindingTransition[]; evidence: AssertionCompletionEvidence[] }>(
        this.path('local-completion', this.completionKey(plan, task.id, index.commit)))
      if (!record || record.runtimePlanHash !== plan.runtimePlanHash || record.taskId !== task.id ||
        record.commit !== index.commit || !Array.isArray(record.transitions) || !Array.isArray(record.evidence)) continue
      const ancestor = await this.git('git', ['merge-base', '--is-ancestor', record.commit, current.baselineCommit],
        { cwd: plan.targetBinding.canonicalPath, timeout: 10_000 }).then(() => true, () => false)
      if (!ancestor) continue
      const owned = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === task.id && item.blocking && item.ownership === 'OWNER')
      if (taskCompletionGate(owned, record.transitions, record.evidence) !== 'LOCALLY_VERIFIED') continue
      let valid = true
      for (const transition of record.transitions) {
        const obligation = owned.find((item) => item.assertionId === transition.assertionId)?.stagedVerification.obligation
        if (!obligation) { valid = false; break }
        const key = this.obligationCommitKey(obligation.obligationId, transition.implementationCommit)
        const stored = await this.read<VerificationBindingTransition>(this.path('transition', key))
        const blueprint = await this.read<ApprovedVerificationBlueprint>(this.path('blueprint', key))
        try {
          if (!stored || !blueprint || stored.id !== transition.id) throw new Error('Missing transition lineage.')
          verifyBindingTransition(stored, obligation, plan.runtimePlanHash, blueprint)
          if (Object.entries(transition.artifactHashes).some(([path, hash]) =>
            (path === 'NOVAWING_SCOPE_MANIFEST' ? generateScopeManifest(facts).sha256 : facts.artifactHashes[path]) !== hash))
            throw new Error('INVALIDATED_ARTIFACT_HASH')
        } catch { valid = false; break }
      }
      if (!valid) continue
      for (const item of record.evidence) if (item.reviewerVerdict !== 'DEFERRED') {
        const observed = await this.getCapabilityEvidence(plan, item.evidenceId).catch(() => undefined)
        if (!observed || observed.assertionId !== item.assertionId || observed.providerId !== item.providerId ||
          observed.result !== 'OBSERVED' || observed.facts.observedMatch !== true) { valid = false; break }
      }
      if (!valid) continue
      completed.add(task.id)
      transitions.push(...record.transitions)
      evidence.push(...record.evidence)
    }
    return assessCustomerDeliveryCompletion(plan.tasks, plan.acceptanceBindings, transitions, evidence, completed)
  }
  async claimSession(binding: WorkSessionPlanBinding): Promise<boolean> {
    try { await this.writeOnce(this.path('session', binding.workSessionId), binding); return true }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    }
  }
  async finishSession(binding: WorkSessionPlanBinding): Promise<void> {
    await this.writeAtomic(this.path('session', binding.workSessionId), { ...binding, status: 'STARTED' })
  }
  async getSession(id: string): Promise<WorkSessionPlanBinding | undefined> { return this.read(this.path('session', id)) }
}

export interface DeliveryRuntimeAdapter {
  configured(target: DeliveryTargetBinding): Promise<boolean>
  executorAvailable(target: DeliveryTargetBinding): Promise<boolean>
  reviewerAvailable(target: DeliveryTargetBinding): Promise<boolean>
  /** Must durably create this exact session, then start the existing Runtime. */
  createAndStart(definition: WorkSessionDefinition, binding: WorkSessionPlanBinding, plan: CompiledRuntimePlan): Promise<void>
}

export class DeliveryService {
  constructor(private readonly store: DeliveryStore, private readonly events: DeliveryEventStore,
    private readonly runtime: DeliveryRuntimeAdapter, private readonly resolver: VerificationCapabilityResolver,
    private readonly policyVersion: string,
    private readonly providerAvailability?: (providerId: string) => ProviderAvailability) {}

  private async options(target: DeliveryTargetBinding): Promise<{ runtimeConfigured: boolean; executorAvailable: boolean; reviewerAvailable: boolean }> {
    const [runtimeConfigured, executorAvailable, reviewerAvailable] = await Promise.all([
      this.runtime.configured(target), this.runtime.executorAvailable(target), this.runtime.reviewerAvailable(target),
    ])
    return { runtimeConfigured, executorAvailable, reviewerAvailable }
  }

  async prepare(snapshotInput: PlanSnapshot, repositoryRoot: string,
    source: DeliveryTargetBinding['source'] = 'customer_path'): Promise<CompiledRuntimePlan> {
    const snapshot = verifyPlanSnapshot(snapshotInput)
    const started = Date.now()
    let target = await bindDeliveryTarget(snapshot, repositoryRoot, source)
    const existingTarget = await this.store.getBinding(target.id)
    if (existingTarget !== undefined) {
      if (existingTarget.snapshotId !== target.snapshotId || existingTarget.canonicalPath !== target.canonicalPath ||
        existingTarget.gitRepositoryIdentity !== target.gitRepositoryIdentity || existingTarget.baselineCommit !== target.baselineCommit ||
        existingTarget.branch !== target.branch || existingTarget.clean !== target.clean) throw new Error('Target binding identity collision.')
      target = existingTarget
    } else await this.store.saveBinding(target)
    await this.events.append('delivery.target_bound', { snapshotId: snapshot.id })
    await this.events.append('runtime_plan.compile_started', { snapshotId: snapshot.id })
    try {
      const plan = await compileRuntimePlan(snapshot, target, { resolver: this.resolver,
        runtimePolicyVersion: this.policyVersion, ...await this.options(target) })
      await this.store.savePlan(plan)
      const fields = { snapshotId: snapshot.id, runtimePlanHash: plan.runtimePlanHash,
        taskCount: plan.tasks.length, assertionCount: plan.acceptanceBindings.length,
        blockerCount: plan.admission.blockers.length, durationMs: Date.now() - started }
      await this.events.append('runtime_plan.compile_completed', fields)
      await this.events.append(plan.admission.status === 'READY' ? 'runtime_plan.admission_passed' : 'runtime_plan.admission_blocked', fields)
      return plan
    } catch (error) {
      await this.events.append('runtime_plan.compile_failed', { snapshotId: snapshot.id, durationMs: Date.now() - started })
      throw error
    }
  }

  async readiness(snapshotInput: PlanSnapshot, runtimePlanId: string): Promise<{ plan: CompiledRuntimePlan; admission: RuntimeAdmission }> {
    const snapshot = verifyPlanSnapshot(snapshotInput)
    const plan = await this.store.getPlan(runtimePlanId)
    if (plan === undefined) throw new Error('Runtime plan does not exist.')
    if (plan.runtimePolicyVersion !== this.policyVersion) throw new Error('Runtime policy changed; recompile the frozen plan.')
    verifyRuntimePlanCoverage(snapshot, plan)
    const storedBinding = await this.store.getBinding(plan.targetBinding.id)
    if (storedBinding === undefined || JSON.stringify(storedBinding) !== JSON.stringify(plan.targetBinding)) {
      throw new Error('Delivery target binding mismatch.')
    }
    const admission = await admitRuntimePlan(snapshot, plan, { ...await this.options(plan.targetBinding),
      resolver: this.resolver,
      ...(this.providerAvailability === undefined ? {} : { providerAvailability: this.providerAvailability }) })
    return { plan, admission }
  }

  async startDelivery(snapshotInput: PlanSnapshot, runtimePlanId: string, runtimePlanHash: string,
    targetBindingId: string): Promise<WorkSessionPlanBinding> {
    const snapshot = verifyPlanSnapshot(snapshotInput)
    await this.events.append('delivery.start_requested', { snapshotId: snapshot.id, runtimePlanHash })
    const { plan, admission } = await this.readiness(snapshot, runtimePlanId)
    if (plan.runtimePlanHash !== runtimePlanHash || plan.targetBinding.id !== targetBindingId ||
      plan.sourceSnapshotId !== snapshot.id || admission.status !== 'READY') throw new Error('Delivery is not ready for this exact frozen plan and target.')
    const digest = createHash('sha256').update('novawing-delivery-session-v1\0')
      .update(`${snapshot.id}\0${plan.runtimePlanHash}\0${targetBindingId}`).digest('hex')
    const workSessionId = `delivery-${digest}-000000000000-${digest.slice(0, 6)}`
    const existing = await this.store.getSession(workSessionId)
    if (existing !== undefined && (existing.workSessionId !== workSessionId || existing.sourceSnapshotId !== snapshot.id ||
      existing.sourcePlanHash !== snapshot.planHash.value || existing.runtimePlanId !== plan.id ||
      existing.runtimePlanHash !== runtimePlanHash || existing.targetBindingId !== targetBindingId ||
      existing.targetBaselineCommit !== plan.targetBaselineCommit || existing.compilerVersion !== plan.compilerImplementationVersion)) {
      throw new Error('Persisted WorkSession binding does not match this exact delivery request.')
    }
    if (existing?.status === 'STARTED') return existing
    if (existing !== undefined) throw new Error('Delivery start is already in progress; reconcile before retrying.')
    const binding: WorkSessionPlanBinding = { workSessionId, sourceSnapshotId: snapshot.id,
      sourcePlanHash: snapshot.planHash.value, runtimePlanId: plan.id, runtimePlanHash: plan.runtimePlanHash,
      targetBindingId, targetBaselineCommit: plan.targetBaselineCommit,
      compilerVersion: plan.compilerImplementationVersion, createdAt: new Date().toISOString(), status: 'STARTING' }
    if (!await this.store.claimSession(binding)) throw new Error('Delivery start is already claimed.')
    // A crash after the runtime call leaves STARTING for explicit reconciliation; it never creates a second session.
    const admittedPlan = { ...plan, admission }
    await this.runtime.createAndStart(workSessionDefinitionFor(admittedPlan, workSessionId), binding, admittedPlan)
    await this.store.finishSession(binding)
    await this.events.append('work_session.created', { snapshotId: snapshot.id, runtimePlanHash })
    await this.events.append('delivery.started', { snapshotId: snapshot.id, runtimePlanHash })
    return { ...binding, status: 'STARTED' }
  }
}
