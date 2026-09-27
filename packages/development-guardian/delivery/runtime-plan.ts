import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { canonicalSerialize, verifyPlanSnapshot, type PlanSnapshot } from '../planning/freeze.js'
import type { AcceptanceAssertion, AcceptanceCriterion, RequirementClause } from '../planning/model.js'
import type { WorkSessionDefinition } from '../work-session/model.js'
import { assessVerificationCommand } from '../verification-command-policy.js'
import { planVerification } from '../work-session/verification-planner.js'

const git = promisify(execFile)
export const COMPILER_SCHEMA_VERSION = 1
export const COMPILER_IMPLEMENTATION_VERSION = '0.5.0-phase3.4'

export type VerificationCapability = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_EXTERNAL_ENVIRONMENT' | 'REQUIRES_HUMAN'
export interface CapabilityResolution {
  capability: VerificationCapability
  /** Stable trusted capability identifier, not a shell command or a claim of PASS. */
  capabilityId: string
  reason: string
  /** Only a trusted resolver may provide this exact Existing Runtime verifier. */
  verificationCommand?: string
}
export type VerificationCapabilityResolver = (input: {
  assertion: AcceptanceAssertion; criterion: AcceptanceCriterion; requirement: RequirementClause
}) => CapabilityResolution

/** No generic command or model review can prove an arbitrary customer outcome. */
export const conservativeCapabilityResolver: VerificationCapabilityResolver = ({ criterion }) =>
  criterion.level === 'platform' ? {
    capability: 'REQUIRES_EXTERNAL_ENVIRONMENT', capabilityId: 'external-platform-evidence-v1',
    reason: '当前缺少该平台的真实编译和验收环境。',
  } : criterion.level === 'ui' ? {
    capability: 'REQUIRES_EXTERNAL_ENVIRONMENT', capabilityId: 'external-ui-evidence-v1',
    reason: '当前缺少可信的界面行为验证环境。',
  } : {
    capability: 'UNSUPPORTED', capabilityId: 'unresolved-business-evidence-v1',
    reason: '当前尚无可证明该业务结果的验证能力。',
  }

export interface DeliveryTargetBinding {
  id: string
  snapshotId: string
  targetType: 'existing_repository' | 'new_project'
  repositoryRoot: string
  canonicalPath: string
  gitRepositoryIdentity: string
  baselineCommit: string
  branch: string | null
  clean: boolean
  boundAt: string
  platform: NodeJS.Platform
  source: 'customer_path' | 'desktop_picker' | 'trusted_test'
}

