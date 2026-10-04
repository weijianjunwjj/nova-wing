import { createHash } from 'node:crypto'
import { canonicalSerialize } from '../planning/freeze.js'
import { assessVerificationCommand, scopedNodeTestPath } from '../verification-command-policy.js'
import type { AcceptanceAssertion, AcceptanceCriterion } from '../planning/model.js'
import type { DeliveryTargetBinding } from './runtime-plan.js'
import { assertionContractHash, type ApprovedVerificationBlueprint } from './verification-blueprint.js'
import { CAPABILITY_REGISTRY, claimExternalResidual, claimRequirements, claimRequiresExactComparison, isDeliveryScopeClaim, type CapabilityFamily, type ResolvedCapability } from './capability-layer.js'

export const ADMISSION_MODEL_VERSION = 2
export type VerificationReadiness = 'BOUND_EXECUTABLE' | 'PROVISIONABLE_DURING_EXECUTION' | 'EXTERNAL_DEFERRED' | 'HUMAN_DEFERRED' | 'UNRESOLVED'
export type VerificationPrerequisite = 'EXECUTION' | 'COMPLETION'

export type VerificationStrategy = 'assertion_scoped_repository_test' | 'loopback_http_get_predicate' |
  'scoped_artifact_predicate' | 'owned_process_predicate' | 'delivery_scope_review'
export type PredicateClass = 'exact_value' | 'exact_set' | 'state_transition' | 'rejection' |
  'presence' | 'absence_in_scope' | 'lifecycle'
/** All normative fields are hashed; only concrete implementation inputs may be bound later. */
export interface VerificationObligation {
  schemaVersion: 2
  obligationId: string
  assertionId: string
  sourceAssertionHash: string
  criterionId: string
  criterionLevel: AcceptanceCriterion['level']
  canonicalOwnerTaskId: string
  coveringTaskIds: string[]
  capabilityFamily: CapabilityFamily
  providerId: string
  providerVersion: string
  strategy: VerificationStrategy
  predicateClass: PredicateClass
  expectedOutcome: string
  expectedEvidence: string
  requirements: ReturnType<typeof claimRequirements>
  externalResidual: boolean
  allowedBindingInputs: string[]
  forbiddenSubstitutions: string[]
  bindingDeadline: 'BEFORE_OWNER_TASK_COMPLETION'
  targetConstraints: { gitRepositoryIdentity: string; baselineCommit: string }
  prerequisite: VerificationPrerequisite
}
export type VerificationProvisioningBinding = VerificationObligation

export interface StagedVerificationContract {
  readiness: VerificationReadiness
  prerequisite: VerificationPrerequisite
  policy: string
  obligation?: VerificationObligation
}

const strategies: Partial<Record<CapabilityFamily, { name: VerificationStrategy; inputs: string[] }>> = {
  command: { name: 'assertion_scoped_repository_test', inputs: ['testFilePath'] },
  http_api: { name: 'loopback_http_get_predicate', inputs: ['port', 'route', 'jsonPointer'] },
  filesystem: { name: 'scoped_artifact_predicate', inputs: ['artifactPath'] },
  process: { name: 'owned_process_predicate', inputs: ['processEntry'] },
}

function frozenRequirementsForScope(assertion: AcceptanceAssertion): boolean {
  return claimRequirements(assertion).requiresMutation
}

function obligationDigest(content: Omit<VerificationObligation, 'obligationId'>): string {
  return createHash('sha256').update('novawing-verification-obligation-v2\0')
    .update(canonicalSerialize(content)).digest('hex')
}

