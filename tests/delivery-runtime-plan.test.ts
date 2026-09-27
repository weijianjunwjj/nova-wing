import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDevelopmentPlan, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { canonicalPlanContent, createPlanSnapshot, planContentHash, type PlanSnapshot } from '../packages/development-guardian/planning/freeze.js'
import { DeliveryEventStore, DeliveryService, DeliveryStore, type DeliveryRuntimeAdapter } from '../packages/development-guardian/delivery/service.js'
import { bindDeliveryTarget, compileRuntimePlan, conservativeCapabilityResolver, verifyRuntimePlanCoverage, workSessionDefinitionFor,
  type CompiledRuntimePlan, type VerificationCapabilityResolver } from '../packages/development-guardian/delivery/runtime-plan.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { FakeTaskRunner } from '../packages/development-guardian/work-session/fake-task-runner.js'
import { NovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import type { PlanningService } from '../packages/development-guardian/planning/service.js'

const exec = promisify(execFile)
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
  verificationCommand: 'npm test', reason: '隔离 fixture 收集行为前后业务状态。' })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nw-delivery-'))
  const repo = join(root, 'repo')
  await (await import('node:fs/promises')).mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node verify.js' } }))
  await writeFile(join(repo, 'verify.js'), "if (2 + 2 !== 4) throw new Error('fixture')\n")
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'fixture baseline')
  return { root, repo, snapshot: snapshotFixture() }
}

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

test('admission blocks unsupported evidence, dirty target and baseline drift', async () => {
  const { repo, snapshot } = await fixture()
  const criterion = snapshot.content.acceptancePlan.criteria[0]!
  const assertion = criterion.assertions[0]!
  const requirement = snapshot.content.clauses[0]!
  assert.equal(conservativeCapabilityResolver({ criterion: { ...criterion, level: 'ui' }, assertion, requirement }).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  assert.equal(conservativeCapabilityResolver({ criterion: { ...criterion, level: 'platform' }, assertion, requirement }).capability, 'REQUIRES_EXTERNAL_ENVIRONMENT')
  const target = await bindDeliveryTarget(snapshot, repo, 'trusted_test')
  const unsupported = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(unsupported.admission.status, 'ADMISSION_BLOCKED')
  assert.ok(unsupported.admission.blockers.some((blocker) => blocker.code === 'VERIFICATION_CAPABILITY_GAP'))
  const human = await compileRuntimePlan(snapshot, target, { resolver: () => ({ capability: 'REQUIRES_HUMAN',
    capabilityId: 'human-acceptance-v1', reason: '需要客户现场验收。' }), runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.equal(human.admission.status, 'ADMISSION_BLOCKED')
  await writeFile(join(repo, 'untracked.txt'), 'dirty')
  const dirty = await compileRuntimePlan(snapshot, target, { resolver: supported, runtimePolicyVersion: 'fixture-policy-v1',
    runtimeConfigured: true, executorAvailable: true, reviewerAvailable: true })
  assert.ok(dirty.admission.blockers.some((blocker) => blocker.code === 'TARGET_DRIFT'))
  assert.ok(dirty.admission.blockers.some((blocker) => blocker.code === 'TARGET_DIRTY'))
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
