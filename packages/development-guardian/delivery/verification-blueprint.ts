import { createHash } from 'node:crypto'
import { isAbsolute, normalize, sep } from 'node:path'
import { canonicalSerialize } from '../planning/freeze.js'
import { z } from 'zod'
import type { AcceptanceAssertion, AcceptanceCriterion } from '../planning/model.js'
import { CAPABILITY_REGISTRY, claimRequirements, claimRequiresExactComparison, type CapabilityFamily, type ProviderAvailability } from './capability-layer.js'
import type { DeliveryTargetBinding } from './runtime-plan.js'
import type { BoundVerifier, VerificationObligation } from './staged-verification.js'
import { assessVerificationCommand, scopedNodeTestPath } from '../verification-command-policy.js'

export const BLUEPRINT_SCHEMA_VERSION = 1
export type BlueprintStepKind = 'setup' | 'action' | 'observation' | 'predicate' | 'reread' | 'cleanup'
export type BlueprintMechanism = 'repository_test' | 'loopback_http_get' | 'scoped_filesystem_read' | 'owned_process' | 'manifest'
export interface BlueprintStep {
  kind: BlueprintStepKind
  mechanism: BlueprintMechanism
  artifact: string
  operation: string
  expected?: string
  mutates: boolean
  entityRef?: string
}
/** Declares the audited delivery surface. Current single-file verifier cannot establish global absence. */
export interface ArtifactScopeContract {
  kind: 'scope_manifest' | 'delivery_manifest'
  relativePath: string
  generator: string
  includedRoots: string[]
  reviewRequired: true
}
export interface VerificationBlueprint {
  schemaVersion: 1
  assertionId: string
  runtimeTaskId: string
  sourceAssertionHash: string
  provider: { id: string; version: string }
  family: CapabilityFamily | 'composite'
  setup: BlueprintStep[]
  action: BlueprintStep[]
  observation: BlueprintStep[]
  predicate: BlueprintStep[]
  reread: BlueprintStep[]
  cleanup: BlueprintStep[]
  timeoutMs: number
  requiredArtifacts: string[]
  artifactScope?: ArtifactScopeContract
  targetConstraints: { canonicalPath: string; gitRepositoryIdentity: string; baselineCommit: string }
  provenance: { kind: 'repository_contract' | 'deterministic_resolver'; relativePath: string; contractHash: string }
  entityIdentity?: { setupRef: string; actionRef: string; observationRef: string }
  plannedVerifier?: BoundVerifier
  obligationId?: string
  implementationCommit?: string
  artifactHashes?: Record<string, string>
}
export interface BlueprintReviewIssue {
  code: 'FALSE_POSITIVE' | 'WEAK_PREDICATE' | 'MISSING_SETUP_ACTION' | 'COMMAND_ONLY' |
    'CAPABILITY_ABSENT' | 'UNSAFE_SCOPE' | 'ENTITY_MISMATCH' | 'OTHER'
  message: string
}
export interface BlueprintReview {
  verdict: 'PASS' | 'REVISION_REQUIRED'
  reviewer: string
  issues: BlueprintReviewIssue[]
}
export interface ApprovedVerificationBlueprint extends VerificationBlueprint {
  id: string
  blueprintHash: string
  review: BlueprintReview & { verdict: 'PASS' }
  trust: 'REVIEWED_PLANNER_RESULT'
}
export interface BlueprintValidationIssue { code: string; message: string }
export interface BlueprintValidation { pass: boolean; issues: BlueprintValidationIssue[] }

const stepSchema = z.object({ kind: z.enum(['setup', 'action', 'observation', 'predicate', 'reread', 'cleanup']),
  mechanism: z.enum(['repository_test', 'loopback_http_get', 'scoped_filesystem_read', 'owned_process', 'manifest']),
  artifact: z.string().min(1).max(240), operation: z.string().min(1).max(300), expected: z.string().max(1_000).optional(),
  mutates: z.boolean(), entityRef: z.string().max(120).optional() }).strict()
