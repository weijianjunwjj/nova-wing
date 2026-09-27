import { buildCoverage, planDraftSchema, type DevelopmentPlan, type PlanDraft } from './model.js'

export interface PlanIssue { code: string; path: string; message: string }
export interface PlanValidation { pass: boolean; issues: PlanIssue[]; mustTaskCoverage: number; mustAcceptanceCoverage: number }

const TECHNICAL_QUESTION = /\b(?:React|Vue|Angular|Svelte|SQLite|PostgreSQL|MySQL|MongoDB|REST|GraphQL|Codex|Claude|GPT|DeepSeek|reviewer|executor|agent|model|framework|database|db|shell|command|verification|test runner|Docker|Kubernetes)\b|技术栈|技术方案|数据库|模型|评审器|执行器|验证命令|测试命令|框架|前端框架|后端框架|前端技术|后端技术|接口协议|编程语言|用什么语言|什么语言开发|用什么开发|部署方式/iu
const RUNTIME_WIRING = /\b(?:Codex|Claude|DeepSeek|Reviewer|Executor|Agent|shell|npm\s+run|npx|pnpm|yarn|pytest|tsc)\b|评审器|执行器|验证命令|测试命令|模型分配|模型选择/iu
const COMMAND_ONLY = /^(?:npm|npx|pnpm|yarn|node|python|pytest|go|cargo|make|git|tsc|bash)\s+[^。.!?]+(?:\s+(?:passes?|成功|通过))?[。.!?]?$/iu
const COMMAND_SUCCESS = /\b(?:npm|npx|pnpm|yarn|node|python|pytest|go|cargo|make|git|tsc|bash)\s+[^。；;.!?]*(?:pass(?:es|ed)?|succeed(?:s|ed)?|成功|通过)|(?:build|typecheck|check|tests?)\s*(?:pass(?:es|ed)?|succeed(?:s|ed)?|成功|通过)/iu
const GENERIC_ASSERTION = /^(?:满足|实现|覆盖|验证|检查|确认)?(?:该|此|相关|全部|所有)?(?:需求|功能|业务|流程|行为|结果)(?:已)?(?:通过|正确|正常|成功|完成|可用|符合要求)[。.!]?$/iu
const OBSERVABLE = /(?:能够|可以|可(?:选择|访问|新增|创建|编辑|查看|执行|重复|通过|由|从|见|填写|确认|提交|打开|加入|下单|支付|修改|删除|接单|制作|配送|查询)|显示|看到|展示|返回|保存|持久|状态|收到|创建|更新|拒绝|阻止|成功|失败|完成|等于|一致|包含|记录|生成|可见|可查询|不存在|数值|覆盖|提供|进入|切换|appears?|returns?|persists?|rejects?|shows?|contains?|matches?|is visible|can )/iu

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) { if (seen.has(value)) repeated.add(value); seen.add(value) }
  return [...repeated]
}

export function validateCustomerQuestion(question: PlanDraft['customerQuestions'][number]): PlanIssue[] {
  const issues: PlanIssue[] = []
  if (TECHNICAL_QUESTION.test(`${question.question} ${question.options.join(' ')}`)) {
    issues.push({ code: 'TECHNICAL_CUSTOMER_QUESTION', path: `customerQuestions.${question.id}`, message: 'Customer decisions must concern business meaning, scope, or product behavior.' })
  }
  if (!question.question.includes('?') && !question.question.includes('？')) {
    issues.push({ code: 'QUESTION_NOT_INTERROGATIVE', path: `customerQuestions.${question.id}`, message: 'Customer question must be a question.' })
  }
  return issues
}

