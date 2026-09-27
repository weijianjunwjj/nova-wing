import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevelopmentPlan, planDraftSchema, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { validateCustomerQuestion, validateDevelopmentPlan } from '../packages/development-guardian/planning/validator.js'
import { PlanningEventStore } from '../packages/development-guardian/planning/telemetry.js'
import { PlanningInputError, PlanningService, PlanningStore } from '../packages/development-guardian/planning/service.js'
import type { PlanningSemanticReviewer } from '../packages/development-guardian/planning/semantic-reviewer.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'

const requirementPath = join(process.cwd(), 'tests/fixtures/requirement-001.txt')
const passReview: PlanningSemanticReviewer = async () => ({ review: { verdict: 'PASS', issues: [] } })

function requirement001Draft(text: string): PlanDraft {
  const specs = [
    ['R1', '首版必须支持无需第三方账号和密钥即可完整本地运行的模拟登录。', '模拟登录可在本地完成', 'functional', 'T2'],
    ['R2', '- 商品分类', '顾客可见商品分类、名称、图片、描述、价格和可售状态', 'functional', 'T1'],
    ['R3', '选择不同 SKU 后价格可以不同。', '商品 SKU 选择决定价格', 'business-rule', 'T1'],
    ['R4', '- 修改数量', '购物车可增减、删除并计算合计', 'functional', 'T3'],
    ['R5', '- 新建地址', '顾客可创建、编辑并选择联系人手机号配送地址', 'functional', 'T2'],
    ['R6', '订单至少包含：', '订单记录商品 SKU 数量价格总额地址联系人状态和时间', 'functional', 'T3'],
    ['R7', '使用 Mock Payment / Payment Adapter。', '模拟支付让未支付订单进入已支付状态且商家可处理', 'functional', 'T4'],
    ['R8', '- 查看订单列表', '顾客可查看订单列表详情和当前状态', 'functional', 'T6'],
    ['R9', '- 创建商品', '商家可管理商品分类 SKU 及上下架', 'functional', 'T1'],
    ['R10', '商家可以看到订单列表和订单详情。', '商家可查看和推进订单状态', 'functional', 'T5'],
    ['R11', '商家自己跑腿配送。', '商家可推进自营配送中及完成', 'business-rule', 'T5'],
    ['R12', '- 今日订单数', '商家可见今日订单数及今日成交金额', 'functional', 'T7'],
    ['R13', '目前只有一个商户，不考虑平台型多商户模式。', '只支持单商户，不扩张多商户范围', 'constraint', 'T8'],
    ['R14', '- fresh database 可以启动', '空数据环境可初始化并启动', 'delivery', 'T8'],
  ] as const
  for (const [, excerpt] of specs) assert.ok(text.includes(excerpt), `missing fixture source: ${excerpt}`)
  const clauses: PlanDraft['clauses'] = specs.map(([id, excerpt, statement, type]) => ({
    id, statement, type, priority: 'must', source: { excerpt, location: 'Requirement 001', origin: 'customer_requirement' }, ambiguity: { ambiguous: false, note: '' },
  }))
  const acceptanceDescriptions = [
    '顾客在空本地环境完成模拟登录后能够进入商品列表，无需外部账号。',
    '顾客看到商品分类、名称、图片、描述、价格和可售状态。',
    '顾客选择不同 SKU 后看到对应价格，并在购物车中保留选中规格。',
    '顾客修改数量或删除商品后，购物车合计金额随之更新。',
    '顾客新建、编辑并选择地址后，订单显示所选联系人、手机号和地址。',
    '创建订单后，重新查询能看到商品、SKU、数量、单价、总额、地址、联系人、状态和创建时间。',
    '顾客对未支付订单执行模拟支付后，订单变为 PAID；商家重新查询能看到待处理订单。',
    '顾客查看订单列表与详情时，能看到商家推进后的最新订单状态。',
    '商家创建、编辑、上下架商品并管理分类与 SKU 后，顾客目录显示对应变化。',
    '商家查看订单详情并接单、开始制作后，订单状态依次显示 ACCEPTED 和 PREPARING。',
    '商家自己配送并完成订单后，商家和顾客都能看到 DELIVERING 和 COMPLETED 状态。',
    '商家看到今日订单数和今日成交金额，统计值与当日已支付订单数据一致。',
    '顾客和商家完成单商户订单流程，界面与数据中不出现多商户分配。',
    '在全新空数据目录启动后，初始化完成且顾客能够登录并完成核心流程。',
  ]
  const criteria: PlanDraft['acceptancePlan']['criteria'] = specs.map(([id], index) => ({
    id: `A${index + 1}`, requirementIds: [id], description: acceptanceDescriptions[index]!,
    level: index === 13 ? 'delivery' : index === 0 || index === 1 || index === 7 || index === 11 ? 'ui' : 'integration',
    expectedEvidence: `Isolated fresh-data scenario for ${id} with observable state before and after`, blocking: true,
    assertions: [{ id: `AS${index + 1}`, requirementId: id,
      observableBehavior: acceptanceDescriptions[index]!, expectedOutcome: acceptanceDescriptions[index]!,
      expectedEvidence: `隔离的新数据环境中记录 ${id} 行为前后状态及业务结果。`, blocking: true }],
  }))
  const taskDefs = [
    ['T1', '商品目录与管理', ['R2', 'R3', 'R9'], []],
    ['T2', '顾客身份与地址', ['R1', 'R5'], []],
    ['T3', '购物车与订单创建', ['R4', 'R6'], ['T1', 'T2']],
    ['T4', '模拟支付', ['R7'], ['T3']],
    ['T5', '商家订单与自营配送', ['R10', 'R11'], ['T4']],
    ['T6', '顾客订单查询', ['R8'], ['T5']],
    ['T7', '商家今日统计', ['R12'], ['T5']],
    ['T8', '单商户边界和空环境交付', ['R13', 'R14'], ['T6', 'T7']],
  ] as const
  const tasks: PlanDraft['tasks'] = taskDefs.map(([id, title, requirementIds, dependencyIds]) => ({
    id, title, objective: `完成${title}并展示可观察的业务结果`, requirementIds: [...requirementIds],
    outputs: [`${title}功能和可检查状态`], dependencyIds: [...dependencyIds],
    acceptanceCriterionIds: requirementIds.map((reqId) => `A${specs.findIndex(([id]) => id === reqId) + 1}`), complexity: 'medium',
  }))
  return {
    clauses,
    analysis: {
      productGoal: '完成单商户餐饮点餐与自营配送闭环',
      summary: '顾客从登录、选购到支付和状态查看；商家管理商品、订单、配送和当日统计。',
      userRoles: [
        { id: 'U1', name: '顾客', goals: ['完成点餐、模拟支付和订单追踪'] },
        { id: 'U2', name: '商家', goals: ['维护商品、处理订单并自营配送'] },
      ],
      businessFlows: [{ id: 'F1', title: '点餐交付闭环', steps: ['顾客模拟登录并选 SKU 加入购物车', '选择地址下单并模拟支付', '商家接单制作和配送', '顾客看到完成状态'], requirementIds: ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R10', 'R11', 'R8'] }],
    },
    productScope: {
      inScope: ['单商户顾客端', '商家 Web 管理后台', '模拟支付', '自营配送与今日统计'],
      outOfScope: ['多商户平台', '独立骑手 App', '地图路线规划', '优惠券、积分与会员等级', '真实微信登录与支付', '云端生产部署', '复杂 BI'],
    },
    architecture: { summary: '单商户业务服务持久化订单与状态，顾客端及商家后台共享业务状态。', components: ['顾客端', '商家后台', '订单与商品服务', '持久化存储', 'Mock Payment Adapter'], decisions: ['支付能力通过适配边界替换；本阶段不接真实支付。'] },
    tasks,
    acceptancePlan: { strategy: '隔离新数据环境逐段核验完整业务闭环，并以重新查询验证状态持久化。', criteria },
    risks: [{ id: 'K1', description: '状态更新可能在两端不一致', mitigation: '以持久化状态和两端重新查询作为验收依据' }],
    assumptions: [{ id: 'S1', statement: '首版为单商户本地验证', impactIfFalse: '多商户或云部署将改变范围' }],
    customerQuestions: [],
  }
}

test('Requirement 001 planning benchmark produces a valid, scoped, traceable plan', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  const store = new PlanningStore(join(directory, 'plans'))
  const service = new PlanningService(async ({ requirement }) => {
    assert.equal(requirement, text)
    return { text: JSON.stringify(draft), provider: 'fixture', model: 'requirement-001', inputTokens: 100, outputTokens: 200 }
  }, store, events, passReview)
  const { plan, validation } = await service.generate(text)
  assert.equal(validation.pass, true, JSON.stringify(validation.issues))
  assert.equal(validation.mustTaskCoverage, 100)
  assert.equal(validation.mustAcceptanceCoverage, 100)
  assert.equal(plan.status, 'ready_for_approval')
  assert.equal(plan.clauses.length, 14)
  assert.ok(plan.productScope.outOfScope.includes('多商户平台'))
  assert.equal(plan.customerQuestions.length, 0)
  assert.equal((await service.list()).length, 1)
  assert.equal((await service.approve(plan.id, 1)).status, 'approved')
  const eventText = await readFile(events.path, 'utf8')
  for (const kind of ['requirement.received', 'planning.started', 'requirement.analyzed', 'development_plan.generated', 'plan.validation_passed', 'plan.approved']) assert.ok(eventText.includes(kind))
  assert.ok(!eventText.includes('模拟登录'))
  assert.ok(!eventText.includes('使用 Mock Payment'))
  assert.ok(!eventText.includes('API_KEY'))
})

test('legacy Requirement 001 model sample cannot claim assertion-level approval', async () => {
  const output = await readFile(join(process.cwd(), 'tests/fixtures/requirement-001-model-output.json'), 'utf8')
  const raw = JSON.parse(output) as { clauses: unknown[]; tasks: unknown[]; acceptancePlan: { criteria: unknown[] } }
  assert.deepEqual([raw.clauses.length, raw.tasks.length, raw.acceptancePlan.criteria.length], [22, 8, 22])
  assert.equal(planDraftSchema.safeParse(raw).success, false)
})

test('planning retries a model draft that fails deterministic validation before approval readiness', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-retry-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  let calls = 0
  const service = new PlanningService(async ({ validationFeedback }) => {
    calls += 1
    const draft = requirement001Draft(text)
    if (calls === 1) draft.acceptancePlan.criteria[0]!.description = 'npm run build passes'
    else assert.ok(validationFeedback?.includes('NOT_OBSERVABLE'))
    return { text: JSON.stringify(draft) }
  }, new PlanningStore(join(directory, 'plans')), events, passReview)
  const result = await service.generate(text)
  assert.equal(calls, 2)
  assert.equal(result.validation.pass, true)
  assert.equal(result.plan.status, 'ready_for_approval')
  const raw = await readFile(events.path, 'utf8')
  assert.ok(raw.includes('plan.validation_failed'))
  assert.ok(raw.includes('plan.validation_passed'))
})