async function gitRead(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await git('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000 })
  return stdout.trim()
}

export async function inspectDeliveryTarget(repositoryRoot: string): Promise<Omit<DeliveryTargetBinding, 'id' | 'snapshotId' | 'targetType' | 'boundAt' | 'platform' | 'source'>> {
  const canonicalPath = await realpath(repositoryRoot)
  const top = await realpath(await gitRead(canonicalPath, 'rev-parse', '--show-toplevel'))
  if (top !== canonicalPath) throw new Error('Delivery target must be the Git repository root.')
  const [gitDirectory, baselineCommit, branch, status] = await Promise.all([
    gitRead(top, 'rev-parse', '--absolute-git-dir'), gitRead(top, 'rev-parse', 'HEAD'),
    gitRead(top, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
    gitRead(top, 'status', '--porcelain=v1', '--untracked-files=all'),
  ])
  if (!/^[a-f0-9]{40}$/u.test(baselineCommit)) throw new Error('Delivery target has no exact baseline commit.')
  return { repositoryRoot, canonicalPath, gitRepositoryIdentity: await realpath(gitDirectory),
    baselineCommit, branch: branch || null, clean: status === '' }
}

export async function bindDeliveryTarget(snapshot: PlanSnapshot, repositoryRoot: string,
  source: DeliveryTargetBinding['source'] = 'customer_path'): Promise<DeliveryTargetBinding> {
  verifyPlanSnapshot(snapshot)
  const inspected = await inspectDeliveryTarget(repositoryRoot)
  const id = createHash('sha256').update('novawing-target-binding-v1\0').update(canonicalSerialize({
    snapshotId: snapshot.id, targetType: 'existing_repository', canonicalPath: inspected.canonicalPath,
    gitRepositoryIdentity: inspected.gitRepositoryIdentity, baselineCommit: inspected.baselineCommit,
    branch: inspected.branch, clean: inspected.clean,
  })).digest('hex')
  return { id, snapshotId: snapshot.id, targetType: 'existing_repository',
    ...inspected, boundAt: new Date().toISOString(), platform: process.platform, source }
}

export interface RuntimeTaskBinding {
  id: string
  plannedTaskId: string
  title: string
  complexity: 'small' | 'medium' | 'large'
  requirementIds: string[]
  objective: string
  outputs: string[]
  dependencyIds: string[]
  acceptanceCriterionIds: string[]
  acceptanceAssertionIds: string[]
}
export interface AcceptanceBinding {
  assertionId: string
  criterionId: string
  requirementId: string
  plannedTaskId: string
  runtimeTaskId: string
  observableBehavior: string
  expectedOutcome: string
  expectedEvidence: string
  blocking: boolean
  verificationCapability: CapabilityResolution
  evidenceStatus: 'NOT_COLLECTED'
}
export interface RuntimeAdmission {
  status: 'READY' | 'ADMISSION_BLOCKED'
  blockers: Array<{ code: string; assertionId?: string; message: string }>
  coverage: { plannedTaskRuntime: number; mustRuntime: number; blockingAssertionRuntime: number }
  checkedAt: string
}
export interface CompiledRuntimePlan {
  id: string
  runtimePlanHash: string
  compilerSchemaVersion: 1
  compilerImplementationVersion: string
  runtimePolicyVersion: string
  sourceSnapshotId: string
  sourcePlanId: string
  sourcePlanVersion: number
  sourcePlanHash: string
  sourceCanonicalSchemaVersion: 1
  targetBinding: DeliveryTargetBinding
  targetBaselineCommit: string
  tasks: RuntimeTaskBinding[]
  requirements: RequirementClause[]
  acceptanceCriteria: AcceptanceCriterion[]
  customerDecisions: PlanSnapshot['content']['customerAnswers']
  acceptanceBindings: AcceptanceBinding[]
  admission: RuntimeAdmission
  createdAt: string
}

function semanticRuntimePlan(plan: CompiledRuntimePlan): unknown {
  return { sourcePlanHash: plan.sourcePlanHash, sourceSnapshotId: plan.sourceSnapshotId,
    target: { canonicalPath: plan.targetBinding.canonicalPath, gitRepositoryIdentity: plan.targetBinding.gitRepositoryIdentity,
      baselineCommit: plan.targetBinding.baselineCommit, branch: plan.targetBinding.branch, clean: plan.targetBinding.clean },
    compilerSchemaVersion: plan.compilerSchemaVersion, compilerImplementationVersion: plan.compilerImplementationVersion,
    runtimePolicyVersion: plan.runtimePolicyVersion, tasks: plan.tasks, requirements: plan.requirements,
    acceptanceCriteria: plan.acceptanceCriteria,
    customerDecisions: plan.customerDecisions, acceptanceBindings: plan.acceptanceBindings }
}

export function verifyRuntimePlanIdentity(plan: CompiledRuntimePlan): void {
  const hash = createHash('sha256').update('novawing-runtime-plan-v1\0')
    .update(canonicalSerialize(semanticRuntimePlan(plan))).digest('hex')
  if (hash !== plan.runtimePlanHash || plan.id !== hash || plan.compilerSchemaVersion !== COMPILER_SCHEMA_VERSION ||
    plan.compilerImplementationVersion !== COMPILER_IMPLEMENTATION_VERSION) {
    throw new Error('Runtime plan identity or compiler version mismatch.')
  }
}

export function verifyRuntimePlanCoverage(snapshotInput: PlanSnapshot, plan: CompiledRuntimePlan): RuntimeAdmission['coverage'] {
  const snapshot = verifyPlanSnapshot(snapshotInput)
  if (plan.sourceSnapshotId !== snapshot.id || plan.sourcePlanId !== snapshot.sourcePlanId ||
    plan.sourcePlanVersion !== snapshot.sourcePlanVersion || plan.sourceCanonicalSchemaVersion !== snapshot.planHash.schemaVersion ||
    plan.sourcePlanHash !== snapshot.planHash.value || plan.targetBaselineCommit !== plan.targetBinding.baselineCommit ||
    canonicalSerialize(plan.customerDecisions) !== canonicalSerialize(snapshot.content.customerAnswers)) {
    throw new Error('Runtime plan changed the frozen source or customer decisions.')
  }
  const source = snapshot.content
  const taskIds = new Set(plan.tasks.map((task) => task.plannedTaskId))
  const plannedTaskRuntime = source.tasks.length === 0 ? 100 : Math.round(100 * source.tasks.filter((task) => taskIds.has(task.id)).length / source.tasks.length)
  const must = source.clauses.filter((clause) => clause.priority === 'must')
  const mustRuntime = must.length === 0 ? 100 : Math.round(100 * must.filter((clause) => plan.tasks.some((task) => task.requirementIds.includes(clause.id))).length / must.length)
  const blocking = source.acceptancePlan.criteria.flatMap((criterion) => criterion.blocking ? criterion.assertions.filter((assertion) => assertion.blocking) : [])
  const expectedBindingKeys = source.acceptancePlan.criteria.flatMap((criterion) => criterion.assertions.flatMap((assertion) =>
    source.tasks.filter((task) => task.acceptanceCriterionIds.includes(criterion.id) && task.requirementIds.includes(assertion.requirementId))
      .map((task) => `${criterion.id}\0${assertion.id}\0${task.id}`)))
  const actualBindingKeys = plan.acceptanceBindings.map((binding) => `${binding.criterionId}\0${binding.assertionId}\0${binding.plannedTaskId}`)
  if (canonicalSerialize([...expectedBindingKeys].sort()) !== canonicalSerialize([...actualBindingKeys].sort())) {
    throw new Error('Runtime acceptance binding set changed.')
  }
  const bindingIds = new Set(plan.acceptanceBindings.filter((binding) => binding.blocking).map((binding) => binding.assertionId))
  const blockingAssertionRuntime = blocking.length === 0 ? 100 : Math.round(100 * blocking.filter((assertion) => bindingIds.has(assertion.id)).length / blocking.length)
  if (plannedTaskRuntime !== 100 || mustRuntime !== 100 || blockingAssertionRuntime !== 100 ||
    plan.tasks.length !== source.tasks.length || plan.requirements.length !== source.clauses.length) {
    throw new Error('Runtime plan lost a task, MUST requirement, or blocking assertion.')
  }
  for (const task of source.tasks) {
    const mapped = plan.tasks.find((entry) => entry.plannedTaskId === task.id)
    const expectedAssertions = source.acceptancePlan.criteria.filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id))
      .flatMap((criterion) => criterion.assertions.filter((assertion) => task.requirementIds.includes(assertion.requirementId)).map((assertion) => assertion.id))
    if (mapped === undefined || mapped.id !== task.id ||
      canonicalSerialize(mapped.acceptanceAssertionIds) !== canonicalSerialize(expectedAssertions) ||
      canonicalSerialize({ title: mapped.title, complexity: mapped.complexity,
        requirementIds: mapped.requirementIds, objective: mapped.objective, outputs: mapped.outputs,
        dependencyIds: mapped.dependencyIds, acceptanceCriterionIds: mapped.acceptanceCriterionIds }) !==
      canonicalSerialize({ title: task.title, complexity: task.complexity,
        requirementIds: task.requirementIds, objective: task.objective, outputs: task.outputs,
        dependencyIds: task.dependencyIds, acceptanceCriterionIds: task.acceptanceCriterionIds })) {
      throw new Error(`Runtime task contract changed: ${task.id}`)
    }
  }
  for (const criterion of source.acceptancePlan.criteria) for (const assertion of criterion.assertions) {
    const owners = source.tasks.filter((task) => task.acceptanceCriterionIds.includes(criterion.id) && task.requirementIds.includes(assertion.requirementId))
    for (const owner of owners) {
      const binding = plan.acceptanceBindings.find((entry) => entry.assertionId === assertion.id && entry.plannedTaskId === owner.id)
      if (binding === undefined || binding.criterionId !== criterion.id || binding.requirementId !== assertion.requirementId ||
        binding.runtimeTaskId !== owner.id || binding.blocking !== (criterion.blocking && assertion.blocking) ||
        binding.observableBehavior !== assertion.observableBehavior || binding.expectedOutcome !== assertion.expectedOutcome ||
        binding.expectedEvidence !== assertion.expectedEvidence ||
        !plan.tasks.find((entry) => entry.id === owner.id)?.acceptanceAssertionIds.includes(assertion.id)) {
        throw new Error(`Runtime acceptance contract changed or lost: ${assertion.id}`)
      }
    }
  }
  if (canonicalSerialize(plan.requirements) !== canonicalSerialize(source.clauses)) throw new Error('Runtime requirement clauses changed.')
  if (canonicalSerialize(plan.acceptanceCriteria) !== canonicalSerialize(source.acceptancePlan.criteria)) {
    throw new Error('Runtime acceptance criteria changed.')
  }
  return { plannedTaskRuntime, mustRuntime, blockingAssertionRuntime }
}