const verifierSchema = z.discriminatedUnion('family', [
  z.object({ family: z.literal('command'), assertionId: z.string(), providerId: z.string(), providerVersion: z.string(),
    command: z.string() }).strict(),
  z.object({ family: z.literal('http_api'), assertionId: z.string(), providerId: z.string(), providerVersion: z.string(),
    method: z.literal('GET'), requestFixture: z.literal('NONE'), port: z.number().int(), route: z.string(),
    expectedStatus: z.number().int(), expectedJsonPointer: z.string(), expectedJsonValue: z.string(),
    timeoutMs: z.number().int() }).strict(),
  z.object({ family: z.literal('filesystem'), assertionId: z.string(), providerId: z.string(), providerVersion: z.string(),
    relativePath: z.string(), expectation: z.enum(['file_exists', 'file_missing', 'directory_exists', 'contains']),
    contains: z.string().optional() }).strict(),
  z.object({ family: z.literal('process'), assertionId: z.string(), providerId: z.string(), providerVersion: z.string(),
    relativeEntry: z.string(), expectedExitCode: z.number().int(), timeoutMs: z.number().int() }).strict(),
  z.object({ family: z.literal('scope_review'), assertionId: z.string(), providerId: z.string(),
    providerVersion: z.string(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    command: z.string().optional() }).strict(),
])
const candidateSchema = z.object({ schemaVersion: z.literal(1), assertionId: z.string().min(1),
  runtimeTaskId: z.string().min(1), sourceAssertionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  provider: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  family: z.enum(['command', 'http_api', 'browser_ui', 'filesystem', 'git', 'process', 'desktop_ui',
    'external_platform', 'human', 'composite']),
  setup: z.array(stepSchema).max(20), action: z.array(stepSchema).max(20), observation: z.array(stepSchema).max(20),
  predicate: z.array(stepSchema).max(20), reread: z.array(stepSchema).max(20), cleanup: z.array(stepSchema).max(20),
  timeoutMs: z.number().int(), requiredArtifacts: z.array(z.string()).max(30),
  artifactScope: z.object({ kind: z.enum(['scope_manifest', 'delivery_manifest']), relativePath: z.string(),
    generator: z.string(), includedRoots: z.array(z.string()), reviewRequired: z.literal(true) }).strict().optional(),
  targetConstraints: z.object({ canonicalPath: z.string().min(1), gitRepositoryIdentity: z.string().min(1),
    baselineCommit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict(),
  provenance: z.object({ kind: z.enum(['repository_contract', 'deterministic_resolver']),
    relativePath: z.string(), contractHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  entityIdentity: z.object({ setupRef: z.string(), actionRef: z.string(), observationRef: z.string() }).strict().optional(),
  plannedVerifier: verifierSchema.optional(),
  obligationId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  implementationCommit: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  artifactHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
}).strict()

export function assertionContractHash(assertion: AcceptanceAssertion): string {
  return createHash('sha256').update('novawing-assertion-contract-v1\0').update(canonicalSerialize({
    id: assertion.id, requirementId: assertion.requirementId, blocking: assertion.blocking,
    observableBehavior: assertion.observableBehavior,
    expectedOutcome: assertion.expectedOutcome, expectedEvidence: assertion.expectedEvidence,
  })).digest('hex')
}

export function blueprintHash(blueprint: VerificationBlueprint): string {
  return createHash('sha256').update('novawing-verification-blueprint-v1\0')
    .update(canonicalSerialize(blueprint)).digest('hex')
}

function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !isAbsolute(path) && !path.includes('\\') &&
    normalize(path) === path && path.split('/').every((part) => part !== '.' && part !== '..' && part !== '') &&
    !path.startsWith(sep)
}
const placeholder = /(?:\{\{|\}\}|<[^>]+>|\$\{|\b(?:TODO|TBD|PLACEHOLDER|YOUR_[A-Z_]+)\b)/iu
export function validateVerificationBlueprint(blueprint: VerificationBlueprint, input: {
  assertion: AcceptanceAssertion; criterion: AcceptanceCriterion; runtimeTaskId: string;
  target: DeliveryTargetBinding; providerAvailability?: (providerId: string) => ProviderAvailability;
  obligation?: VerificationObligation; implementationCommit?: string;
  artifactSources?: Record<string, string>; scopeManifestHash?: string
}): BlueprintValidation {
  if (!candidateSchema.safeParse(blueprint).success) return { pass: false,
    issues: [{ code: 'INVALID_BLUEPRINT_SHAPE', message: 'Blueprint schema or bounded fields are invalid.' }] }
  const issues: BlueprintValidationIssue[] = []
  const add = (code: string, message: string): void => { issues.push({ code, message }) }
  if (blueprint.schemaVersion !== BLUEPRINT_SCHEMA_VERSION || !blueprint.assertionId || !blueprint.runtimeTaskId)
    add('MISSING_ASSERTION_BINDING', 'Blueprint requires an exact assertion and runtime task.')
  if (blueprint.assertionId !== input.assertion.id || blueprint.runtimeTaskId !== input.runtimeTaskId ||
    blueprint.sourceAssertionHash !== assertionContractHash(input.assertion))
    add('ASSERTION_MISMATCH', 'Blueprint does not bind the frozen assertion contract.')
  if (blueprint.targetConstraints.canonicalPath !== input.target.canonicalPath ||
    blueprint.targetConstraints.gitRepositoryIdentity !== input.target.gitRepositoryIdentity ||
    blueprint.targetConstraints.baselineCommit !== (input.implementationCommit ?? input.target.baselineCommit))
    add('COMMIT_NOT_DESCENDANT', 'Blueprint target or baseline ancestry differs from the bound repository.')
  if (input.implementationCommit && blueprint.implementationCommit !== input.implementationCommit)
    add('COMMIT_MISMATCH', 'Blueprint is not bound to the inspected implementation commit.')
  const provider = blueprint.family === 'composite' ? undefined : CAPABILITY_REGISTRY[blueprint.family]
  if (!provider || provider.providerId !== blueprint.provider.id || provider.providerVersion !== blueprint.provider.version ||
    provider.availability !== 'AVAILABLE' || (input.providerAvailability &&
      input.providerAvailability(blueprint.provider.id) !== 'AVAILABLE'))
    add('PROVIDER_UNAVAILABLE', 'The selected verification provider is unavailable.')
  if (!Number.isSafeInteger(blueprint.timeoutMs) || blueprint.timeoutMs < 100 || blueprint.timeoutMs > 120_000)
    add('UNBOUNDED_TIMEOUT', 'Blueprint timeout must be bounded.')
  const sections = [blueprint.setup, blueprint.action, blueprint.observation, blueprint.predicate, blueprint.reread, blueprint.cleanup]
  for (const [index, section] of sections.entries()) for (const step of section) if (step.kind !==
    (['setup', 'action', 'observation', 'predicate', 'reread', 'cleanup'] as const)[index])
    add('STEP_ORDER_MISMATCH', 'Blueprint step is in the wrong lifecycle section.')
  const steps = sections.flat()
  if (!blueprint.predicate.length || blueprint.predicate.some((step) => !step.expected?.trim()))
    add('UNSPECIFIED_PREDICATE', 'An explicit expected business outcome is required.')
  for (const step of steps) {
    if (!step.artifact || placeholder.test(step.artifact) || placeholder.test(step.operation) || placeholder.test(step.expected ?? ''))
      add('PLACEHOLDER', 'Blueprint contains an unresolved path, endpoint, variable, or expectation.')
    if (!safeRelative(step.artifact) &&
      !(step.mechanism === 'loopback_http_get' && /^\/(?!\/)[^?#\s]*$/u.test(step.artifact)))
      add('TARGET_ESCAPE', 'Blueprint artifact is outside the repository or is not a concrete loopback route.')
    if (step.mechanism === 'loopback_http_get' &&
      (!/^\/(?!\/)[^?#\s]*$/u.test(step.artifact) || placeholder.test(step.artifact)))
      add('PLACEHOLDER_ENDPOINT', 'HTTP evidence needs a concrete loopback route.')
    if (step.mechanism === 'owned_process' && /(?:\b(?:sh|bash|zsh|cmd|powershell)\b|[;&|`$])/iu.test(step.operation))
      add('UNRESTRICTED_SHELL', 'Process evidence cannot invoke an unrestricted shell.')
  }
  for (const artifact of blueprint.requiredArtifacts) if (!safeRelative(artifact) || placeholder.test(artifact))
    add('PLACEHOLDER_PATH', 'Required artifact must be a concrete repository-relative path.')
  if (blueprint.artifactScope && (!safeRelative(blueprint.artifactScope.relativePath) ||
    !blueprint.artifactScope.generator.trim() || !blueprint.artifactScope.includedRoots.length ||
    blueprint.artifactScope.includedRoots.some((path) => !safeRelative(path)) ||
    blueprint.artifactScope.reviewRequired !== true))
    add('INVALID_SCOPE_MANIFEST', 'Artifact scope needs a concrete generated, bounded and reviewed manifest.')
  const requirements = claimRequirements(input.assertion)
  if (requirements.requiresMutation && ![...blueprint.setup, ...blueprint.action].some((step) => step.mutates))
    add('MUTATION_WITH_READ_ONLY_EVIDENCE', 'A state-changing assertion needs a trusted action.')
  if (requirements.requiresReread && blueprint.reread.length === 0)
    add('PERSISTENCE_WITHOUT_REREAD', 'Persistence needs a separate reread observation.')
  if (claimRequiresExactComparison(input.assertion) && !blueprint.predicate.some((step) => /(?:===|==|equals|equal_to|exact_value)/u.test(step.operation)))
    add('NUMBER_WITHOUT_EXACT_COMPARISON', 'A numerical claim needs an exact comparison.')
  const claimNumbers = requirements.exactNumbers
  if (claimNumbers.length && claimNumbers.some((number) => !blueprint.predicate.some((step) =>
    new RegExp(`(?:^|\\D)${number.replace('.', '\\.')}($|\\D)`, 'u').test(step.expected ?? ''))))
    add('EXPECTED_NUMBER_MISSING', 'An exact number in the frozen claim is absent from the expected predicate.')
  if (requirements.requiresEntityContinuity && (!blueprint.entityIdentity ||
    !Object.values(blueprint.entityIdentity).every((value) => value.trim().length > 0) ||
    new Set(Object.values(blueprint.entityIdentity)).size !== 1))
    add('ENTITY_IDENTITY_MISSING', 'The same business entity must be bound across steps.')
  if ([...blueprint.setup, ...blueprint.action].some((step) => step.mutates) && !blueprint.cleanup.length)
    add('CLEANUP_MISSING', 'Mutating setup needs a bounded cleanup contract.')
  if ((input.criterion.level === 'ui' || input.criterion.level === 'platform') &&
    !['browser_ui', 'desktop_ui', 'external_platform'].includes(blueprint.family))
    add('UI_API_SUBSTITUTION', 'API or filesystem evidence cannot replace UI or platform interaction.')
  if (blueprint.plannedVerifier?.family === 'http_api' &&
    (!blueprint.plannedVerifier.expectedJsonPointer || blueprint.predicate.every((step) => /(?:status|http)/iu.test(step.operation))))
    add('HTTP_STATUS_ONLY', 'HTTP status alone cannot prove business state.')
  if (blueprint.plannedVerifier?.family === 'http_api' &&
    (blueprint.setup.length > 0 || blueprint.action.length > 0 || blueprint.cleanup.length > 0 ||
      blueprint.reread.length > 0 || steps.some((step) => step.mechanism !== 'loopback_http_get')))
    add('EXECUTION_COVERAGE_GAP', 'A single GET verifier cannot execute scenario setup, mutation, cleanup or reread.')
  if (blueprint.plannedVerifier?.family === 'filesystem' &&
    (blueprint.setup.length > 0 || blueprint.action.length > 0 || blueprint.cleanup.length > 0 ||
      blueprint.reread.length > 0 || steps.some((step) => step.mechanism !== 'scoped_filesystem_read')))
    add('EXECUTION_COVERAGE_GAP', 'A single filesystem read cannot execute a scenario.')
  if (blueprint.plannedVerifier?.family === 'command') {
    const testFile = blueprint.plannedVerifier.command.slice('node --test '.length)
    if (steps.some((step) => step.mechanism !== 'repository_test' || step.artifact !== testFile))
      add('EXECUTION_COVERAGE_GAP', 'A repository test blueprint must be wholly implemented by its exact test entry.')
  }
  if (blueprint.plannedVerifier?.family === 'process' && !blueprint.observation.some((step) =>
    step.mechanism !== 'owned_process'))
    add('PROCESS_EXIT_ONLY', 'Process exit alone cannot prove application readiness.')
  if (blueprint.plannedVerifier?.family === 'process' && steps.some((step) => step.mechanism !== 'owned_process'))
    add('EXECUTION_COVERAGE_GAP', 'A single process verifier cannot collect other evidence steps.')
  if (blueprint.plannedVerifier?.family === 'filesystem' && blueprint.plannedVerifier.expectation === 'file_missing')
    add('NEGATIVE_SCOPE_UNPROVEN', 'A missing file does not prove a system-wide absence claim.')
  if (blueprint.family === 'composite' && blueprint.plannedVerifier)
    add('COMPOSITE_PROVIDER_GAP', 'The current runtime cannot bind a composite verifier.')
  if (blueprint.plannedVerifier && (blueprint.plannedVerifier.assertionId !== blueprint.assertionId ||
    blueprint.plannedVerifier.providerId !== blueprint.provider.id ||
    blueprint.plannedVerifier.providerVersion !== blueprint.provider.version ||
    (blueprint.plannedVerifier.family !== blueprint.family &&
      !(input.obligation?.strategy === 'delivery_scope_review' && blueprint.plannedVerifier.family === 'scope_review'))))
    add('VERIFIER_MISMATCH', 'Runtime verifier differs from blueprint provider and assertion.')
  if (!blueprint.plannedVerifier) add('RUNTIME_ADAPTER_MISSING', 'No exact Runtime verifier implements this blueprint.')
  if (input.obligation) {
    const obligation = input.obligation
    if (blueprint.obligationId !== obligation.obligationId || blueprint.family !== obligation.capabilityFamily ||
      blueprint.provider.id !== obligation.providerId || blueprint.provider.version !== obligation.providerVersion ||
      blueprint.sourceAssertionHash !== obligation.sourceAssertionHash ||
      blueprint.runtimeTaskId !== obligation.canonicalOwnerTaskId)
      add('OBLIGATION_CONFORMANCE', 'Blueprint changes a frozen obligation field.')
    const requiredMechanism: BlueprintMechanism = obligation.strategy === 'assertion_scoped_repository_test' ? 'repository_test' :
      obligation.strategy === 'loopback_http_get_predicate' ? 'loopback_http_get' :
      obligation.strategy === 'scoped_artifact_predicate' ? 'scoped_filesystem_read' :
      obligation.strategy === 'owned_process_predicate' ? 'owned_process' : 'manifest'
    const mixedScope = obligation.strategy === 'delivery_scope_review' && obligation.requirements.requiresMutation
    const scopeCommand = blueprint.plannedVerifier?.family === 'scope_review'
      ? blueprint.plannedVerifier.command : undefined
    const scopeTestPath = scopeCommand === undefined ? undefined : scopedNodeTestPath(scopeCommand)
    if ((obligation.strategy === 'delivery_scope_review'
      ? steps.some((step) => step.mechanism !== 'manifest' && !(mixedScope && step.mechanism === 'repository_test'))
      : steps.some((step) => step.mechanism !== requiredMechanism)) ||
      obligation.strategy === 'delivery_scope_review' && blueprint.plannedVerifier?.family !== 'scope_review' ||
      obligation.strategy === 'assertion_scoped_repository_test' && blueprint.plannedVerifier?.family !== 'command' ||
      obligation.strategy === 'loopback_http_get_predicate' && blueprint.plannedVerifier?.family !== 'http_api' ||
      obligation.strategy === 'scoped_artifact_predicate' && blueprint.plannedVerifier?.family !== 'filesystem' ||
      obligation.strategy === 'owned_process_predicate' && blueprint.plannedVerifier?.family !== 'process')
      add('OBLIGATION_CONFORMANCE', 'Blueprint mechanism or verifier substitutes the frozen strategy.')
    const scopeManifestCovered = blueprint.observation.some((step) => step.mechanism === 'manifest') &&
      blueprint.predicate.some((step) => step.mechanism === 'manifest')
    const scopeTestCovered = scopeTestPath !== undefined && scopeCommand !== undefined &&
      assessVerificationCommand(scopeCommand).status === 'ALLOWED' &&
      blueprint.requiredArtifacts.includes(scopeTestPath) &&
      blueprint.action.length > 0 && blueprint.action.some((step) => step.mutates) &&
      blueprint.cleanup.length > 0 &&
      [...blueprint.action, ...blueprint.cleanup].every((step) =>
        step.mechanism === 'repository_test' && step.artifact === scopeTestPath) &&
      blueprint.predicate.some((step) => step.mechanism === 'repository_test' && step.artifact === scopeTestPath)
    if (obligation.strategy === 'delivery_scope_review' &&
      (!scopeManifestCovered || Boolean(scopeCommand) !== mixedScope ||
        (mixedScope && !scopeTestCovered) ||
        (!mixedScope && steps.some((step) => step.mechanism === 'repository_test'))))
      add('OBLIGATION_CONFORMANCE', 'Mixed scope requires a scoped executable test plus generated manifest review.')
    if (obligation.requirements.requiresMutation && ![...blueprint.setup, ...blueprint.action].some((step) => step.mutates) ||
      obligation.requirements.requiresReread && !blueprint.reread.length ||
      obligation.requirements.requiresCleanup && !blueprint.cleanup.length ||
      obligation.requirements.requiresEntityContinuity && !blueprint.entityIdentity)
      add('OBLIGATION_CONFORMANCE', 'Blueprint omits a frozen requirement flag.')
    const expected = blueprint.predicate.map((step) => step.expected ?? '').join(' ')
    const sources = Object.values(input.artifactSources ?? {}).join(' ')
    if (obligation.requirements.exactNumbers.some((number) => !expected.includes(number) ||
      ((blueprint.plannedVerifier?.family === 'command' || scopeCommand !== undefined) && !sources.includes(number))))
      add('OBLIGATION_CONFORMANCE', 'Frozen exact numbers are missing from predicate or test source.')
    if (!blueprint.artifactHashes || blueprint.requiredArtifacts.some((path) =>
      !/^[a-f0-9]{64}$/u.test(blueprint.artifactHashes?.[path] ?? '')))
      add('OBLIGATION_CONFORMANCE', 'Blueprint lacks inspected artifact hashes.')
    if (obligation.strategy === 'delivery_scope_review' &&
      (!blueprint.artifactScope || !input.scopeManifestHash ||
        blueprint.artifactHashes?.NOVAWING_SCOPE_MANIFEST !== input.scopeManifestHash ||
        blueprint.plannedVerifier?.family !== 'scope_review'))
      add('OBLIGATION_CONFORMANCE', 'Scope review needs a NovaWing manifest and exact manifest hash.')
  }
  return { pass: issues.length === 0, issues }
}

export function approveVerificationBlueprint(candidate: VerificationBlueprint, review: BlueprintReview): ApprovedVerificationBlueprint {
  const normalized = candidateSchema.parse(candidate) as VerificationBlueprint
  if (review.verdict !== 'PASS' || review.issues.length || !review.reviewer.trim())
    throw new Error('Independent blueprint review did not pass.')
  const hash = blueprintHash(normalized)
  return { ...normalized, id: hash, blueprintHash: hash,
    review: { verdict: 'PASS', reviewer: review.reviewer, issues: [] }, trust: 'REVIEWED_PLANNER_RESULT' }
}

export function verifyApprovedBlueprint(blueprint: ApprovedVerificationBlueprint, input: Parameters<typeof validateVerificationBlueprint>[1]): void {
  const { id, blueprintHash: hash, review, trust, ...candidate } = blueprint
  if (!validateVerificationBlueprint(candidate, input).pass) throw new Error('Approved verification blueprint is invalid or stale.')
  if (trust !== 'REVIEWED_PLANNER_RESULT' || review.verdict !== 'PASS' || review.issues.length ||
    !review.reviewer || id !== blueprintHash(candidate) || hash !== id)
    throw new Error('Approved verification blueprint is invalid or stale.')
}