test('validator rejects uncovered requirements, invalid graph, orphan acceptance, technical questions, and command-only acceptance', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  draft.tasks[0]!.requirementIds = draft.tasks[0]!.requirementIds.filter((id) => id !== 'R2')
  draft.tasks[1]!.dependencyIds.push('T8', 'missing')
  draft.tasks[2]!.acceptanceCriterionIds = ['A4']
  draft.acceptancePlan.criteria[0]!.description = 'npm run build passes'
  draft.customerQuestions.push({ id: 'Q1', question: 'Vue 还是 React？', reason: '技术选择', decisionType: 'scope', options: ['Vue', 'React'], blocking: true })
  const plan = createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan')
  const validation = validateDevelopmentPlan(plan)
  assert.equal(validation.pass, false)
  for (const code of ['MUST_TASK_UNCOVERED', 'DANGLING_DEPENDENCY', 'TASK_CYCLE', 'ORPHAN_ACCEPTANCE', 'NOT_OBSERVABLE', 'TECHNICAL_CUSTOMER_QUESTION']) {
    assert.ok(validation.issues.some((issue) => issue.code === code), code)
  }
  assert.ok(validateCustomerQuestion({ id: 'Q2', question: '已经制作的订单允许取消吗？', reason: '决定订单状态规则', decisionType: 'business_rule', options: ['允许', '不允许'], blocking: true }).length === 0)
  for (const question of ['Vue 还是 React？', 'SQLite 还是 PostgreSQL？', 'REST 还是 GraphQL？', 'Codex 还是 Claude？', '使用什么 Reviewer？', 'verification command 怎么写？']) {
    assert.ok(validateCustomerQuestion({ id: 'Q3', question, reason: '技术选型', decisionType: 'scope', options: ['A', 'B'], blocking: true }).some((issue) => issue.code === 'TECHNICAL_CUSTOMER_QUESTION'), question)
  }
  const clean = requirement001Draft(text)
  clean.tasks[0]!.objective = 'Assign Codex Executor to implement catalog.'
  const wired = validateDevelopmentPlan(createDevelopmentPlan(clean, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(wired.issues.some((issue) => issue.code === 'RUNTIME_WIRING'))
  const optionalOnly = requirement001Draft(text)
  for (const clause of optionalOnly.clauses) clause.priority = 'should'
  assert.ok(validateDevelopmentPlan(createDevelopmentPlan(optionalOnly, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan')).issues.some((issue) => issue.code === 'NO_MUST_REQUIREMENT'))
})

test('Customer Mode HTTP flow generates, revises and approves without starting a Work Session', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-customer-http-'))
  let modelCalls = 0
  let runtimeCalls = 0
  const service = new PlanningService(async () => {
    modelCalls += 1
    return { text: JSON.stringify(requirement001Draft(text)) }
  }, new PlanningStore(join(directory, 'plans')), new PlanningEventStore(join(directory, 'events.jsonl')), passReview)
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: join(directory, 'configs'),
    dependencies: {
      planningService: service,
      createWorkSession: async () => { runtimeCalls += 1; throw new Error('Customer Mode must not start runtime') },
    },
  })
  try {
    const address = await launchpad.start()
    const home = await (await fetch(address.url)).text()
    assert.ok(home.includes('你想做什么？'))
    const customer = await (await fetch(`${address.url}/customer`)).text()
    assert.ok(customer.includes('生成开发方案'))
    assert.ok((await (await fetch(`${address.url}/advanced`)).text()).includes('新建 Work Session'))
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${address.url}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: address.url, ...headers }, body: JSON.stringify(body),
    })
    assert.equal((await post('/api/planning/generate', { requirement: text })).status, 403)
    const tokenHeader = { 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest() }
    const created = await post('/api/planning/generate', { requirement: text }, tokenHeader)
    assert.equal(created.status, 200)
    const first = await created.json() as { plan: { id: string; version: number; status: string }; validation: { pass: boolean } }
    assert.equal(first.validation.pass, true)
    assert.equal(first.plan.status, 'ready_for_approval')
  const revised = await post('/api/planning/generate', { requirement: text, planId: first.plan.id, feedback: '请确认验收路径完整。' }, tokenHeader)
    assert.equal(revised.status, 200)
    const second = await revised.json() as { plan: { id: string; version: number; status: string } }
    assert.equal(second.plan.version, 2)
    assert.deepEqual((await service.get(first.plan.id))?.requirement.revisionNotes, ['请确认验收路径完整。'])
    assert.equal((await post('/api/planning/approve', { planId: first.plan.id, version: 1 }, tokenHeader)).status, 409)
    const approved = await post('/api/planning/approve', { planId: first.plan.id, version: 2 }, tokenHeader)
    assert.equal(approved.status, 200)
    assert.equal(((await approved.json()) as { status: string }).status, 'approved')
    assert.equal((await post('/api/planning/generate', { requirement: text, planId: first.plan.id, feedback: '再改一次' }, tokenHeader)).status, 400)
    assert.equal(((await (await fetch(`${address.url}/api/planning/plans`)).json()) as unknown[]).length, 1)
    assert.equal(modelCalls, 2)
    assert.equal(runtimeCalls, 0)
  } finally { await launchpad.close() }
})

