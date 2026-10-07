import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, realpath, writeFile, symlink, link, rm } from 'node:fs/promises'
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
import { createTaskStateV2, loadTaskStateV2, type TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assertionCapabilityEvidenceValid, unmappedAcceptanceCriteria } from '../packages/development-guardian/work-session/risk-evidence.js'
import { checkpointImplementationForVerification, finalizeCompletedTask, inspectImplementationCommit,
  verifyDeliveryImplementationCommit, type GitCheckpointCommandRunner } from '../packages/development-guardian/work-session/git-checkpoint.js'
import { applyImplementationCheckpoint, commitImplementationCheckpoint,
  consumeImplementationCheckpoint } from '../packages/development-guardian/work-session/implementation-checkpoint.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'

const run = promisify(execFile)
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout.trim()
}
function snapshot(options: { level?: 'integration' | 'delivery' | 'ui'; behavior?: string; outcome?: string;
  evidence?: string; tasks?: Array<{ id: string; dependencyIds: string[] }>;
  separateTaskAssertions?: boolean } = {}) {
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
    tasks: taskSpecs.map((item, index) => ({ id: item.id, title: `任务 ${item.id}`, objective: '实现并验证订单',
      requirementIds: ['R1'], outputs: ['订单结果'], dependencyIds: item.dependencyIds,
      acceptanceCriterionIds: [options.separateTaskAssertions && index === 1 ? 'C2' : 'C1'], complexity: 'small' as const })),
    acceptancePlan: { strategy: '按冻结断言独立验证。', criteria: [{ id: 'C1', requirementIds: ['R1'],
      description: behavior, level: options.level ?? 'integration', expectedEvidence: evidence, blocking: true,
      assertions: [{ id: 'A1', requirementId: 'R1', observableBehavior: behavior,
        expectedOutcome: outcome, expectedEvidence: evidence, blocking: true }] },
      ...(options.separateTaskAssertions ? [{ id: 'C2', requirementIds: ['R1'],
        description: '本地订单状态可验证。', level: 'integration' as const,
        expectedEvidence: '订单状态证据。', blocking: true,
        assertions: [{ id: 'A2', requirementId: 'R1', observableBehavior: '创建订单并保存。',
          expectedOutcome: '订单状态持久化。', expectedEvidence: '订单操作和重读。', blocking: true }] }] : [])] },
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
async function fixture(options: Parameters<typeof snapshot>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nw-obligation-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'checkout', '-qb', 'codex/obligation-fixture')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
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
  const plan = await f.compile()
  assert.equal(plan.acceptanceBindings.filter((item) => item.stagedVerification.obligation).length, 1)
  assert.equal(plan.acceptanceBindings.find((item) => item.ownership === 'OWNER')?.runtimeTaskId, 'T3')
  assert.equal(plan.admission.blockers.filter((item) => item.assertionId === 'A1').length, 0)
  assert.equal(taskCompletionGate(plan.acceptanceBindings.filter((item) => item.runtimeTaskId === 'T1'), [], []), 'BLOCKED')
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

// ============ E0-H1 Host-owned implementation checkpoint handoff ============

const CHECKPOINT_SESSION = 'checkpoint-session'
const CHECKPOINT_TASK = 'T1'

async function repositoryObservation(repo: string) {
  const status = (await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo })).stdout
  const entries = parseGitStatus(status)
  const indexDiff = (await run('git', ['diff', '--cached', '--binary'], { cwd: repo })).stdout
  return { repositoryIdentity: await realpath(repo), branch: await git(repo, 'branch', '--show-current'),
    headSha: await git(repo, 'rev-parse', 'HEAD'), changedFiles: entries.map((item) => item.path),
    worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(repo, entries,
      { strict: true })).update(indexDiff).digest('hex') }
}

/** Issue one real Host implementation checkpoint per call on an always-clean base. */
async function checkpointFixture() {
  const f = await fixture()
  let index = 0
  const issue = async (mutate: (options: Record<string, unknown>) => void = () => undefined) => {
    index += 1
    const file = `feature-${index}.js`
    await writeFile(join(f.repo, file), `export const feature${index} = true\n`)
    const before = await repositoryObservation(f.repo)
    const options: Record<string, unknown> = { repoPath: f.repo, repositoryIdentity: before.repositoryIdentity,
      branch: before.branch, baselineCommit: f.target.baselineCommit, sessionId: CHECKPOINT_SESSION,
      taskId: CHECKPOINT_TASK, before, expectedChangedFiles: [file], allowedPaths: ['.'], forbiddenPaths: [] }
    mutate(options)
    const issued = await commitImplementationCheckpoint(
      options as unknown as Parameters<typeof commitImplementationCheckpoint>[0])
    assert.equal(issued.disposition, 'COMMITTED')
    const after = await repositoryObservation(f.repo)
    assert.equal(after.headSha, issued.commitSha)
    return { issued, before, after, file }
  }
  return { ...f, issue }
}

