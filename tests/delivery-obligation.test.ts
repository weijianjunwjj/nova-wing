import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, verifyPlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { bindDeliveryTarget, compileRuntimePlan, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity,
  workSessionDefinitionFor } from '../packages/development-guardian/delivery/runtime-plan.js'
import { assertionContractHash, validateVerificationBlueprint, type VerificationBlueprint } from '../packages/development-guardian/delivery/verification-blueprint.js'
import { validateVerificationObligation, taskCompletionGate, customerDeliveryCompletionGate,
  bindProvisionedVerifier } from '../packages/development-guardian/delivery/staged-verification.js'
import { collectCommandEvidence } from '../packages/development-guardian/delivery/capability-layer.js'
import { inspectAtCommit, generateScopeManifest } from '../packages/development-guardian/delivery/repo-capability-inspector.js'
import { DeliveryStore } from '../packages/development-guardian/delivery/service.js'
import { createDeliveryRuntimeDispatcher } from '../packages/development-guardian/delivery/runtime-adapter.js'
import { bindObligationAtCommit } from '../packages/development-guardian/delivery/verification-blueprint-planner.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assertionCapabilityEvidenceValid, unmappedAcceptanceCriteria } from '../packages/development-guardian/work-session/risk-evidence.js'
import { checkpointImplementationForVerification, finalizeCompletedTask,
  verifyDeliveryImplementationCommit } from '../packages/development-guardian/work-session/git-checkpoint.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'

const run = promisify(execFile)
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout.trim()
}
function snapshot(options: { level?: 'integration' | 'delivery' | 'ui'; behavior?: string; outcome?: string;
  evidence?: string; tasks?: Array<{ id: string; dependencyIds: string[]; acceptanceCriterionIds?: string[];
    objective?: string; outputs?: string[] }>;
  separateTaskAssertions?: boolean; secondExternal?: boolean } = {}) {
  const requirement = '顾客创建订单后必须能重新读取同一订单的持久化业务状态，并获得可复核的结果。'
  const behavior = options.behavior ?? '创建订单并保存。'
  const outcome = options.outcome ?? '订单状态持久化且同一订单可重新读取。'
  const evidence = options.evidence ?? '同一订单操作、重读和结果记录。'
  const taskSpecs = options.tasks ?? [{ id: 'T1', dependencyIds: [] }]
  const draft: PlanDraft = {
    clauses: [{ id: 'R1', statement: requirement, type: 'business-rule', priority: 'must',
      source: { excerpt: requirement, location: 'fixture:1', origin: 'customer_requirement' },
      ambiguity: { ambiguous: false, note: '' } }],
    analysis: { productGoal: '交付订单流程', summary: '订单流程可观察。',
      userRoles: [{ id: 'U1', name: '顾客', goals: ['查看订单'] }],
      businessFlows: [{ id: 'F1', title: '订单', steps: ['创建订单', '检查结果'], requirementIds: ['R1'] }] },
    productScope: { inScope: ['订单'], outOfScope: ['会员'] },
    architecture: { summary: '用持久化订单和隔离测试提供证据。', components: ['订单'], decisions: [] },
    tasks: taskSpecs.map((item, index) => ({ id: item.id, title: `任务 ${item.id}`, objective: item.objective ?? '实现并验证订单',
      requirementIds: ['R1'], outputs: item.outputs ?? ['订单结果'], dependencyIds: item.dependencyIds,
      acceptanceCriterionIds: item.acceptanceCriterionIds ?? [options.separateTaskAssertions && index === 1 ? 'C2' : 'C1'], complexity: 'small' as const })),
    acceptancePlan: { strategy: '按冻结断言独立验证。', criteria: [{ id: 'C1', requirementIds: ['R1'],
      description: behavior, level: options.level ?? 'integration', expectedEvidence: evidence, blocking: true,
      assertions: [{ id: 'A1', requirementId: 'R1', observableBehavior: behavior,
        expectedOutcome: outcome, expectedEvidence: evidence, blocking: true }] },
      ...(options.separateTaskAssertions ? [{ id: 'C2', requirementIds: ['R1'],
        description: options.secondExternal ? '顾客在外部页面查看订单。' : '本地订单状态可验证。',
        level: options.secondExternal ? 'ui' as const : 'integration' as const,
        expectedEvidence: options.secondExternal ? '客户浏览器交互和截图。' : '订单状态证据。', blocking: true,
        assertions: [{ id: 'A2', requirementId: 'R1',
          observableBehavior: options.secondExternal ? '顾客在外部页面查看订单。' : '创建订单并保存。',
          expectedOutcome: options.secondExternal ? '页面呈现已保存的订单状态。' : '订单状态持久化。',
          expectedEvidence: options.secondExternal ? '客户浏览器交互和截图。' : '订单操作和重读。', blocking: true }] }] : [])] },
    risks: [], assumptions: [], customerQuestions: [],
  }
  const id = '22222222-2222-4222-8222-222222222222'
  const plan = createDevelopmentPlan(draft, { id, text: requirement, receivedAt: new Date().toISOString() }, id)
  plan.semanticReview = { verdict: 'PASS', issues: [] }
  plan.status = 'ready_for_approval'
  const approval = { planId: id, planVersion: 1, approvedAt: new Date().toISOString(), actor: 'customer' as const,
    source: 'customer_mode' as const, contentHash: planContentHash(canonicalPlanContent(plan)) }
  return createPlanSnapshot(plan, approval, null)
}
async function fixture(options: Parameters<typeof snapshot>[0] = {}, seed?: (repo: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nw-obligation-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'checkout', '-qb', 'codex/obligation-fixture')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await seed?.(repo)
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'baseline')
  const frozen = snapshot(options)
  const target = await bindDeliveryTarget(frozen, repo, 'trusted_test')
  const compile = () => compileRuntimePlan(frozen, target, { runtimePolicyVersion: 'test-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  return { root, repo, frozen, target, compile }
}
function blueprint(frozen: ReturnType<typeof snapshot>, target: Awaited<ReturnType<typeof bindDeliveryTarget>>,
  family: 'command' | 'filesystem' | 'http_api' = 'command'): VerificationBlueprint {
  const assertion = frozen.content.acceptancePlan.criteria[0]!.assertions[0]!
  const artifact = 'tests/assertion.test.js'
  const step = (kind: 'setup' | 'action' | 'observation' | 'predicate' | 'reread' | 'cleanup',
    expected = '24') => ({ kind, mechanism: 'repository_test' as const, artifact,
      operation: kind === 'predicate' ? 'exact_value' : `scoped_${kind}`, expected,
      mutates: kind === 'setup' || kind === 'action', entityRef: 'order-id' })
  return { schemaVersion: 1, assertionId: 'A1', runtimeTaskId: 'T1',
    sourceAssertionHash: assertionContractHash(assertion), provider: { id: 'existing-guarded-verifier', version: '1' },
    family, setup: [step('setup')], action: [step('action')], observation: [step('observation')],
    predicate: [step('predicate')], reread: [step('reread')], cleanup: [step('cleanup')], timeoutMs: 5_000,
    requiredArtifacts: [artifact], targetConstraints: { canonicalPath: target.canonicalPath,
      gitRepositoryIdentity: target.gitRepositoryIdentity, baselineCommit: target.baselineCommit },
    provenance: { kind: 'repository_contract', relativePath: 'verification/blueprints.v1.json', contractHash: 'a'.repeat(64) },
    entityIdentity: { setupRef: 'order-id', actionRef: 'order-id', observationRef: 'order-id' },
    plannedVerifier: { family: 'command', assertionId: 'A1', providerId: 'existing-guarded-verifier',
      providerVersion: '1', command: `node --test ${artifact}` } }
}
function deferredEvidence(binding: { assertionId: string; runtimeTaskId: string; expectedOutcome: string;
  verificationCapability: { providerId: string } }) {
  return { assertionId: binding.assertionId, runtimeTaskId: binding.runtimeTaskId,
    providerId: binding.verificationCapability.providerId, collector: 'independent-reviewer',
    verificationStep: 'COMPLETION_DEFERRED', expectedOutcome: binding.expectedOutcome,
    evidenceId: `DEFERRED:${binding.assertionId}`, executed: false, observedMatch: false,
    reviewerVerdict: 'DEFERRED' as const }
}

test('1 implementation-dependent endpoint absent but exact obligation admits Start', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  assert.equal(plan.admission.status, 'READY')
  assert.equal(obligation.strategy, 'assertion_scoped_repository_test')
  assert.equal(obligation.predicateClass, 'state_transition')
  assert.equal(obligation.requirements.requiresReread, true)
  assert.equal(obligation.targetConstraints.baselineCommit, f.target.baselineCommit)
})

test('2 strategy or input names alone fail the minimum obligation contract', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const binding = plan.acceptanceBindings[0]!
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const original = binding.stagedVerification.obligation!
  const input = { assertion, criterion, ownerTaskId: 'T1', coveringTaskIds: ['T1'], target: f.target }
  assert.ok(validateVerificationObligation({ ...original, predicateClass: '' as typeof original.predicateClass }, input).includes('PREDICATE_CLASS_MISSING'))
  assert.ok(validateVerificationObligation({ ...original, expectedOutcome: '' }, input).includes('EXPECTED_NOT_FROZEN'))
  assert.ok(validateVerificationObligation({ ...original, requirements: {} as typeof original.requirements }, input).includes('FLAGS_INCONSISTENT'))
  assert.ok(validateVerificationObligation({ ...original, forbiddenSubstitutions: [] }, input).includes('FORBIDDEN_SUBSTITUTION_MISSING'))
})

test('3 implementation without transition cannot complete', async () => {
  const plan = await (await fixture()).compile()
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [], []), 'BLOCKED')
})

test('4 executed verifier failure produces failed evidence', async () => {
  const f = await fixture()
  await mkdir(join(f.repo, 'tests'))
  await writeFile(join(f.repo, 'tests/fail.test.js'), "import test from 'node:test'; test('failure', () => { throw new Error('wrong business outcome') })\n")
  const observed = await collectCommandEvidence({ target: f.target, assertionId: 'A1', command: 'node --test tests/fail.test.js' })
  assert.equal(observed.facts.observedMatch, false)
  assert.equal(observed.facts.exitCode, 1)
})

test('5 exit-zero source without exact number and reread fails obligation conformance', async () => {
  const f = await fixture({ outcome: '精确 24 元，订单持久化。' })
  const plan = await f.compile()
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const candidate = blueprint(f.frozen, f.target)
  const invalid = validateVerificationBlueprint({ ...candidate, reread: [] }, { assertion: criterion.assertions[0]!, criterion,
    runtimeTaskId: 'T1', target: f.target, obligation: plan.acceptanceBindings[0]!.stagedVerification.obligation!,
    implementationCommit: f.target.baselineCommit, artifactSources: { 'tests/assertion.test.js': 'test(() => {})' } })
  assert.ok(invalid.issues.some((item) => item.code === 'PERSISTENCE_WITHOUT_REREAD'))
  assert.ok(invalid.issues.some((item) => item.code === 'OBLIGATION_CONFORMANCE'))
})

test('6 deleted frozen assertion invalidates snapshot or RuntimePlan identity', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const changed = structuredClone(f.frozen)
  changed.content.acceptancePlan.criteria[0]!.assertions = []
  assert.throws(() => verifyPlanSnapshot(changed))
  assert.throws(() => verifyRuntimePlanCoverage(f.frozen, { ...plan, acceptanceBindings: [] }))
})

test('7 flipping blocking to false invalidates frozen and RuntimePlan hashes', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const changed = structuredClone(f.frozen)
  changed.content.acceptancePlan.criteria[0]!.assertions[0]!.blocking = false
  assert.throws(() => verifyPlanSnapshot(changed))
  assert.throws(() => verifyRuntimePlanIdentity({ ...plan, acceptanceBindings: plan.acceptanceBindings.map((item) => ({ ...item, blocking: false })) }))
})

