import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { symlink } from 'node:fs/promises'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, type PlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { DeliveryEventStore, DeliveryService, DeliveryStore, type DeliveryRuntimeAdapter } from '../packages/development-guardian/delivery/service.js'
import { bindDeliveryTarget, compileRuntimePlan, conservativeCapabilityResolver, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity, workSessionDefinitionFor,
  type CompiledRuntimePlan, type VerificationCapabilityResolver } from '../packages/development-guardian/delivery/runtime-plan.js'
import { CAPABILITY_REGISTRY, classifyCapability, collectFilesystemEvidence, collectGitEvidence, collectHttpEvidence,
  collectProcessEvidence, trustedCapabilityRegistry,
  resolveCapability, verifyCapabilityEvidence } from '../packages/development-guardian/delivery/capability-layer.js'
import { ADMISSION_MODEL_VERSION, customerDeliveryCompletionGate, taskCompletionGate } from '../packages/development-guardian/delivery/staged-verification.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assertionCapabilityEvidenceValid } from '../packages/development-guardian/work-session/risk-evidence.js'
import type { V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { createDeliveryRuntimeDispatcher } from '../packages/development-guardian/delivery/runtime-adapter.js'
import { FakeTaskRunner } from '../packages/development-guardian/work-session/fake-task-runner.js'
import { NovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import type { PlanningService } from '../packages/development-guardian/planning/service.js'
import { inspectRepoCapabilities } from '../packages/development-guardian/delivery/repo-capability-inspector.js'
import { planVerificationBlueprints } from '../packages/development-guardian/delivery/verification-blueprint-planner.js'
import { approveVerificationBlueprint, assertionContractHash, validateVerificationBlueprint,
  type VerificationBlueprint } from '../packages/development-guardian/delivery/verification-blueprint.js'

const exec = promisify(execFile)
const plannedHttpVerifier = (port = 0) => ({ family: 'http_api' as const, assertionId: 'A1',
  providerId: 'loopback-http-read', providerVersion: '1', method: 'GET' as const, requestFixture: 'NONE' as const,
  port, route: '/cart', expectedStatus: 200, expectedJsonPointer: '/total', expectedJsonValue: '24', timeoutMs: 1000 })
const provisionableHttp: VerificationCapabilityResolver = () => ({ capability: 'UNSUPPORTED',
  capabilityId: 'fixture-exact-http-v1', family: 'http_api', reason: 'Exact future loopback predicate.',
  provisioningVerifier: plannedHttpVerifier() })
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

function snapshotFixture(): PlanSnapshot {
  const requirement = '顾客增加两件不同商品、修改数量并删除一件后，购物车总金额必须精确更新。'
  const behavior = '顾客加入两件不同商品、改变第一件数量并删除第二件后，页面和持久化购物车都显示精确合计。'
  const draft: PlanDraft = {
    clauses: [{ id: 'R1', statement: requirement, type: 'business-rule', priority: 'must',
      source: { excerpt: requirement, location: 'fixture:1', origin: 'customer_requirement' },
      ambiguity: { ambiguous: false, note: '' } }],
    analysis: { productGoal: '精确计算购物车金额', summary: '顾客操作购物车后可观察金额变化。',
      userRoles: [{ id: 'U1', name: '顾客', goals: ['看到购物车金额变化'] }],
      businessFlows: [{ id: 'F1', title: '购物车金额', steps: ['加入两件不同商品', '修改数量并删除一件后查看合计'], requirementIds: ['R1'] }] },
    productScope: { inScope: ['购物车金额计算'], outOfScope: ['支付'] },
    architecture: { summary: '以商品单价、数量和购物车状态计算合计。', components: ['购物车'], decisions: [] },
    tasks: [{ id: 'T1', title: '购物车金额', objective: '实现增减、删除和精确合计', requirementIds: ['R1'],
      outputs: ['可观察的购物车状态'], dependencyIds: [], acceptanceCriterionIds: ['C1'], complexity: 'small' }],
    acceptancePlan: { strategy: '在隔离数据上操作并读取持久化结果。', criteria: [{ id: 'C1', requirementIds: ['R1'],
      description: behavior, level: 'integration', expectedEvidence: '操作前后状态及金额', blocking: true,
      assertions: [{ id: 'A1', requirementId: 'R1', observableBehavior: behavior,
        expectedOutcome: '两种商品的数量、删除结果及剩余精确合计与持久化值一致。',
        expectedEvidence: '逐步状态、数量、单价和最终合计的可复核记录。', blocking: true }] }] },
    risks: [], assumptions: [], customerQuestions: [],
  }
  const id = '11111111-1111-4111-8111-111111111111'
  const plan = createDevelopmentPlan(draft, { id, text: requirement, receivedAt: new Date().toISOString() }, id)
  plan.semanticReview = { verdict: 'PASS', issues: [] }
  plan.status = 'ready_for_approval'
  const approval = { planId: id, planVersion: 1, approvedAt: new Date().toISOString(), actor: 'customer' as const,
    source: 'customer_mode' as const, contentHash: planContentHash(canonicalPlanContent(plan)) }
  return createPlanSnapshot(plan, approval, null)
}

const supported: VerificationCapabilityResolver = () => ({ capability: 'SUPPORTED', capabilityId: 'fixture-business-observation-v1',
  contractAssertionId: 'A1', verificationCommand: 'node --test tests/cart.test.js',
  reason: '隔离 fixture 收集行为前后业务状态。' })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nw-delivery-'))
  const repo = join(root, 'repo')
  await (await import('node:fs/promises')).mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await (await import('node:fs/promises')).mkdir(join(repo, 'tests'))
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test tests/cart.test.js' } }))
  await writeFile(join(repo, 'tests/cart.test.js'), "const items = [{ price: 12, count: 2 }, { price: 5, count: 1 }]; items.pop(); if (items.reduce((sum, item) => sum + item.price * item.count, 0) !== 24) throw new Error('cart total')\n")
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'fixture baseline')
  return { root, repo, snapshot: snapshotFixture() }
}