test('22 Host checkpoint authority is bound to the dispatch and consumed exactly once', async () => {
  const f = await checkpointFixture()
  const { issued, before, after } = await f.issue()
  const context = { sessionId: CHECKPOINT_SESSION, taskId: CHECKPOINT_TASK, action: 'VERIFY', before, after }
  const accepted = consumeImplementationCheckpoint({ handoff: issued.handoff, ...context })
  assert.equal(accepted.accepted, true)
  // One-time authority: the very same handoff can never authorize a second state change.
  const replay = consumeImplementationCheckpoint({ handoff: issued.handoff, ...context })
  assert.equal(replay.accepted, false)
  assert.match(replay.accepted === false ? replay.reason : '', /not issued by this runtime/u)

  const wrongAction = await f.issue()
  assert.equal(consumeImplementationCheckpoint({ handoff: wrongAction.issued.handoff,
    ...context, before: wrongAction.before, after: wrongAction.after, action: 'EXECUTE' }).accepted, false)
  const wrongTask = await f.issue()
  assert.equal(consumeImplementationCheckpoint({ handoff: wrongTask.issued.handoff,
    ...context, before: wrongTask.before, after: wrongTask.after, taskId: 'T2' }).accepted, false)
  const wrongAttempt = await f.issue()
  assert.equal(consumeImplementationCheckpoint({ handoff: wrongAttempt.issued.handoff,
    ...context, before: wrongAttempt.before, after: wrongAttempt.after, attemptId: 'a'.repeat(64) }).accepted, false)
  const wrongBefore = await f.issue()
  assert.equal(consumeImplementationCheckpoint({ handoff: wrongBefore.issued.handoff,
    ...context, before: { ...wrongBefore.before, headSha: f.target.baselineCommit }, after: wrongBefore.after }).accepted, false)
  const wrongAfter = await f.issue()
  assert.equal(consumeImplementationCheckpoint({ handoff: wrongAfter.issued.handoff,
    ...context, before: wrongAfter.before, after: { ...wrongAfter.after, headSha: wrongAfter.before.headSha } }).accepted, false)
})

test('23 a SHA, a plain object, or a persisted record can never obtain checkpoint authority', async () => {
  const f = await checkpointFixture()
  const { issued, before, after } = await f.issue()
  const context = { sessionId: CHECKPOINT_SESSION, taskId: CHECKPOINT_TASK, action: 'VERIFY', before, after }
  const auditRecord = { action: 'VERIFY', sessionId: CHECKPOINT_SESSION, taskId: CHECKPOINT_TASK,
    repositoryIdentity: after.repositoryIdentity, branch: after.branch, baselineCommit: f.target.baselineCommit,
    parentCommit: before.headSha, commitSha: after.headSha, treeSha: 'b'.repeat(40),
    changedFiles: [], acceptedAt: new Date().toISOString() }
  const forgeries: unknown[] = [issued.commitSha, before.headSha, null, undefined, 'VERIFY',
    { commitSha: issued.commitSha, parentCommit: before.headSha },
    { ...issued.handoff }, structuredClone(issued.handoff),
    JSON.parse(JSON.stringify(issued.handoff)) as unknown, auditRecord, [issued.handoff]]
  for (const handoff of forgeries) {
    const consumed = consumeImplementationCheckpoint({ handoff, ...context })
    assert.equal(consumed.accepted, false, `forgery must never be accepted: ${JSON.stringify(handoff)}`)
    assert.match(consumed.accepted === false ? consumed.reason : '', /not issued by this runtime/u)
  }
  // Forgeries never touch the real authority.
  assert.equal(consumeImplementationCheckpoint({ handoff: issued.handoff, ...context }).accepted, true)
})