test('8 weakening frozen expected outcome invalidates source assertion hash', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const changed = structuredClone(f.frozen)
  changed.content.acceptancePlan.criteria[0]!.assertions[0]!.expectedOutcome = 'npm test PASS'
  assert.throws(() => verifyPlanSnapshot(changed))
  assert.throws(() => verifyRuntimePlanCoverage(f.frozen, { ...plan,
    acceptanceBindings: plan.acceptanceBindings.map((item) => ({ ...item, expectedOutcome: 'npm test PASS' })) }))
})

test('9 completion-only external assertion is locally verified but customer delivery blocked', async () => {
  const f = await fixture({ level: 'ui', behavior: '顾客在页面查看订单。', outcome: '页面呈现订单状态。', evidence: '浏览器交互与截图。' })
  const plan = await f.compile()
  assert.equal(plan.admission.status, 'READY')
  const deferred = deferredEvidence(plan.acceptanceBindings[0]!)
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [], [deferred]), 'LOCALLY_VERIFIED')
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [], [deferred], new Set(['T1'])), false)
})

test('10 three covering tasks yield one canonical owner and one obligation', async () => {
  const f = await fixture({ tasks: [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] },
    { id: 'T3', dependencyIds: ['T2'] }] })
  assert.equal(verifyPlanSnapshot(f.frozen).sourcePlanVersion, 1)
  const plan = await f.compile()
  assert.deepEqual(verifyRuntimePlanCoverage(f.frozen, plan).blockingAssertionRuntime, 100)
  assert.deepEqual(plan.tasks.map((task) => task.dependencyIds), [[], ['T1'], ['T2']])
  assert.equal(plan.acceptanceBindings.filter((item) => item.stagedVerification.obligation).length, 1)
  assert.equal(plan.acceptanceBindings.find((item) => item.ownership === 'OWNER')?.runtimeTaskId, 'T3')
  assert.deepEqual(plan.acceptanceBindings.map((item) => [item.runtimeTaskId, item.ownership, item.canonicalOwnerTaskId]),
    [['T1', 'CONTRIBUTES', 'T3'], ['T2', 'CONTRIBUTES', 'T3'], ['T3', 'OWNER', 'T3']])
  const definition = workSessionDefinitionFor(plan, 'admission-probe')
  assert.deepEqual(definition.tasks.map((task) => task.acceptanceCriteria?.length), [1, 1, 1])
  assert.deepEqual(definition.tasks.map((task) => task.acceptanceEvidenceBindings?.length), [1, 1, 1])
  assert.equal(plan.admission.status, 'READY')
  assert.deepEqual(plan.admission.blockers.filter((item) => item.code === 'CONTRIBUTOR_TASK_PROOF_UNAVAILABLE'), [])
  assert.deepEqual(definition.tasks.slice(0, 2).map((task) => task.contribution?.taskId), ['T1', 'T2'])
  assert.ok(definition.tasks[0]!.acceptanceCriteria?.[0]?.startsWith('TechnicalOutput T1/1:'))
  assert.ok(definition.tasks[0]!.constraints?.some((constraint) =>
    constraint.includes('task-local deterministic test') && constraint.includes('technical output')))
  assert.equal(definition.tasks[0]!.constraints?.some((constraint) => constraint.startsWith('AcceptanceCriterion ')), false,
    'contributor reviewer must not receive customer assertion IDs as its task contract')
  assert.equal(definition.tasks[2]!.constraints?.some((constraint) => constraint.startsWith('AcceptanceCriterion ')), true)
  assert.ok(definition.tasks[0]!.acceptanceEvidenceBindings?.[0]?.requiredEvidence[0]?.startsWith('NOVAWING_TECHNICAL_PENDING:'))
  assert.equal(plan.admission.blockers.filter((item) => item.code === 'TASK_NO_BLOCKING_ASSERTION').length, 0)
  assert.equal(taskCompletionGate(plan.acceptanceBindings.filter((item) => item.runtimeTaskId === 'T1'), [], []), 'BLOCKED')
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [], [],
    new Set(['T1', 'T2', 'T3']), [], new Set(['T1', 'T2'])), false)
})

test('four-task contributor DAG preserves unique customer owners and blocks customer completion', async () => {
  const f = await fixture({ separateTaskAssertions: true, secondExternal: true, tasks: [
    { id: 'T1', dependencyIds: [], acceptanceCriterionIds: ['C1'] },
    { id: 'T2', dependencyIds: ['T1'], acceptanceCriterionIds: ['C1'] },
    { id: 'T3', dependencyIds: ['T2'], acceptanceCriterionIds: ['C1', 'C2'] },
    { id: 'T4', dependencyIds: ['T3'], acceptanceCriterionIds: ['C2'] },
  ] })
  const plan = await f.compile()
  assert.equal(plan.admission.status, 'READY')
  assert.deepEqual(plan.tasks.map((task) => task.dependencyIds), [[], ['T1'], ['T2'], ['T3']])
  assert.deepEqual(plan.acceptanceBindings.filter((binding) => binding.ownership === 'OWNER')
    .map((binding) => [binding.assertionId, binding.runtimeTaskId]), [['A1', 'T3'], ['A2', 'T4']])
  assert.deepEqual(workSessionDefinitionFor(plan, 'four-task-fixture').tasks.map((task) =>
    task.contribution ? 'CONTRIBUTION_VERIFIED' : 'LOCALLY_VERIFIED'),
  ['CONTRIBUTION_VERIFIED', 'CONTRIBUTION_VERIFIED', 'LOCALLY_VERIFIED', 'LOCALLY_VERIFIED'])
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [], [],
    new Set(['T1', 'T2', 'T3', 'T4']), [], new Set(['T1', 'T2'])), false)
})

test('11 artifact or baseline drift blocks commit inspection', async () => {
  const f = await fixture()
  const facts = await inspectAtCommit(f.target, f.target.baselineCommit)
  assert.equal(generateScopeManifest(facts).sha256.length, 64)
  await writeFile(join(f.repo, 'README.md'), 'changed\n')
  await assert.rejects(inspectAtCommit(f.target, f.target.baselineCommit))
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'new implementation')
  await assert.rejects(inspectAtCommit(f.target, f.target.baselineCommit))
})

test('12 impossible capability and execution prerequisite block Start', async () => {
  const f = await fixture()
  const options = { runtimePolicyVersion: 'test-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true }
  const impossible = await compileRuntimePlan(f.frozen, f.target, { ...options, resolver: () => ({ capability: 'UNSUPPORTED',
    capabilityId: 'unimplemented-git-v1', family: 'git', reason: 'No trusted strategy.' }) })
  assert.ok(impossible.admission.blockers.some((item) => item.code === 'VERIFICATION_UNRESOLVED'))
  const external = await compileRuntimePlan(f.frozen, f.target, { ...options, resolver: () => ({
    capability: 'REQUIRES_EXTERNAL_ENVIRONMENT', capabilityId: 'external-v1', family: 'browser_ui',
    startPrerequisite: 'EXECUTION', reason: 'External credential required for implementation.' }) })
  assert.ok(external.admission.blockers.some((item) => item.code === 'EXECUTION_PREREQUISITE_MISSING'))
})

test('13 parallel covering tasks without owner block Start', async () => {
  const f = await fixture({ tasks: [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: [] }] })
  const plan = await f.compile()
  assert.equal(plan.admission.status, 'ADMISSION_BLOCKED')
  assert.equal(plan.admission.blockers.filter((item) => item.code === 'OWNERSHIP_AMBIGUOUS').length, 1)
})

test('14 changed obligation family, strategy or expectation rejects blueprint binding', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const input = { assertion: criterion.assertions[0]!, criterion, ownerTaskId: 'T1', coveringTaskIds: ['T1'], target: f.target }
  assert.ok(validateVerificationObligation({ ...obligation, capabilityFamily: 'http_api' }, input).length)
  assert.ok(validateVerificationObligation({ ...obligation, strategy: 'loopback_http_get_predicate' }, input).includes('OBLIGATION_STRATEGY_MISSING'))
  assert.ok(validateVerificationObligation({ ...obligation, expectedOutcome: 'anything' }, input).includes('EXPECTED_NOT_FROZEN'))
  const approved = { ...blueprint(f.frozen, f.target), id: 'a'.repeat(64), blueprintHash: 'a'.repeat(64),
    review: { verdict: 'PASS' as const, reviewer: 'independent', issues: [] }, trust: 'REVIEWED_PLANNER_RESULT' as const,
    obligationId: 'b'.repeat(64), implementationCommit: f.target.baselineCommit, artifactHashes: {} }
  assert.throws(() => bindProvisionedVerifier({ runtimePlanHash: plan.runtimePlanHash, obligation,
    approvedBlueprint: approved, implementationCommit: f.target.baselineCommit, artifactHashes: {} }))
})

test('15 blueprint approval does not change RuntimePlan hash', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const before = plan.runtimePlanHash
  const candidate = blueprint(f.frozen, f.target)
  assert.ok(candidate)
  assert.equal(plan.runtimePlanHash, before)
  assert.equal(plan.obligationSetHash.length, 64)
})

test('16 file_missing cannot prove absence; scope review requires generated manifest and review', async () => {
  const f = await fixture({ level: 'delivery', behavior: '交付范围不包含会员系统。',
    outcome: '交付物中无会员系统。', evidence: '交付文件清单和独立范围审查。' })
  const plan = await f.compile()
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  assert.equal(obligation.strategy, 'delivery_scope_review')
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const candidate = blueprint(f.frozen, f.target, 'filesystem')
  const invalid = validateVerificationBlueprint({ ...candidate, provider: { id: 'scoped-filesystem-read', version: '1' },
    setup: [], action: [], reread: [], cleanup: [], plannedVerifier: { family: 'filesystem', assertionId: 'A1',
      providerId: 'scoped-filesystem-read', providerVersion: '1', relativePath: 'missing-member', expectation: 'file_missing' } },
  { assertion: criterion.assertions[0]!, criterion, runtimeTaskId: 'T1', target: f.target, obligation })
  assert.ok(invalid.issues.some((item) => item.code === 'NEGATIVE_SCOPE_UNPROVEN'))
  assert.ok(invalid.issues.some((item) => item.code === 'OBLIGATION_CONFORMANCE'))
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ dependencies: { express: '^5.0.0' } }))
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'Add package scope')
  const baselineFacts = await inspectAtCommit(f.target, await git(f.repo, 'rev-parse', 'HEAD'))
  const manifest = generateScopeManifest(baselineFacts)
  assert.match(manifest.content, /"name":"express"/u)
  const scopeStep = (kind: 'observation' | 'predicate') => ({ kind, mechanism: 'manifest' as const,
    artifact: 'NOVAWING_SCOPE_MANIFEST', operation: kind === 'predicate' ? 'absence_in_scope' : 'inspect_tracked_scope',
    ...(kind === 'predicate' ? { expected: '会员系统不在交付范围内' } : {}), mutates: false })
  const scopeBlueprint: VerificationBlueprint = { schemaVersion: 1, assertionId: 'A1', runtimeTaskId: 'T1',
    sourceAssertionHash: assertionContractHash(criterion.assertions[0]!),
    provider: { id: obligation.providerId, version: obligation.providerVersion }, family: 'filesystem',
    setup: [], action: [], observation: [scopeStep('observation')], predicate: [scopeStep('predicate')],
    reread: [], cleanup: [], timeoutMs: 5_000, requiredArtifacts: [],
    artifactScope: { kind: 'scope_manifest', relativePath: 'verification/scope-manifest.json',
      generator: 'NovaWing', includedRoots: ['README.md', 'package.json'], reviewRequired: true },
    targetConstraints: { canonicalPath: f.target.canonicalPath,
      gitRepositoryIdentity: f.target.gitRepositoryIdentity, baselineCommit: f.target.baselineCommit },
    provenance: { kind: 'repository_contract', relativePath: 'verification/blueprints.v1.json',
      contractHash: 'a'.repeat(64) },
    plannedVerifier: { family: 'scope_review', assertionId: 'A1', providerId: obligation.providerId,
      providerVersion: obligation.providerVersion, manifestHash: manifest.sha256 } }
  await mkdir(join(f.repo, 'verification'))
  const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash,
    targetConstraints: _target, provenance: _provenance, ...content } = scopeBlueprint
  await writeFile(join(f.repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
    entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'Add scope verification contract')
  const commit = await git(f.repo, 'rev-parse', 'HEAD')
  let reviewed = false
  const approved = await bindObligationAtCommit({ obligation, assertion: criterion.assertions[0]!, criterion,
    target: f.target, commit, reviewer: async (input) => {
      reviewed = input.scopeManifest?.sha256 === manifest.sha256 && input.obligation?.obligationId === obligation.obligationId
      return { verdict: 'PASS', reviewer: 'independent-fixture', issues: [] }
    } })
  assert.equal(reviewed, true)
  assert.equal(approved.targetConstraints.baselineCommit, commit)
  const store = new DeliveryStore(join(f.root, 'delivery'))
  await store.savePlan(plan)
  const transition = await store.bindProvisionedVerifier(plan, 'A1', 'T1', approved)
  assert.equal(transition.verifier.family, 'scope_review')
  assert.equal((await store.collectProvisionedEvidence(plan, 'A1', 'T1')).facts.manifestHash, manifest.sha256)
})