function blueprintFixture(snapshot: PlanSnapshot, target: Awaited<ReturnType<typeof bindDeliveryTarget>>): VerificationBlueprint {
  const assertion = snapshot.content.acceptancePlan.criteria[0]!.assertions[0]!
  const artifact = 'tests/cart.test.js'
  const step = (kind: 'setup' | 'action' | 'observation' | 'predicate' | 'reread' | 'cleanup',
    mutates = false) => ({ kind, mechanism: 'repository_test' as const, artifact,
      operation: kind === 'predicate' ? 'exact_value' : `isolated_${kind}`,
      expected: kind === 'predicate' ? 'exact business total' : 'scoped fixture', mutates, entityRef: 'cart-id' })
  return { schemaVersion: 1, assertionId: assertion.id, runtimeTaskId: 'T1',
    sourceAssertionHash: assertionContractHash(assertion), provider: { id: 'existing-guarded-verifier', version: '1' },
    family: 'command', setup: [step('setup', true)], action: [step('action', true)],
    observation: [step('observation')], predicate: [step('predicate')], reread: [step('reread')], cleanup: [step('cleanup')],
    timeoutMs: 5_000, requiredArtifacts: [artifact], targetConstraints: {
      canonicalPath: target.canonicalPath, gitRepositoryIdentity: target.gitRepositoryIdentity,
      baselineCommit: target.baselineCommit },
    provenance: { kind: 'repository_contract', relativePath: 'verification/blueprints.v1.json', contractHash: 'a'.repeat(64) },
    entityIdentity: { setupRef: 'cart-id', actionRef: 'cart-id', observationRef: 'cart-id' },
    plannedVerifier: { family: 'command', assertionId: assertion.id, providerId: 'existing-guarded-verifier',
      providerVersion: '1', command: `node --test ${artifact}` } }
}

test('Phase 6 blueprint validator rejects weak evidence, unsafe scope and baseline drift', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const base = blueprintFixture(snapshot, target)
  const validate = (candidate: VerificationBlueprint, level: typeof criterion.level = criterion.level) =>
    validateVerificationBlueprint(candidate, { assertion, criterion: { ...criterion, level }, runtimeTaskId: 'T1', target })
  assert.equal(validate(base).pass, true)
  const codes = (candidate: VerificationBlueprint, level?: typeof criterion.level) =>
    validate(candidate, level).issues.map((issue) => issue.code)
  assert.ok(codes({ ...base, action: [], setup: [] }).includes('MUTATION_WITH_READ_ONLY_EVIDENCE'))
  assert.ok(codes({ ...base, predicate: [] }).includes('UNSPECIFIED_PREDICATE'))
  assert.ok(codes({ ...base, reread: [] }).includes('PERSISTENCE_WITHOUT_REREAD'))
  assert.ok(codes({ ...base, predicate: [{ ...base.predicate[0]!, operation: 'status' }] }).includes('NUMBER_WITHOUT_EXACT_COMPARISON'))
  assert.ok(codes({ ...base, entityIdentity: { setupRef: 'first', actionRef: 'second', observationRef: 'first' } },
    'integration').includes('ENTITY_IDENTITY_MISSING') === false)
  const readOnlyHttp = { family: 'http_api' as const, assertionId: 'A1', providerId: 'loopback-http-read',
    providerVersion: '1', method: 'GET', requestFixture: 'NONE', port: 0, route: '/cart', expectedStatus: 200,
    expectedJsonPointer: '', expectedJsonValue: '', timeoutMs: 1000 } as const
  assert.ok(codes({ ...base, plannedVerifier: readOnlyHttp }).includes('HTTP_STATUS_ONLY'))
  assert.ok(codes({ ...base, plannedVerifier: readOnlyHttp }).includes('EXECUTION_COVERAGE_GAP'))
  assert.ok(codes({ ...base, requiredArtifacts: ['tests/<test>.js'] }).includes('PLACEHOLDER_PATH'))
  assert.ok(codes({ ...base, observation: [{ ...base.observation[0]!, artifact: '/<route>', mechanism: 'loopback_http_get' }] })
    .includes('PLACEHOLDER_ENDPOINT'))
  assert.ok(codes({ ...base, action: [{ ...base.action[0]!, mechanism: 'owned_process', operation: 'sh -c anything' }] })
    .includes('UNRESTRICTED_SHELL'))
  assert.ok(codes({ ...base, requiredArtifacts: ['../secret'] }).includes('PLACEHOLDER_PATH'))
  assert.ok(codes({ ...base, targetConstraints: { ...base.targetConstraints, baselineCommit: 'f'.repeat(40) } })
    .includes('BASELINE_DRIFT'))
  const sameEntity = { ...assertion, observableBehavior: `${assertion.observableBehavior} 同一订单必须保持身份。` }
  assert.ok(validateVerificationBlueprint({ ...base, sourceAssertionHash: assertionContractHash(sameEntity),
    entityIdentity: { setupRef: 'first', actionRef: 'second', observationRef: 'first' } },
  { assertion: sameEntity, criterion, runtimeTaskId: 'T1', target }).issues.some((issue) => issue.code === 'ENTITY_IDENTITY_MISSING'))
  const amount = { ...assertion, expectedOutcome: `${assertion.expectedOutcome} 精确金额为 80 元。` }
  assert.ok(validateVerificationBlueprint({ ...base, sourceAssertionHash: assertionContractHash(amount) },
  { assertion: amount, criterion, runtimeTaskId: 'T1', target }).issues.some((issue) => issue.code === 'EXPECTED_NUMBER_MISSING'))
  assert.ok(validateVerificationBlueprint(base, { assertion, criterion, runtimeTaskId: 'T1', target,
    providerAvailability: () => 'UNAVAILABLE' }).issues.some((issue) => issue.code === 'PROVIDER_UNAVAILABLE'))
  assert.ok(codes({ ...base, cleanup: [] }).includes('CLEANUP_MISSING'))
  assert.ok(codes({ ...base }, 'ui').includes('UI_API_SUBSTITUTION'))
  assert.ok(codes({ ...base, family: 'composite' }).includes('COMPOSITE_PROVIDER_GAP'))
  assert.ok(codes({ ...base, family: 'filesystem', plannedVerifier: {
    family: 'filesystem', assertionId: 'A1', providerId: 'scoped-filesystem-read', providerVersion: '1',
    relativePath: 'missing-app', expectation: 'file_missing' }, artifactScope: {
      kind: 'scope_manifest', relativePath: 'verification/scope.json', generator: 'project-build',
      includedRoots: ['src'], reviewRequired: true } }).includes('NEGATIVE_SCOPE_UNPROVEN'))
  assert.ok(codes({ ...base, assertionId: 'OTHER' }).includes('ASSERTION_MISMATCH'))
})