export function validateVerificationObligation(obligation: VerificationObligation,
  input: { assertion: AcceptanceAssertion; criterion: AcceptanceCriterion; ownerTaskId: string;
    coveringTaskIds: string[]; target: DeliveryTargetBinding; providerAvailability?: (id: string) => string;
    prerequisite?: VerificationPrerequisite }): string[] {
  const issues: string[] = []
  if (!obligation || !obligation.requirements || !Array.isArray(obligation.coveringTaskIds) ||
    !Array.isArray(obligation.allowedBindingInputs) || !Array.isArray(obligation.forbiddenSubstitutions) ||
    !obligation.targetConstraints) return ['OBLIGATION_IDENTITY_MISMATCH', 'FLAGS_INCONSISTENT']
  const { obligationId: _id, ...content } = obligation
  const expectedStrategy = isDeliveryScopeClaim(input.assertion, input.criterion)
    ? { name: 'delivery_scope_review' as const,
        inputs: frozenRequirementsForScope(input.assertion) ? ['scopeManifestHash', 'testFilePath'] : ['scopeManifestHash'] } :
      strategies[obligation.capabilityFamily]
  if (!expectedStrategy || obligation.strategy !== expectedStrategy.name ||
    canonicalSerialize(obligation.allowedBindingInputs) !== canonicalSerialize(expectedStrategy.inputs))
    issues.push('OBLIGATION_STRATEGY_MISSING')
  const frozenRequirements = claimRequirements(input.assertion)
  const claim = `${input.assertion.observableBehavior} ${input.assertion.expectedOutcome} ${input.assertion.expectedEvidence}`
  const expectedPredicate: PredicateClass = expectedStrategy?.name === 'delivery_scope_review' ? 'absence_in_scope' :
    /(?:拒绝|禁止|不能|失败|rejected|denied|forbidden)/iu.test(claim) ? 'rejection' :
    frozenRequirements.requiresMutation ? 'state_transition' : claimRequiresExactComparison(input.assertion) ? 'exact_value' :
    obligation.capabilityFamily === 'process' ? 'lifecycle' : 'presence'
  if (obligation.predicateClass !== expectedPredicate) issues.push('PREDICATE_CLASS_MISSING')
  if (obligation.expectedOutcome !== input.assertion.expectedOutcome || obligation.expectedEvidence !== input.assertion.expectedEvidence ||
    obligation.sourceAssertionHash !== assertionContractHash(input.assertion)) issues.push('EXPECTED_NOT_FROZEN')
  if (canonicalSerialize(obligation.requirements) !== canonicalSerialize(frozenRequirements))
    issues.push('FLAGS_INCONSISTENT')
  const externalResidual = claimExternalResidual(input.assertion, input.criterion)
  if (obligation.externalResidual !== externalResidual) issues.push('FLAGS_INCONSISTENT')
  if (frozenRequirements.exactNumbers.some((number) => !obligation.requirements.exactNumbers?.includes(number)))
    issues.push('EXACT_NUMBERS_MISSING')
  if (obligation.canonicalOwnerTaskId !== input.ownerTaskId ||
    canonicalSerialize(obligation.coveringTaskIds) !== canonicalSerialize([...input.coveringTaskIds].sort()))
    issues.push('OWNER_AMBIGUOUS')
  const provider = CAPABILITY_REGISTRY[obligation.capabilityFamily]
  if (!provider || provider.trustLevel !== 'TRUSTED_LOCAL' || provider.availability !== 'AVAILABLE' ||
    input.providerAvailability?.(obligation.providerId) === 'UNAVAILABLE' ||
    provider.providerId !== obligation.providerId || provider.providerVersion !== obligation.providerVersion)
    issues.push('PROVIDER_UNAVAILABLE')
  if (!obligation.forbiddenSubstitutions?.includes('EXIT_CODE_ONLY') ||
    !obligation.forbiddenSubstitutions.includes('HTTP_STATUS_ONLY') ||
    !obligation.forbiddenSubstitutions.includes('API_FOR_UI') ||
    (obligation.strategy === 'delivery_scope_review' && !obligation.forbiddenSubstitutions.includes('FILE_MISSING_FOR_ABSENCE')))
    issues.push('FORBIDDEN_SUBSTITUTION_MISSING')
  if (obligation.obligationId !== obligationDigest(content) || obligation.schemaVersion !== 2 ||
    obligation.assertionId !== input.assertion.id || obligation.criterionId !== input.criterion.id ||
    obligation.criterionLevel !== input.criterion.level ||
    obligation.targetConstraints.gitRepositoryIdentity !== input.target.gitRepositoryIdentity ||
    obligation.targetConstraints.baselineCommit !== input.target.baselineCommit ||
    obligation.bindingDeadline !== 'BEFORE_OWNER_TASK_COMPLETION' ||
    (input.prerequisite !== undefined && obligation.prerequisite !== input.prerequisite)) issues.push('OBLIGATION_IDENTITY_MISMATCH')
  return issues
}