test('17 HTTP status alone and API substitution for UI remain rejected', async () => {
  const f = await fixture({ level: 'ui', behavior: '顾客在页面查看订单。', outcome: '页面呈现订单。', evidence: '浏览器交互截图。' })
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const candidate = blueprint(f.frozen, f.target, 'http_api')
  const invalid = validateVerificationBlueprint({ ...candidate, provider: { id: 'loopback-http-read', version: '1' },
    setup: [], action: [], reread: [], cleanup: [], predicate: [{ kind: 'predicate', mechanism: 'loopback_http_get',
      artifact: '/order', operation: 'status', expected: '200', mutates: false }],
    plannedVerifier: { family: 'http_api', assertionId: 'A1', providerId: 'loopback-http-read',
      providerVersion: '1', method: 'GET', requestFixture: 'NONE', port: 1, route: '/order', expectedStatus: 200,
      expectedJsonPointer: '', expectedJsonValue: '', timeoutMs: 1000 } },
  { assertion: criterion.assertions[0]!, criterion, runtimeTaskId: 'T1', target: f.target })
  assert.ok(invalid.issues.some((item) => item.code === 'HTTP_STATUS_ONLY'))
  assert.ok(invalid.issues.some((item) => item.code === 'UI_API_SUBSTITUTION'))
})

test('18 pure external task can progress locally; PASS is rejected, DEFERRED remains open', async () => {
  const f = await fixture({ level: 'ui', behavior: '顾客在页面查看订单。', outcome: '页面呈现订单。', evidence: '浏览器截图。',
    tasks: [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] }], separateTaskAssertions: true })
  const plan = await f.compile()
  assert.equal(plan.admission.status, 'READY')
  const owned = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === 'T1')
  const deferred = deferredEvidence(owned[0]!)
  assert.equal(taskCompletionGate(owned, [], [deferred]), 'LOCALLY_VERIFIED')
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [], [deferred], new Set(['T1', 'T2'])), false)
  const definition = workSessionDefinitionFor(plan, 'fixture-session')
  const task = createTaskStateV2(definition, definition.tasks[0]!)
  assert.equal(unmappedAcceptanceCriteria(task).length, 0)
  assert.equal(assertionCapabilityEvidenceValid(task, { assertionId: 'A1', verdict: 'PASS', evidence: 'claim' }), false)
  assert.equal(assertionCapabilityEvidenceValid(task, { assertionId: 'A1', verdict: 'DEFERRED', evidence: 'platform pending' }), true)
})

test('19 provider unavailable during execution returns BLOCKED', async () => {
  const f = await fixture()
  const plan = await f.compile()
  const definition = workSessionDefinitionFor(plan, 'fixture-session')
  const task = createTaskStateV2(definition, definition.tasks[0]!)
  const dispatcher = createDeliveryRuntimeDispatcher(plan, new DeliveryStore(join(f.root, 'delivery')),
    { inspectRepository: async () => { throw new Error('unused') }, dispatch: async () => { throw new Error('not called') } },
    () => 'UNAVAILABLE')
  const agent = { id: 'fixture', available: true, quotaExhausted: false, degraded: false,
    capabilities: { coding: true, reasoning: true, verification: true, review: true } }
  const result = await dispatcher.dispatch({ action: 'VERIFY', agent, task })
  assert.equal(result.status, 'BLOCKED')
  assert.match(result.blockers?.[0] ?? '', /provider unavailable/u)
})

test('20 delivery implementation is safely committed before VERIFY and normal finalization accepts deferred evidence', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'feature.js'), 'export const verified = true\n')
  const status = (await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: f.repo })).stdout
  const entries = parseGitStatus(status)
  const indexDiff = (await run('git', ['diff', '--cached', '--binary'], { cwd: f.repo })).stdout
  const fingerprint = createHash('sha256').update(await computeWorktreeFingerprint(f.repo, entries,
    { strict: true })).update(indexDiff).digest('hex')
  const branch = await git(f.repo, 'branch', '--show-current')
  const commit = await checkpointImplementationForVerification({ repoPath: f.repo,
    expectedRepositoryIdentity: await realpath(f.repo), expectedBranch: branch,
    baselineCommit: f.target.baselineCommit, expectedHeadSha: f.target.baselineCommit,
    expectedChangedFiles: ['feature.js'], expectedWorktreeFingerprint: fingerprint, taskId: 'T1' })
  assert.notEqual(commit, f.target.baselineCommit)
  await verifyDeliveryImplementationCommit({ repoPath: f.repo, expectedBranch: branch,
    baselineCommit: f.target.baselineCommit, taskBaseCommit: f.target.baselineCommit,
    implementationCommit: commit })
  const finalized = await finalizeCompletedTask({ repoPath: f.repo, expectedBranch: branch,
    expectedBaseHeadSha: commit, task: { id: 'T1', goal: '实现并验证订单',
      acceptanceCriteria: ['AcceptanceAssertion A1: 外部页面 → 页面呈现 | Expected evidence: 浏览器截图 | VerificationReadiness: EXTERNAL_DEFERRED | CapabilityContract: browser_ui/browser-harness-pending@1'] },
    completionEvidence: { changedFiles: [], requiredVerification: [], blockers: [],
      finalReviewerVerdict: 'done', verificationResults: [{ name: 'NOVAWING_DEFERRED:A1:EXTERNAL_DEFERRED',
        stepId: 'NOVAWING_DEFERRED:A1:EXTERNAL_DEFERRED', status: 'skipped' }] },
    policy: { autoCommit: true, autoPush: false } })
  assert.equal(finalized.disposition, 'ALREADY_SATISFIED')
  assert.equal(finalized.commitSha, commit)
})

test('21 mixed positive action and negative scope require executed test and reviewed manifest', async () => {
  const f = await fixture({ level: 'delivery', behavior: '顾客可以取消订单。',
    outcome: '取消规则可运行，交付范围没有正式退款体系。',
    evidence: '取消状态测试、交付清单和独立范围审查。' })
  const plan = await f.compile()
  const criterion = f.frozen.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  assert.equal(obligation.strategy, 'delivery_scope_review')
  assert.equal(obligation.requirements.requiresMutation, true)
  assert.deepEqual(obligation.allowedBindingInputs, ['scopeManifestHash', 'testFilePath'])
  await mkdir(join(f.repo, 'tests'))
  const source = `import test from 'node:test'; import assert from 'node:assert/strict';\n` +
    `const assertionId = 'A1'; const assertionContractHash = '${assertionContractHash(assertion)}';\n` +
    `test('cancel changes state and cleanup restores it', () => { const order = { status: 'placed' };` +
    ` order.status = 'cancelled'; assert.equal(order.status, 'cancelled');` +
    ` order.status = 'placed'; assert.equal(order.status, 'placed') })\n`
  await writeFile(join(f.repo, 'tests/cancel.test.js'), source)
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'Implement cancellation test')
  const facts = await inspectAtCommit(f.target, await git(f.repo, 'rev-parse', 'HEAD'))
  const manifest = generateScopeManifest(facts)
  const testStep = (kind: 'action' | 'predicate' | 'cleanup') => ({ kind,
    mechanism: 'repository_test' as const, artifact: 'tests/cancel.test.js',
    operation: kind === 'predicate' ? 'exact_value' : `cancel_${kind}`,
    ...(kind === 'predicate' ? { expected: '取消规则可运行' } : {}), mutates: kind === 'action' })
  const manifestStep = (kind: 'observation' | 'predicate') => ({ kind,
    mechanism: 'manifest' as const, artifact: 'NOVAWING_SCOPE_MANIFEST',
    operation: kind === 'predicate' ? 'absence_in_scope' : 'inspect_tracked_scope',
    ...(kind === 'predicate' ? { expected: '交付范围没有正式退款体系' } : {}), mutates: false })
  const candidate: VerificationBlueprint = { schemaVersion: 1, assertionId: 'A1', runtimeTaskId: 'T1',
    sourceAssertionHash: assertionContractHash(assertion),
    provider: { id: obligation.providerId, version: obligation.providerVersion }, family: 'filesystem',
    setup: [], action: [testStep('action')], observation: [manifestStep('observation')],
    predicate: [testStep('predicate'), manifestStep('predicate')], reread: [], cleanup: [testStep('cleanup')],
    timeoutMs: 5_000, requiredArtifacts: ['tests/cancel.test.js'],
    artifactScope: { kind: 'scope_manifest', relativePath: 'verification/scope-manifest.json',
      generator: 'NovaWing', includedRoots: ['README.md', 'tests/cancel.test.js'], reviewRequired: true },
    targetConstraints: { canonicalPath: f.target.canonicalPath,
      gitRepositoryIdentity: f.target.gitRepositoryIdentity, baselineCommit: f.target.baselineCommit },
    provenance: { kind: 'repository_contract', relativePath: 'verification/blueprints.v1.json',
      contractHash: 'a'.repeat(64) },
    plannedVerifier: { family: 'scope_review', assertionId: 'A1', providerId: obligation.providerId,
      providerVersion: obligation.providerVersion, manifestHash: manifest.sha256,
      command: 'node --test tests/cancel.test.js' } }
  const manifestOnly = { ...candidate, action: [], cleanup: [],
    predicate: [manifestStep('predicate')], plannedVerifier: { ...candidate.plannedVerifier!, command: undefined } }
  assert.ok(validateVerificationBlueprint(manifestOnly as VerificationBlueprint, { assertion, criterion,
    runtimeTaskId: 'T1', target: f.target, obligation }).issues.some((item) => item.code === 'OBLIGATION_CONFORMANCE'))
  await mkdir(join(f.repo, 'verification'))
  const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash,
    targetConstraints: _target, provenance: _provenance, ...content } = candidate
  await writeFile(join(f.repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
    entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'Bind mixed scope contract')
  const approved = await bindObligationAtCommit({ obligation, assertion, criterion, target: f.target,
    commit: await git(f.repo, 'rev-parse', 'HEAD'), reviewer: async (input) => ({
      verdict: input.scopeManifest?.sha256 === manifest.sha256 && input.reviewMaterial.some((item) =>
        item.path === 'tests/cancel.test.js') ? 'PASS' : 'REVISION_REQUIRED',
      reviewer: 'independent-fixture', issues: [] }) })
  const store = new DeliveryStore(join(f.root, 'delivery'))
  await store.savePlan(plan)
  await store.bindProvisionedVerifier(plan, 'A1', 'T1', approved)
  const observed = await store.collectProvisionedEvidence(plan, 'A1', 'T1')
  assert.equal(observed.facts.observedMatch, true)
  assert.equal(typeof observed.facts.commandEvidenceId, 'string')
  assert.match(String(observed.facts.commandStdoutSha256), /^[a-f0-9]{64}$/u)
  assert.match(String(observed.facts.commandStderrSha256), /^[a-f0-9]{64}$/u)
  assert.equal(observed.facts.manifestHash, manifest.sha256)
})