test('Phase 6 exact repository contract needs independent review, changes RuntimePlan identity, and preserves old plan', async () => {
  const { root, repo, snapshot } = await fixture()
  const initial = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const initialBlueprint = blueprintFixture(snapshot, initial)
  const marker = `const assertionId = 'A1'; const assertionContractHash = '${initialBlueprint.sourceAssertionHash}';\n`
  await writeFile(join(repo, 'tests/cart.test.js'), marker + await readFile(join(repo, 'tests/cart.test.js'), 'utf8'))
  await (await import('node:fs/promises')).mkdir(join(repo, 'verification'))
  const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash, targetConstraints: _target,
    provenance: _provenance, ...content } = initialBlueprint
  await writeFile(join(repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
    entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'Add exact verification contract')
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const facts = await inspectRepoCapabilities(target)
  assert.equal(facts.testFiles[0]?.assertionIds.includes('A1'), true)
  assert.equal(facts.contract?.entries.length, 1)
  const options = { runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true,
    executorAvailable: true, reviewerAvailable: true }
  const old = await compileRuntimePlan(snapshot, target, options)
  const rejected = await planVerificationBlueprints({ snapshot, plan: old, target, facts,
    reviewer: async () => ({ verdict: 'REVISION_REQUIRED', reviewer: 'independent-fixture',
      issues: [{ code: 'FALSE_POSITIVE', message: 'Needs stronger observation.' }] }), maxRepairs: 0 })
  assert.equal(rejected.approved.length, 0)
  assert.equal(rejected.outcomes[0]?.status, 'UNRESOLVED')
  let repairs = 0
  const bounded = await planVerificationBlueprints({ snapshot, plan: old, target, facts,
    reviewer: async () => ({ verdict: 'REVISION_REQUIRED', reviewer: 'independent-fixture',
      issues: [{ code: 'FALSE_POSITIVE', message: 'Still weak.' }] }),
    repairer: async ({ candidate }) => { repairs += 1; return candidate }, maxRepairs: 2 })
  assert.equal(repairs, 2)
  assert.equal(bounded.approved.length, 0)
  const approved = await planVerificationBlueprints({ snapshot, plan: old, target, facts,
    reviewer: async ({ reviewMaterial }) => {
      assert.equal(reviewMaterial.length, 1)
      assert.match(reviewMaterial[0]!.source, /assertionContractHash/u)
      return { verdict: 'PASS', reviewer: 'independent-fixture', issues: [] }
    } })
  assert.equal(approved.approved.length, 1)
  const newPlan = await compileRuntimePlan(snapshot, target, { ...options, approvedBlueprints: approved.approved })
  assert.notEqual(newPlan.runtimePlanHash, old.runtimePlanHash)
  assert.equal(newPlan.sourcePlanHash, old.sourcePlanHash)
  assert.equal(newPlan.acceptanceBindings[0]?.stagedVerification.readiness, 'PROVISIONABLE')
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.saveBinding(target)
  await store.savePlan(old)
  await store.savePlan(newPlan)
  assert.equal((await store.getPlan(old.id))?.id, old.id)
  assert.equal((await store.getPlan(newPlan.id))?.id, newPlan.id)
  const events = new DeliveryEventStore(join(root, 'delivery-events.jsonl'))
  const adapter: DeliveryRuntimeAdapter = { configured: async () => true, executorAvailable: async () => true,
    reviewerAvailable: async () => true, createAndStart: async () => { throw new Error('Must not start in planning.') } }
  const service = new DeliveryService(store, events, adapter, conservativeCapabilityResolver, 'fixture-policy-v1')
  const prepared = await service.prepareWithBlueprintPlanning(snapshot, repo,
    async () => ({ verdict: 'PASS', reviewer: 'independent-fixture', issues: [] }))
  assert.equal(prepared.plan.id, newPlan.id)
  assert.equal((await service.readiness(snapshot, newPlan.id)).admission.status, 'READY')
  const eventText = await readFile(join(root, 'delivery-events.jsonl'), 'utf8')
  assert.match(eventText, /verification_blueprint\.approved/u)
  assert.doesNotMatch(eventText, /exact business total|tests\/cart\.test\.js|\/repo/u)
  assert.equal(await git(repo, 'status', '--porcelain=v1'), '')
  assert.equal((await (await import('node:fs/promises')).readdir(join(root, 'delivery')))
    .some((path) => path.startsWith('session-')), false)
  assert.throws(() => approveVerificationBlueprint(approved.approved[0]!, { verdict: 'REVISION_REQUIRED',
    reviewer: 'independent-fixture', issues: [] }))
})