export async function admitRuntimePlan(snapshotInput: PlanSnapshot, plan: CompiledRuntimePlan,
  options: { runtimeConfigured: boolean; executorAvailable: boolean; reviewerAvailable: boolean }): Promise<RuntimeAdmission> {
  verifyRuntimePlanIdentity(plan)
  const coverage = verifyRuntimePlanCoverage(snapshotInput, plan)
  const blockers: RuntimeAdmission['blockers'] = []
  if (plan.targetBinding.snapshotId !== plan.sourceSnapshotId || plan.targetBinding.targetType !== 'existing_repository')
    blockers.push({ code: 'TARGET_BINDING_INVALID', message: '交付项目绑定无效。' })
  try {
    const current = await inspectDeliveryTarget(plan.targetBinding.repositoryRoot)
    if (current.canonicalPath !== plan.targetBinding.canonicalPath || current.gitRepositoryIdentity !== plan.targetBinding.gitRepositoryIdentity ||
      current.baselineCommit !== plan.targetBaselineCommit || current.branch !== plan.targetBinding.branch ||
      current.clean !== plan.targetBinding.clean) blockers.push({ code: 'TARGET_DRIFT', message: '交付项目已变化，需要重新检查。' })
    if (!current.clean) blockers.push({ code: 'TARGET_DIRTY', message: '交付项目存在未提交的改动。' })
  } catch { blockers.push({ code: 'TARGET_UNAVAILABLE', message: '交付项目无法读取。' }) }
  for (const binding of plan.acceptanceBindings) if (binding.blocking && binding.verificationCapability.capability !== 'SUPPORTED') {
    blockers.push({ code: 'VERIFICATION_CAPABILITY_GAP', assertionId: binding.assertionId,
      message: binding.verificationCapability.reason })
  }
  for (const binding of plan.acceptanceBindings) if (binding.blocking && binding.verificationCapability.capability === 'SUPPORTED' &&
    (binding.verificationCapability.verificationCommand === undefined ||
      assessVerificationCommand(binding.verificationCapability.verificationCommand).status !== 'ALLOWED')) {
    blockers.push({ code: 'VERIFICATION_COMMAND_UNAVAILABLE', assertionId: binding.assertionId,
      message: '该验收结果没有可安全运行的精确验证方式。' })
  }
  if (!blockers.some((item) => item.code === 'VERIFICATION_CAPABILITY_GAP' || item.code === 'VERIFICATION_COMMAND_UNAVAILABLE')) {
    const definition = workSessionDefinitionFor({ ...plan, admission: { status: 'READY', blockers: [], coverage,
      checkedAt: new Date().toISOString() } }, 'admission-probe')
    for (const task of definition.tasks) {
      if (!task.acceptanceCriteria?.length) {
        blockers.push({ code: 'TASK_NO_BLOCKING_ASSERTION', message: `任务 ${task.id} 缺少必须证明的验收结果。` })
        continue
      }
      const verification = await planVerification({ repositoryRoot: plan.targetBinding.canonicalPath,
        task, risk: 'HIGH' }).catch(() => undefined)
      if (verification?.confidence !== 'HIGH') blockers.push({ code: 'VERIFICATION_PLAN_UNAVAILABLE',
        message: `任务 ${task.id} 的精确验证方式无法在交付项目中解析。` })
    }
  }
  if (!options.runtimeConfigured) blockers.push({ code: 'RUNTIME_CONFIG_UNAVAILABLE', message: '交付运行配置尚未就绪。' })
  if (!options.executorAvailable) blockers.push({ code: 'EXECUTOR_UNAVAILABLE', message: '执行能力尚未就绪。' })
  if (!options.reviewerAvailable) blockers.push({ code: 'REVIEWER_UNAVAILABLE', message: '独立评审能力尚未就绪。' })
  return { status: blockers.length === 0 ? 'READY' : 'ADMISSION_BLOCKED', blockers, coverage, checkedAt: new Date().toISOString() }
}