export function stagedVerificationContract(input: { assertion: AcceptanceAssertion; criterion: AcceptanceCriterion;
  ownerTaskId: string; coveringTaskIds: string[]; target: DeliveryTargetBinding;
  capability: ResolvedCapability; prerequisite?: VerificationPrerequisite }): StagedVerificationContract {
  const { capability, assertion, criterion } = input
  const prerequisite = input.prerequisite ?? 'COMPLETION'
  if (capability.capability === 'REQUIRES_EXTERNAL_ENVIRONMENT') return { readiness: 'EXTERNAL_DEFERRED',
    prerequisite, policy: 'external-evidence-required-v1' }
  if (capability.capability === 'REQUIRES_HUMAN') return { readiness: 'HUMAN_DEFERRED', prerequisite,
    policy: 'identified-human-decision-required-v1' }
  const family = capability.family
  const strategy = isDeliveryScopeClaim(assertion, criterion)
    ? { name: 'delivery_scope_review' as const,
        inputs: frozenRequirementsForScope(assertion) ? ['scopeManifestHash', 'testFilePath'] : ['scopeManifestHash'] } :
      strategies[family]
  const provider = CAPABILITY_REGISTRY[family]
  if (!strategy || provider.trustLevel !== 'TRUSTED_LOCAL' ||
    capability.providerId !== provider.providerId || capability.providerVersion !== provider.providerVersion) {
    return { readiness: 'UNRESOLVED', prerequisite, policy: 'no-trusted-obligation-strategy-v2' }
  }
  const requirements = claimRequirements(assertion)
  if (strategy.name === 'loopback_http_get_predicate' &&
    (requirements.requiresMutation || requirements.requiresReread || requirements.requiresCleanup))
    return { readiness: 'UNRESOLVED', prerequisite, policy: 'http-get-cannot-prove-mutation-v2' }
  const claim = `${assertion.observableBehavior} ${assertion.expectedOutcome} ${assertion.expectedEvidence}`
  const predicateClass: PredicateClass = strategy.name === 'delivery_scope_review' ? 'absence_in_scope' :
    /(?:拒绝|禁止|不能|失败|rejected|denied|forbidden)/iu.test(claim) ? 'rejection' :
    requirements.requiresMutation ? 'state_transition' : claimRequiresExactComparison(assertion) ? 'exact_value' :
    family === 'process' ? 'lifecycle' : 'presence'
  const content: Omit<VerificationObligation, 'obligationId'> = {
    schemaVersion: 2, assertionId: assertion.id, sourceAssertionHash: assertionContractHash(assertion),
    criterionId: criterion.id, criterionLevel: criterion.level,
    canonicalOwnerTaskId: input.ownerTaskId, coveringTaskIds: [...input.coveringTaskIds].sort(),
    capabilityFamily: family, providerId: provider.providerId, providerVersion: provider.providerVersion,
    strategy: strategy.name, predicateClass, expectedOutcome: assertion.expectedOutcome,
    expectedEvidence: assertion.expectedEvidence, requirements,
    externalResidual: claimExternalResidual(assertion, criterion),
    allowedBindingInputs: strategy.inputs,
    forbiddenSubstitutions: ['HTTP_STATUS_ONLY', 'EXIT_CODE_ONLY', 'API_FOR_UI',
      ...(strategy.name === 'delivery_scope_review' ? ['FILE_MISSING_FOR_ABSENCE'] : [])],
    bindingDeadline: 'BEFORE_OWNER_TASK_COMPLETION',
    targetConstraints: { gitRepositoryIdentity: input.target.gitRepositoryIdentity,
      baselineCommit: input.target.baselineCommit }, prerequisite,
  }
  const obligation = { ...content, obligationId: obligationDigest(content) }
  const issues = validateVerificationObligation(obligation, { assertion, criterion, ownerTaskId: input.ownerTaskId,
    coveringTaskIds: input.coveringTaskIds, target: input.target, prerequisite })
  if (issues.length) return { readiness: 'UNRESOLVED', prerequisite, policy: issues.join(',') }
  return { readiness: 'PROVISIONABLE_DURING_EXECUTION', prerequisite,
    policy: 'immutable-verification-obligation-v2', obligation }
}

