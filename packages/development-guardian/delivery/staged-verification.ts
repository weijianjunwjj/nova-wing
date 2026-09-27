import { createHash } from 'node:crypto'
import { canonicalSerialize } from '../planning/freeze.js'
import { assessVerificationCommand, scopedNodeTestPath } from '../verification-command-policy.js'
import { CAPABILITY_REGISTRY, type CapabilityFamily, type ResolvedCapability } from './capability-layer.js'

export const ADMISSION_MODEL_VERSION = 1
export type VerificationReadiness = 'BOUND_EXECUTABLE' | 'PROVISIONABLE' | 'EXTERNAL_DEFERRED' | 'HUMAN_DEFERRED' | 'UNRESOLVED'
export type VerificationPrerequisite = 'EXECUTION' | 'COMPLETION'

/** Immutable obligation. Concrete verifier inputs are a separate, audited transition. */
export interface VerificationProvisioningBinding {
  id: string
  assertionId: string
  runtimeTaskId: string
  capabilityFamily: CapabilityFamily
  providerId: string
  providerVersion: string
  intendedEvidenceType: string
  strategy: 'assertion_scoped_test' | 'loopback_http_predicate' | 'scoped_artifact_predicate' | 'owned_process_predicate'
  strategyVersion: '1'
  requiredInputs: readonly string[]
  verifierLifecycle: 'PROVISION_THEN_BIND_AND_EXECUTE'
  completionRequirement: 'EXACT_EVIDENCE_AND_INDEPENDENT_REVIEW'
}

export interface StagedVerificationContract {
  readiness: VerificationReadiness
  prerequisite: VerificationPrerequisite
  policy: string
  provisioning?: VerificationProvisioningBinding
}

const strategies: Partial<Record<CapabilityFamily, { name: VerificationProvisioningBinding['strategy']; inputs: readonly string[] }>> = {
  command: { name: 'assertion_scoped_test', inputs: ['repositoryRelativeTestFile', 'exactAllowedCommand', 'expectedAssertionOutcome'] },
  http_api: { name: 'loopback_http_predicate', inputs: ['method=GET', 'loopbackPort', 'route', 'requestFixture=none', 'expectedStatus', 'expectedBodyPredicate', 'timeoutMs'] },
  filesystem: { name: 'scoped_artifact_predicate', inputs: ['repositoryRelativePath', 'artifactMatcher', 'boundedPredicate', 'expectedObservableOutcome'] },
  process: { name: 'owned_process_predicate', inputs: ['projectOwnedEntry', 'restrictedStartPolicy', 'expectedLifecycle', 'expectedExitOrListen', 'timeoutMs'] },
}

export function stagedVerificationContract(input: { assertionId: string; runtimeTaskId: string;
  capability: ResolvedCapability; prerequisite?: VerificationPrerequisite }): StagedVerificationContract {
  const { capability, assertionId, runtimeTaskId } = input
  const prerequisite = input.prerequisite ?? 'COMPLETION'
  if (capability.capability === 'SUPPORTED') return { readiness: 'BOUND_EXECUTABLE', prerequisite,
    policy: 'exact-trusted-verifier-v1' }
  if (capability.capability === 'REQUIRES_EXTERNAL_ENVIRONMENT') return { readiness: 'EXTERNAL_DEFERRED',
    prerequisite, policy: 'external-evidence-required-v1' }
  if (capability.capability === 'REQUIRES_HUMAN') return { readiness: 'HUMAN_DEFERRED', prerequisite,
    policy: 'identified-human-decision-required-v1' }
  const family = capability.family
  const strategy = strategies[family]
  const provider = CAPABILITY_REGISTRY[family]
  if (!strategy || provider.trustLevel !== 'TRUSTED_LOCAL' ||
    capability.providerId !== provider.providerId || capability.providerVersion !== provider.providerVersion) {
    return { readiness: 'UNRESOLVED', prerequisite, policy: 'no-trusted-provisioning-strategy-v1' }
  }
  const content = { assertionId, runtimeTaskId, capabilityFamily: family, providerId: provider.providerId,
    providerVersion: provider.providerVersion, intendedEvidenceType: provider.evidenceType,
    strategy: strategy.name, strategyVersion: '1' as const, requiredInputs: strategy.inputs,
    verifierLifecycle: 'PROVISION_THEN_BIND_AND_EXECUTE' as const,
    completionRequirement: 'EXACT_EVIDENCE_AND_INDEPENDENT_REVIEW' as const }
  const id = createHash('sha256').update('novawing-verification-obligation-v1\0')
    .update(canonicalSerialize(content)).digest('hex')
  return { readiness: 'PROVISIONABLE', prerequisite, policy: 'trusted-provisioning-obligation-v1',
    provisioning: { id, ...content } }
}

export type BoundVerifier =
  | { family: 'command'; assertionId: string; providerId: string; providerVersion: string; command: string }
  | { family: 'http_api'; assertionId: string; providerId: string; providerVersion: string; method: 'GET'; requestFixture: 'NONE';
      port: number; route: string; expectedStatus: number; expectedJsonPointer: string; expectedJsonValue: string; timeoutMs: number }
  | { family: 'filesystem'; assertionId: string; providerId: string; providerVersion: string; relativePath: string;
      expectation: 'file_exists' | 'file_missing' | 'directory_exists' | 'contains'; contains?: string }
  | { family: 'process'; assertionId: string; providerId: string; providerVersion: string; relativeEntry: string;
      expectedExitCode: number; timeoutMs: number }

export interface VerificationBindingTransition {
  id: string
  runtimePlanHash: string
  obligationId: string
  assertionId: string
  runtimeTaskId: string
  from: 'PROVISIONABLE'
  to: 'BOUND_EXECUTABLE'
  verifier: BoundVerifier
  recordedAt: string
}