test('compiler preserves exact contracts, deterministic identity, and rejects mutation or omission', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const options = { resolver: supported, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true }
  const first = await compileRuntimePlan(snapshot, target, options)
  const rebound = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  assert.equal(rebound.id, target.id)
  const second = await compileRuntimePlan(snapshot, rebound, options)
  assert.equal(first.runtimePlanHash, second.runtimePlanHash)
  assert.equal(first.admission.status, 'READY')
  assert.deepEqual(first.admission.coverage, { plannedTaskRuntime: 100, mustRuntime: 100, blockingAssertionRuntime: 100 })
  assert.equal(first.acceptanceBindings[0]?.expectedOutcome, snapshot.content.acceptancePlan.criteria[0]?.assertions[0]?.expectedOutcome)
  const runtimeTask = workSessionDefinitionFor(first, 'fixture-session').tasks[0]
  assert.ok(runtimeTask?.acceptanceCriteria?.[0]?.includes('A1'))
  assert.ok(runtimeTask?.constraints?.some((item) => item.includes('两件不同商品')))
  for (const changed of [
    { ...first, acceptanceBindings: [] },
    { ...first, acceptanceBindings: first.acceptanceBindings.map((binding) => ({ ...binding, blocking: false })) },
    { ...first, acceptanceBindings: first.acceptanceBindings.map((binding) => ({ ...binding, expectedOutcome: 'npm test PASS' })) },
    { ...first, customerDecisions: [{ invented: true }] },
    { ...first, targetBaselineCommit: 'f'.repeat(40) },
  ] as CompiledRuntimePlan[]) assert.throws(() => verifyRuntimePlanCoverage(snapshot, changed))
  await assert.rejects(compileRuntimePlan({ ...snapshot, planHash: { ...snapshot.planHash, value: '0'.repeat(64) } }, target, options))
})

test('staged admission permits provisionable development but still blocks dirty target and drift', async () => {
  const { repo, snapshot } = await fixture()
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const requirement = snapshot.content.clauses[0]!
  assert.equal(conservativeCapabilityResolver({ criterion: { ...criterion, level: 'ui' }, assertion, requirement }).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  assert.equal(conservativeCapabilityResolver({ criterion: { ...criterion, level: 'platform' }, assertion, requirement }).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const conservative = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(conservative.acceptanceBindings[0]?.stagedVerification.readiness, 'UNRESOLVED')
  assert.equal(conservative.admission.status, 'ADMISSION_BLOCKED')
  const unsupported = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(unsupported.admission.status, 'READY')
  assert.equal(unsupported.admission.gate, 'START_DELIVERY_ADMISSION')
  assert.equal(unsupported.admission.modelVersion, ADMISSION_MODEL_VERSION)
  assert.equal(unsupported.acceptanceBindings[0]?.stagedVerification.readiness, 'PROVISIONABLE')
  assert.ok(unsupported.acceptanceBindings[0]?.stagedVerification.provisioning?.id)
  assert.equal(taskCompletionGate(unsupported.acceptanceBindings, [], []), false)
  const forgedEvidence = { assertionId: 'A1', runtimeTaskId: 'T1', providerId: 'loopback-http-read',
    collector: 'loopback-http-read', verificationStep: 'GET /cart',
    expectedOutcome: unsupported.acceptanceBindings[0]!.expectedOutcome, evidenceId: 'claimed',
    executed: true, observedMatch: true, reviewerVerdict: 'PASS' as const }
  assert.equal(taskCompletionGate(unsupported.acceptanceBindings, [], [forgedEvidence]), false,
    'green execution and review cannot replace the exact provisioning transition')
  const human = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'REQUIRES_HUMAN',
    capabilityId: 'human-acceptance-v1', reason: '需要客户现场验收。' }), runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(human.admission.status, 'READY')
  assert.equal(human.acceptanceBindings[0]?.stagedVerification.readiness, 'HUMAN_DEFERRED')
  assert.equal(taskCompletionGate(human.acceptanceBindings, [], []), false)
  const missingArtifact = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'SUPPORTED',
    capabilityId: 'missing-exact-test-v1', contractAssertionId: 'A1',
    verificationCommand: 'node --test tests/not-yet-created.test.js', reason: 'Fixture verifier has not appeared.' }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.ok(missingArtifact.admission.blockers.some((item) => item.code === 'VERIFIER_ARTIFACT_UNAVAILABLE'))
  assert.equal(human.admission.capabilityCoverage.human, 1)
  const external = await compileRuntimePlan({ ...snapshot, content: { ...snapshot.content,
    acceptancePlan: { ...snapshot.content.acceptancePlan, criteria: [{ ...criterion, level: 'ui' }] } } }, target,
  { runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true }).catch(() => undefined)
  assert.equal(external, undefined, 'a changed criterion cannot bypass the frozen snapshot hash')
  await writeFile(join(repo, 'untracked.txt'), 'dirty')
  const dirty = await compileRuntimePlan(snapshot, target, { resolver: supported, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.ok(dirty.admission.blockers.some((blocker) => blocker.code === 'TARGET_DRIFT'))
  assert.ok(dirty.admission.blockers.some((blocker) => blocker.code === 'TARGET_DIRTY'))
})

test('exact provisioning transition persists across restart and cannot authorize an unsafe verifier', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  const binding = plan.acceptanceBindings[0]!
  const verifier = { family: 'http_api' as const, assertionId: 'A1', providerId: 'loopback-http-read',
    providerVersion: '1', method: 'GET' as const, requestFixture: 'NONE' as const, port: 23456, route: '/cart', expectedStatus: 200,
    expectedJsonPointer: '/total', expectedJsonValue: '24', timeoutMs: 1000 }
  const transition = await store.bindProvisionedVerifier(plan, 'A1', 'T1', verifier)
  assert.equal(snapshot.planHash.value, plan.sourcePlanHash, 'transition does not mutate the Frozen Plan')
  assert.equal((await store.getPlan(plan.id))?.runtimePlanHash, plan.runtimePlanHash)
  assert.equal(transition.from, 'PROVISIONABLE')
  assert.equal(transition.to, 'BOUND_EXECUTABLE')
  assert.equal((await new DeliveryStore(join(root, 'delivery')).getBindingTransition(plan, 'A1', 'T1'))?.id, transition.id)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...verifier, route: '/other' }), /exact trusted obligation/)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...verifier, assertionId: 'A2' }), /exact trusted obligation/)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...verifier, expectedJsonPointer: '' }), /exact trusted obligation/)
  const item = { assertionId: 'A1', runtimeTaskId: 'T1', transitionId: transition.id,
    providerId: 'loopback-http-read', collector: 'loopback-http-read', verificationStep: 'GET /cart',
    expectedOutcome: binding.expectedOutcome, evidenceId: 'observed-1', executed: true,
    observedMatch: true, reviewerVerdict: 'PASS' as const }
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], []), false)
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [{ ...item, reviewerVerdict: 'PENDING' }]), false)
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [{ ...item, assertionId: 'A2' }]), false)
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [item]), true)
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [transition], [item], new Set()), false)
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [transition], [item], new Set(['T1'])), true)
})

