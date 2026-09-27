import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { scopedNodeTestPath } from '../verification-command-policy.js'
import { type PlanSnapshot, verifyPlanSnapshot } from '../planning/freeze.js'
import type { WorkSessionDefinition } from '../work-session/model.js'
import { collectCommandEvidence, collectFilesystemEvidence, collectHttpEvidence, collectProcessEvidence,
  verifyCapabilityEvidence, type CapabilityEvidence, type ProviderAvailability } from './capability-layer.js'
import { bindProvisionedVerifier, verifyBindingTransition, type BoundVerifier,
  type VerificationBindingTransition } from './staged-verification.js'
import {
  admitRuntimePlan, bindDeliveryTarget, compileRuntimePlan, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity,
  workSessionDefinitionFor, type CompiledRuntimePlan, type DeliveryTargetBinding, type RuntimeAdmission,
  type VerificationCapabilityResolver,
} from './runtime-plan.js'

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
  'runtime_plan.admission_blocked' | 'delivery.start_requested' | 'delivery.started' | 'work_session.created'

/** Closed event projection: paths, requirement text, prompts, responses and secrets cannot enter the file. */
export class DeliveryEventStore {
  constructor(readonly path: string) {}
  async append(type: DeliveryEventType, fields: { snapshotId: string; runtimePlanHash?: string;
    taskCount?: number; assertionCount?: number; blockerCount?: number; durationMs?: number }): Promise<void> {
    const event = { id: randomUUID(), at: new Date().toISOString(), type,
      snapshotId: /^[a-f0-9-]{36}$/u.test(fields.snapshotId) ? fields.snapshotId : 'invalid',
      ...(fields.runtimePlanHash && /^[a-f0-9]{64}$/u.test(fields.runtimePlanHash)
        ? { runtimePlanHashPrefix: fields.runtimePlanHash.slice(0, 12) } : {}),
      ...Object.fromEntries((['taskCount', 'assertionCount', 'blockerCount', 'durationMs'] as const)
        .filter((key) => Number.isSafeInteger(fields[key]) && fields[key]! >= 0).map((key) => [key, fields[key]])),
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600)
    try { await file.writeFile(`${JSON.stringify(event)}\n`) } finally { await file.close() }
  }
}

export class DeliveryStore {
  constructor(readonly directory: string) {}
  private path(kind: 'binding' | 'plan' | 'session' | 'evidence' | 'transition', id: string): string {
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
    runtimeTaskId: string, verifier: BoundVerifier): Promise<VerificationBindingTransition> {
    verifyRuntimePlanIdentity(plan)
    const obligation = plan.acceptanceBindings.find((binding) => binding.assertionId === assertionId &&
      binding.runtimeTaskId === runtimeTaskId && binding.blocking)?.stagedVerification.provisioning
    if (obligation === undefined) throw new Error('No exact blocking provisioning obligation exists.')
    const transition = bindProvisionedVerifier({ runtimePlanHash: plan.runtimePlanHash, obligation, verifier })
    if (verifier.family === 'command' || verifier.family === 'process') {
      const relativePath = verifier.family === 'command' ? scopedNodeTestPath(verifier.command)! : verifier.relativeEntry
      const path = join(plan.targetBinding.canonicalPath, relativePath)
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink() || await realpath(path) !== path)
        throw new Error('Exact verifier artifact is not an ordinary repository file.')
    }
    const path = this.path('transition', obligation.id)
    const existing = await this.read<VerificationBindingTransition>(path)
    if (existing !== undefined) {
      verifyBindingTransition(existing, obligation, plan.runtimePlanHash)
      if (existing.id !== transition.id) throw new Error('Provisioning contract already bound to a different verifier.')
      return existing
    }
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
      binding.runtimeTaskId === runtimeTaskId && binding.blocking)?.stagedVerification.provisioning
    if (obligation === undefined) return undefined
    const transition = await this.read<VerificationBindingTransition>(this.path('transition', obligation.id))
    if (transition !== undefined) verifyBindingTransition(transition, obligation, plan.runtimePlanHash)
    return transition
  }
  async collectProvisionedEvidence(plan: CompiledRuntimePlan, assertionId: string,
    runtimeTaskId: string): Promise<CapabilityEvidence> {
    const transition = await this.getBindingTransition(plan, assertionId, runtimeTaskId)
    if (transition === undefined) throw new Error('Verifier has not been provisioned.')
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
    }
    await this.saveCapabilityEvidence(plan, observed)
    return observed
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
