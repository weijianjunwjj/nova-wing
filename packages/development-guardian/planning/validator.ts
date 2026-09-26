import { buildCoverage, planDraftSchema, type DevelopmentPlan, type PlanDraft } from './model.js'

export interface PlanIssue { code: string; path: string; message: string }
export interface PlanValidation { pass: boolean; issues: PlanIssue[]; mustTaskCoverage: number; mustAcceptanceCoverage: number }

const TECHNICAL_QUESTION = /\b(?:React|Vue|Angular|Svelte|SQLite|PostgreSQL|MySQL|MongoDB|REST|GraphQL|Codex|Claude|GPT|DeepSeek|reviewer|executor|agent|model|framework|database|db|shell|command|verification|test runner|Docker|Kubernetes)\b|技术栈|技术方案|数据库|模型|评审器|执行器|验证命令|测试命令|框架|前端框架|后端框架|前端技术|后端技术|接口协议|编程语言|用什么语言|什么语言开发|用什么开发|部署方式/iu
const RUNTIME_WIRING = /\b(?:Codex|Claude|DeepSeek|Reviewer|Executor|Agent|shell|npm\s+run|npx|pnpm|yarn|pytest|tsc)\b|评审器|执行器|验证命令|测试命令|模型分配|模型选择/iu
const COMMAND_ONLY = /^(?:npm|npx|pnpm|yarn|node|python|pytest|go|cargo|make|git|tsc|bash)\s+[^。.!?]+(?:\s+(?:passes?|成功|通过))?[。.!?]?$/iu
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
    if (![plan.requirement.text, ...(plan.requirement.revisionNotes ?? [])].some((source) => source.includes(clause.source.excerpt))) {
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
  for (const criterion of draft.acceptancePlan.criteria) {
    for (const reference of criterion.requirementIds) if (!clauseIds.has(reference)) add('INVALID_REQUIREMENT_REFERENCE', `criteria.${criterion.id}`, reference)
    if (!draft.tasks.some((task) => task.acceptanceCriterionIds.includes(criterion.id))) add('ORPHAN_ACCEPTANCE', `criteria.${criterion.id}`, 'No task owns this criterion.')
    if (criterion.blocking && (criterion.description.length < 12 || COMMAND_ONLY.test(criterion.description) || !OBSERVABLE.test(criterion.description))) {
      add('NOT_OBSERVABLE', `criteria.${criterion.id}`, 'Blocking acceptance must state an observable outcome, not just a command.')
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
  for (const question of draft.customerQuestions) issues.push(...validateCustomerQuestion(question))
  const planningText = [
    draft.analysis.productGoal, draft.analysis.summary,
    ...draft.analysis.userRoles.flatMap((role) => [role.name, ...role.goals]),
    ...draft.analysis.businessFlows.flatMap((flow) => [flow.title, ...flow.steps]),
    ...draft.productScope.inScope, ...draft.productScope.outOfScope,
    draft.architecture.summary, ...draft.architecture.components, ...draft.architecture.decisions,
    ...draft.tasks.flatMap((task) => [task.title, task.objective, ...task.outputs]),
    ...draft.acceptancePlan.criteria.flatMap((criterion) => [criterion.description, criterion.expectedEvidence]),
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
    const linkedBlocking = draft.acceptancePlan.criteria.filter((criterion) => criterion.blocking && criterion.requirementIds.includes(clause.id) && draft.tasks.some((task) => task.requirementIds.includes(clause.id) && task.acceptanceCriterionIds.includes(criterion.id)))
    if (linkedBlocking.length) acceptanceCovered += 1
    else add('MUST_ACCEPTANCE_UNCOVERED', `coverage.${clause.id}`, 'MUST requirement has no linked blocking acceptance.')
  }
  return {
    pass: issues.length === 0,
    issues,
    mustTaskCoverage: must.length === 0 ? 100 : Math.round(100 * taskCovered / must.length),
    mustAcceptanceCoverage: must.length === 0 ? 100 : Math.round(100 * acceptanceCovered / must.length),
  }
}