test('generated command verifier must be exact, safe and present before binding', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'UNSUPPORTED',
    capabilityId: 'fixture-command-obligation-v1', family: 'command', reason: 'Assertion test must be provisioned.',
    provisioningVerifier: { family: 'command', assertionId: 'A1', providerId: 'existing-guarded-verifier',
      providerVersion: '1', command: 'node --test tests/cart.test.js' } }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  const base = { family: 'command' as const, assertionId: 'A1', providerId: 'existing-guarded-verifier', providerVersion: '1' }
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...base, command: 'npm test' }), /exact trusted obligation/)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...base, command: 'node --test tests/absent.test.js' }))
  const bound = await store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...base, command: 'node --test tests/cart.test.js' })
  assert.equal(bound.to, 'BOUND_EXECUTABLE')
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [bound], []), false)
  const observed = await store.collectProvisionedEvidence(plan, 'A1', 'T1')
  assert.equal(observed.facts.observedMatch, true)
  const definition = workSessionDefinitionFor(plan, 'fixture-command-session')
  const task = createTaskStateV2(definition, definition.tasks[0]!)
  const dispatcher = createDeliveryRuntimeDispatcher(plan, store, { inspectRepository: async () => { throw new Error('unused') },
    dispatch: async () => { throw new Error('assertion-bound test must use native adapter') } })
  const agent = { id: 'fixture', identity: { agent: 'fixture', provider: 'fixture', runtimeIdentity: 'fixture' },
    available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true,
      verification: true, review: true } }
  const verified = await dispatcher.dispatch({ action: 'VERIFY', agent, task })
  assert.equal(verified.verificationResults?.[0]?.status, 'passed')
  const verifiedTask = { ...task, verificationState: { ...task.verificationState,
    results: [...(verified.verificationResults ?? [])] } }
  assert.equal(assertionCapabilityEvidenceValid(verifiedTask, { assertionId: 'A1', verdict: 'PASS', evidence: 'Scoped test observed.',
    capabilityEvidence: { family: 'command', providerId: 'existing-guarded-verifier', providerVersion: '1',
      collector: 'existing-guarded-verifier', evidenceIds: [verified.verificationResults![0]!.rawOutputRef!],
      verificationResult: 'OBSERVED' } }), true)
})