test('telemetry persists only closed numeric metadata and safe model identifiers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-telemetry-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  await events.append({
    planningSessionId: '00000000-0000-0000-0000-000000000000', type: 'development_plan.generated', actorRole: 'planning',
    provider: 'secret=API_KEY_123', model: 'model\naccess_token=ABC', durationMs: 25,
    usage: { inputTokens: 120, outputTokens: 80, cachedTokens: 20 }, estimatedCost: 0.02,
    metadata: { planVersion: 1, clauseCount: 3, taskCount: 2, issueCount: 0, questionCount: 0 },
  })
  const raw = await readFile(events.path, 'utf8')
  const event = JSON.parse(raw) as Record<string, unknown>
  assert.equal(event.provider, undefined)
  assert.equal(event.model, undefined)
  assert.deepEqual(event.usage, { inputTokens: 120, outputTokens: 80, cachedTokens: 20 })
  assert.equal(event.estimatedCost, 0.02)
  assert.ok(!raw.includes('API_KEY_123'))
  assert.ok(!raw.includes('access_token'))
  await events.append({
    planningSessionId: '00000000-0000-0000-0000-000000000000', type: 'development_plan.generated', actorRole: 'planning',
    provider: 'codex', model: 'gpt-5.6-terra', metadata: { planVersion: 2 },
  })
  const valid = JSON.parse((await readFile(events.path, 'utf8')).trim().split('\n')[1]!) as Record<string, unknown>
  assert.equal(valid.provider, 'codex')
  assert.equal(valid.model, 'gpt-5.6-terra')
})