// Production Delivery dispatcher + Controller, actual Git inspection and commit. Only LLM replies are fixtures.
async function checkpointIntegrationFixture(local = false, tasks?: NonNullable<Parameters<typeof snapshot>[0]>['tasks'],
  seed?: (repo: string) => Promise<void>) {
  const f = await fixture({ ...(local ? {} : { level: 'ui' as const, behavior: '顾客在页面查看订单。', outcome: '页面呈现订单。', evidence: '浏览器截图。' }),
    ...(tasks ? { tasks } : {}) }, seed)
  const plan = await f.compile(), store = new DeliveryStore(join(f.root, 'delivery'))
  await store.savePlan(plan)
  const definition = workSessionDefinitionFor(plan, 'checkpoint-integration')
  const inspectRepository = async () => {
    const entries = parseGitStatus(await git(f.repo, 'status', '--porcelain', '-z', '--untracked-files=all'))
    return { repositoryIdentity: await realpath(f.repo), branch: await git(f.repo, 'branch', '--show-current'),
      headSha: await git(f.repo, 'rev-parse', 'HEAD'), changedFiles: entries.map(e => e.path),
      worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(f.repo, entries, { strict: true }))
        .update(await git(f.repo, 'diff', '--cached', '--binary')).digest('hex') }
  }
  const agents = [{ id: 'executor', identity: { agent: 'executor', provider: 'codex', runtimeIdentity: 'fixture-executor' },
    available: true, degraded: false, quotaExhausted: false, capabilities: { coding: true, reasoning: true, verification: true } },
  { id: 'reviewer', identity: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'fixture-reviewer' },
    available: true, degraded: false, quotaExhausted: false, capabilities: { review: true, reasoning: true } }]
  return { ...f, plan, store, definition, inspectRepository, agents }
}

test('owned checkpoint production wiring: EXECUTE -> real VERIFY commit -> REVIEW without false drift', async () => {
  const f = await checkpointIntegrationFixture()
  const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
  const { TaskEventLogV2 } = await import('../packages/development-guardian/work-session/task-observability.js')
  const log = new TaskEventLogV2()
  let reviews = 0
  const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, {
    inspectRepository: f.inspectRepository,
    async dispatch({ action, task, agent }) {
      if (action === 'EXECUTE') {
        await writeFile(join(f.repo, 'feature.js'), 'export const feature = 1\n')
        return { status: 'SUCCESS', changedFiles: ['feature.js'], workspaceExecution: { outcome: 'IMPLEMENTED', mutationFailures: [] } }
      }
      assert.equal(action, 'REVIEW'); reviews++
      return { status: 'SUCCESS', review: { passed: true, findings: [], blockingFindings: [], severity: 'LOW',
        reviewer: agent.identity!, implementer: task.implementer!, reviewedRepository: task.gitState.repositoryIdentity!,
        reviewedBranch: task.gitState.branch!, reviewedCommit: task.gitState.headSha!, reviewedWorkspace: task.gitState.worktreeFingerprint!,
        reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: task.gitState.headSha!,
        reviewedFiles: ['feature.js'], timestamp: new Date().toISOString(), assertionVerdicts: [{ assertionId: 'A1', verdict: 'DEFERRED', evidence: 'external browser pending' }] } }
    },
  })
  const runner = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch, agents: f.agents, dispatcher })
  const result = await runner.run(f.definition.tasks[0]!, undefined, undefined, { taskEventLog: log })
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(result.status, 'COMPLETED'); assert.equal(reviews, 1)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD^'), f.target.baselineCommit)
  assert.equal(await git(f.repo, 'status', '--porcelain'), '')
  assert.equal((await f.store.customerAssessment(f.plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED')
})

test('contributor completion persists technical proof across Store reopen without customer assertion evidence', async () => {
  const f = await checkpointIntegrationFixture(false, [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] }])
  assert.equal(f.plan.admission.status, 'READY')
  assert.equal(f.definition.tasks[0]!.contribution?.taskId, 'T1')
  const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
  const { loadTaskStateV2 } = await import('../packages/development-guardian/work-session/task-state-v2.js')
  const actions: string[] = []
  const defaultDispatcher: import('../packages/development-guardian/work-session/v2-controller-task-runner.js').V2ActionDispatcher = {
    inspectRepository: f.inspectRepository,
    async dispatch({ action, task, agent }) {
      actions.push(action)
      if (action === 'EXECUTE') {
        assert.ok(task.completion.bindings.every((binding) =>
          binding.requiredEvidence.every((evidence) => !evidence.startsWith('NOVAWING_TECHNICAL_PENDING:'))))
        await mkdir(join(f.repo, 'tests'))
        await writeFile(join(f.repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
        await writeFile(join(f.repo, 'order.js'), 'export const order = { result: 1 }\n')
        await writeFile(join(f.repo, 'tests/order.test.js'),
          'import test from "node:test"; import assert from "node:assert/strict"; import { order } from "../order.js"; test("order result", () => assert.equal(order.result, 1));\n')
        return { status: 'SUCCESS', changedFiles: ['package.json', 'order.js', 'tests/order.test.js'],
          workspaceExecution: { outcome: 'IMPLEMENTED', mutationFailures: [] } }
      }
      if (action === 'VERIFY') {
        assert.ok(task.verificationPlan)
        const results = []
        for (const step of task.verificationPlan.steps) {
          assert.equal(step.admission, 'ALLOWED')
          if (step.id === 'targeted-test') {
            assert.equal(step.command, 'node --test tests/order.test.js')
            await run(process.execPath, ['--test', 'tests/order.test.js'], { cwd: f.repo })
          } else if (step.id === 'diff-check') await git(f.repo, 'diff', '--check')
          else assert.fail(`Unexpected verifier: ${step.id}`)
          results.push({ name: step.id, stepId: step.id, command: step.command, status: 'passed' as const })
        }
        return { status: 'SUCCESS', verificationResults: results }
      }
      assert.equal(action, 'REVIEW')
      assert.equal(task.verificationPlan?.confidence, 'HIGH')
      assert.ok(task.verificationState.results.some((result) => result.stepId === 'targeted-test' && result.status === 'passed'))
      return { status: 'SUCCESS', review: { passed: true, findings: [], blockingFindings: [], severity: 'LOW',
        reviewer: agent.identity!, implementer: task.implementer!, reviewedRepository: task.gitState.repositoryIdentity!,
        reviewedBranch: task.gitState.branch!, reviewedCommit: task.gitState.headSha!, reviewedWorkspace: task.gitState.worktreeFingerprint!,
        reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: task.gitState.headSha!,
        reviewedFiles: ['package.json', 'order.js', 'tests/order.test.js'], timestamp: new Date().toISOString() } }
    },
  }
  const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, defaultDispatcher)
  const runner = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
    agents: f.agents, dispatcher })
  const savedStates: import('../packages/development-guardian/work-session/task-state-v2.js').TaskStateV2[] = []
  const result = await runner.run(f.definition.tasks[0]!, undefined, undefined, {
    persistTaskStateV2: async (state) => { savedStates.push(loadTaskStateV2(JSON.parse(JSON.stringify(state)))) },
  })
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired))
  assert.equal(result.taskStateV2?.completion.review?.assertionVerdicts, undefined)
  assert.equal(result.taskStateV2?.ownedCheckpoints?.length, 1)
  const proof = result.taskStateV2!
  const head = await git(f.repo, 'rev-parse', 'HEAD')
  const reopenAt = async (stage: 'before-verify' | 'before-review' | 'before-finalizer') => {
    const state = stage === 'before-verify'
      ? savedStates.find((item) => item.ownedCheckpoints?.length === 1 && item.verificationPlan &&
        item.verificationState.results.length === 0 && item.completion.review === undefined)
      : stage === 'before-review'
        ? savedStates.find((item) => item.currentAction === 'REVIEW' &&
          item.verificationState.results.some((entry) => entry.status === 'passed') && item.completion.review === undefined)
        : proof
    assert.ok(state, `${stage} must have an actual persisted TaskStateV2 boundary`)
    const reopened = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
      agents: f.agents, dispatcher: createDeliveryRuntimeDispatcher(f.plan,
        new DeliveryStore(join(f.root, 'delivery')), defaultDispatcher) })
    actions.length = 0
    const result = await reopened.run(f.definition.tasks[0]!, undefined, undefined, {
      taskStateV2: loadTaskStateV2(JSON.parse(JSON.stringify(state))),
    })
    assert.equal(result.status, 'COMPLETED', `${stage}: ${JSON.stringify(result.humanRequired)}`)
    assert.equal(actions.includes('EXECUTE'), false, stage)
    assert.deepEqual(actions, stage === 'before-verify' ? ['VERIFY', 'REVIEW'] :
      stage === 'before-review' ? ['REVIEW'] : [], stage)
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), head)
  }
  await reopenAt('before-verify')
  await reopenAt('before-review')
  await reopenAt('before-finalizer')
  assert.deepEqual((await new DeliveryStore(join(f.root, 'delivery')).customerAssessment(f.plan.id)).completedRuntimeTaskIds, [],
    'Review and checkpoint without a durable contributor record cannot advance delivery')
  const { verificationPlan: _verificationPlan, ...withoutVerifier } = proof
  const { ownedCheckpoints: _ownedCheckpoints, ...withoutCheckpoint } = proof
  const broken = [
    { label: 'verifier failed', state: { ...proof, verificationState: { ...proof.verificationState,
      results: proof.verificationState.results.map((item) => ({ ...item, status: 'failed' as const })) } } },
    { label: 'reviewer failed', state: { ...proof, completion: { ...proof.completion,
      review: { ...proof.completion.review!, passed: false } } } },
    { label: 'verifier unavailable', state: withoutVerifier },
    { label: 'checkpoint missing', state: withoutCheckpoint },
    { label: 'customer assertion verdict', state: { ...proof, completion: { ...proof.completion,
      review: { ...proof.completion.review!, assertionVerdicts: [{ assertionId: 'A1', verdict: 'PASS' as const,
        evidence: 'forbidden customer proof' }] } } } },
  ]
  for (const item of broken) {
    assert.equal((await dispatcher.deliveryCompletionGate!(item.state)).status, 'BLOCKED', item.label)
    await assert.rejects(f.store.recordContributorTaskCompletion(f.plan, item.state, head), /incomplete/u, item.label)
  }
  assert.equal((await dispatcher.deliveryCompletionGate!(proof)).status, 'CONTRIBUTION_VERIFIED')
  await runner.afterRuntimeTaskFinalized(result.taskStateV2!, head)
  const afterRecord = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
    agents: f.agents, dispatcher: createDeliveryRuntimeDispatcher(f.plan,
      new DeliveryStore(join(f.root, 'delivery')), defaultDispatcher) })
  actions.length = 0
  const replay = await afterRecord.run(f.definition.tasks[0]!, undefined, undefined, {
    taskStateV2: loadTaskStateV2(JSON.parse(JSON.stringify(proof))),
  })
  assert.equal(replay.status, 'COMPLETED', JSON.stringify(replay.humanRequired))
  assert.deepEqual(actions, [], 'A durable proof replay never reruns Executor, verifier or reviewer')
  await afterRecord.afterRuntimeTaskFinalized(replay.taskStateV2!, head)
  const reopened = new DeliveryStore(join(f.root, 'delivery'))
  const assessment = await reopened.customerAssessment(f.plan.id)
  assert.deepEqual(assessment.completedRuntimeTaskIds, ['T1'])
  assert.deepEqual(assessment.blockedRuntimeTaskIds, ['T2'])
  assert.equal(assessment.status, 'CUSTOMER_DELIVERY_BLOCKED')
  const files = await readdir(join(f.root, 'delivery'))
  const saved = JSON.parse(await readFile(join(f.root, 'delivery', files.find((file) => file.startsWith('local-completion-'))!), 'utf8'))
  assert.equal(saved.kind, 'CONTRIBUTION_VERIFIED')
  assert.equal(saved.evidence, undefined)
  assert.equal(saved.transitions, undefined)
  saved.taskState.completion.review.assertionVerdicts = [{ assertionId: 'A1', verdict: 'PASS', evidence: 'forged' }]
  await writeFile(join(f.root, 'delivery', files.find((file) => file.startsWith('local-completion-'))!), JSON.stringify(saved))
  assert.deepEqual((await reopened.customerAssessment(f.plan.id)).completedRuntimeTaskIds, [])
})