test('external completion-only permits Start while execution prerequisite and unresolved block it', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const external = () => ({ capability: 'REQUIRES_EXTERNAL_ENVIRONMENT' as const, capabilityId: 'fixture-external-v1',
    family: 'browser_ui' as const, reason: 'Browser evidence pending.' })
  const completion = await compileRuntimePlan(snapshot, target, { resolver: external, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(completion.admission.status, 'READY')
  assert.equal(completion.acceptanceBindings[0]?.stagedVerification.readiness, 'EXTERNAL_DEFERRED')
  assert.equal(taskCompletionGate(completion.acceptanceBindings, [], []), false)
  assert.equal(customerDeliveryCompletionGate(completion.tasks, completion.acceptanceBindings, [], [{
    assertionId: 'A1', runtimeTaskId: 'T1', providerId: 'browser-harness-pending', collector: 'claimed',
    verificationStep: 'claimed', expectedOutcome: completion.acceptanceBindings[0]!.expectedOutcome,
    evidenceId: 'claimed', executed: true, observedMatch: true, reviewerVerdict: 'PASS',
  }], new Set(['T1'])), false, 'external evidence cannot be replaced by a claimed review or completed task')
  const prerequisite = await compileRuntimePlan(snapshot, target, { resolver: () => ({ ...external(), startPrerequisite: 'EXECUTION' }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.ok(prerequisite.admission.blockers.some((item) => item.code === 'EXECUTION_PREREQUISITE_MISSING'))
  const unresolved = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'UNSUPPORTED',
    capabilityId: 'fixture-git-v1', family: 'git', reason: 'No exact Git predicate.' }), runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.ok(unresolved.admission.blockers.some((item) => item.code === 'VERIFICATION_UNRESOLVED'))
})

test('process adapter observes only an owned, bounded Node entry', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  await writeFile(join(repo, 'worker.mjs'), 'process.stdout.write("ready")\n')
  const observed = await collectProcessEvidence({ target, assertionId: 'A1', relativeEntry: 'worker.mjs',
    expectedExitCode: 0, timeoutMs: 1000 })
  assert.equal(observed.facts.observedMatch, true)
  await assert.rejects(collectProcessEvidence({ target, assertionId: 'A1', relativeEntry: '../worker.mjs',
    expectedExitCode: 0, timeoutMs: 1000 }))
})

test('internal HTTP adapter collects an exact bounded JSON predicate without granting assertion PASS', async () => {
  const { root, repo, snapshot } = await fixture()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"total":"24"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
    const plan = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp, runtimePolicyVersion: 'fixture-policy-v1',
      runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
    const store = new DeliveryStore(join(root, 'delivery'))
    await store.savePlan(plan)
    const transition = await store.bindProvisionedVerifier(plan, 'A1', 'T1', {
      family: 'http_api', assertionId: 'A1', providerId: 'loopback-http-read', providerVersion: '1', method: 'GET', requestFixture: 'NONE',
      port: address.port, route: '/cart', expectedStatus: 200, expectedJsonPointer: '/total',
      expectedJsonValue: '24', timeoutMs: 1000 })
    const observed = await store.collectProvisionedEvidence(plan, 'A1', 'T1')
    assert.equal(observed.facts.observedMatch, true)
    assert.equal((await new DeliveryStore(join(root, 'delivery')).getCapabilityEvidence(plan, observed.id))?.id, observed.id)
    assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], []), false)
    const wrong = await collectHttpEvidence({ assertionId: 'A1', port: address.port, route: '/cart',
      expectedStatus: 200, expectedJsonPointer: '/total', expectedJsonValue: '25' })
    assert.equal(wrong.facts.observedMatch, false)
    assert.equal(Object.hasOwn(wrong.facts, 'body'), false)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('delivery V2 adapter lets implementation run without executing markers and blocks verification until binding', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(plan, 'fixture-session')
  const task = createTaskStateV2(definition, definition.tasks[0]!)
  const received: string[][] = []
  const fallback: V2ActionDispatcher = { inspectRepository: async () => { throw new Error('unused') },
    dispatch: async ({ task: state }) => {
      received.push(state.completion.bindings.flatMap((item) => item.requiredEvidence))
      return { status: 'SUCCESS', changedFiles: ['README.md'], repositoryChanged: true }
    } }
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  const dispatcher = createDeliveryRuntimeDispatcher(plan, store, fallback)
  const agent = { id: 'fixture', identity: { agent: 'fixture', provider: 'fixture', runtimeIdentity: 'fixture' },
    available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true,
      verification: true, review: true } }
  assert.equal((await dispatcher.dispatch({ action: 'EXECUTE', agent, task })).status, 'SUCCESS')
  assert.deepEqual(received, [[]])
  const missing = await dispatcher.dispatch({ action: 'VERIFY', agent, task })
  assert.equal(missing.status, 'BLOCKED')
  assert.equal(received.length, 1)
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"total":"24"}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await store.bindProvisionedVerifier(plan, 'A1', 'T1', { family: 'http_api', assertionId: 'A1',
      providerId: 'loopback-http-read', providerVersion: '1', method: 'GET', requestFixture: 'NONE', port: address.port, route: '/cart',
      expectedStatus: 200, expectedJsonPointer: '/total', expectedJsonValue: '24', timeoutMs: 1000 })
    const verified = await dispatcher.dispatch({ action: 'VERIFY', agent, task })
    assert.equal(verified.status, 'SUCCESS')
    assert.equal(verified.verificationResults?.[0]?.status, 'passed')
    assert.equal(verified.verificationResults?.[0]?.stepId, task.completion.bindings[0]?.requiredEvidence[0])
    const evidenceId = verified.verificationResults?.[0]?.rawOutputRef
    assert.match(evidenceId ?? '', /^[a-f0-9]{64}$/u)
    const verifiedTask = { ...task, verificationState: { ...task.verificationState,
      results: [...(verified.verificationResults ?? [])] } }
    const trace = { assertionId: 'A1', verdict: 'PASS' as const, evidence: 'Expected cart total observed.',
      capabilityEvidence: { family: 'http_api', providerId: 'loopback-http-read', providerVersion: '1',
        collector: 'loopback-http-read', evidenceIds: [evidenceId!], verificationResult: 'OBSERVED' as const } }
    assert.equal(assertionCapabilityEvidenceValid(verifiedTask, trace), true)
    assert.equal(assertionCapabilityEvidenceValid(verifiedTask, { ...trace,
      capabilityEvidence: { ...trace.capabilityEvidence, evidenceIds: ['0'.repeat(64)] } }), false)
    assert.equal(received.length, 1, 'native evidence does not execute an invented shell command')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('Requirement 001 audit guard rejects a different snapshot before inspecting a target', async () => {
  const { root, repo, snapshot } = await fixture()
  const path = join(root, 'other.snapshot.json')
  await writeFile(path, JSON.stringify(snapshot))
  await assert.rejects(exec('node', ['scripts/requirement-001-capability-audit.mjs', path, repo],
    { cwd: process.cwd(), timeout: 10_000 }), /not the approved frozen Requirement 001 snapshot/)
})

test('capability registry classifies all families without claiming unsupported assertions pass', async () => {
  const snapshot = snapshotFixture()
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const requirement = snapshot.content.clauses[0]!
  assert.deepEqual(Object.keys(CAPABILITY_REGISTRY).sort(),
    ['command', 'http_api', 'browser_ui', 'filesystem', 'git', 'process', 'desktop_ui', 'external_platform', 'human'].sort())
  const input = { criterion, assertion, requirement }
  assert.equal(classifyCapability(input).family, 'http_api')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'ui' } }).family, 'browser_ui')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'platform' } }).family, 'external_platform')
  assert.equal(conservativeCapabilityResolver({ ...input, criterion: { ...criterion, level: 'platform' },
    assertion: { ...assertion, observableBehavior: '开始开发前必须先取得平台 SDK 权限。' } }).startPrerequisite, 'EXECUTION')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'delivery' },
    assertion: { ...assertion, expectedEvidence: '交付文件清单' } }).family, 'filesystem')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'delivery' },
    assertion: { ...assertion, expectedEvidence: '客户人工验收' } }).family, 'human')
  const defaultResolution = resolveCapability(input, conservativeCapabilityResolver)
  assert.equal(defaultResolution.capability, 'UNSUPPORTED')
  assert.equal(defaultResolution.family, 'http_api')
  assert.equal(defaultResolution.schemaVersion, 1)
  assert.throws(() => resolveCapability(input, () => ({ capability: 'SUPPORTED', capabilityId: 'unsafe',
    verificationCommand: 'node -e "process.exit(0)"', reason: 'unsafe' })))
  assert.throws(() => resolveCapability(input, () => ({ capability: 'SUPPORTED', capabilityId: 'generic',
    contractAssertionId: 'A1', verificationCommand: 'npm test', reason: 'A root suite is insufficient.' })))
  assert.throws(() => resolveCapability(input, () => ({ capability: 'SUPPORTED', capabilityId: 'exact',
    providerId: 'bad/provider', contractAssertionId: 'A1', verificationCommand: 'node --test tests/cart.test.js',
    reason: 'Provider identity cannot evade Reviewer binding.' })))
  assert.throws(() => resolveCapability(input, () => ({ capability: 'SUPPORTED', capabilityId: 'unwired',
    family: 'filesystem', reason: 'No existing runtime adapter.' })))
})