test('approval cannot race an in-flight revision of the same planning session', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-race-'))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  let calls = 0
  const service = new PlanningService(async () => {
    calls += 1
    if (calls === 2) { entered(); await gate }
    return { text: JSON.stringify(requirement001Draft(text)) }
  }, new PlanningStore(join(directory, 'plans')), new PlanningEventStore(join(directory, 'events.jsonl')), passReview)
  const first = await service.generate(text)
  const revising = service.generate(text, { planId: first.plan.id, feedback: '确认业务范围。' })
  await started
  await assert.rejects(service.approve(first.plan.id, 1), PlanningInputError)
  release()
  assert.equal((await revising).plan.version, 2)
})

test('a genuine blocking business question requires customer input before approval', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-question-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  const service = new PlanningService(async () => {
    const draft = requirement001Draft(text)
    draft.customerQuestions.push({
      id: 'Q1', question: '已经开始制作的订单允许取消吗？', reason: '决定订单取消业务规则',
      decisionType: 'business_rule', options: ['允许并记录原因', '不允许'], blocking: true,
    })
    return { text: JSON.stringify(draft) }
  }, new PlanningStore(join(directory, 'plans')), events, passReview)
  const { plan, validation } = await service.generate(text)
  assert.equal(validation.pass, true)
  assert.equal(plan.status, 'needs_customer_input')
  await assert.rejects(service.approve(plan.id, 1), PlanningInputError)
  assert.ok((await readFile(events.path, 'utf8')).includes('customer_question.required'))
})