export type BoundVerifier =
  | { family: 'command'; assertionId: string; providerId: string; providerVersion: string; command: string }
  | { family: 'http_api'; assertionId: string; providerId: string; providerVersion: string; method: 'GET'; requestFixture: 'NONE';
      port: number; route: string; expectedStatus: number; expectedJsonPointer: string; expectedJsonValue: string; timeoutMs: number }
  | { family: 'filesystem'; assertionId: string; providerId: string; providerVersion: string; relativePath: string;
      expectation: 'file_exists' | 'file_missing' | 'directory_exists' | 'contains'; contains?: string }
  | { family: 'process'; assertionId: string; providerId: string; providerVersion: string; relativeEntry: string;
      expectedExitCode: number; timeoutMs: number }
  | { family: 'scope_review'; assertionId: string; providerId: string; providerVersion: string;
      manifestHash: string; command?: string }

export interface VerificationBindingTransition {
  id: string
  runtimePlanHash: string
  obligationId: string
  assertionId: string
  runtimeTaskId: string
  implementationCommit: string
  blueprintHash: string
  artifactHashes: Record<string, string>
  from: 'PROVISIONABLE_DURING_EXECUTION'
  to: 'BOUND_EXECUTABLE'
  verifier: BoundVerifier
  recordedAt: string
}

