export function renderCustomerHtml(token: string): string {
  const bootstrap = JSON.stringify({ token }).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NovaWing · Customer Mode</title><link rel="stylesheet" href="/customer/styles.css"></head>
<body><main class="shell">
  <header><div><p class="eyebrow">NOVAWING · CUSTOMER MODE</p><h1>你想做什么？</h1><p class="intro">描述目标与业务规则。NovaWing 会整理开发方案，供你检查和批准。</p></div><a href="/advanced">高级模式</a></header>
  <section class="input-card" aria-label="客户需求"><label for="requirement">你的需求</label><textarea id="requirement" rows="12" maxlength="20000" placeholder="例如：我想做一个单商户点餐系统，顾客可以选商品、下单并模拟支付，商家可以接单和自营配送……"></textarea><div class="actions"><button id="generate" type="button">生成开发方案</button></div></section>
  <section id="progress" class="panel" hidden role="status" aria-live="polite"><h2>正在规划</h2><p id="progress-step">理解需求</p><ol><li>理解需求</li><li>识别角色与业务流程</li><li>规划功能与架构</li><li>拆解任务与依赖</li><li>制定验收标准</li><li>完整性检查</li></ol></section>
  <p id="error" class="error" role="alert" aria-live="polite"></p>
  <section id="recent" class="panel" hidden><h2>最近的方案</h2><ul id="recent-list"></ul></section>
  <section id="plan" hidden aria-label="开发方案"><div class="plan-head"><div><p class="eyebrow">DEVELOPMENT PLAN</p><h2 id="plan-title">开发方案</h2><p id="plan-status"></p></div><span id="coverage" class="coverage"></span></div><div id="plan-sections"></div>
    <section id="validation" class="panel" hidden><h3>完整性检查</h3><ul id="validation-issues"></ul></section>
    <section id="questions" class="panel" hidden><h3>需要你决定的问题</h3><p>请在下方“要求修改”中写下你的选择，再生成下一版方案。</p><div id="question-list"></div></section>
    <section class="panel"><h3>要求修改</h3><p>写下需要改变的业务目标、范围或规则，然后重新生成下一版方案。</p><textarea id="feedback" rows="4" maxlength="4000" placeholder="例如：已开始制作的订单也允许取消，并且需要记录取消原因。"></textarea><div class="actions"><button id="revise" type="button" class="secondary">根据意见修改</button><button id="approve" type="button">批准方案</button></div></section>
  </section><footer>规划批准不会启动执行。</footer>
</main><script id="customer-bootstrap" type="application/json">${bootstrap}</script><script src="/customer/app.js"></script></body></html>`
}

export const CUSTOMER_APP_JS = `(() => {
  'use strict'
  const bootstrap = JSON.parse(document.getElementById('customer-bootstrap').textContent || '{}')
  const requirement = document.getElementById('requirement')
  const feedback = document.getElementById('feedback')
  const progress = document.getElementById('progress')
  const progressStep = document.getElementById('progress-step')
  const error = document.getElementById('error')
  const planElement = document.getElementById('plan')
  const sections = document.getElementById('plan-sections')
  const questions = document.getElementById('questions')
  const questionList = document.getElementById('question-list')
  const recent = document.getElementById('recent')
  const recentList = document.getElementById('recent-list')
  const validationElement = document.getElementById('validation')
  const validationIssues = document.getElementById('validation-issues')
  let current = null
  let busy = false
  const steps = ['理解需求', '识别角色与业务流程', '规划功能与架构', '拆解任务与依赖', '制定验收标准', '完整性检查']
  const node = (tag, value, className) => {
    const el = document.createElement(tag)
    if (value !== undefined) el.textContent = value
    if (className) el.className = className
    return el
  }
  const appendList = (parent, values) => { const list = node('ul'); for (const value of values) list.append(node('li', value)); parent.append(list) }
  const section = (title) => { const panel = node('section', undefined, 'panel'); panel.append(node('h3', title)); sections.append(panel); return panel }
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': bootstrap.token }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '请求失败')
    return result
  }
  const render = (result) => {
    const plan = result.plan || result
    current = plan
    requirement.value = plan.requirement.text
    planElement.hidden = false
    sections.replaceChildren()
    document.getElementById('plan-title').textContent = '开发方案 v' + plan.version
    document.getElementById('plan-status').textContent = ({ draft: '草稿：完整性检查未通过', needs_customer_input: '等待业务决定', ready_for_approval: '等待批准', approved: '已批准' })[plan.status] || plan.status
    const must = plan.clauses.filter(item => item.priority === 'must')
    const coveredTasks = must.filter(item => plan.coverage.some(row => row.requirementId === item.id && row.taskIds.length > 0)).length
    const coveredAcceptance = must.filter(item => plan.coverage.some(row => row.requirementId === item.id && row.blockingAcceptanceCriterionIds.length > 0)).length
    document.getElementById('coverage').textContent = 'MUST 任务覆盖 ' + coveredTasks + '/' + must.length + ' · 验收覆盖 ' + coveredAcceptance + '/' + must.length
    let panel = section('产品目标')
    panel.append(node('p', plan.analysis.productGoal), node('p', plan.analysis.summary))
    panel = section('范围与非目标')
    panel.append(node('h4', '范围内')); appendList(panel, plan.productScope.inScope)
    panel.append(node('h4', '不做')); appendList(panel, plan.productScope.outOfScope)
    panel = section('需求条款与来源')
    appendList(panel, plan.clauses.map(item => item.id + ' · ' + item.priority.toUpperCase() + ' · ' + item.statement + '（来源：' + item.source.excerpt + '）'))
    panel = section('用户角色')
    appendList(panel, plan.analysis.userRoles.map(item => item.name + '：' + item.goals.join('；')))
    panel = section('核心业务流程')
    for (const flow of plan.analysis.businessFlows) { panel.append(node('h4', flow.title)); appendList(panel, flow.steps) }
    panel = section('技术方案')
    panel.append(node('p', plan.architecture.summary)); appendList(panel, plan.architecture.components); appendList(panel, plan.architecture.decisions)
    panel = section('任务与依赖')
    for (const task of plan.tasks) { panel.append(node('h4', task.id + ' · ' + task.title)); panel.append(node('p', task.objective)); appendList(panel, ['关联需求：' + task.requirementIds.join(', '), '依赖：' + (task.dependencyIds.join(', ') || '无'), '产出：' + task.outputs.join('；'), '验收：' + task.acceptanceCriterionIds.join(', ')]) }
    panel = section('验收方案')
    panel.append(node('p', plan.acceptancePlan.strategy))
    for (const item of plan.acceptancePlan.criteria) { panel.append(node('h4', item.id + ' · ' + item.level + (item.blocking ? ' · 必须通过' : ''))); panel.append(node('p', item.description)); panel.append(node('p', '预期证据：' + item.expectedEvidence, 'muted')) }
    panel = section('风险与假设')
    appendList(panel, plan.risks.map(item => item.description + '；应对：' + item.mitigation))
    appendList(panel, plan.assumptions.map(item => item.statement + '；若不成立：' + item.impactIfFalse))
    questionList.replaceChildren()
    questions.hidden = plan.customerQuestions.length === 0
    for (const item of plan.customerQuestions) { questionList.append(node('h4', item.question)); questionList.append(node('p', item.reason)); appendList(questionList, item.options) }
    validationIssues.replaceChildren()
    const issues = result.validation ? result.validation.issues : []
    validationElement.hidden = issues.length === 0
    for (const item of issues) validationIssues.append(node('li', item.code + '：' + item.message))
    document.getElementById('approve').disabled = plan.status !== 'ready_for_approval'
    document.getElementById('revise').disabled = plan.status === 'approved'
    planElement.scrollIntoView({ behavior: 'smooth' })
  }
  const loadRecent = async () => {
    try {
      const response = await fetch('/api/planning/plans')
      if (!response.ok) return
      const plans = await response.json()
      recentList.replaceChildren()
      recent.hidden = plans.length === 0
      for (const item of plans) {
        const row = node('li')
        const button = node('button', item.productGoal + ' · v' + item.version + ' · ' + item.status, 'recent-button')
        button.type = 'button'
        button.addEventListener('click', async () => {
          error.textContent = ''
          try {
            const detail = await fetch('/api/planning/plans/' + encodeURIComponent(item.id))
            if (!detail.ok) throw new Error('方案无法读取')
            render(await detail.json())
          } catch (failure) { error.textContent = failure.message || '方案无法读取' }
        })
        row.append(button); recentList.append(row)
      }
    } catch { /* Recent plans are optional when the local store is unavailable. */ }
  }
  const run = async (revision) => {
    if (busy) return
    error.textContent = ''
    busy = true
    progress.hidden = false
    let step = 0
    progressStep.textContent = steps[0]
    const timer = setInterval(() => { step = Math.min(step + 1, steps.length - 1); progressStep.textContent = steps[step] }, 2500)
    try {
      const body = { requirement: requirement.value }
      if (revision) { body.planId = current.id; body.feedback = feedback.value }
      const result = await post('/api/planning/generate', body)
      render(result)
      feedback.value = ''
      await loadRecent()
    } catch (failure) { error.textContent = failure.message || '规划失败' }
    finally { clearInterval(timer); progress.hidden = true; busy = false }
  }
  document.getElementById('generate').addEventListener('click', () => run(false))
  document.getElementById('revise').addEventListener('click', () => { if (!feedback.value.trim()) { error.textContent = '请先写下修改意见。'; return }; run(true) })
  document.getElementById('approve').addEventListener('click', async () => {
    if (!current || busy) return
    busy = true; error.textContent = ''
    try { render(await post('/api/planning/approve', { planId: current.id, version: current.version })); await loadRecent() }
    catch (failure) { error.textContent = failure.message || '批准失败' }
    finally { busy = false }
  })
  const saved = sessionStorage.getItem('novawing-customer-requirement')
  if (saved) { requirement.value = saved; sessionStorage.removeItem('novawing-customer-requirement') }
  void loadRecent()
})()`

export const CUSTOMER_STYLES_CSS = `:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eef3fb;background:#0c111a}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:radial-gradient(circle at 10% 0%,#1c3551 0,transparent 35%),#0c111a}.shell{max-width:1100px;margin:auto;padding:42px 24px 60px}header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:24px}h1{font-size:clamp(32px,5vw,54px);margin:6px 0}h2{margin:8px 0}h3{margin-top:0}h4{margin:20px 0 6px}p,li{line-height:1.65}.intro,.muted,footer{color:#a5b3c7}.eyebrow{letter-spacing:.16em;color:#89bcf5;font-size:12px;font-weight:700}a{color:#98c9ff;padding:12px}.input-card,.panel{background:#151d2a;border:1px solid #304056;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 12px 36px #0002}label{display:block;font-weight:700;margin-bottom:12px}textarea{width:100%;padding:15px;border:1px solid #52647c;border-radius:10px;color:#f2f6ff;background:#0d1520;font:inherit;resize:vertical;line-height:1.5}button{background:#71b8ff;border:0;border-radius:10px;color:#091321;padding:12px 20px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.4;cursor:not-allowed}.secondary{background:#273b52;color:#e4f2ff}.recent-button{background:transparent;color:#bce0ff;text-align:left;padding:6px 0;font-weight:500}.recent-button:hover{text-decoration:underline}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:16px}.error{color:#ff9d9d;min-height:1.5em}.plan-head{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:32px}.coverage{background:#163b35;color:#b5f5dc;padding:10px 14px;border-radius:999px;font-size:13px}.panel ul{padding-left:22px}footer{text-align:center;margin-top:40px;font-size:12px}@media(max-width:650px){header,.plan-head{display:block}.shell{padding:24px 14px}.input-card,.panel{padding:18px}.actions{flex-wrap:wrap}.coverage{display:inline-block}}`