test('one criterion citing multiple MUST clauses needs a separate assertion for each', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  draft.acceptancePlan.criteria[0]!.requirementIds.push('R2')
  const result = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.equal(result.pass, false)
  assert.ok(result.issues.some((issue) => issue.code === 'CRITERION_REQUIREMENT_WITHOUT_ASSERTION'))
})

test('explicit source bullet items cannot hide behind one blocking assertion', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  const cart = draft.clauses.find((clause) => clause.statement.includes('购物车'))!
  cart.source.excerpt = '- 加入商品\n- 修改数量\n- 删除商品\n- 查看合计金额'
  const result = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(result.issues.some((issue) => issue.code === 'EXPLICIT_SOURCE_ATOMS_UNCOVERED'))
})

test('business assertion cannot be only a successful build command', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  const assertion = draft.acceptancePlan.criteria[0]!.assertions[0]!
  assertion.observableBehavior = 'npm run build succeeds'
  assertion.expectedOutcome = 'npm run build succeeds'
  assertion.expectedEvidence = 'npm run build command exit code zero'
  const result = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.equal(result.pass, false)
  assert.ok(result.issues.some((issue) => issue.code === 'COMMAND_ONLY_ASSERTION' || issue.code === 'WEAK_ASSERTION'))
})

test('duplicate, orphan and dangling assertion references fail before approval', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  draft.acceptancePlan.criteria[1]!.assertions[0]!.id = draft.acceptancePlan.criteria[0]!.assertions[0]!.id
  draft.acceptancePlan.criteria[2]!.assertions[0]!.requirementId = 'MISSING'
  draft.tasks[3]!.acceptanceCriterionIds = ['A1']
  const result = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  for (const code of ['DUPLICATE_ASSERTION_ID', 'DANGLING_ASSERTION_REQUIREMENT', 'ORPHAN_ASSERTION']) {
    assert.ok(result.issues.some((issue) => issue.code === code), code)
  }
})