function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function bindProvisionedVerifier(input: { runtimePlanHash: string; obligation: VerificationProvisioningBinding;
  verifier: BoundVerifier }): VerificationBindingTransition {
  const { obligation, verifier } = input
  if (!/^[a-f0-9]{64}$/u.test(input.runtimePlanHash) || verifier.assertionId !== obligation.assertionId ||
    verifier.family !== obligation.capabilityFamily || verifier.providerId !== obligation.providerId ||
    verifier.providerVersion !== obligation.providerVersion) throw new Error('Verifier does not match the exact trusted obligation.')
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
  const content = { runtimePlanHash: input.runtimePlanHash, obligationId: obligation.id,
    assertionId: obligation.assertionId, runtimeTaskId: obligation.runtimeTaskId,
    from: 'PROVISIONABLE' as const, to: 'BOUND_EXECUTABLE' as const, verifier }
  const id = createHash('sha256').update('novawing-verifier-transition-v1\0').update(canonicalSerialize(content)).digest('hex')
  return { id, ...content, recordedAt: new Date().toISOString() }
}

export function verifyBindingTransition(value: VerificationBindingTransition,
  obligation: VerificationProvisioningBinding, runtimePlanHash: string): void {
  const expected = bindProvisionedVerifier({ runtimePlanHash, obligation, verifier: value.verifier })
  if (value.id !== expected.id || value.obligationId !== expected.obligationId ||
    value.runtimeTaskId !== expected.runtimeTaskId || value.from !== expected.from || value.to !== expected.to ||
    !Number.isFinite(Date.parse(value.recordedAt))) throw new Error('Provisioning transition integrity mismatch.')
}

export interface AssertionCompletionEvidence {
  assertionId: string
  runtimeTaskId: string
  transitionId?: string
  providerId: string
  collector: string
  verificationStep: string
  expectedOutcome: string
  evidenceId: string
  executed: boolean
  observedMatch: boolean
  reviewerVerdict: 'PASS' | 'FAIL' | 'PENDING'
}

export function taskCompletionGate(bindings: readonly { assertionId: string; runtimeTaskId: string; blocking: boolean;
  expectedOutcome: string; stagedVerification: StagedVerificationContract; verificationCapability: ResolvedCapability }[],
  transitions: readonly VerificationBindingTransition[], evidence: readonly AssertionCompletionEvidence[]): boolean {
  const blocking = bindings.filter((binding) => binding.blocking)
  return blocking.length > 0 && blocking.every((binding) => {
    const stage = binding.stagedVerification
    const transition = stage.readiness === 'PROVISIONABLE'
      ? transitions.find((item) => item.obligationId === stage.provisioning?.id && item.assertionId === binding.assertionId &&
        item.runtimeTaskId === binding.runtimeTaskId && item.to === 'BOUND_EXECUTABLE') : undefined
    if (stage.readiness !== 'BOUND_EXECUTABLE' && transition === undefined) return false
    return evidence.some((item) => item.assertionId === binding.assertionId && item.runtimeTaskId === binding.runtimeTaskId &&
      item.transitionId === transition?.id && item.providerId === binding.verificationCapability.providerId &&
      item.collector.length > 0 && item.verificationStep.length > 0 && item.evidenceId.length > 0 &&
      item.expectedOutcome === binding.expectedOutcome && item.executed && item.observedMatch && item.reviewerVerdict === 'PASS')
  })
}

export function customerDeliveryCompletionGate(tasks: readonly { id: string }[],
  bindings: readonly Parameters<typeof taskCompletionGate>[0][number][], transitions: readonly VerificationBindingTransition[],
  evidence: readonly AssertionCompletionEvidence[], completedTaskIds: ReadonlySet<string>): boolean {
  return tasks.length > 0 && bindings.some((binding) => binding.blocking) && tasks.every((task) => completedTaskIds.has(task.id) &&
    taskCompletionGate(bindings.filter((binding) => binding.runtimeTaskId === task.id), transitions, evidence)) &&
    bindings.filter((binding) => binding.blocking).every((binding) => tasks.some((task) => task.id === binding.runtimeTaskId))
}

export interface CustomerDeliveryCompletionAssessment {
  gate: 'CUSTOMER_DELIVERY_COMPLETION_GATE'
  status: 'CUSTOMER_DELIVERY_COMPLETED' | 'BLOCKED'
  completedRuntimeTaskIds: readonly string[]
  blockedRuntimeTaskIds: readonly string[]
  blockingAssertionIds: readonly string[]
}

/** Read model: implementation progress is never itself a customer delivery verdict. */
export function assessCustomerDeliveryCompletion(tasks: readonly { id: string }[],
  bindings: readonly Parameters<typeof taskCompletionGate>[0][number][], transitions: readonly VerificationBindingTransition[],
  evidence: readonly AssertionCompletionEvidence[], completedTaskIds: ReadonlySet<string>): CustomerDeliveryCompletionAssessment {
  const blockedRuntimeTaskIds = tasks.filter((task) => !completedTaskIds.has(task.id) ||
    !taskCompletionGate(bindings.filter((binding) => binding.runtimeTaskId === task.id), transitions, evidence)).map((task) => task.id)
  return { gate: 'CUSTOMER_DELIVERY_COMPLETION_GATE',
    status: customerDeliveryCompletionGate(tasks, bindings, transitions, evidence, completedTaskIds)
      ? 'CUSTOMER_DELIVERY_COMPLETED' : 'BLOCKED',
    completedRuntimeTaskIds: tasks.filter((task) => completedTaskIds.has(task.id)).map((task) => task.id),
    blockedRuntimeTaskIds, blockingAssertionIds: bindings.filter((binding) => binding.blocking).map((binding) => binding.assertionId) }
}