function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function bindProvisionedVerifier(input: { runtimePlanHash: string; obligation: VerificationProvisioningBinding;
  approvedBlueprint: ApprovedVerificationBlueprint; implementationCommit: string;
  artifactHashes: Record<string, string>; verifier?: BoundVerifier }): VerificationBindingTransition {
  const { obligation, approvedBlueprint } = input
  const verifier = input.verifier ?? approvedBlueprint.plannedVerifier
  if (!verifier) throw new Error('Approved blueprint has no exact verifier.')
  if (!/^[a-f0-9]{64}$/u.test(input.runtimePlanHash) || verifier.assertionId !== obligation.assertionId ||
    (verifier.family !== obligation.capabilityFamily && !(obligation.strategy === 'delivery_scope_review' && verifier.family === 'scope_review')) ||
    verifier.providerId !== obligation.providerId ||
    verifier.providerVersion !== obligation.providerVersion ||
    canonicalSerialize(verifier) !== canonicalSerialize(approvedBlueprint.plannedVerifier) ||
    approvedBlueprint.obligationId !== obligation.obligationId ||
    approvedBlueprint.implementationCommit !== input.implementationCommit ||
    canonicalSerialize(approvedBlueprint.artifactHashes) !== canonicalSerialize(input.artifactHashes) ||
    !/^[a-f0-9]{40}$/u.test(input.implementationCommit) ||
    Object.values(input.artifactHashes).some((hash) => !/^[a-f0-9]{64}$/u.test(hash)))
    throw new Error('Verifier does not match the approved obligation blueprint and commit.')
  if (verifier.family === 'command' && (scopedNodeTestPath(verifier.command) === undefined ||
    assessVerificationCommand(verifier.command).status !== 'ALLOWED')) throw new Error('Unsafe assertion verifier command.')
  if (verifier.family === 'http_api' && (verifier.method !== 'GET' || verifier.requestFixture !== 'NONE' ||
    !Number.isInteger(verifier.port) || verifier.port < 1 ||
    verifier.port > 65535 || !verifier.route.startsWith('/') || verifier.route.startsWith('//') ||
    !Number.isInteger(verifier.expectedStatus) || verifier.expectedStatus < 100 || verifier.expectedStatus > 599 ||
    !/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/u.test(verifier.expectedJsonPointer) ||
    verifier.expectedJsonValue.length > 1000 || verifier.timeoutMs < 1 || verifier.timeoutMs > 10_000))
    throw new Error('Unsafe or incomplete HTTP predicate.')
  if (verifier.family === 'filesystem' && (!safeRelative(verifier.relativePath) ||
    (verifier.expectation === 'contains' && (!verifier.contains || verifier.contains.length > 1000))))
    throw new Error('Unsafe or incomplete filesystem predicate.')
  if (verifier.family === 'process' && (!safeRelative(verifier.relativeEntry) ||
    !Number.isInteger(verifier.expectedExitCode) || verifier.expectedExitCode < 0 || verifier.expectedExitCode > 255 ||
    verifier.timeoutMs < 1 || verifier.timeoutMs > 10_000)) throw new Error('Unsafe process predicate.')
  if (verifier.family === 'scope_review' && (!/^[a-f0-9]{64}$/u.test(verifier.manifestHash) ||
    verifier.manifestHash !== input.artifactHashes['NOVAWING_SCOPE_MANIFEST'] ||
    Boolean(verifier.command) !== obligation.requirements.requiresMutation ||
    (verifier.command !== undefined && (scopedNodeTestPath(verifier.command) === undefined ||
      assessVerificationCommand(verifier.command).status !== 'ALLOWED' ||
      !input.artifactHashes[scopedNodeTestPath(verifier.command)!]))))
    throw new Error('Invalid or incomplete scope review verifier.')
  const content = { runtimePlanHash: input.runtimePlanHash, obligationId: obligation.obligationId,
    assertionId: obligation.assertionId, runtimeTaskId: obligation.canonicalOwnerTaskId,
    implementationCommit: input.implementationCommit, blueprintHash: approvedBlueprint.blueprintHash,
    artifactHashes: input.artifactHashes,
    from: 'PROVISIONABLE_DURING_EXECUTION' as const, to: 'BOUND_EXECUTABLE' as const, verifier }
  const id = createHash('sha256').update('novawing-verifier-transition-v2\0').update(canonicalSerialize(content)).digest('hex')
  return { id, ...content, recordedAt: new Date().toISOString() }
}

export function verifyBindingTransition(value: VerificationBindingTransition,
  obligation: VerificationProvisioningBinding, runtimePlanHash: string, blueprint: ApprovedVerificationBlueprint): void {
  const expected = bindProvisionedVerifier({ runtimePlanHash, obligation, approvedBlueprint: blueprint,
    implementationCommit: value.implementationCommit, artifactHashes: value.artifactHashes, verifier: value.verifier })
  if (value.id !== expected.id || value.obligationId !== expected.obligationId ||
    value.runtimeTaskId !== expected.runtimeTaskId || value.from !== expected.from || value.to !== expected.to ||
    !Number.isFinite(Date.parse(value.recordedAt))) throw new Error('Provisioning transition integrity mismatch.')
}

export interface AssertionCompletionEvidence {
  executionId?: string
  assertionId: string
  runtimeTaskId: string
  transitionId?: string
  providerId: string
  collector: string
  verificationStep: string
  expectedOutcome: string
  evidenceId: string
  implementationCommit?: string
  blueprintHash?: string
  artifactHashes?: Record<string, string>
  reviewerEvidenceIds?: readonly string[]
  executed: boolean
  observedMatch: boolean
  reviewerVerdict: 'PASS' | 'FAIL' | 'PENDING' | 'DEFERRED'
}