test('MUST clause cannot promote an unsupported or derived statement into customer provenance', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const draft = requirement001Draft(text)
  draft.clauses[0]!.source.origin = 'derived_assumption'
  const result = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(result.issues.some((issue) => issue.code === 'UNSUPPORTED_MUST_PROVENANCE'))
  draft.clauses[0]!.source.origin = 'customer_requirement'
  draft.clauses[0]!.source.excerpt = '客户从未说过的库存能力'
  const result2 = validateDevelopmentPlan(createDevelopmentPlan(draft, { id: 'req', text, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(result2.issues.some((issue) => issue.code === 'UNTRACEABLE_CLAUSE'))
})

test('unrequested cancellation question is rejected but an explicitly requested ambiguous cancellation may be asked', async () => {
  const original = await readFile(requirementPath, 'utf8')
  const question = { id: 'Q1', question: '顾客可以在哪些阶段取消订单？', reason: '决定取消业务规则',
    decisionType: 'business_rule' as const, options: ['支付前', '开始制作前'], blocking: true }
  const withoutCancellation = original.replace('`CANCELLED`', '`ARCHIVED`')
  const draft = requirement001Draft(withoutCancellation)
  draft.customerQuestions.push(question)
  const rejected = validateDevelopmentPlan(createDevelopmentPlan(draft,
    { id: 'req', text: withoutCancellation, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(rejected.issues.some((issue) => issue.code === 'UNREQUESTED_CUSTOMER_QUESTION'))
  const requested = validateDevelopmentPlan(createDevelopmentPlan(draft,
    { id: 'req', text: original, receivedAt: new Date().toISOString() }, 'plan'))
  assert.ok(!requested.issues.some((issue) => issue.code === 'UNREQUESTED_CUSTOMER_QUESTION'))
})

test('silent paid-only daily count flagged by semantic review cannot reach approval after bounded repair', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-business-rule-'))
  let generated = 0
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  const service = new PlanningService(async () => {
    generated += 1
    const draft = requirement001Draft(text)
    draft.assumptions.push({ id: 'S2', statement: '今日订单数只统计已支付订单。', impactIfFalse: '数量会改变。' })
    return { text: JSON.stringify(draft) }
  }, new PlanningStore(join(directory, 'plans')), events, async () => ({ review: {
    verdict: 'REVISION_REQUIRED', issues: [{ code: 'UNSUPPORTED_BUSINESS_ASSUMPTION', path: 'assumptions.S2',
      message: 'Customer did not choose paid-only order count.', sourceExcerpt: '今日订单数' }],
  } }))
  const { plan, validation } = await service.generate(text)
  assert.equal(validation.pass, true)
  assert.equal(generated, 3)
  assert.equal(plan.status, 'planning_failed')
  assert.equal(plan.semanticReview?.issues[0]?.code, 'UNSUPPORTED_BUSINESS_ASSUMPTION')
  await assert.rejects(service.approve(plan.id, plan.version), PlanningInputError)
  const raw = await readFile(events.path, 'utf8')
  assert.equal(raw.match(/planning\.repair\.started/gu)?.length, 2)
  assert.ok(!raw.includes('今日订单数只统计已支付订单'))
})

test('semantic repair feedback can produce a plan ready for approval on the second generation', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-semantic-repair-'))
  let generated = 0
  let reviewed = 0
  const service = new PlanningService(async ({ validationFeedback, priorDraft }) => {
    generated += 1
    if (generated === 2) {
      assert.ok(validationFeedback?.includes('WEAK_ACCEPTANCE'))
      assert.ok(priorDraft?.includes('"AS1"'))
    }
    return { text: JSON.stringify(requirement001Draft(text)) }
  }, new PlanningStore(join(directory, 'plans')), new PlanningEventStore(join(directory, 'events.jsonl')), async () => {
    reviewed += 1
    return reviewed === 1 ? { review: { verdict: 'REVISION_REQUIRED', issues: [{ code: 'WEAK_ACCEPTANCE',
      path: 'acceptancePlan.criteria.A1', message: 'Strengthen the business outcome.', sourceExcerpt: '' }] } }
      : { review: { verdict: 'PASS', issues: [] } }
  })
  const result = await service.generate(text)
  assert.equal(generated, 2)
  assert.equal(reviewed, 2)
  assert.equal(result.validation.pass, true)
  assert.equal(result.plan.semanticReview?.verdict, 'PASS')
  assert.equal(result.plan.status, 'ready_for_approval')
})

test('semantic reviewer can block a vague task despite complete assertion IDs', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-vague-task-'))
  const service = new PlanningService(async () => ({ text: JSON.stringify(requirement001Draft(text)) }),
    new PlanningStore(join(directory, 'plans')), new PlanningEventStore(join(directory, 'events.jsonl')),
    async () => ({ review: { verdict: 'REVISION_REQUIRED', issues: [{ code: 'TASK_TOO_VAGUE', path: 'tasks.T1',
      message: 'Task objective does not guide implementation.', sourceExcerpt: '' }] } }))
  const result = await service.generate(text)
  assert.equal(result.validation.mustAcceptanceCoverage, 100)
  assert.equal(result.plan.status, 'planning_failed')
  assert.equal(result.plan.semanticReview?.issues[0]?.code, 'TASK_TOO_VAGUE')
})

test('pre-hardening persisted ready plans are no longer shown as approvable', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-old-ready-'))
  const store = new PlanningStore(join(directory, 'plans'))
  const plan = createDevelopmentPlan(requirement001Draft(text),
    { id: 'req', text, receivedAt: new Date().toISOString() }, '00000000-0000-0000-0000-000000000001')
  plan.status = 'ready_for_approval'
  await store.save(plan)
  assert.equal((await store.get(plan.id))?.status, 'planning_failed')
  const service = new PlanningService(async () => ({ text: '{}' }), store,
    new PlanningEventStore(join(directory, 'events.jsonl')), passReview)
  await assert.rejects(service.approve(plan.id, 1), PlanningInputError)
})

test('contradictory or unavailable semantic verdict fails closed without leaking requirement into telemetry', async () => {
  const text = await readFile(requirementPath, 'utf8')
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-review-failure-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  const service = new PlanningService(async () => ({ text: JSON.stringify(requirement001Draft(text)),
    provider: 'codex', model: 'gpt-5.6-terra' }),
  new PlanningStore(join(directory, 'plans')), events,
  async () => ({ review: { verdict: 'PASS', issues: [{ code: 'WEAK_ACCEPTANCE', path: 'acceptancePlan.criteria.A1',
    message: 'A business outcome is missing.', sourceExcerpt: '' }] } }))
  const { plan, validation } = await service.generate(text)
  assert.equal(validation.pass, true)
  assert.equal(plan.status, 'planning_failed')
  assert.equal(plan.semanticReview?.issues[0]?.code, 'REVIEW_UNAVAILABLE')
  const raw = await readFile(events.path, 'utf8')
  const entries = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.ok(entries.some((entry) => entry.type === 'planning.semantic_review.failed'))
  assert.equal(entries.find((entry) => entry.type === 'development_plan.generated')?.usage, undefined)
  assert.ok(!raw.includes(text))
  assert.ok(!raw.includes('Mock Payment'))
})