test('read-only collectors stay scoped and persist evidence against an exact plan', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'UNSUPPORTED',
    capabilityId: 'scoped-filesystem-read-v1', family: 'filesystem', reason: 'Explicit contract is not bound to runtime.' }),
    runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const file = await trustedCapabilityRegistry.collect({ family: 'filesystem', target, assertionId: 'A1',
    relativePath: 'README.md', expectation: 'contains', contains: 'fixture' })
  assert.equal(file.facts.observedMatch, true)
  assert.equal(file.result, 'OBSERVED')
  assert.equal((await collectFilesystemEvidence({ target, assertionId: 'A1', relativePath: 'absent.txt',
    expectation: 'file_missing' })).facts.observedMatch, true)
  await assert.rejects(collectFilesystemEvidence({ target, assertionId: 'A1', relativePath: '../outside', expectation: 'file_exists' }))
  await symlink(root, join(repo, 'escape'))
  await assert.rejects(collectFilesystemEvidence({ target, assertionId: 'A1', relativePath: 'escape/file', expectation: 'file_exists' }))
  const observedGit = await collectGitEvidence({ target, assertionId: 'A1', fact: 'head', expected: target.baselineCommit })
  assert.equal(observedGit.facts.observedMatch, true)
  verifyCapabilityEvidence(file)
  assert.throws(() => verifyCapabilityEvidence({ ...file, facts: { ...file.facts, observedMatch: false } }))
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  await store.saveCapabilityEvidence(plan, file)
  assert.deepEqual(await new DeliveryStore(join(root, 'delivery')).getCapabilityEvidence(plan, file.id), file)
  await assert.rejects(store.saveCapabilityEvidence(plan, observedGit), /does not belong/)
})

test('loopback HTTP collector bounds target and response without treating status as assertion PASS', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const observed = await collectHttpEvidence({ assertionId: 'A1', port: address.port, route: '/health', expectedStatus: 200 })
    assert.equal(observed.result, 'OBSERVED')
    assert.equal(observed.facts.observedMatch, true)
    assert.equal(Object.hasOwn(observed.facts, 'body'), false)
    await assert.rejects(collectHttpEvidence({ assertionId: 'A1', port: address.port, route: '//example.com', expectedStatus: 200 }))
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('capability policy and provider availability drift fail closed after restart', async () => {
  const { root, repo, snapshot } = await fixture()
  const store = new DeliveryStore(join(root, 'delivery'))
  const events = new DeliveryEventStore(join(root, 'delivery', 'events.jsonl'))
  const adapter: DeliveryRuntimeAdapter = { configured: async () => true, executorAvailable: async () => true,
    reviewerAvailable: async () => true, createAndStart: async () => undefined }
  const service = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1')
  const plan = await service.prepare(snapshot, repo, 'trusted_test')
  assert.equal(plan.admission.capabilityCoverage.trustedProvider, 1)
  assert.equal((await new DeliveryService(new DeliveryStore(join(root, 'delivery')), events, adapter, supported,
    'fixture-policy-v1').readiness(snapshot, plan.id)).admission.status, 'READY')
  const unavailable = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1', () => 'UNAVAILABLE')
  const unavailableAdmission = (await unavailable.readiness(snapshot, plan.id)).admission
  assert.ok(unavailableAdmission.blockers.some((item) => item.code === 'VERIFICATION_PROVIDER_UNAVAILABLE'))
  assert.equal(unavailableAdmission.capabilityCoverage.executableOnCurrentHost, 0)
  const changed: VerificationCapabilityResolver = () => ({ capability: 'SUPPORTED', capabilityId: 'different-provider-v2',
    contractAssertionId: 'A1', verificationCommand: 'node --test tests/cart.test.js', reason: 'Different policy.' })
  await assert.rejects(new DeliveryService(store, events, adapter, changed, 'fixture-policy-v1').readiness(snapshot, plan.id),
    /capability policy changed/)
  const corrupted: CompiledRuntimePlan = { ...plan, acceptanceBindings: plan.acceptanceBindings.map((binding) => ({ ...binding,
    verificationCapability: { ...binding.verificationCapability, providerVersion: '99' } })) }
  assert.throws(() => verifyRuntimePlanIdentity(corrupted))
  assert.throws(() => verifyRuntimePlanCoverage(snapshot, { ...plan, acceptanceBindings: [...plan.acceptanceBindings, plan.acceptanceBindings[0]!] }))
})

test('fixture delivery creates one exact WorkSession, persists binding and rejects later drift', async () => {
  const { root, repo, snapshot } = await fixture()
  const store = new DeliveryStore(join(root, 'delivery'))
  const events = new DeliveryEventStore(join(root, 'delivery', 'events.jsonl'))
  const definitions: string[] = []
  const adapter: DeliveryRuntimeAdapter = {
    configured: async () => true, executorAvailable: async () => true, reviewerAvailable: async () => true,
    createAndStart: async (definition, binding) => {
      assert.equal(binding.sourceSnapshotId, snapshot.id)
      assert.equal(binding.sourcePlanHash, snapshot.planHash.value)
      assert.equal(definition.id, binding.workSessionId)
      definitions.push(definition.id)
      const runtime = new WorkSessionRuntime({ definition: { ...definition, controlPlane: 'v1' },
        taskRunner: new FakeTaskRunner({ T1: { type: 'COMPLETED' } }),
        storageUrl: pathToFileURL(join(root, 'fixture-runtime.db')).href })
      try { await runtime.start() } finally { await runtime.close() }
    },
  }
  const service = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1')
  const plan = await service.prepare(snapshot, repo, 'trusted_test')
  const preparedAgain = await service.prepare(snapshot, repo, 'trusted_test')
  assert.equal(preparedAgain.runtimePlanHash, plan.runtimePlanHash)
  assert.equal(preparedAgain.targetBinding.id, plan.targetBinding.id)
  assert.equal(definitions.length, 0)
  const competing = await Promise.allSettled([
    service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id),
    service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id),
  ])
  const started = competing.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof service.startDelivery>>> =>
    item.status === 'fulfilled')?.value
  assert.ok(started)
  assert.equal(new Set(competing.filter((item) => item.status === 'fulfilled').map((item) => item.value.workSessionId)).size, 1)
  assert.equal(started.status, 'STARTED')
  assert.equal(started.runtimePlanHash, plan.runtimePlanHash)
  assert.equal((await service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id)).workSessionId, started.workSessionId)
  assert.equal(definitions.length, 1)
  const reopened = new DeliveryService(new DeliveryStore(join(root, 'delivery')), events, adapter, supported, 'fixture-policy-v1')
  assert.equal((await reopened.readiness(snapshot, plan.id)).admission.status, 'READY')
  assert.equal((await reopened.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id)).workSessionId, started.workSessionId)
  await assert.rejects(new DeliveryService(new DeliveryStore(join(root, 'delivery')), events, adapter, supported, 'fixture-policy-v2')
    .readiness(snapshot, plan.id))
  await writeFile(join(repo, 'README.md'), 'changed\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-qm', 'drift')
  await assert.rejects(reopened.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id))
  const raw = await readFile(events.path, 'utf8')
  assert.ok(raw.includes('delivery.started'))
  assert.ok(!raw.includes(repo))
  assert.ok(!raw.includes('两件不同商品'))
})