export interface CompletionBinding { assertionId: string; runtimeTaskId: string; blocking: boolean;
  ownership?: 'OWNER' | 'CONTRIBUTES' | 'AMBIGUOUS'; expectedOutcome: string;
  stagedVerification: StagedVerificationContract; verificationCapability: ResolvedCapability }

export function taskCompletionGate(bindings: readonly CompletionBinding[],
  transitions: readonly VerificationBindingTransition[], evidence: readonly AssertionCompletionEvidence[]): 'LOCALLY_VERIFIED' | 'BLOCKED' {
  const blocking = bindings.filter((binding) => binding.blocking && binding.ownership !== 'CONTRIBUTES')
  const passed = blocking.length > 0 && blocking.every((binding) => {
    const stage = binding.stagedVerification
    if (stage.readiness === 'EXTERNAL_DEFERRED' || stage.readiness === 'HUMAN_DEFERRED')
      return stage.prerequisite === 'COMPLETION' && evidence.some((item) => item.assertionId === binding.assertionId &&
        item.runtimeTaskId === binding.runtimeTaskId && item.reviewerVerdict === 'DEFERRED') &&
        !evidence.some((item) => item.assertionId === binding.assertionId && item.reviewerVerdict === 'PASS')
    const transition = stage.readiness === 'PROVISIONABLE_DURING_EXECUTION'
      ? transitions.find((item) => item.obligationId === stage.obligation?.obligationId && item.assertionId === binding.assertionId &&
        item.runtimeTaskId === binding.runtimeTaskId && item.to === 'BOUND_EXECUTABLE') : undefined
    if (stage.readiness !== 'BOUND_EXECUTABLE' && transition === undefined) return false
    return evidence.some((item) => item.assertionId === binding.assertionId && item.runtimeTaskId === binding.runtimeTaskId &&
      item.transitionId === transition?.id && item.providerId === binding.verificationCapability.providerId &&
      item.collector.length > 0 && item.verificationStep.length > 0 && item.evidenceId.length > 0 &&
      item.expectedOutcome === binding.expectedOutcome && item.executed && item.observedMatch && item.reviewerVerdict === 'PASS' &&
      item.implementationCommit === transition?.implementationCommit && item.blueprintHash === transition?.blueprintHash &&
      canonicalSerialize(item.artifactHashes ?? {}) === canonicalSerialize(transition?.artifactHashes ?? {}) &&
      item.reviewerEvidenceIds?.includes(item.evidenceId))
  })
  return passed ? 'LOCALLY_VERIFIED' : 'BLOCKED'
}

export interface ExternalAcceptanceRecord { assertionId: string; kind: 'EXTERNAL' | 'HUMAN';
  evidenceIds: readonly string[]; reviewerVerdict: 'PASS'; acceptedBy: { role: 'LOCAL_OPERATOR_UI'; channel: 'LAUNCHPAD_SESSION'; sessionRef: string; displayName?: string }; acceptedAt: string }