export async function compileRuntimePlan(snapshotInput: PlanSnapshot, targetBinding: DeliveryTargetBinding,
  options: { resolver?: VerificationCapabilityResolver; runtimePolicyVersion: string;
    runtimeConfigured: boolean; executorAvailable: boolean; reviewerAvailable: boolean }): Promise<CompiledRuntimePlan> {
  const snapshot = verifyPlanSnapshot(snapshotInput)
  if (targetBinding.snapshotId !== snapshot.id) throw new Error('Target binding belongs to another frozen snapshot.')
  if (!options.runtimePolicyVersion.trim()) throw new Error('Runtime policy version is required.')
  const resolver = options.resolver ?? conservativeCapabilityResolver
  const tasks: RuntimeTaskBinding[] = snapshot.content.tasks.map((task) => ({
    id: task.id, plannedTaskId: task.id, title: task.title, complexity: task.complexity,
    requirementIds: [...task.requirementIds], objective: task.objective,
    outputs: [...task.outputs], dependencyIds: [...task.dependencyIds], acceptanceCriterionIds: [...task.acceptanceCriterionIds],
    acceptanceAssertionIds: snapshot.content.acceptancePlan.criteria.filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id))
      .flatMap((criterion) => criterion.assertions.filter((assertion) => task.requirementIds.includes(assertion.requirementId)).map((assertion) => assertion.id)),
  }))
  const acceptanceBindings: AcceptanceBinding[] = snapshot.content.acceptancePlan.criteria.flatMap((criterion) =>
    criterion.assertions.flatMap((assertion) => snapshot.content.tasks
      .filter((task) => task.acceptanceCriterionIds.includes(criterion.id) && task.requirementIds.includes(assertion.requirementId))
      .map((task) => {
        const requirement = snapshot.content.clauses.find((item) => item.id === assertion.requirementId)!
        const verificationCapability = resolver({ assertion, criterion, requirement })
        if (!verificationCapability.capabilityId.trim() || !verificationCapability.reason.trim() ||
          (verificationCapability.capability === 'SUPPORTED' &&
            (verificationCapability.verificationCommand === undefined ||
              assessVerificationCommand(verificationCapability.verificationCommand).status !== 'ALLOWED'))) {
          throw new Error('Invalid verification capability resolution.')
        }
        return { assertionId: assertion.id, criterionId: criterion.id, requirementId: assertion.requirementId,
          plannedTaskId: task.id, runtimeTaskId: task.id, observableBehavior: assertion.observableBehavior,
          expectedOutcome: assertion.expectedOutcome, expectedEvidence: assertion.expectedEvidence,
          blocking: criterion.blocking && assertion.blocking, verificationCapability,
          evidenceStatus: 'NOT_COLLECTED' as const }
      })))
  const semantic = { sourcePlanHash: snapshot.planHash.value, sourceSnapshotId: snapshot.id,
    target: { canonicalPath: targetBinding.canonicalPath, gitRepositoryIdentity: targetBinding.gitRepositoryIdentity,
      baselineCommit: targetBinding.baselineCommit, branch: targetBinding.branch, clean: targetBinding.clean },
    compilerSchemaVersion: COMPILER_SCHEMA_VERSION, compilerImplementationVersion: COMPILER_IMPLEMENTATION_VERSION,
    runtimePolicyVersion: options.runtimePolicyVersion, tasks, requirements: snapshot.content.clauses,
    acceptanceCriteria: snapshot.content.acceptancePlan.criteria,
    customerDecisions: snapshot.content.customerAnswers, acceptanceBindings }
  const runtimePlanHash = createHash('sha256').update('novawing-runtime-plan-v1\0').update(canonicalSerialize(semantic)).digest('hex')
  const plan: CompiledRuntimePlan = { id: runtimePlanHash, runtimePlanHash, compilerSchemaVersion: 1,
    compilerImplementationVersion: COMPILER_IMPLEMENTATION_VERSION, runtimePolicyVersion: options.runtimePolicyVersion,
    sourceSnapshotId: snapshot.id, sourcePlanId: snapshot.sourcePlanId, sourcePlanVersion: snapshot.sourcePlanVersion,
    sourcePlanHash: snapshot.planHash.value, sourceCanonicalSchemaVersion: 1, targetBinding,
    targetBaselineCommit: targetBinding.baselineCommit, tasks, requirements: snapshot.content.clauses,
    acceptanceCriteria: snapshot.content.acceptancePlan.criteria,
    customerDecisions: snapshot.content.customerAnswers, acceptanceBindings,
    admission: { status: 'ADMISSION_BLOCKED', blockers: [], coverage: { plannedTaskRuntime: 0, mustRuntime: 0, blockingAssertionRuntime: 0 }, checkedAt: '' },
    createdAt: new Date().toISOString() }
  plan.admission = await admitRuntimePlan(snapshot, plan, options)
  return plan
}