export function validateDevelopmentPlan(plan: DevelopmentPlan): PlanValidation {
  const issues: PlanIssue[] = []
  const add = (code: string, path: string, message: string): void => { issues.push({ code, path, message }) }
  if (plan === null || typeof plan !== 'object' || typeof plan.id !== 'string' || !plan.id.trim() ||
    !Number.isSafeInteger(plan.version) || plan.version < 1 ||
    plan.requirement === null || typeof plan.requirement !== 'object' ||
    typeof plan.requirement.id !== 'string' || !plan.requirement.id.trim() ||
    typeof plan.requirement.text !== 'string' || !plan.requirement.text.trim() ||
    !Array.isArray(plan.coverage) || !Array.isArray(plan.dependencies)) {
    add('INVALID_PLAN_IDENTITY', 'requirement', 'Plan, version, coverage and original requirement must be present.')
    return { pass: false, issues, mustTaskCoverage: 0, mustAcceptanceCoverage: 0 }
  }
  const parsed = planDraftSchema.safeParse({
    clauses: plan.clauses, analysis: plan.analysis, productScope: plan.productScope,
    architecture: plan.architecture, tasks: plan.tasks, acceptancePlan: plan.acceptancePlan,
    risks: plan.risks, assumptions: plan.assumptions, customerQuestions: plan.customerQuestions,
  })
  if (!parsed.success) {
    for (const error of parsed.error.issues) add('INVALID_STRUCTURE', error.path.join('.'), error.message)
    return { pass: false, issues, mustTaskCoverage: 0, mustAcceptanceCoverage: 0 }
  }
  const draft = parsed.data
  const clauseIds = new Set(draft.clauses.map((clause) => clause.id))
  const taskIds = new Set(draft.tasks.map((task) => task.id))
  const criterionIds = new Set(draft.acceptancePlan.criteria.map((criterion) => criterion.id))
  for (const [path, ids] of [['clauses', draft.clauses.map((item) => item.id)], ['tasks', draft.tasks.map((item) => item.id)], ['criteria', draft.acceptancePlan.criteria.map((item) => item.id)]] as const) {
    for (const repeated of duplicates(ids)) add('DUPLICATE_ID', path, `Duplicate id: ${repeated}`)
  }
  for (const clause of draft.clauses) {
    const sources = clause.source.origin === 'customer_requirement' ? [plan.requirement.text]
      : clause.source.origin === 'customer_revision' ? (plan.requirement.revisionNotes ?? []) : []
    if (clause.source.origin === 'derived_assumption' && clause.priority === 'must') {
      add('UNSUPPORTED_MUST_PROVENANCE', `clauses.${clause.id}`, 'A derived assumption cannot become a MUST customer requirement.')
    }
    if (clause.source.origin !== 'derived_assumption' && !sources.some((source) => source.includes(clause.source.excerpt))) {
      add('UNTRACEABLE_CLAUSE', `clauses.${clause.id}`, 'Source excerpt must occur verbatim in the original requirement or customer revision.')
    }
  }
  for (const flow of draft.analysis.businessFlows) {
    for (const reference of flow.requirementIds) if (!clauseIds.has(reference)) add('INVALID_REQUIREMENT_REFERENCE', `businessFlows.${flow.id}`, reference)
  }
  for (const task of draft.tasks) {
    for (const reference of task.requirementIds) if (!clauseIds.has(reference)) add('INVALID_REQUIREMENT_REFERENCE', `tasks.${task.id}`, reference)
    for (const reference of task.acceptanceCriterionIds) if (!criterionIds.has(reference)) add('INVALID_ACCEPTANCE_REFERENCE', `tasks.${task.id}`, reference)
    for (const dependency of task.dependencyIds) if (!taskIds.has(dependency)) add('DANGLING_DEPENDENCY', `tasks.${task.id}`, dependency)
    if (task.dependencyIds.includes(task.id)) add('TASK_CYCLE', `tasks.${task.id}`, 'Task depends on itself.')
  }
  const allAssertions = draft.acceptancePlan.criteria.flatMap((criterion) => criterion.assertions)
  for (const repeated of duplicates(allAssertions.map((assertion) => assertion.id))) add('DUPLICATE_ASSERTION_ID', 'acceptancePlan.criteria', repeated)
  for (const criterion of draft.acceptancePlan.criteria) {
    for (const reference of criterion.requirementIds) if (!clauseIds.has(reference)) add('INVALID_REQUIREMENT_REFERENCE', `criteria.${criterion.id}`, reference)
    if (!draft.tasks.some((task) => task.acceptanceCriterionIds.includes(criterion.id))) add('ORPHAN_ACCEPTANCE', `criteria.${criterion.id}`, 'No task owns this criterion.')
    if (criterion.blocking && (criterion.description.length < 12 || COMMAND_ONLY.test(criterion.description) || !OBSERVABLE.test(criterion.description))) {
      add('NOT_OBSERVABLE', `criteria.${criterion.id}`, 'Blocking acceptance must state an observable outcome, not just a command.')
    }
    for (const requirementId of criterion.requirementIds) {
      if (!criterion.assertions.some((assertion) => assertion.requirementId === requirementId)) {
        add('CRITERION_REQUIREMENT_WITHOUT_ASSERTION', `criteria.${criterion.id}`, requirementId)
      }
    }
    for (const assertion of criterion.assertions) {
      const path = `criteria.${criterion.id}.assertions.${assertion.id}`
      if (!clauseIds.has(assertion.requirementId) || !criterion.requirementIds.includes(assertion.requirementId)) {
        add('DANGLING_ASSERTION_REQUIREMENT', path, assertion.requirementId)
      }
      if (!draft.tasks.some((task) => task.acceptanceCriterionIds.includes(criterion.id) && task.requirementIds.includes(assertion.requirementId))) {
        add('ORPHAN_ASSERTION', path, 'No owning task maps this assertion and its requirement.')
      }
      const clause = draft.clauses.find((item) => item.id === assertion.requirementId)
      const business = clause !== undefined && (clause.type === 'functional' || clause.type === 'business-rule' || clause.type === 'quality')
      if (assertion.observableBehavior.length < 4 || assertion.expectedOutcome.length < 4 || assertion.expectedEvidence.length < 8 ||
        GENERIC_ASSERTION.test(assertion.observableBehavior) || GENERIC_ASSERTION.test(assertion.expectedOutcome) ||
        !OBSERVABLE.test(`${assertion.observableBehavior} ${assertion.expectedOutcome}`) ||
        (business && COMMAND_SUCCESS.test(`${assertion.observableBehavior} ${assertion.expectedOutcome} ${assertion.expectedEvidence}`) &&
          !/(?:顾客|商家|订单|商品|购物车|地址|支付|状态|界面|业务|customer|merchant|order|cart|address|payment)/iu.test(assertion.expectedOutcome))) {
        add('WEAK_ASSERTION', path, 'Assertion needs a specific observable outcome and supporting evidence; command success alone cannot prove a business behavior.')
      }
      if (business && (COMMAND_ONLY.test(assertion.observableBehavior) || COMMAND_ONLY.test(assertion.expectedOutcome))) {
        add('COMMAND_ONLY_ASSERTION', path, 'A business assertion cannot be only a command result.')
      }
    }
  }
  for (const task of draft.tasks) {
    if (!task.acceptanceCriterionIds.some((criterionId) => draft.acceptancePlan.criteria.some((criterion) => criterion.id === criterionId && criterion.requirementIds.some((id) => task.requirementIds.includes(id))))) {
      add('ORPHAN_TASK', `tasks.${task.id}`, 'Task must have acceptance tied to one of its requirements.')
    }
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) { add('TASK_CYCLE', `tasks.${taskId}`, 'Dependency cycle detected.'); return }
    if (visited.has(taskId)) return
    visiting.add(taskId)
    const task = draft.tasks.find((candidate) => candidate.id === taskId)
    for (const dep of task?.dependencyIds ?? []) if (taskIds.has(dep)) visit(dep)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of draft.tasks) visit(task.id)
  for (const question of draft.customerQuestions) {
    issues.push(...validateCustomerQuestion(question))
    if (/(?:取消|撤单|cancel(?:led|lation)?)/iu.test(question.question) &&
      !/(?:取消|撤单|cancel(?:led|lation)?)/iu.test([plan.requirement.text, ...(plan.requirement.revisionNotes ?? [])].join('\n'))) {
      add('UNREQUESTED_CUSTOMER_QUESTION', `customerQuestions.${question.id}`, 'Cancellation was not requested; do not expand product scope through a question.')
    }
  }
  const planningText = [
    draft.analysis.productGoal, draft.analysis.summary,
    ...draft.analysis.userRoles.flatMap((role) => [role.name, ...role.goals]),
    ...draft.analysis.businessFlows.flatMap((flow) => [flow.title, ...flow.steps]),
    ...draft.productScope.inScope, ...draft.productScope.outOfScope,
    draft.architecture.summary, ...draft.architecture.components, ...draft.architecture.decisions,
    ...draft.tasks.flatMap((task) => [task.title, task.objective, ...task.outputs]),
    ...draft.acceptancePlan.criteria.flatMap((criterion) => [criterion.description, criterion.expectedEvidence,
      ...criterion.assertions.flatMap((assertion) => [assertion.observableBehavior, assertion.expectedOutcome, assertion.expectedEvidence])]),
    ...draft.risks.flatMap((risk) => [risk.description, risk.mitigation]),
    ...draft.assumptions.flatMap((assumption) => [assumption.statement, assumption.impactIfFalse]),
  ]
  if (planningText.some((value) => RUNTIME_WIRING.test(value))) {
    add('RUNTIME_WIRING', 'plan', 'Customer plan may not assign agents, models, reviewers or verification commands.')
  }
  const coverage = buildCoverage(draft)
  if (JSON.stringify(coverage) !== JSON.stringify(plan.coverage)) add('STALE_COVERAGE', 'coverage', 'Coverage must be derived from current tasks and acceptance.')
  const dependencies = draft.tasks.flatMap((task) => task.dependencyIds.map((dependencyId) => ({ fromTaskId: dependencyId, toTaskId: task.id })))
  if (JSON.stringify(dependencies) !== JSON.stringify(plan.dependencies)) add('STALE_DEPENDENCIES', 'dependencies', 'Dependency list must match task graph.')
  const must = draft.clauses.filter((clause) => clause.priority === 'must')
  if (must.length === 0) add('NO_MUST_REQUIREMENT', 'clauses', 'A plan ready for approval needs at least one MUST requirement.')
  let taskCovered = 0
  let acceptanceCovered = 0
  for (const clause of must) {
    const entry = coverage.find((candidate) => candidate.requirementId === clause.id)
    if (entry?.taskIds.length) taskCovered += 1
    else add('MUST_TASK_UNCOVERED', `coverage.${clause.id}`, 'MUST requirement has no task.')
    const linkedBlocking = draft.acceptancePlan.criteria.filter((criterion) => criterion.blocking && criterion.requirementIds.includes(clause.id) &&
      criterion.assertions.some((assertion) => assertion.blocking && assertion.requirementId === clause.id) &&
      draft.tasks.some((task) => task.requirementIds.includes(clause.id) && task.acceptanceCriterionIds.includes(criterion.id)))
    if (linkedBlocking.length) acceptanceCovered += 1
    else add('MUST_ASSERTION_UNCOVERED', `coverage.${clause.id}`, 'MUST requirement has no directly linked blocking assertion owned by a matching task.')
    // Explicit source lists are a safe syntactic lower bound. A semantic review
    // still decides whether each assertion actually proves the corresponding item.
    const lines = clause.source.excerpt.split(/\r?\n/u)
    const bullets = lines.filter((line) => /^\s*[-*]\s+\S/u.test(line)).length
    const arrows = lines.filter((line) => /^\s*→\s*\S/u.test(line)).length
    const minimum = Math.max(1, bullets, arrows > 0 ? arrows + 1 : 0)
    const blockingAssertions = new Set(linkedBlocking.flatMap((criterion) =>
      criterion.assertions.filter((assertion) => assertion.blocking && assertion.requirementId === clause.id).map((assertion) => assertion.id)))
    if (blockingAssertions.size < minimum) {
      add('EXPLICIT_SOURCE_ATOMS_UNCOVERED', `coverage.${clause.id}`,
        `The quoted source has at least ${minimum} independent listed items but only ${blockingAssertions.size} blocking assertions.`)
    }
  }
  return {
    pass: issues.length === 0,
    issues,
    mustTaskCoverage: must.length === 0 ? 100 : Math.round(100 * taskCovered / must.length),
    mustAcceptanceCoverage: must.length === 0 ? 100 : Math.round(100 * acceptanceCovered / must.length),
  }
}