test('24 tampered parent, branch, or commit tree cannot become an implementation checkpoint', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'feature.js'), 'export const verified = true\n')
  await git(f.repo, 'add', '.')
  await git(f.repo, 'commit', '-qm', 'feature')
  const head = await git(f.repo, 'rev-parse', 'HEAD')
  const parent = await git(f.repo, 'rev-parse', 'HEAD^')
  const identity = await realpath(f.repo)
  const branch = await git(f.repo, 'branch', '--show-current')
  const diffTree = `diff-tree --no-commit-id --name-only -r -z ${head}`
  const scripted = (overrides: Record<string, string>): GitCheckpointCommandRunner => async (args) => {
    const table: Record<string, string> = { 'branch --show-current': branch, 'rev-parse HEAD': head,
      'rev-parse HEAD^': parent, 'rev-parse HEAD^{tree}': 'b'.repeat(40),
      'status --porcelain -z --untracked-files=all': '', 'diff --cached --binary': '',
      [diffTree]: 'feature.js\0', ...overrides }
    const stdout = table[args.join(' ')]
    return stdout === undefined
      ? { exitCode: 128, stdout: '', stderr: `unexpected git command: ${args.join(' ')}` }
      : { exitCode: 0, stdout, stderr: '' }
  }
  const proof = (commandRunner?: GitCheckpointCommandRunner) => inspectImplementationCommit({ repoPath: f.repo,
    expectedRepositoryIdentity: identity, expectedBranch: branch, parentCommit: parent, commitSha: head,
    expectedChangedFiles: ['feature.js'], ...(commandRunner === undefined ? {} : { commandRunner }) })
  assert.equal((await proof(scripted({}))).treeSha, 'b'.repeat(40))
  await assert.rejects(proof(scripted({ 'rev-parse HEAD^': 'c'.repeat(40) })), /parent changed/u)
  await assert.rejects(proof(scripted({ [diffTree]: 'feature.js\0smuggled.js\0' })), /tree does not match/u)
  await assert.rejects(proof(scripted({ 'branch --show-current': 'main' })), /branch|protected/u)
  await assert.rejects(proof(scripted({ 'status --porcelain -z --untracked-files=all': '?? extra.js\0' })),
    /clean repository/u)
  // A real branch switch after the commit is not a checkpoint either.
  await git(f.repo, 'checkout', '-qb', 'codex/other-branch')
  await assert.rejects(proof(), /branch/u)
})

test('25 out-of-scope, symlinked-out, and hardlinked changes cannot enter an implementation checkpoint', async () => {
  const f = await checkpointFixture()
  await writeFile(join(f.repo, 'scoped.js'), 'export const scoped = true\n')
  const before = await repositoryObservation(f.repo)
  const attempt = (allowedPaths: string[], forbiddenPaths: string[] = []) =>
    commitImplementationCheckpoint({ repoPath: f.repo, repositoryIdentity: before.repositoryIdentity,
      branch: before.branch, baselineCommit: f.target.baselineCommit, sessionId: CHECKPOINT_SESSION,
      taskId: CHECKPOINT_TASK, before, expectedChangedFiles: ['scoped.js'], allowedPaths, forbiddenPaths })
  await assert.rejects(attempt(['src']), /outside allowed scope/u)
  await assert.rejects(attempt(['.'], ['scoped.js']), /inside forbidden scope/u)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before.headSha)
  assert.match(await git(f.repo, 'status', '--porcelain', '--untracked-files=all'), /scoped\.js/u)

  await writeFile(join(f.root, 'outside.txt'), 'outside the repository\n')
  await symlink(join(f.root, 'outside.txt'), join(f.repo, 'escape.js'))
  const escaping = await repositoryObservation(f.repo)
  await assert.rejects(commitImplementationCheckpoint({ repoPath: f.repo, repositoryIdentity: escaping.repositoryIdentity,
    branch: escaping.branch, baselineCommit: f.target.baselineCommit, sessionId: CHECKPOINT_SESSION,
    taskId: CHECKPOINT_TASK, before: escaping, expectedChangedFiles: escaping.changedFiles,
    allowedPaths: ['.'], forbiddenPaths: [] }), /symlink escapes the repository/u)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before.headSha)

  await rm(join(f.repo, 'escape.js'))
  await link(join(f.root, 'outside.txt'), join(f.repo, 'linked.js'))
  const linked = await repositoryObservation(f.repo)
  await assert.rejects(commitImplementationCheckpoint({ repoPath: f.repo, repositoryIdentity: linked.repositoryIdentity,
    branch: linked.branch, baselineCommit: f.target.baselineCommit, sessionId: CHECKPOINT_SESSION,
    taskId: CHECKPOINT_TASK, before: linked, expectedChangedFiles: linked.changedFiles,
    allowedPaths: ['.'], forbiddenPaths: [] }), /links outside the checkpoint/u)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), before.headSha)
})