/** Reviewer and executor receive the same immutable business contract; commands are only evidence collection. */
export function workSessionDefinitionFor(plan: CompiledRuntimePlan, sessionId: string): WorkSessionDefinition {
  if (plan.admission.status !== 'READY') throw new Error('Runtime plan is not admitted.')
  const ordered: RuntimeTaskBinding[] = []
  const visited = new Set<string>()
  const visit = (task: RuntimeTaskBinding): void => {
    if (visited.has(task.id)) return
    visited.add(task.id)
    for (const id of task.dependencyIds) {
      const dependency = plan.tasks.find((item) => item.id === id)
      if (dependency === undefined) throw new Error(`Runtime dependency is missing: ${id}`)
      visit(dependency)
    }
    ordered.push(task)
  }
  for (const task of plan.tasks) visit(task)
  const criterionFor = (binding: AcceptanceBinding): string =>
    `AcceptanceAssertion ${binding.assertionId}: ${binding.observableBehavior} → ${binding.expectedOutcome} | Expected evidence: ${binding.expectedEvidence}`
  return { id: sessionId, targetRepo: plan.targetBinding.canonicalPath, branch: plan.targetBinding.branch ?? '',
    controlPlane: 'v2', directPath: { enabled: false }, goldenPath: { enabled: false },
    limits: { softMinutes: 60, hardMinutes: 240, maxTasks: plan.tasks.length },
    tasks: ordered.map((task) => ({ id: task.id,
      goal: task.objective, constraints: [`Frozen plan SHA-256: ${plan.sourcePlanHash}`,
        `Delivery target baseline: ${plan.targetBaselineCommit}`,
        `PlannedTask ID: ${task.plannedTaskId}`,
        `PlannedTask title and complexity: ${task.title} (${task.complexity})`,
        ...task.requirementIds.map((id) => `RequirementClause ${id}: ${canonicalSerialize(plan.requirements.find((item) => item.id === id)!)}`),
        ...task.acceptanceCriterionIds.map((id) => `AcceptanceCriterion ${id}: ${canonicalSerialize(plan.acceptanceCriteria.find((item) => item.id === id)!)}`),
        ...task.outputs.map((output) => `Expected output: ${output}`),
        ...plan.customerDecisions.map((decision) => `Customer decision ${decision.questionId}: ${decision.selectedOptionText}`)],
      allowedPaths: [plan.targetBinding.canonicalPath], forbiddenPaths: [], risk: 'HIGH',
      acceptanceCriteria: plan.acceptanceBindings.filter((binding) => binding.runtimeTaskId === task.id && binding.blocking)
        .map(criterionFor),
      acceptanceEvidenceBindings: plan.acceptanceBindings.filter((binding) => binding.runtimeTaskId === task.id && binding.blocking)
        .map((binding) => ({ criterion: criterionFor(binding),
          requiredEvidence: [binding.verificationCapability.verificationCommand!] })),
    })) }
}