test('Customer delivery API binds an exact snapshot and uses the production session entry', async () => {
  const { root, repo, snapshot } = await fixture()
  const created: string[] = []
  const launchpad = new NovaWingLaunchpad([], join(root, 'configs'), {
    planningService: { getSnapshot: async (id: string, version: number) =>
      id === snapshot.sourcePlanId && version === snapshot.sourcePlanVersion ? snapshot : undefined } as PlanningService,
    deliveryResolver: supported, deliveryPolicyVersion: 'fixture-policy-v1', deliveryDataRoot: join(root, 'delivery'),
    resolveReviewerRouteAvailable: async () => true,
    resolveEnvironment: async () => process.env,
    createWorkSession: async (config) => {
      created.push(config.session.id)
      assert.equal(config.session.targetRepo, await realpath(repo))
      assert.equal(config.session.controlPlane, 'v2')
      assert.equal(config.tasks[0]?.risk, 'HIGH')
      assert.ok(config.tasks[0]?.guardian.acceptanceCriteria.some((criterion) => criterion.includes('A1')))
      return { controller: { start: () => ({ started: true }) }, start: async () => ({ url: 'http://127.0.0.1:9999' }),
        isLive: () => true, hasActiveSession: () => false, close: async () => undefined }
    },
  })
  try {
    const address = await launchpad.start()
    const html = await (await fetch(`${address.url}/customer`)).text()
    const token = JSON.parse(html.match(/<script id="customer-bootstrap" type="application\/json">([^<]+)<\/script>/u)?.[1] ?? '{}').token as string
    assert.ok(token)
    const post = async (path: string, body: unknown) => fetch(`${address.url}${path}`, { method: 'POST',
      headers: { Origin: address.url, 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': token },
      body: JSON.stringify(body) })
    const preparedResponse = await post('/api/delivery/prepare', { planId: snapshot.sourcePlanId,
      version: snapshot.sourcePlanVersion, snapshotId: snapshot.id, repositoryRoot: repo })
    assert.equal(preparedResponse.status, 200)
    const prepared = await preparedResponse.json() as { runtimePlanId: string; runtimePlanHash: string;
      targetBindingId: string; admission: { status: string } }
    assert.equal(prepared.admission.status, 'READY')
    assert.equal(created.length, 0)
    const exact = { planId: snapshot.sourcePlanId, version: snapshot.sourcePlanVersion, snapshotId: snapshot.id,
      sourcePlanHash: snapshot.planHash.value,
      runtimePlanId: prepared.runtimePlanId, runtimePlanHash: prepared.runtimePlanHash, targetBindingId: prepared.targetBindingId }
    assert.equal((await post('/api/delivery/start', { ...exact, sourcePlanHash: '0'.repeat(64) })).status, 409)
    assert.equal(created.length, 0)
    const started = await post('/api/delivery/start', exact)
    assert.equal(started.status, 202)
    const binding = await started.json() as { workSessionId: string; sourcePlanHash: string }
    assert.equal(binding.sourcePlanHash, snapshot.planHash.value)
    assert.deepEqual(created, [binding.workSessionId])
    const repeated = await post('/api/delivery/start', exact)
    assert.equal(repeated.status, 202)
    assert.deepEqual(created, [binding.workSessionId])
    const restored = await fetch(`${address.url}/api/delivery/plans/${prepared.runtimePlanId}?planId=${snapshot.sourcePlanId}&version=${snapshot.sourcePlanVersion}`)
    assert.equal(restored.status, 200)
    assert.equal((await restored.json() as { admission: { status: string } }).admission.status, 'READY')
  } finally { await launchpad.close() }
})