test('26 accepted checkpoint persists the new observation, keeps audit facts, and invalidates old evidence', async () => {
  const f = await checkpointFixture()
  const { issued, before, after, file } = await f.issue()
  const stale = { type: 'old-verifier', status: 'PASSED' as const, source: 'deterministic',
    repositoryIdentity: before.repositoryIdentity, branch: before.branch, headSha: before.headSha,
    workspaceIdentity: before.worktreeFingerprint, timestamp: new Date().toISOString() }
  const state: TaskStateV2 = { ...createTaskStateV2({ id: CHECKPOINT_SESSION, branch: before.branch },
    { id: CHECKPOINT_TASK, goal: '实现并验证订单' }),
    gitState: before,
    verificationState: { results: [{ name: 'old-verifier', stepId: 'old-verifier', status: 'passed' }],
      evidenceHeadSha: before.headSha, evidenceWorktreeFingerprint: before.worktreeFingerprint },
    completion: { bindings: [], evidence: [stale],
      review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
        reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'reviewer-runtime' },
        implementer: { agent: 'executor', provider: 'codex', runtimeIdentity: 'executor-runtime' },
        reviewedCommit: before.headSha, reviewedWorkspace: before.worktreeFingerprint, reviewedFiles: [],
        timestamp: new Date().toISOString() },
      approval: { approved: true, workspaceIdentity: before.worktreeFingerprint, reviewedCommit: before.headSha,
        risk: 'HIGH', timestamp: new Date().toISOString() } } }
  const consumed = consumeImplementationCheckpoint({ handoff: issued.handoff, sessionId: CHECKPOINT_SESSION,
    taskId: CHECKPOINT_TASK, action: 'VERIFY', before, after })
  assert.equal(consumed.accepted, true)
  const next = applyImplementationCheckpoint(state, consumed.accepted ? consumed.record : assert.fail('not accepted'))
  assert.deepEqual(next.gitState, { repositoryIdentity: after.repositoryIdentity, branch: after.branch,
    headSha: after.headSha, changedFiles: [], worktreeFingerprint: after.worktreeFingerprint })
  assert.deepEqual(next.verificationState, { results: [] })
  assert.deepEqual(next.completion.evidence, [])
  assert.equal(next.completion.review, undefined)
  assert.equal(next.completion.approval, undefined)
  assert.equal(next.implementationCheckpointAudit?.length, 1)
  const audit = next.implementationCheckpointAudit![0]!
  assert.equal(audit.parentCommit, before.headSha)
  assert.equal(audit.commitSha, after.headSha)
  assert.equal(audit.commitSha, next.gitState.headSha)
  assert.equal(audit.treeSha.length, 40)
  assert.deepEqual(audit.changedFiles, [file])
  // Persisted audit facts survive restart but can never be replayed as authority.
  const reloaded = loadTaskStateV2(JSON.parse(JSON.stringify(next)) as unknown)
  assert.equal(reloaded.implementationCheckpointAudit?.[0]?.commitSha, after.headSha)
  assert.equal(consumeImplementationCheckpoint({ handoff: reloaded.implementationCheckpointAudit,
    sessionId: CHECKPOINT_SESSION, taskId: CHECKPOINT_TASK, action: 'VERIFY', before, after }).accepted, false)
})

test('27 a no-op implementation issue creates no checkpoint authority', async () => {
  const f = await fixture()
  const before = await repositoryObservation(f.repo)
  const issued = await commitImplementationCheckpoint({ repoPath: f.repo,
    repositoryIdentity: before.repositoryIdentity, branch: before.branch, baselineCommit: f.target.baselineCommit,
    sessionId: CHECKPOINT_SESSION, taskId: CHECKPOINT_TASK, before, expectedChangedFiles: [],
    allowedPaths: ['.'], forbiddenPaths: [] })
  assert.equal(issued.disposition, 'ALREADY_SATISFIED')
  assert.equal(issued.commitSha, before.headSha)
  assert.equal(Object.hasOwn(issued, 'handoff'), false)
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), f.target.baselineCommit)
  assert.equal(await git(f.repo, 'status', '--porcelain'), '')
})