test('contributor ALREADY_SATISFIED needs host-read file hashes, executed test and independent review', async () => {
  const seed = async (repo: string) => {
    await mkdir(join(repo, 'tests'))
    await writeFile(join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
    await writeFile(join(repo, 'order.js'), 'export const order = { result: 1 }\n')
    await writeFile(join(repo, 'tests/order.test.js'),
      'import test from "node:test"; import assert from "node:assert/strict"; import { order } from "../order.js"; test("order", () => assert.equal(order.result, 1));\n')
  }
  const tasks = [{ id: 'T1', dependencyIds: [], objective: 'Verify existing order result', outputs: ['order result'] },
    { id: 'T2', dependencyIds: ['T1'] }]
  const runFixture = async (withProof: boolean) => {
    const f = await checkpointIntegrationFixture(false, tasks, seed)
    const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
    let reviews = 0
    const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, {
      inspectRepository: f.inspectRepository,
      async dispatch({ action, task, agent }) {
        if (action === 'EXECUTE') return { status: 'SUCCESS', changedFiles: [], workspaceExecution: {
          outcome: 'ALREADY_SATISFIED', mutationFailures: [], ...(withProof ? { alreadySatisfied: {
            reason: 'Read existing order source and compared its result with frozen output.',
            files: [{ path: 'order.js', sha256: createHash('sha256').update(await readFile(join(f.repo, 'order.js'))).digest('hex') }],
          } } : {}) } }
        if (action === 'VERIFY') {
          const results = []
          for (const step of task.verificationPlan?.steps ?? []) {
            if (step.id === 'targeted-test') await run(process.execPath, ['--test', 'tests/order.test.js'], { cwd: f.repo })
            else if (step.id === 'diff-check') await git(f.repo, 'diff', '--check')
            else assert.fail(`Unexpected verifier ${step.id}`)
            results.push({ name: step.id, stepId: step.id, command: step.command, status: 'passed' as const })
          }
          return { status: 'SUCCESS', verificationResults: results }
        }
        assert.equal(action, 'REVIEW'); reviews++
        return { status: 'SUCCESS', review: { passed: true, findings: [], blockingFindings: [], severity: 'LOW',
          reviewer: agent.identity!, implementer: task.implementer!, reviewedRepository: task.gitState.repositoryIdentity!,
          reviewedBranch: task.gitState.branch!, reviewedCommit: task.gitState.headSha!, reviewedWorkspace: task.gitState.worktreeFingerprint!,
          reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: task.gitState.headSha!, reviewedFiles: [], timestamp: new Date().toISOString() } }
      },
    })
    const runner = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
      agents: f.agents, dispatcher })
    return { f, runner, result: await runner.run(f.definition.tasks[0]!), reviews }
  }
  const blocked = await runFixture(false)
  assert.notEqual(blocked.result.status, 'COMPLETED')
  assert.match(blocked.result.taskStateV2?.blockers.join(' ') ?? '', /CONTRIBUTOR_NO_OP_UNPROVEN/u)
  assert.equal(blocked.reviews, 0)
  const valid = await runFixture(true)
  assert.equal(valid.result.status, 'COMPLETED', JSON.stringify(valid.result.humanRequired))
  assert.equal(valid.reviews, 1)
  assert.equal(valid.result.taskStateV2?.contributorNoOp?.files[0]?.path, 'order.js')
  assert.equal(await git(valid.f.repo, 'rev-parse', 'HEAD'), valid.f.target.baselineCommit)
  await valid.runner.afterRuntimeTaskFinalized(valid.result.taskStateV2!, valid.f.target.baselineCommit)
  assert.deepEqual((await new DeliveryStore(join(valid.f.root, 'delivery')).customerAssessment(valid.f.plan.id)).completedRuntimeTaskIds, ['T1'])
})

test('contributor without a safe verifier suspends before checkpoint, review or dependency advance', async () => {
  const f = await checkpointIntegrationFixture(false, [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] }])
  assert.equal(f.plan.admission.status, 'READY', 'The executor may provision a verifier during implementation')
  const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
  let reviews = 0
  const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, {
    inspectRepository: f.inspectRepository,
    async dispatch({ action }) {
      if (action === 'EXECUTE') {
        await writeFile(join(f.repo, 'order.js'), 'export const order = true\n')
        return { status: 'SUCCESS', changedFiles: ['order.js'], workspaceExecution: { outcome: 'IMPLEMENTED', mutationFailures: [] } }
      }
      reviews++
      return { status: 'BLOCKED', blockers: ['Unexpected action after no verifier.'] }
    },
  })
  const runner = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
    agents: f.agents, dispatcher })
  const result = await runner.run(f.definition.tasks[0]!)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.match(result.taskStateV2?.blockers.join(' ') ?? '', /CONTRIBUTOR_VERIFIER_UNAVAILABLE/u)
  assert.equal(reviews, 0)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
  assert.deepEqual((await f.store.customerAssessment(f.plan.id)).completedRuntimeTaskIds, [])
})

