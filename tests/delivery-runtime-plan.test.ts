import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { symlink } from 'node:fs/promises'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, type PlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { DeliveryEventStore, DeliveryService, DeliveryStore, type DeliveryRuntimeAdapter,
  type WorkSessionPlanBinding } from '../packages/development-guardian/delivery/service.js'
import { bindDeliveryTarget, compileRuntimePlan, conservativeCapabilityResolver, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity, workSessionDefinitionFor,
  type CompiledRuntimePlan, type VerificationCapabilityResolver } from '../packages/development-guardian/delivery/runtime-plan.js'
import { CAPABILITY_REGISTRY, classifyCapability, collectFilesystemEvidence, collectGitEvidence, collectHttpEvidence,
  collectProcessEvidence, trustedCapabilityRegistry,
  resolveCapability, verifyCapabilityEvidence } from '../packages/development-guardian/delivery/capability-layer.js'
import { ADMISSION_MODEL_VERSION, customerDeliveryCompletionGate, taskCompletionGate } from '../packages/development-guardian/delivery/staged-verification.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assertionCapabilityEvidenceValid, type ReviewEvidence } from '../packages/development-guardian/work-session/risk-evidence.js'
import { V2ControllerTaskRunner, type V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { createDeliveryRuntimeDispatcher } from '../packages/development-guardian/delivery/runtime-adapter.js'
import { FakeTaskRunner } from '../packages/development-guardian/work-session/fake-task-runner.js'
import { NovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import type { PlanningService } from '../packages/development-guardian/planning/service.js'
import { bindObligationAtCommit } from '../packages/development-guardian/delivery/verification-blueprint-planner.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'
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
  await git(repo, 'checkout', '-qb', 'codex/delivery-fixture')
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

async function trustedGitState(repo: string) {
  const status = (await exec('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repo })).stdout
  const entries = parseGitStatus(status)
  const indexDiff = (await exec('git', ['diff', '--cached', '--binary'], { cwd: repo })).stdout
  return { repositoryIdentity: await realpath(repo), branch: await git(repo, 'branch', '--show-current'),
    headSha: await git(repo, 'rev-parse', 'HEAD'), changedFiles: entries.map((item) => item.path),
    worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(repo, entries,
      { strict: true })).update(indexDiff).digest('hex') }
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
    .includes('COMMIT_NOT_DESCENDANT'))
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

test('Phase 6 blueprint is reviewed and bound at implementation commit without changing RuntimePlan identity', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const options = { runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true,
    executorAvailable: true, reviewerAvailable: true }
  const plan = await compileRuntimePlan(snapshot, target, options)
  assert.equal(plan.admission.status, 'READY')
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  const initialBlueprint = blueprintFixture(snapshot, target)
  const marker = `const assertionId = 'A1'; const assertionContractHash = '${initialBlueprint.sourceAssertionHash}';\n`
  await writeFile(join(repo, 'tests/cart.test.js'), marker + await readFile(join(repo, 'tests/cart.test.js'), 'utf8'))
  await (await import('node:fs/promises')).mkdir(join(repo, 'verification'))
  const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash, targetConstraints: _target,
    provenance: _provenance, ...content } = initialBlueprint
  await writeFile(join(repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
    entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'Implement exact assertion verifier')
  const commit = await git(repo, 'rev-parse', 'HEAD')
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const base = { obligation, assertion, criterion, target, commit }
  await assert.rejects(bindObligationAtCommit({ ...base,
    reviewer: async () => ({ verdict: 'REVISION_REQUIRED', reviewer: 'independent-fixture',
      issues: [{ code: 'FALSE_POSITIVE', message: 'Needs stronger observation.' }] }), maxRepairs: 0 }),
  /BLUEPRINT_BINDING_BLOCKED/)
  let repairs = 0
  await assert.rejects(bindObligationAtCommit({ ...base,
    reviewer: async () => ({ verdict: 'REVISION_REQUIRED', reviewer: 'independent-fixture',
      issues: [{ code: 'FALSE_POSITIVE', message: 'Still weak.' }] }),
    repairer: async ({ candidate }) => { repairs += 1; return candidate }, maxRepairs: 2 }), /BLUEPRINT_BINDING_BLOCKED/)
  assert.equal(repairs, 2)
  const approved = await bindObligationAtCommit({ ...base, reviewer: async ({ reviewMaterial, obligation: reviewed }) => {
    assert.equal(reviewMaterial.length, 1)
    assert.equal(reviewed?.obligationId, obligation.obligationId)
    assert.match(reviewMaterial[0]!.source, /assertionContractHash/u)
    return { verdict: 'PASS', reviewer: 'independent-fixture', issues: [] }
  } })
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.saveBinding(target)
  await store.savePlan(plan)
  const transition = await store.bindProvisionedVerifier(plan, 'A1', 'T1', approved)
  assert.equal(transition.from, 'PROVISIONABLE_DURING_EXECUTION')
  assert.equal(transition.implementationCommit, commit)
  assert.equal((await store.getPlan(plan.id))?.runtimePlanHash, plan.runtimePlanHash)
  assert.equal((await new DeliveryStore(join(root, 'delivery')).getBindingTransition(plan, 'A1', 'T1'))?.id, transition.id)
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], []), 'BLOCKED')
  assert.equal(await git(repo, 'status', '--porcelain=v1'), '')
  assert.equal((await (await import('node:fs/promises')).readdir(join(root, 'delivery')))
    .some((path) => path.startsWith('session-')), false)
  assert.throws(() => approveVerificationBlueprint(approved, { verdict: 'REVISION_REQUIRED',
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
  assert.equal(conservative.acceptanceBindings[0]?.stagedVerification.readiness, 'PROVISIONABLE_DURING_EXECUTION')
  assert.equal(conservative.admission.status, 'READY')
  const unsupported = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(unsupported.admission.status, 'ADMISSION_BLOCKED')
  assert.equal(unsupported.admission.gate, 'START_DELIVERY_ADMISSION')
  assert.equal(unsupported.admission.modelVersion, ADMISSION_MODEL_VERSION)
  assert.equal(conservative.acceptanceBindings[0]?.stagedVerification.readiness, 'PROVISIONABLE_DURING_EXECUTION')
  assert.ok(conservative.acceptanceBindings[0]?.stagedVerification.obligation?.obligationId)
  assert.equal(taskCompletionGate(conservative.acceptanceBindings, [], []), 'BLOCKED')
  const forgedEvidence = { assertionId: 'A1', runtimeTaskId: 'T1', providerId: 'loopback-http-read',
    collector: 'loopback-http-read', verificationStep: 'GET /cart',
    expectedOutcome: conservative.acceptanceBindings[0]!.expectedOutcome, evidenceId: 'claimed',
    executed: true, observedMatch: true, reviewerVerdict: 'PASS' as const }
  assert.equal(taskCompletionGate(conservative.acceptanceBindings, [], [forgedEvidence]), 'BLOCKED',
    'green execution and review cannot replace the exact provisioning transition')
  const human = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'REQUIRES_HUMAN',
    capabilityId: 'human-acceptance-v1', reason: '需要客户现场验收。' }), runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(human.admission.status, 'READY')
  assert.equal(human.acceptanceBindings[0]?.stagedVerification.readiness, 'HUMAN_DEFERRED')
  assert.equal(taskCompletionGate(human.acceptanceBindings, [], []), 'BLOCKED')
  assert.equal(taskCompletionGate(human.acceptanceBindings, [], [{ assertionId: 'A1', runtimeTaskId: 'T1',
    providerId: 'customer-human-acceptance', collector: 'independent-reviewer', verificationStep: 'COMPLETION_DEFERRED',
    expectedOutcome: human.acceptanceBindings[0]!.expectedOutcome, evidenceId: 'DEFERRED:A1',
    executed: false, observedMatch: false, reviewerVerdict: 'DEFERRED' }]), 'LOCALLY_VERIFIED')
  const missingArtifact = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'SUPPORTED',
    capabilityId: 'missing-exact-test-v1', contractAssertionId: 'A1',
    verificationCommand: 'node --test tests/not-yet-created.test.js', reason: 'Fixture verifier has not appeared.' }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(missingArtifact.admission.status, 'READY')
  assert.equal(missingArtifact.acceptanceBindings[0]?.stagedVerification.readiness, 'PROVISIONABLE_DURING_EXECUTION')
  assert.ok(missingArtifact.acceptanceBindings[0]?.stagedVerification.obligation?.obligationId)
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

test('completion transition rejects verifier substitution, missing artifact, and unreviewed evidence', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const obligation = plan.acceptanceBindings[0]!.stagedVerification.obligation!
  const blueprint = blueprintFixture(snapshot, target)
  const marker = `const assertionId = 'A1'; const assertionContractHash = '${blueprint.sourceAssertionHash}';\n`
  await writeFile(join(repo, 'tests/cart.test.js'), marker + await readFile(join(repo, 'tests/cart.test.js'), 'utf8'))
  await (await import('node:fs/promises')).mkdir(join(repo, 'verification'))
  const { schemaVersion: _schema, assertionId, runtimeTaskId, sourceAssertionHash, targetConstraints: _target,
    provenance: _provenance, ...content } = blueprint
  await writeFile(join(repo, 'verification/blueprints.v1.json'), JSON.stringify({ schemaVersion: 1,
    entries: [{ assertionId, runtimeTaskId, sourceAssertionHash, blueprint: content }] }))
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'Implement verifier')
  const commit = await git(repo, 'rev-parse', 'HEAD')
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const approved = await bindObligationAtCommit({ obligation, assertion: criterion.assertions[0]!, criterion,
    target, commit, reviewer: async () => ({ verdict: 'PASS', reviewer: 'independent-fixture', issues: [] }) })
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...approved,
    plannedVerifier: { ...approved.plannedVerifier!, assertionId: 'A2' } }), /invalid or stale|approved obligation/i)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...approved,
    requiredArtifacts: ['tests/absent.test.js'] }), /invalid or stale|artifact/i)
  await assert.rejects(store.bindProvisionedVerifier(plan, 'A1', 'T1', { ...approved,
    plannedVerifier: { family: 'command', assertionId: 'A1', providerId: 'existing-guarded-verifier',
      providerVersion: '1', command: 'npm test' } }), /invalid or stale|unsafe|Review source/i)
  const transition = await store.bindProvisionedVerifier(plan, 'A1', 'T1', approved)
  const observed = await store.collectProvisionedEvidence(plan, 'A1', 'T1')
  assert.equal(observed.facts.observedMatch, true)
  const baseEvidence = { assertionId: 'A1', runtimeTaskId: 'T1', transitionId: transition.id,
    providerId: observed.providerId, collector: observed.collector, verificationStep: 'node --test tests/cart.test.js',
    expectedOutcome: plan.acceptanceBindings[0]!.expectedOutcome, evidenceId: observed.id,
    implementationCommit: commit, blueprintHash: approved.blueprintHash, artifactHashes: transition.artifactHashes,
    executed: true, observedMatch: true, reviewerVerdict: 'PASS' as const,
    reviewerEvidenceIds: [observed.id] }
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], []), 'BLOCKED')
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [{ ...baseEvidence, reviewerVerdict: 'PENDING' }]), 'BLOCKED')
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [{ ...baseEvidence, assertionId: 'A2' }]), 'BLOCKED')
  assert.equal(taskCompletionGate(plan.acceptanceBindings, [transition], [baseEvidence]), 'LOCALLY_VERIFIED')
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [transition], [baseEvidence], new Set()), false)
  assert.equal(customerDeliveryCompletionGate(plan.tasks, plan.acceptanceBindings, [transition], [baseEvidence], new Set(['T1'])), true)
  const definition = workSessionDefinitionFor(plan, 'fixture-command-session')
  const task = { ...createTaskStateV2(definition, definition.tasks[0]!), gitState: await trustedGitState(repo) }
  const dispatcher = createDeliveryRuntimeDispatcher(plan, store, { inspectRepository: async () => { throw new Error('unused') },
    dispatch: async () => { throw new Error('native verifier expected') } })
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
  const review: ReviewEvidence = { passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
    reviewer: { agent: 'reviewer', provider: 'independent', runtimeIdentity: 'reviewer-runtime' },
    implementer: { agent: 'fixture', provider: 'fixture', runtimeIdentity: 'fixture' },
    reviewedFiles: [], timestamp: new Date().toISOString(), assertionVerdicts: [{ assertionId: 'A1',
      verdict: 'PASS', evidence: 'Scoped test observed.', capabilityEvidence: { family: 'command',
        providerId: 'existing-guarded-verifier', providerVersion: '1', collector: 'existing-guarded-verifier',
        evidenceIds: [verified.verificationResults![0]!.rawOutputRef!], verificationResult: 'OBSERVED' } }] }
  const unlinkedReview: ReviewEvidence = { ...review, assertionVerdicts: [{ ...review.assertionVerdicts![0]!,
    capabilityEvidence: { ...review.assertionVerdicts![0]!.capabilityEvidence!, evidenceIds: [] } }] }
  const unlinkedTask = { ...verifiedTask, completion: { ...verifiedTask.completion, review: unlinkedReview } }
  assert.equal(assertionCapabilityEvidenceValid(unlinkedTask, unlinkedReview.assertionVerdicts![0]!), false)
  assert.equal((await dispatcher.deliveryCompletionGate!(unlinkedTask)).status, 'BLOCKED')
  const reviewedTask = { ...verifiedTask, completion: { ...verifiedTask.completion, review } }
  assert.equal((await dispatcher.deliveryCompletionGate!(reviewedTask)).status, 'LOCALLY_VERIFIED')
  await dispatcher.deliveryTaskCompleted!(reviewedTask)
  assert.equal((await store.customerAssessment(plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED',
    'the task is not locally completed until the Runtime checkpoint is durable')
  await dispatcher.deliveryTaskFinalized!(reviewedTask, commit)
  assert.equal((await store.customerAssessment(plan.id)).status, 'CUSTOMER_DELIVERY_COMPLETED')
  await writeFile(join(repo, 'README.md'), 'Later independent task output\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'Later task commit')
  assert.equal((await store.customerAssessment(plan.id)).status, 'CUSTOMER_DELIVERY_COMPLETED',
    'an unchanged verifier lineage remains valid after a later descendant commit')
  await writeFile(join(repo, 'tests/cart.test.js'), 'throw new Error("verifier changed")\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'Change verifier artifact')
  assert.equal((await store.customerAssessment(plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED',
    'artifact drift invalidates earlier task completion')
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
  assert.equal(taskCompletionGate(completion.acceptanceBindings, [], []), 'BLOCKED')
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

test('internal HTTP collector checks body predicate; mutation obligation cannot bind GET', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const impossible = await compileRuntimePlan(snapshot, target, { resolver: provisionableHttp,
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true,
    executorAvailable: true, reviewerAvailable: true })
  assert.equal(impossible.admission.status, 'ADMISSION_BLOCKED')
  assert.ok(impossible.admission.blockers.some((item) => item.code === 'VERIFICATION_UNRESOLVED'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"total":"24"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const observed = await collectHttpEvidence({ assertionId: 'A1', port: address.port, route: '/cart',
      expectedStatus: 200, expectedJsonPointer: '/total', expectedJsonValue: '24' })
    assert.equal(observed.facts.observedMatch, true)
    const wrong = await collectHttpEvidence({ assertionId: 'A1', port: address.port, route: '/cart',
      expectedStatus: 200, expectedJsonPointer: '/total', expectedJsonValue: '25' })
    assert.equal(wrong.facts.observedMatch, false)
    assert.equal(Object.hasOwn(wrong.facts, 'body'), false)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('delivery V2 adapter lets implementation run without executing obligation markers', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(plan, 'fixture-session')
  const task = { ...createTaskStateV2(definition, definition.tasks[0]!), gitState: await trustedGitState(repo) }
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
  await writeFile(join(repo, 'feature.js'), 'export const implemented = true\n')
  const dirtyTask = { ...task, gitState: await trustedGitState(repo) }
  const beforeVerificationCommit = dirtyTask.gitState.headSha
  const missing = await dispatcher.dispatch({ action: 'VERIFY', agent, task: dirtyTask })
  assert.equal(missing.status, 'BLOCKED')
  assert.match(missing.blockers?.[0] ?? '', /OWNED_CHECKPOINT_HANDOFF_REQUIRED/u)
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), beforeVerificationCommit)
  assert.notEqual(await git(repo, 'status', '--porcelain'), '')
  assert.equal(received.length, 1)
})

test('production V2 controller cannot complete an owner task when its exact blueprint is absent', async () => {
  const { root, repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(plan, 'fixture-production-gate')
  const store = new DeliveryStore(join(root, 'delivery'))
  await store.savePlan(plan)
  let fallbackCalls = 0
  const dispatcher = createDeliveryRuntimeDispatcher(plan, store, {
    inspectRepository: () => trustedGitState(repo),
    dispatch: async () => { fallbackCalls++; throw new Error('No fallback may certify this obligation.') },
  })
  const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch,
    agents: [{ id: 'fixture', available: true, quotaExhausted: false, degraded: false,
      capabilities: { coding: true, reasoning: true, verification: true, review: true } }], dispatcher })
  const initial = createTaskStateV2(definition, definition.tasks[0]!)
  const result = await runner.run(definition.tasks[0]!, undefined, undefined, {
    taskStateV2: { ...initial, humanConstraints: { verifyOnly: true } },
  })
  assert.notEqual(result.status, 'COMPLETED')
  assert.equal(fallbackCalls, 0)
  assert.equal((await store.customerAssessment(plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED')
  assert.equal(await git(repo, 'status', '--porcelain'), '')
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
  assert.equal(classifyCapability(input).family, 'command')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'ui' } }).family, 'browser_ui')
  const browserIntegration = { ...input, criterion: { ...criterion, level: 'integration' as const }, assertion: {
    ...assertion, observableBehavior: '编辑任务后重启服务并打开浏览器页面',
    expectedOutcome: '同一任务仍显示修改后的标题',
    expectedEvidence: '重启前后的浏览器结果和同一任务的 SQLite 记录',
  } }
  assert.equal(classifyCapability(browserIntegration).family, 'browser_ui')
  assert.equal(conservativeCapabilityResolver(browserIntegration).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  assert.equal(classifyCapability({ ...browserIntegration,
    criterion: { ...browserIntegration.criterion, level: 'delivery' } }).family, 'browser_ui')
  const pageReload = { ...input, criterion: { ...criterion, level: 'integration' as const }, assertion: {
    ...assertion, observableBehavior: '用户创建并修改任务后刷新页面。',
    expectedOutcome: '同一任务及其最新标题、完成状态仍然存在。',
    expectedEvidence: '刷新前后同一任务的页面结果和重新读取的数据。',
  } }
  assert.equal(classifyCapability(pageReload).family, 'browser_ui')
  assert.equal(conservativeCapabilityResolver(pageReload).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  const browserEvidenceReview = { ...input, criterion: { ...criterion, level: 'delivery' as const }, assertion: {
    ...assertion, observableBehavior: '审查最终验收证据。',
    expectedOutcome: '每项业务结果均有实际浏览器行为证据，测试命令成功不单独构成业务通过。',
    expectedEvidence: '实际操作与结果记录。',
  } }
  assert.equal(classifyCapability(browserEvidenceReview).family, 'browser_ui')
  assert.equal(conservativeCapabilityResolver(browserEvidenceReview).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  for (const [behavior, evidence, family] of [
    ['未登录的用户打开应用并操作任务。', '无登录步骤的浏览器访问及任务操作结果。', 'browser_ui'],
    ['在浏览器中删除一项验收任务。', '删除前后的任务列表与重新读取的结果。', 'browser_ui'],
    ['在没有第三方 API 配置或调用的本地环境操作任务。', '应用配置、操作期间的请求记录及对应任务结果。', 'external_platform'],
    ['不配置云服务，启动并操作应用。', '本地配置、任务操作结果和 SQLite 中的对应记录。', 'external_platform'],
    ['在干净环境安装项目依赖。', '干净环境和依赖安装记录。', 'external_platform'],
  ] as const) {
    const scenario = { ...input, criterion: { ...criterion, level: 'delivery' as const },
      assertion: { ...assertion, observableBehavior: behavior, expectedEvidence: evidence } }
    assert.equal(classifyCapability(scenario).family, family)
    assert.equal(conservativeCapabilityResolver(scenario).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  }
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'platform' } }).family, 'external_platform')
  assert.equal(conservativeCapabilityResolver({ ...input, criterion: { ...criterion, level: 'platform' },
    assertion: { ...assertion, observableBehavior: '开始开发前必须先取得平台 SDK 权限。' } }).startPrerequisite, 'EXECUTION')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'delivery' },
    assertion: { ...assertion, expectedEvidence: '交付文件清单' } }).family, 'filesystem')
  assert.equal(classifyCapability({ ...input, criterion: { ...criterion, level: 'delivery' },
    assertion: { ...assertion, expectedEvidence: '客户人工验收' } }).family, 'human')
  const defaultResolution = resolveCapability(input, conservativeCapabilityResolver)
  assert.equal(defaultResolution.capability, 'UNSUPPORTED')
  assert.equal(defaultResolution.family, 'command')
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
  const runner = new FakeTaskRunner({ T1: { type: 'COMPLETED' } })
  const adapter: DeliveryRuntimeAdapter = {
    configured: async () => true, executorAvailable: async () => true, reviewerAvailable: async () => true,
    createAndStart: async (definition, binding) => {
      assert.equal(binding.sourceSnapshotId, snapshot.id)
      assert.equal(binding.sourcePlanHash, snapshot.planHash.value)
      assert.equal(definition.id, binding.workSessionId)
      definitions.push(definition.id)
      const runtime = new WorkSessionRuntime({ definition: { ...definition, controlPlane: 'v1' },
        taskRunner: runner,
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
  assert.equal(runner.getExecutionCount('T1'), 1)
  assert.ok((await (await import('node:fs/promises')).stat(join(root, 'fixture-runtime.db'))).size > 0)
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

test('a non-settling createAndStart times out, records failure, and cannot create a second session', async () => {
  const { root, repo, snapshot } = await fixture()
  const store = new DeliveryStore(join(root, 'delivery'))
  const events = new DeliveryEventStore(join(root, 'delivery', 'events.jsonl'))
  let calls = 0
  const adapter: DeliveryRuntimeAdapter = { configured: async () => true, executorAvailable: async () => true,
    reviewerAvailable: async () => true, createAndStart: async (_definition, _binding, _plan, context) => {
      calls++
      await context.progress('preflight_started')
      await new Promise<void>(() => undefined)
    } }
  const service = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1', undefined, 30)
  const plan = await service.prepare(snapshot, repo, 'trusted_test')
  await assert.rejects(service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id),
    /DELIVERY_START_TIMEOUT/)
  const digest = createHash('sha256').update('novawing-delivery-session-v1\0')
    .update(`${snapshot.id}\0${plan.runtimePlanHash}\0${plan.targetBinding.id}`).digest('hex')
  const id = `delivery-${digest}-000000000000-${digest.slice(0, 6)}`
  assert.equal((await store.getSession(id))?.status, 'TIMEOUT')
  await assert.rejects(service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id), /TIMEOUT/)
  assert.equal(calls, 1)
  const raw = await readFile(events.path, 'utf8')
  assert.ok(raw.includes('preflight_started'))
  assert.ok(raw.includes('delivery_start_failed'))
  assert.ok(!raw.includes(repo))
})

test('controller start failure is terminal and interrupted STARTING reconciles without relaunch', async () => {
  const { root, repo, snapshot } = await fixture()
  const store = new DeliveryStore(join(root, 'delivery'))
  const events = new DeliveryEventStore(join(root, 'delivery', 'events.jsonl'))
  let calls = 0
  const adapter: DeliveryRuntimeAdapter = { configured: async () => true, executorAvailable: async () => true,
    reviewerAvailable: async () => true, createAndStart: async (_definition, _binding, _plan, context) => {
      calls++
      await context.progress('preflight_started')
      await context.progress('preflight_completed')
      await context.progress('config_created')
      await context.progress('work_session_creation_started')
      await context.progress('work_session_creation_completed')
      await context.progress('controller_start_started')
      throw new Error('controller failed')
    } }
  const service = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1')
  const plan = await service.prepare(snapshot, repo, 'trusted_test')
  await assert.rejects(service.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id),
    /DELIVERY_START_FAILED/)
  const digest = createHash('sha256').update('novawing-delivery-session-v1\0')
    .update(`${snapshot.id}\0${plan.runtimePlanHash}\0${plan.targetBinding.id}`).digest('hex')
  const id = `delivery-${digest}-000000000000-${digest.slice(0, 6)}`
  assert.equal((await store.getSession(id))?.status, 'FAILED')
  assert.equal((await store.getSession(id))?.failure?.stage, 'controller_start')
  assert.equal(calls, 1)

  const second = await fixture()
  const secondStore = new DeliveryStore(join(second.root, 'delivery'))
  const secondEvents = new DeliveryEventStore(join(second.root, 'delivery', 'events.jsonl'))
  const secondService = new DeliveryService(secondStore, secondEvents, adapter, supported, 'fixture-policy-v1')
  const secondPlan = await secondService.prepare(second.snapshot, second.repo, 'trusted_test')
  const secondDigest = createHash('sha256').update('novawing-delivery-session-v1\0')
    .update(`${second.snapshot.id}\0${secondPlan.runtimePlanHash}\0${secondPlan.targetBinding.id}`).digest('hex')
  const secondId = `delivery-${secondDigest}-000000000000-${secondDigest.slice(0, 6)}`
  await secondStore.claimSession({ workSessionId: secondId, sourceSnapshotId: second.snapshot.id,
    sourcePlanHash: second.snapshot.planHash.value, runtimePlanId: secondPlan.id,
    runtimePlanHash: secondPlan.runtimePlanHash, targetBindingId: secondPlan.targetBinding.id,
    targetBaselineCommit: secondPlan.targetBaselineCommit,
    compilerVersion: secondPlan.compilerImplementationVersion, createdAt: new Date().toISOString(), status: 'STARTING' })
  await secondService.reconcileInterruptedStarts()
  assert.equal((await secondStore.getSession(secondId))?.status, 'TIMEOUT')
  await assert.rejects(secondService.startDelivery(second.snapshot, secondPlan.id, secondPlan.runtimePlanHash,
    secondPlan.targetBinding.id), /TIMEOUT/)
  assert.equal(calls, 1)
})

test('production delivery preflight Promise timeout stops before WorkSession creation', async () => {
  const { root, repo, snapshot } = await fixture()
  const store = new DeliveryStore(join(root, 'delivery'))
  const events = new DeliveryEventStore(join(root, 'delivery', 'events.jsonl'))
  const adapter: DeliveryRuntimeAdapter = { configured: async () => true, executorAvailable: async () => true,
    reviewerAvailable: async () => true, createAndStart: async () => undefined }
  const service = new DeliveryService(store, events, adapter, supported, 'fixture-policy-v1')
  const plan = await service.prepare(snapshot, repo, 'trusted_test')
  const observed: string[] = []
  let workSessionsCreated = 0
  const launchpad = new NovaWingLaunchpad([], join(root, 'configs'), {
    deliveryDataRoot: join(root, 'delivery'), deliveryStageTimeoutMs: 30,
    resolveReviewerProvider: async () => 'deepseek',
    preflight: async () => new Promise(() => undefined),
    createWorkSession: async () => { workSessionsCreated++; throw new Error('must not create') },
  })
  const diagnostic = launchpad as unknown as { createDeliveryWorkSession: (definition: ReturnType<typeof workSessionDefinitionFor>,
    binding: WorkSessionPlanBinding, plan: CompiledRuntimePlan,
    context: { signal: AbortSignal; progress: (event: string) => Promise<void> }) => Promise<void> }
  const runtime: DeliveryRuntimeAdapter = { ...adapter,
    createAndStart: (definition, binding, admittedPlan, context) =>
      diagnostic.createDeliveryWorkSession(definition, binding, admittedPlan, {
        ...context, progress: async (event) => { observed.push(event); await context.progress(event as Parameters<typeof context.progress>[0]) },
      }) }
  const runningService = new DeliveryService(store, events, runtime, supported, 'fixture-policy-v1', undefined, 500)
  await assert.rejects(runningService.startDelivery(snapshot, plan.id, plan.runtimePlanHash, plan.targetBinding.id),
    /PREFLIGHT_TIMEOUT/)
  const digest = createHash('sha256').update('novawing-delivery-session-v1\0')
    .update(`${snapshot.id}\0${plan.runtimePlanHash}\0${plan.targetBinding.id}`).digest('hex')
  const id = `delivery-${digest}-000000000000-${digest.slice(0, 6)}`
  assert.equal((await store.getSession(id))?.status, 'TIMEOUT')
  assert.equal((await store.getSession(id))?.failure?.code, 'PREFLIGHT_TIMEOUT')
  assert.ok(observed.includes('config_created'))
  assert.ok(observed.includes('preflight_started'))
  assert.equal(workSessionsCreated, 0)
  await launchpad.close()
})

test('delivery V2 accepts completion-only empty command bindings while ordinary configs still reject them', async () => {
  const { repo } = await fixture()
  const config = { session: { id: `delivery-${'a'.repeat(64)}-000000000000-aaaaaa`, targetRepo: repo,
    branch: 'codex/delivery-fixture', controlPlane: 'v2' as const,
    limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'fixture', guardian: { constraints: [], acceptanceCriteria: ['completion only'],
      doNotDo: [], allowedPaths: [repo], forbiddenPaths: [] },
      acceptanceEvidenceBindings: [{ criterion: 'completion only', requiredEvidence: [] }] }],
    gitCheckpoint: { autoCommit: true, autoPush: false },
    executor: { model: 'fixture', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false } }
  assert.equal((await validateTrustedWorkSessionConfig(config)).tasks[0]?.acceptanceEvidenceBindings?.[0]?.requiredEvidence.length, 0)
  await assert.rejects(validateTrustedWorkSessionConfig({ ...config,
    session: { ...config.session, id: 'ordinary-202609281200-aaaaaa' } }), /evidence binding is empty/)
  await assert.rejects(validateTrustedWorkSessionConfig({ ...config,
    session: { ...config.session, controlPlane: 'v1' } }), /evidence binding is empty/)
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
    const status = await restored.json() as { admission: { status: string };
      customerAssessment: { status: string; gate: string } }
    assert.equal(status.admission.status, 'READY')
    assert.equal(status.customerAssessment.gate, 'CUSTOMER_DELIVERY_COMPLETION_GATE')
    assert.equal(status.customerAssessment.status, 'CUSTOMER_DELIVERY_BLOCKED')
  } finally { await launchpad.close() }
})

test('delivery T1 external-deferred fixture has relative root scope and permits isolated implementation', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: () => ({
    capability: 'REQUIRES_EXTERNAL_ENVIRONMENT', capabilityId: 'fixture-external-v1',
    family: 'browser_ui', reason: 'Completion-only browser observation.' }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(plan, 'scope-fixture-T1')
  const t1 = definition.tasks[0]!
  assert.deepEqual(t1.allowedPaths, ['.'])
  assert.ok(plan.acceptanceBindings.every(binding => binding.stagedVerification.readiness === 'EXTERNAL_DEFERRED'))
  assert.deepEqual(t1.acceptanceEvidenceBindings?.map(binding => binding.requiredEvidence), [[]])
  const { CodexWorkspaceTools } = await import('../packages/development-guardian/codex-workspace-tools.js')
  const workspace = await CodexWorkspaceTools.create(repo, { ...t1, state: 'READY', iteration: 0, maxIterations: 3 })
  try {
    await workspace.call('write_file', { path: 'server/domain.js', content: 'export const orderDomain = { fixture: true }\n' })
    assert.deepEqual(workspace.mutationFailures, [])
    assert.match(await readFile(join(repo, 'server/domain.js'), 'utf8'), /fixture: true/u)
    assert.match(await git(repo, 'status', '--porcelain', '--untracked-files=all'), /server\/domain.js/u)
  } finally { await workspace.revoke() }
})

test('suspended T1 review recovery does not restart EXECUTE, including ALLOW REEXECUTE', async () => {
  const { repo, snapshot } = await fixture()
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const plan = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'REQUIRES_EXTERNAL_ENVIRONMENT',
    capabilityId: 'fixture-external-v1', family: 'browser_ui', reason: 'Completion-only.' }),
    runtimePolicyVersion: 'fixture-policy-v1', runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  const definition = workSessionDefinitionFor(plan, 'existing-work-session')
  const t1 = definition.tasks[0]!
  const initial = createTaskStateV2(definition, t1)
  const implementer = { agent: 'executor', provider: 'codex', runtimeIdentity: 'same-session-executor' }
  const reviewer = { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'independent-reviewer' }
  const suspended = { ...initial, status: 'SUSPENDED' as const, currentAction: 'REVIEW',
    implementer, providerHistory: ['codex'], gitState: await trustedGitState(repo),
    verificationState: { results: [{ name: 'deferred', stepId: 'NOVAWING_DEFERRED:A1:EXTERNAL_DEFERRED', status: 'skipped' as const }] } }
  for (const mode of ['ordinary', 'allow-reexecute', 'reviewer-repair']) {
    const actions: string[] = []
    const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch,
      agents: [implementer, reviewer].map(identity => ({ id: identity.agent, identity,
        available: true, quotaExhausted: false, degraded: false,
        capabilities: { coding: identity.agent === 'executor', reasoning: true, verification: true, review: identity.agent === 'reviewer' } })),
      dispatcher: { inspectRepository: () => trustedGitState(repo), dispatch: async ({ action }) => {
        actions.push(action)
        return { status: 'BLOCKED', providerFailure: { provider: 'deepseek', status: 'DEGRADED', reason: 'independent REVIEW_FAILURE fixture' } }
      } } })
    const result = await runner.run(t1, mode === 'allow-reexecute' ? { decision: 'ALLOW REEXECUTE' } : undefined, undefined,
      { taskStateV2: suspended, ...(mode === 'reviewer-repair' ? { chosenReviewer: reviewer } : {}) })
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(actions.includes('EXECUTE'), false)
    if (mode !== 'ordinary') assert.deepEqual(actions, ['REVIEW'], JSON.stringify({ mode, humanRequired: result.humanRequired }))
    assert.deepEqual(result.taskStateV2?.identity, { sessionId: definition.id, taskId: t1.id })
  }
})