export function customerDeliveryCompletionGate(tasks: readonly { id: string }[],
  bindings: readonly CompletionBinding[], transitions: readonly VerificationBindingTransition[],
  evidence: readonly AssertionCompletionEvidence[], completedTaskIds: ReadonlySet<string>,
  externalAccepted: readonly ExternalAcceptanceRecord[] = [],
  contributorCompletedTaskIds: ReadonlySet<string> = new Set()): boolean {
  const unique = [...new Map(bindings.filter((binding) => binding.blocking && binding.ownership !== 'CONTRIBUTES')
    .map((binding) => [binding.assertionId, binding])).values()]
  const accepted = (id: string, kind: ExternalAcceptanceRecord['kind']): boolean =>
    externalAccepted.some((item) => item.assertionId === id && item.kind === kind && item.reviewerVerdict === 'PASS' &&
      item.acceptedBy?.role === 'LOCAL_OPERATOR_UI' && item.acceptedBy.channel === 'LAUNCHPAD_SESSION' && /^[a-f0-9]{64}$/u.test(item.acceptedBy.sessionRef) && item.evidenceIds.length > 0 && Number.isFinite(Date.parse(item.acceptedAt)))
  const assertionIds = [...new Set(bindings.filter(binding => binding.blocking).map(binding => binding.assertionId))]
  const canonicalOwners = assertionIds.length > 0 && assertionIds.every(id =>
    bindings.filter(binding => binding.blocking && binding.assertionId === id && binding.ownership === 'OWNER').length === 1)
  return tasks.length > 0 && canonicalOwners && tasks.every((task) => {
    if (!completedTaskIds.has(task.id)) return false
    const taskBindings = bindings.filter((binding) => binding.runtimeTaskId === task.id && binding.blocking)
    return taskBindings.some((binding) => binding.ownership === 'OWNER')
      ? taskCompletionGate(taskBindings, transitions, evidence) === 'LOCALLY_VERIFIED'
      : taskBindings.some((binding) => binding.ownership === 'CONTRIBUTES') && contributorCompletedTaskIds.has(task.id)
  }) &&
    unique.every((binding) => {
      if (binding.stagedVerification.readiness === 'EXTERNAL_DEFERRED') return accepted(binding.assertionId, 'EXTERNAL')
      if (binding.stagedVerification.readiness === 'HUMAN_DEFERRED') return accepted(binding.assertionId, 'HUMAN')
      return !binding.stagedVerification.obligation?.externalResidual || accepted(binding.assertionId, 'EXTERNAL')
    })
}

export interface CustomerDeliveryCompletionAssessment {
  gate: 'CUSTOMER_DELIVERY_COMPLETION_GATE'
  status: 'CUSTOMER_DELIVERY_COMPLETED' | 'CUSTOMER_DELIVERY_BLOCKED'
  completedRuntimeTaskIds: readonly string[]
  blockedRuntimeTaskIds: readonly string[]
  blockingAssertionIds: readonly string[]
}

/** Read model: implementation progress is never itself a customer delivery verdict. */
export function assessCustomerDeliveryCompletion(tasks: readonly { id: string }[],
  bindings: readonly CompletionBinding[], transitions: readonly VerificationBindingTransition[],
  evidence: readonly AssertionCompletionEvidence[], completedTaskIds: ReadonlySet<string>,
  externalAccepted: readonly ExternalAcceptanceRecord[] = [],
  contributorCompletedTaskIds: ReadonlySet<string> = new Set()): CustomerDeliveryCompletionAssessment {
  const blockedRuntimeTaskIds = tasks.filter((task) => !completedTaskIds.has(task.id) ||
    (bindings.some((binding) => binding.runtimeTaskId === task.id && binding.blocking && binding.ownership === 'OWNER')
      ? taskCompletionGate(bindings.filter((binding) => binding.runtimeTaskId === task.id), transitions, evidence) !== 'LOCALLY_VERIFIED'
      : !contributorCompletedTaskIds.has(task.id))).map((task) => task.id)
  return { gate: 'CUSTOMER_DELIVERY_COMPLETION_GATE',
    status: customerDeliveryCompletionGate(tasks, bindings, transitions, evidence, completedTaskIds, externalAccepted, contributorCompletedTaskIds)
      ? 'CUSTOMER_DELIVERY_COMPLETED' : 'CUSTOMER_DELIVERY_BLOCKED',
    completedRuntimeTaskIds: tasks.filter((task) => completedTaskIds.has(task.id)).map((task) => task.id),
    blockedRuntimeTaskIds, blockingAssertionIds: [...new Set(bindings.filter((binding) => binding.blocking)
      .map((binding) => binding.assertionId))] }
}