test('durable contributor T1 then T2 advances the Runtime DAG only after each proof survives reopen', async () => {
  const { WorkSessionRuntime } = await import('../packages/development-guardian/work-session/runtime.js')
  const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
  const f = await checkpointIntegrationFixture(false, [
    { id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] }, { id: 'T3', dependencyIds: ['T2'] },
  ])
  const definition = { ...f.definition, id: `delivery-${'c'.repeat(64)}-000000000000-cccccc` }
  const storageUrl = `file:${join(f.root, 'contributor-workflow.db')}`
  const executions: string[] = []
  const defaultDispatcher = {
    inspectRepository: f.inspectRepository,
    async dispatch({ action, task, agent }: Parameters<import('../packages/development-guardian/work-session/v2-controller-task-runner.js').V2ActionDispatcher['dispatch']>[0]) {
      const taskId = task.identity.taskId
      if (action === 'EXECUTE') {
        if (taskId !== 'T3') assert.ok(task.completion.bindings.every((binding) =>
          binding.requiredEvidence.every((evidence) => !evidence.startsWith('NOVAWING_TECHNICAL_PENDING:'))))
        executions.push(taskId)
        if (taskId !== 'T1') {
          const prior = await new DeliveryStore(join(f.root, 'delivery')).customerAssessment(f.plan.id)
          assert.ok(prior.completedRuntimeTaskIds.includes(taskId === 'T2' ? 'T1' : 'T2'))
        }
        if (taskId === 'T1') {
          await mkdir(join(f.repo, 'tests'))
          await writeFile(join(f.repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }))
        }
        const source = `order${taskId}.js`, spec = `tests/order${taskId}.test.js`
        await writeFile(join(f.repo, source), `export const order${taskId} = true\n`)
        if (taskId !== 'T3') await writeFile(join(f.repo, spec),
          `import test from 'node:test'; import assert from 'node:assert/strict'; import { order${taskId} } from '../${source}'; test('${taskId}', () => assert.equal(order${taskId}, true));\n`)
        return { status: 'SUCCESS' as const, changedFiles: (await f.inspectRepository()).changedFiles,
          workspaceExecution: { outcome: 'IMPLEMENTED' as const, mutationFailures: [] } }
      }
      if (action === 'VERIFY') {
        const results = []
        for (const step of task.verificationPlan?.steps ?? []) {
          assert.equal(step.admission, 'ALLOWED')
          if (step.id === 'targeted-test') {
            assert.match(step.command, /^node --test tests\/orderT[12]\.test\.js$/u)
            await run(process.execPath, ['--test', step.command.split(' ').at(-1)!], { cwd: f.repo })
          } else if (step.id === 'diff-check') await git(f.repo, 'diff', '--check')
          else assert.fail(`Unexpected verifier ${step.id}`)
          results.push({ name: step.id, stepId: step.id, command: step.command, status: 'passed' as const })
        }
        return { status: 'SUCCESS' as const, verificationResults: results }
      }
      assert.equal(action, 'REVIEW')
      return { status: 'SUCCESS' as const, review: { passed: true, findings: [], blockingFindings: [], severity: 'LOW' as const,
        reviewer: agent.identity!, implementer: task.implementer!, reviewedRepository: task.gitState.repositoryIdentity!,
        reviewedBranch: task.gitState.branch!, reviewedCommit: task.gitState.headSha!, reviewedWorkspace: task.gitState.worktreeFingerprint!,
        reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: task.gitState.headSha!,
        reviewedFiles: (await git(f.repo, 'diff', '--no-renames', '--name-only', task.taskBaseCommit!, task.gitState.headSha!, '--')).split('\n').filter(Boolean),
        timestamp: new Date().toISOString(), ...(taskId === 'T3' ? { assertionVerdicts: [{ assertionId: 'A1' as const,
          verdict: 'DEFERRED' as const, evidence: 'External customer browser remains open.' }] } : {}) } }
    },
  }
  const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, defaultDispatcher)
  const makeRuntime = (pauseTask?: string) => {
    const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch,
      agents: f.agents, dispatcher })
    let runtime: InstanceType<typeof WorkSessionRuntime>
    runtime = new WorkSessionRuntime({ definition, storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } }, taskRunner: {
        run: (...args) => runner.run(...args),
        async afterRuntimeTaskFinalized(task, commitSha) {
          await runner.afterRuntimeTaskFinalized(task, commitSha)
          if (task.identity.taskId === pauseTask) assert.equal(runtime.requestPause().accepted, true)
        },
      } })
    return runtime
  }
  for (const taskId of ['T1', 'T2'] as const) {
    const runtime = makeRuntime(taskId)
    try {
      const before = taskId === 'T1' ? undefined : await runtime.loadPersistedState()
      if (taskId === 'T2') assert.deepEqual(before?.completedTaskIds, ['T1'])
      const paused = taskId === 'T1' ? await runtime.start() : await runtime.resume({})
      assert.equal(paused.state, 'SUSPENDED', JSON.stringify(paused.humanRequired))
      assert.equal(paused.suspensionReason, 'USER_PAUSED')
      assert.deepEqual(paused.completedTaskIds, taskId === 'T1' ? ['T1'] : ['T1', 'T2'])
      assert.equal(paused.taskStatesV2?.[taskId]?.status, 'COMPLETED')
      assert.equal(paused.taskStatesV2?.[taskId]?.completion.review?.assertionVerdicts, undefined)
      assert.deepEqual((await new DeliveryStore(join(f.root, 'delivery')).customerAssessment(f.plan.id)).completedRuntimeTaskIds,
        taskId === 'T1' ? ['T1'] : ['T1', 'T2'])
    } finally { await runtime.close() }
  }
  const final = makeRuntime()
  try {
    assert.deepEqual((await final.loadPersistedState())?.completedTaskIds, ['T1', 'T2'])
    const done = await final.resume({})
    assert.equal(done.state, 'COMPLETED', JSON.stringify(done.humanRequired))
    assert.deepEqual(done.completedTaskIds, ['T1', 'T2', 'T3'])
    assert.deepEqual(executions, ['T1', 'T2', 'T3'])
    assert.equal((await f.store.customerAssessment(f.plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED')
  } finally { await final.close() }
})

async function integrationRunner(f: Awaited<ReturnType<typeof checkpointIntegrationFixture>>, options: {
  execute?: () => Promise<void>; noOp?: boolean;
  wrap?: (dispatcher: import('../packages/development-guardian/work-session/v2-controller-task-runner.js').V2ActionDispatcher) => import('../packages/development-guardian/work-session/v2-controller-task-runner.js').V2ActionDispatcher;
  blueprintReviewer?: import('../packages/development-guardian/delivery/verification-blueprint-planner.js').BlueprintReviewer
} = {}) {
  const { V2ControllerTaskRunner } = await import('../packages/development-guardian/work-session/v2-controller-task-runner.js')
  const { TaskEventLogV2 } = await import('../packages/development-guardian/work-session/task-observability.js')
  const log = new TaskEventLogV2(), calls: string[] = []
  const dispatcher = createDeliveryRuntimeDispatcher(f.plan, f.store, { inspectRepository: f.inspectRepository,
    async dispatch({ action, task, agent }) {
      calls.push(action)
      if (action === 'EXECUTE') {
        if (options.execute) await options.execute()
        else if (!options.noOp) await writeFile(join(f.repo, 'feature.js'), 'export const feature = 1\n')
        if (options.noOp) return { status: 'SUCCESS', changedFiles: [], workspaceExecution: {
          outcome: 'ALREADY_SATISFIED', mutationFailures: [], alreadySatisfied: { reason: 'The fixture README already exists.',
            files: [{ path: 'README.md', sha256: createHash('sha256').update(await readFile(join(f.repo, 'README.md'))).digest('hex') }] } } }
        return { status: 'SUCCESS', changedFiles: (await f.inspectRepository()).changedFiles,
          workspaceExecution: { outcome: 'IMPLEMENTED', mutationFailures: [] } }
      }
      assert.equal(action, 'REVIEW')
      const verification = task.verificationState.results[0]
      const external = f.plan.acceptanceBindings[0]!.stagedVerification.readiness === 'EXTERNAL_DEFERRED'
      return { status: 'SUCCESS', review: { passed: true, findings: [], blockingFindings: [], severity: 'LOW',
        reviewer: agent.identity!, implementer: task.implementer!, reviewedRepository: task.gitState.repositoryIdentity!,
        reviewedBranch: task.gitState.branch!, reviewedCommit: task.gitState.headSha!, reviewedWorkspace: task.gitState.worktreeFingerprint!,
        reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: task.gitState.headSha!,
        reviewedFiles: options.noOp ? [] : [...new Set([...(task.ownedCheckpoints?.flatMap(item => item.before.changedFiles) ?? []), ...task.gitState.changedFiles])],
        timestamp: new Date().toISOString(), assertionVerdicts: [{ assertionId: 'A1',
          verdict: external ? 'DEFERRED' : 'PASS', evidence: external ? 'external platform pending' : verification!.rawOutputRef!,
          ...(external ? {} : { capabilityEvidence: { family: 'command', providerId: 'existing-guarded-verifier', providerVersion: '1',
            collector: 'existing-guarded-verifier', evidenceIds: [verification!.rawOutputRef!], verificationResult: 'OBSERVED' } }) }] } }
    } }, undefined, { reviewer: options.blueprintReviewer ?? (async () => { throw new Error('No fixture blueprint reviewer configured') }) })
  const runner = new V2ControllerTaskRunner({ sessionId: f.definition.id, branch: f.definition.branch,
    agents: f.agents, dispatcher: options.wrap?.(dispatcher) ?? dispatcher })
  return { runner, calls, log, run: (context?: import('../packages/development-guardian/work-session/task-runner.js').WorkSessionTaskRunContext) =>
    runner.run(f.definition.tasks[0]!, undefined, undefined, { ...context, taskEventLog: log }) }
}

test('owned checkpoint: explicit already-satisfied makes no empty commit and still reviews DEFERRED', async () => {
  const f = await checkpointIntegrationFixture(), h = await integrationRunner(f, { noOp: true })
  const result = await h.run()
  assert.equal(result.status, 'COMPLETED')
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
  assert.equal(result.taskStateV2?.ownedCheckpoints, undefined)
  assert.equal(result.taskStateV2?.completion.review?.assertionVerdicts?.[0]?.verdict, 'DEFERRED')
  assert.equal(h.log.count('IMPLEMENTATION_CHECKPOINT_ACCEPTED'), 0)
})

for (const field of ['canonicalPath', 'branch'] as const)
  test(`owned checkpoint preserves frozen target ${field} binding`, async () => {
    const f = await checkpointIntegrationFixture()
    f.plan.targetBinding[field] += '-mismatch'
    const h = await integrationRunner(f), result = await h.run()
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
    assert.match(JSON.stringify(result), /OWNED_CHECKPOINT_TARGET_BINDING_MISMATCH/u)
    assert.equal(result.taskStateV2?.ownedCheckpoints, undefined)
    assert.ok(!h.calls.includes('REVIEW'))
  })

for (const change of ['extra-file', 'content', 'extra-commit', 'branch'] as const)
  test(`owned checkpoint rejects real Git hook tampering: ${change}`, async () => {
    const f = await checkpointIntegrationFixture()
    const post = change === 'extra-commit' || change === 'branch'
    const hook = join(f.repo, '.git/hooks', post ? 'post-commit' : 'pre-commit')
    const body = change === 'extra-file' ? 'echo extra > smuggled.txt\ngit add smuggled.txt'
      : change === 'content' ? 'echo changed > feature.js\ngit add feature.js'
      : change === 'branch' ? 'git checkout -qb unexpected-branch'
      : 'git -c core.hooksPath=.git/no-hooks commit --allow-empty -qm extra-commit'
    await writeFile(hook, `#!/bin/sh\n${body}\n`); await chmod(hook, 0o755)
    const h = await integrationRunner(f), result = await h.run()
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
    assert.equal(result.taskStateV2?.ownedCheckpoints, undefined)
    assert.equal(h.log.count('IMPLEMENTATION_CHECKPOINT_ACCEPTED'), 0)
    assert.ok(!h.calls.includes('REVIEW'))
  })

for (const change of ['file-before', 'content-before', 'file-after', 'commit-after', 'forged-proof'] as const)
  test(`owned checkpoint handoff rejects ${change}`, async () => {
    const f = await checkpointIntegrationFixture()
    const h = await integrationRunner(f, { wrap: dispatcher => ({ ...dispatcher, async dispatch(input) {
      if (input.action !== 'VERIFY') return dispatcher.dispatch(input)
      if (change === 'file-before') await writeFile(join(f.repo, 'extra.txt'), 'outside observed change set\n')
      if (change === 'content-before') await writeFile(join(f.repo, 'feature.js'), 'raced content\n')
      if (change === 'forged-proof') {
        await git(f.repo, 'add', '.'); await git(f.repo, 'commit', '-qm', 'model claimed commit')
        await assert.rejects(input.implementationCheckpoint!.accept({ kind: 'runtime-implementation-checkpoint' }), /HANDOFF_REJECTED/u)
        return { status: 'SUCCESS' }
      }
      const original = input.implementationCheckpoint!
      return dispatcher.dispatch({ ...input, implementationCheckpoint: { ...original, accept: async proof => {
        if (change === 'file-after') await writeFile(join(f.repo, 'extra.txt'), 'after checkpoint\n')
        if (change === 'commit-after') await git(f.repo, 'commit', '--allow-empty', '-qm', 'external descendant')
        return original.accept(proof)
      } } })
    } }) })
    const result = await h.run()
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
    assert.equal(h.log.count('IMPLEMENTATION_CHECKPOINT_ACCEPTED'), 0)
    assert.ok(!h.calls.includes('REVIEW'))
  })

for (const scope of ['forbidden', 'outside', 'symlink'] as const)
  test(`owned checkpoint preserves ${scope} scope restriction`, async () => {
    const f = await checkpointIntegrationFixture()
    const configured = f.definition.tasks[0]!
    if (scope === 'forbidden') configured.forbiddenPaths = ['feature.js']
    if (scope === 'outside') configured.allowedPaths = ['README.md']
    const h = await integrationRunner(f, { execute: async () => {
      if (scope === 'symlink') await symlink(join(f.root, 'outside.txt'), join(f.repo, 'feature.js'))
      else await writeFile(join(f.repo, 'feature.js'), 'not allowed\n')
    } })
    const result = await h.run()
    assert.notEqual(result.status, 'COMPLETED')
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
    assert.equal(h.log.count('IMPLEMENTATION_CHECKPOINT_ACCEPTED'), 0)
  })

test('owned checkpoint verifier failure persists C in WorkSession DB; reopen and VERIFY ONLY never reexecutes or recommits', async () => {
  const { WorkSessionRuntime } = await import('../packages/development-guardian/work-session/runtime.js')
  const f = await checkpointIntegrationFixture(true), h = await integrationRunner(f)
  const storageUrl = `file:${join(f.root, 'workflow.db')}`
  const first = new WorkSessionRuntime({ definition: f.definition, taskRunner: h.runner, storageUrl })
  let persisted: import('../packages/development-guardian/work-session/task-state-v2.js').TaskStateV2
  try {
    const result = await first.start()
    assert.equal(result.state, 'SUSPENDED')
    assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
    persisted = result.taskStatesV2!.T1!
    assert.match(persisted.blockers.join(' '), /BLUEPRINT_CANDIDATE_MISSING/u)
    assert.equal(persisted.ownedCheckpoints!.length, 1)
    assert.equal(persisted.gitState.headSha, await git(f.repo, 'rev-parse', 'HEAD'))
  } finally { await first.close() }
  const second = new WorkSessionRuntime({ definition: f.definition, taskRunner: h.runner, storageUrl })
  try {
    const state = await second.loadPersistedState()
    assert.deepEqual(state!.taskStatesV2!.T1!.ownedCheckpoints, JSON.parse(JSON.stringify(persisted!.ownedCheckpoints)))
    const resumed = await second.resume({ decision: 'VERIFY ONLY' })
    assert.equal(resumed.state, 'SUSPENDED')
    assert.notEqual(resumed.humanRequired?.category, 'REPO_DRIFT')
    assert.equal(resumed.taskStatesV2!.T1!.gitState.headSha, persisted!.gitState.headSha)
    assert.equal(resumed.taskStatesV2!.T1!.ownedCheckpoints!.length, 1)
    assert.equal(h.calls.filter(action => action === 'EXECUTE').length, 1)
    assert.equal(await git(f.repo, 'rev-list', '--count', `${f.target.baselineCommit}..HEAD`), '1')
  } finally { await second.close() }
})

test('owned checkpoint persisted before verifier failure clears old evidence/review and survives interrupted verifier', async () => {
  const { loadTaskStateV2 } = await import('../packages/development-guardian/work-session/task-state-v2.js')
  const f = await checkpointIntegrationFixture(true)
  const h = await integrationRunner(f, { wrap: dispatcher => ({ ...dispatcher, async dispatch(input) {
    if (input.action !== 'VERIFY') return dispatcher.dispatch(input)
    const original = input.implementationCheckpoint!
    return dispatcher.dispatch({ ...input, implementationCheckpoint: { ...original, accept: async proof => {
      const accepted = await original.accept(proof)
      assert.equal(accepted.completion.review, undefined); assert.equal(accepted.completion.approval, undefined)
      assert.deepEqual(accepted.verificationState.results, []); assert.deepEqual(accepted.completion.evidence, [])
      throw new Error('fixture interrupted after durable checkpoint')
    } } })
  } }) })
  const file = join(f.root, 'persisted-task.json')
  const result = await h.run({ persistTaskStateV2: async state => { await writeFile(file, JSON.stringify(state)) } })
  assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  const state = loadTaskStateV2(JSON.parse(await readFile(file, 'utf8')))
  assert.equal(state.ownedCheckpoints!.length, 1)
  assert.equal(state.gitState.headSha, await git(f.repo, 'rev-parse', 'HEAD'))
})

test('owned checkpoint persistence interrupted before acknowledgement stays fail closed and does not adopt descendant', async () => {
  const f = await checkpointIntegrationFixture(), h = await integrationRunner(f)
  const file = join(f.root, 'task.json')
  const result = await h.run({ persistTaskStateV2: async state => {
    if (state.ownedCheckpoints?.length) throw new Error('fixture durable write failed')
    await writeFile(file, JSON.stringify(state))
  } })
  assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(result.taskStateV2?.ownedCheckpoints, undefined)
  assert.equal(h.log.count('IMPLEMENTATION_CHECKPOINT_ACCEPTED'), 0)
  assert.notEqual(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
  assert.ok(!h.calls.includes('REVIEW'))
})

test('owned checkpoint local obligation binds exact reviewed blueprint and collected evidence to C', async () => {
  const f = await checkpointIntegrationFixture(true)
  const originalHash = f.plan.runtimePlanHash
  let blueprintReviews = 0
  const h = await integrationRunner(f, {
    execute: async () => {
      await mkdir(join(f.repo, 'tests')); await mkdir(join(f.repo, 'verification'))
      const candidate = blueprint(f.frozen, f.target)
      await writeFile(join(f.repo, 'tests/assertion.test.js'), `const assert = require('node:assert/strict');\n` +
        `const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');\n` +
        `const assertionId = 'A1'; const assertionContractHash = '${candidate.sourceAssertionHash}';\n` +
        `const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-owned-evidence-'));\n` +
        `try { const file = path.join(root, 'order.json'); const order = { id: 'order-id', status: 0 };\n` +
        `order.status = 24; fs.writeFileSync(file, JSON.stringify(order));\n` +
        `const reread = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(reread.id, order.id); assert.equal(reread.status, 24);\n` +
        `} finally { fs.rmSync(root, { recursive: true, force: true }); }\n`)
      const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash, targetConstraints: _target,
        provenance: _provenance, ...content } = candidate
      await writeFile(join(f.repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
        entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
    },
    blueprintReviewer: async input => {
      blueprintReviews++
      assert.equal(input.candidate.implementationCommit, await git(f.repo, 'rev-parse', 'HEAD'))
      assert.notEqual(input.candidate.implementationCommit, f.target.baselineCommit)
      assert.ok(input.reviewMaterial.some(item => item.source.includes('assert.equal(reread.status, 24)')))
      return { verdict: 'PASS', reviewer: 'isolated-independent-blueprint-reviewer', issues: [] }
    },
  })
  const result = await h.run()
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired))
  assert.equal(blueprintReviews, 1)
  const commit = await git(f.repo, 'rev-parse', 'HEAD')
  const transition = await f.store.getBindingTransition(f.plan, 'A1', 'T1')
  assert.equal(transition!.implementationCommit, commit)
  const verification = result.taskStateV2!.verificationState.results[0]!
  assert.equal(verification.status, 'passed')
  const evidence = await f.store.getCapabilityEvidence(f.plan, verification.rawOutputRef!)
  assert.equal(evidence!.facts.observedMatch, true)
  assert.ok(result.taskStateV2!.completion.review!.assertionVerdicts![0]!.capabilityEvidence!.evidenceIds.includes(evidence!.id))
  assert.equal(f.plan.runtimePlanHash, originalHash); assert.equal(f.plan.targetBaselineCommit, f.target.baselineCommit)
  const proof = result.taskStateV2!.ownedCheckpoints![0]!
  assert.equal(proof.before.headSha, f.target.baselineCommit); assert.equal(proof.after.headSha, commit)
  assert.equal(taskCompletionGate(f.plan.acceptanceBindings, [transition!], []), 'BLOCKED')
})

test('delivery vertical: T1 finalizes and persists, then reopened Runtime executes dependent deferred T2', async () => {
  const { WorkSessionRuntime } = await import('../packages/development-guardian/work-session/runtime.js')
  const { ReviewerRuntimeRegistry } = await import('../packages/development-guardian/work-session/reviewer-runtime.js')
  const { createProductionWorkSessionUi } = await import('../packages/development-guardian/work-session/production.js')
  type TrustedWorkSessionConfig = import('../packages/development-guardian/work-session/production.js').TrustedWorkSessionConfig
  // Keep the real compiled plan and bindings; use a second frozen external assertion.
  const vertical = await fixture({ tasks: [{ id: 'T1', dependencyIds: [] }, { id: 'T2', dependencyIds: ['T1'] }],
    separateTaskAssertions: true, secondExternal: true })
  const plan = await vertical.compile(), store = new DeliveryStore(join(vertical.root, 'delivery'))
  await store.savePlan(plan)
  const deliveryDigest = createHash('sha256').update('novawing-delivery-session-v1\0')
    .update(`${vertical.frozen.id}\0${plan.runtimePlanHash}\0${plan.targetBinding.id}`).digest('hex')
  const definition = workSessionDefinitionFor(plan, `delivery-${deliveryDigest}-000000000000-${deliveryDigest.slice(0, 6)}`)
  const t1Files = ['tests/assertion.test.js', 'verification/blueprints.v1.json']
  const seen: Array<{ task: string; base: string; head: string; files: string[]; evidenceId?: string }> = []
  let t1Commit = ''
  let persistedBeforeT2 = false
  let executeT1 = 0, executeT2 = 0, blueprintReviews = 0
  const reviewerRegistry = new ReviewerRuntimeRegistry([{ provider: 'codex', async review({ task }) {
      assert.deepEqual(task.changedFiles, [], 'review must see the real clean worktree')
      assert.equal(task.reviewHeadCommit, task.headSha)
      assert.equal(task.reviewBaseCommit, task.taskId === 'T1' ? vertical.target.baselineCommit : t1Commit)
      assert.deepEqual(task.reviewChangedFiles, task.taskId === 'T1' ? t1Files : ['external.js'])
      const actual = (await git(vertical.repo, 'diff', '--no-renames', '--name-only',
        task.reviewBaseCommit!, task.reviewHeadCommit!, '--')).split('\n').filter(Boolean).sort()
      assert.deepEqual(actual, task.reviewChangedFiles)
      const assertionId = task.taskId === 'T1' ? 'A1' : 'A2'
      assert.ok(task.acceptanceCriteria.some(item => item.startsWith(`AcceptanceAssertion ${assertionId}: `)))
      const evidenceId = task.verificationEvidence.find(item => item.status === 'passed')?.rawOutputRef
      if (task.taskId === 'T1') {
        assert.match(evidenceId ?? '', /^[a-f0-9]{64}$/u)
        assert.ok(task.verificationEvidence.some(item => item.stepId?.startsWith('NOVAWING_VERIFICATION_PENDING:A1:') &&
          item.rawOutputRef === evidenceId && item.command === 'node --test tests/assertion.test.js'))
        t1Commit = task.reviewHeadCommit!
      } else {
        assert.equal(persistedBeforeT2, true)
        assert.equal(evidenceId, undefined)
        assert.ok(task.verificationEvidence.some(item => item.stepId === 'NOVAWING_DEFERRED:A2:EXTERNAL_DEFERRED' && item.status === 'skipped'))
      }
      seen.push({ task: task.taskId, base: task.reviewBaseCommit!, head: task.reviewHeadCommit!,
        files: [...task.reviewChangedFiles!], ...(evidenceId ? { evidenceId } : {}) })
      return { kind: 'VERDICT' as const, passed: true, findings: [], blockingFindings: [],
        summary: 'Exact submitted scope and assertion evidence checked.', provider: 'codex',
        assertionVerdicts: [{ assertionId, verdict: task.taskId === 'T1' ? 'PASS' as const : 'DEFERRED' as const,
          evidence: task.taskId === 'T1' ? `Executed verifier evidence ${evidenceId}` : 'Customer browser evidence remains pending.',
          ...(task.taskId === 'T1' ? { capabilityEvidence: { family: 'command', providerId: 'existing-guarded-verifier',
            providerVersion: '1', collector: 'existing-guarded-verifier', evidenceIds: [evidenceId!],
            verificationResult: 'OBSERVED' as const } } : {}) }] }
    } }])
  const agents = [{ id: 'executor', identity: { agent: 'executor', provider: 'deepseek', runtimeIdentity: 'fixture-executor' },
    available: true, degraded: false, quotaExhausted: false,
    capabilities: { coding: true, reasoning: true, verification: true } },
  { id: 'reviewer', identity: { agent: 'reviewer', provider: 'codex', runtimeIdentity: 'fixture-reviewer' },
    available: true, degraded: false, quotaExhausted: false, capabilities: { review: true, reasoning: true } }]
  const executeFixtureTask = async (taskId: string) => {
      if (taskId === 'T1') {
        executeT1++
        assert.equal(await git(vertical.repo, 'rev-parse', 'HEAD'), vertical.target.baselineCommit)
        await mkdir(join(vertical.repo, 'tests')); await mkdir(join(vertical.repo, 'verification'))
        const candidate = blueprint(vertical.frozen, vertical.target)
        await writeFile(join(vertical.repo, 'tests/assertion.test.js'), `const assert = require('node:assert/strict');\n` +
          `const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');\n` +
          `const assertionId = 'A1'; const assertionContractHash = '${candidate.sourceAssertionHash}';\n` +
          `const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-vertical-evidence-'));\n` +
          `try { const file = path.join(root, 'order.json'); const order = { id: 'order-id', status: 0 };\n` +
          `order.status = 24; fs.writeFileSync(file, JSON.stringify(order));\n` +
          `const reread = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(reread.id, order.id); assert.equal(reread.status, 24);\n` +
          `} finally { fs.rmSync(root, { recursive: true, force: true }); }\n`)
        const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash,
          targetConstraints: _target, provenance: _provenance, ...content } = candidate
        await writeFile(join(vertical.repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
          entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
      } else {
        executeT2++
        assert.equal(persistedBeforeT2, true)
        assert.equal(await git(vertical.repo, 'rev-parse', 'HEAD'), t1Commit)
        await writeFile(join(vertical.repo, 'external.js'), 'export const externalView = true\n')
      }
      const entries = parseGitStatus((await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'],
        { cwd: vertical.repo })).stdout)
      return entries.map(entry => entry.path)
  }
  const blueprintReviewer: import('../packages/development-guardian/delivery/verification-blueprint-planner.js').BlueprintReviewer = async input => {
    blueprintReviews++
    assert.equal(input.candidate.implementationCommit, t1Commit || await git(vertical.repo, 'rev-parse', 'HEAD'))
    assert.ok(input.reviewMaterial.some(item => item.source.includes('assert.equal(reread.status, 24)')))
    return { verdict: 'PASS', reviewer: 'isolated-independent-blueprint-reviewer', issues: [] }
  }
  const storageUrl = `file:${join(vertical.root, 'workflow.db')}`
  const config: TrustedWorkSessionConfig = { session: { id: definition.id, targetRepo: definition.targetRepo,
    branch: definition.branch, controlPlane: 'v2', directPath: { enabled: false },
    goldenPath: { enabled: false }, limits: definition.limits },
  tasks: definition.tasks.map(task => ({ id: task.id, goal: task.goal, risk: task.risk!,
    guardian: { constraints: [...(task.constraints ?? [])], acceptanceCriteria: [...(task.acceptanceCriteria ?? [])],
      doNotDo: [], allowedPaths: [...(task.allowedPaths ?? [])], forbiddenPaths: [...(task.forbiddenPaths ?? [])] },
    acceptanceEvidenceBindings: (task.acceptanceEvidenceBindings ?? []).map(binding => ({
      criterion: binding.criterion, requiredEvidence: [...binding.requiredEvidence],
      ...(binding.requiresApproval === undefined ? {} : { requiresApproval: binding.requiresApproval }),
      ...(binding.commandCanonicalizations === undefined ? {} : { commandCanonicalizations: binding.commandCanonicalizations.map(item => ({ ...item })) }) })) })),
  gitCheckpoint: { autoCommit: true, autoPush: false },
  executor: { defaultMode: 'deepseek', model: 'fixture-only', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false },
  storageUrl }
  const createApp = async (pauseAfterT1: boolean) => {
    let runtime: InstanceType<typeof WorkSessionRuntime> | undefined
    const app = await createProductionWorkSessionUi(config, { desktopNotifier: null, serverPort: 0,
      env: { ...process.env, NOVAWING_DATA_DIR: vertical.root }, v2Agents: agents,
      createExecutor: () => ({ async execute({ task }) {
        const changedFiles = await executeFixtureTask(task.id)
        return { summary: 'Deterministic implementation response', changedFiles, commandsRun: [],
          verificationResults: [], blockers: [], workspaceExecution: { outcome: 'IMPLEMENTED' as const,
            mutationFailures: [] } }
      } }),
      createReviewerRegistry: () => reviewerRegistry,
      createV2Dispatcher: ({ defaultDispatcher }) => createDeliveryRuntimeDispatcher(plan, store,
        defaultDispatcher, undefined, { reviewer: blueprintReviewer }),
      createRuntime(runtimeConfig) {
        if (pauseAfterT1) {
          const realRunner = runtimeConfig.taskRunner
          runtime = new WorkSessionRuntime({ ...runtimeConfig, taskRunner: {
            run: (...args) => realRunner.run(...args),
            async afterRuntimeTaskFinalized(task, commitSha) {
              await realRunner.afterRuntimeTaskFinalized?.(task, commitSha)
              if (task.identity.taskId === 'T1') assert.equal(runtime!.requestPause().accepted, true)
            },
          } })
        } else runtime = new WorkSessionRuntime(runtimeConfig)
        return runtime
      },
    })
    return { app, runtime: runtime! }
  }
  const { app: firstApp, runtime: first } = await createApp(true)
  try {
    const stopped = await first.start()
    assert.equal(stopped.state, 'SUSPENDED', JSON.stringify(stopped.humanRequired))
    assert.equal(stopped.suspensionReason, 'USER_PAUSED')
    assert.deepEqual(stopped.completedTaskIds, ['T1'])
    assert.equal(stopped.taskStatesV2!.T1!.status, 'COMPLETED')
    assert.equal(await git(vertical.repo, 'rev-parse', 'HEAD'), t1Commit)
    assert.equal(stopped.checkpointCommits?.T1, undefined, 'Runtime finalizer accepts the already committed implementation')
    assert.equal(stopped.taskStatesV2?.T2, undefined)
    assert.equal(executeT2, 0)
    assert.deepEqual((await store.customerAssessment(plan.id)).completedRuntimeTaskIds, ['T1'])
  } finally { await firstApp.close() }
  const { app: secondApp, runtime: second } = await createApp(false)
  try {
    const reopened = await second.loadPersistedState()
    assert.deepEqual(reopened?.completedTaskIds, ['T1'])
    assert.equal(reopened?.taskStatesV2?.T1?.status, 'COMPLETED')
    assert.deepEqual(reopened?.taskStatesV2?.T1?.completion.review?.assertionVerdicts?.[0]?.capabilityEvidence?.evidenceIds,
      [seen[0]?.evidenceId])
    persistedBeforeT2 = true
    const done = await second.resume({})
    assert.equal(done.state, 'COMPLETED', JSON.stringify(done.humanRequired))
    assert.deepEqual(done.completedTaskIds, ['T1', 'T2'])
    assert.equal(done.taskStatesV2?.T2?.status, 'COMPLETED')
    assert.equal(done.taskStatesV2?.T2?.completion.review?.assertionVerdicts?.[0]?.verdict, 'DEFERRED')
    assert.equal(done.taskStatesV2?.T1?.ownedCheckpoints?.length, 1)
    assert.equal(done.taskStatesV2?.T2?.ownedCheckpoints?.length, 1)
    assert.equal(done.checkpointCommits?.T1, undefined)
    assert.equal(done.checkpointCommits?.T2, undefined)
    assert.equal(await git(vertical.repo, 'rev-list', '--count', `${vertical.target.baselineCommit}..HEAD`), '2')
    assert.deepEqual([executeT1, executeT2, blueprintReviews], [1, 1, 1])
    assert.deepEqual(seen.map(item => item.task), ['T1', 'T2'])
    const assessment = await store.customerAssessment(plan.id)
    assert.deepEqual(assessment.completedRuntimeTaskIds, ['T1', 'T2'])
    assert.equal(assessment.status, 'CUSTOMER_DELIVERY_BLOCKED')
    const completedReadback = await second.loadPersistedState()
    assert.equal(completedReadback?.taskStatesV2?.T2?.completion.review?.assertionVerdicts?.[0]?.verdict, 'DEFERRED')
  } finally { await secondApp.close() }
})

test('owned checkpoint binds session/task/attempt/dispatch and cannot be replayed as model JSON', async () => {
  const { acceptOwnedCheckpoint } = await import('../packages/development-guardian/work-session/owned-checkpoint.js')
  const f = await checkpointIntegrationFixture()
  let validated = 0
  const h = await integrationRunner(f, { wrap: dispatcher => ({ ...dispatcher, async dispatch(input) {
    if (input.action !== 'VERIFY') return dispatcher.dispatch(input)
    const original = input.implementationCheckpoint!
    return dispatcher.dispatch({ ...input, implementationCheckpoint: { ...original, accept: async proof => {
      const observed = await f.inspectRepository()
      for (const task of [
        { ...input.task, identity: { ...input.task.identity, sessionId: 'another-session' } },
        { ...input.task, identity: { ...input.task.identity, taskId: 'T2' } },
        { ...input.task, attemptId: 'f'.repeat(64) },
      ]) await assert.rejects(acceptOwnedCheckpoint(proof, task, original.dispatchId, observed), /HANDOFF_REJECTED/u)
      await assert.rejects(acceptOwnedCheckpoint(proof, input.task, 'wrong-dispatch', observed), /HANDOFF_REJECTED/u)
      await assert.rejects(acceptOwnedCheckpoint(JSON.parse(JSON.stringify(proof)), input.task, original.dispatchId, observed), /HANDOFF_REJECTED/u)
      const accepted = await original.accept(proof); validated++
      await assert.rejects(original.accept(proof), /ACTION_CLOSED/u)
      return accepted
    } } })
  } }) })
  const initial = { ...createTaskStateV2(f.definition, f.definition.tasks[0]!), attemptId: 'a'.repeat(64) }
  const result = await h.run({ taskStateV2: initial })
  assert.equal(result.status, 'COMPLETED'); assert.equal(validated, 1)
  assert.equal(result.taskStateV2!.ownedCheckpoints![0]!.attemptId, initial.attemptId)
})

test('owned checkpoint archives and invalidates old commit evidence, review and approval before new verification', async () => {
  const f = await checkpointIntegrationFixture()
  await writeFile(join(f.repo, 'feature.js'), 'export const feature = 1\n')
  const current = await f.inspectRepository(), initial = createTaskStateV2(f.definition, f.definition.tasks[0]!)
  const oldReview = { passed: true, findings: [], blockingFindings: [], severity: 'LOW' as const,
    reviewer: f.agents[1]!.identity, implementer: f.agents[0]!.identity, reviewedRepository: current.repositoryIdentity,
    reviewedBranch: current.branch, reviewedCommit: current.headSha, reviewedWorkspace: current.worktreeFingerprint,
    reviewedFiles: ['feature.js'], timestamp: new Date().toISOString() }
  const state: typeof initial = { ...initial, status: 'ACTIVE', gitState: current, implementer: f.agents[0]!.identity,
    currentAgent: 'executor', providerHistory: ['codex'], verificationState: { results: [], evidenceHeadSha: current.headSha,
      evidenceWorktreeFingerprint: current.worktreeFingerprint }, completion: { ...initial.completion,
      evidence: [{ type: 'old', status: 'PASSED', source: 'deterministic', headSha: current.headSha, timestamp: new Date().toISOString() }],
      review: oldReview, approval: { approved: true, workspaceIdentity: current.worktreeFingerprint,
        reviewedCommit: current.headSha, risk: 'LOW', timestamp: new Date().toISOString() } } }
  let checked = false
  const h = await integrationRunner(f, { wrap: dispatcher => ({ ...dispatcher, async dispatch(input) {
    if (input.action !== 'VERIFY') return dispatcher.dispatch(input)
    const original = input.implementationCheckpoint!
    return dispatcher.dispatch({ ...input, implementationCheckpoint: { ...original, accept: async proof => {
      const next = await original.accept(proof)
      assert.deepEqual(next.verificationState, { results: [] }); assert.deepEqual(next.completion.evidence, [])
      assert.equal(next.completion.review, undefined); assert.equal(next.completion.approval, undefined)
      assert.deepEqual((next.ownedCheckpoints![0]!.supersededEvidence as { completion: unknown }).completion, state.completion)
      checked = true; return next
    } } })
  } }) })
  const result = await h.run({ taskStateV2: state })
  assert.equal(result.status, 'COMPLETED'); assert.equal(checked, true)
  assert.deepEqual(h.calls, ['REVIEW'])
  assert.notEqual(result.taskStateV2!.completion.review!.reviewedCommit, oldReview.reviewedCommit)
})

test('owned checkpoint survives subsequent reviewer unavailability without claiming completion or drift', async () => {
  const f = await checkpointIntegrationFixture()
  const h = await integrationRunner(f, { wrap: dispatcher => ({ ...dispatcher, async dispatch(input) {
    return input.action === 'REVIEW' ? { status: 'BLOCKED', blockers: ['fixture reviewer offline'],
      providerFailure: { provider: 'deepseek', status: 'OFFLINE', reason: 'fixture reviewer offline' } } : dispatcher.dispatch(input)
  } }) })
  const result = await h.run()
  assert.equal(result.status, 'HUMAN_REQUIRED'); assert.notEqual(result.humanRequired?.category, 'REPO_DRIFT')
  assert.match(result.humanRequired!.reason, /reviewer offline/u)
  assert.equal(result.taskStateV2!.ownedCheckpoints!.length, 1)
  assert.equal(result.taskStateV2!.gitState.headSha, await git(f.repo, 'rev-parse', 'HEAD'))
  assert.equal(await git(f.repo, 'rev-list', '--count', `${f.target.baselineCommit}..HEAD`), '1')
  assert.notEqual(result.taskStateV2!.completion.review?.passed, true)
})
