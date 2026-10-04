export function renderCustomerHtml(): string {
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
    <section id="questions" class="panel" hidden><h3>需要你决定的问题</h3><p>请选择业务规则，或写下你自己的准确规则。提交后会生成新版方案，并重新检查质量。</p><div id="question-list"></div><div class="actions"><button id="answer-revise" type="button">提交回答并重新生成方案</button></div></section>
    <section id="freeze-result" class="panel" hidden><h3>PLAN FROZEN</h3><p id="freeze-details"></p><p>此版本已固定。后续修改须创建新版本。</p>
      <div id="delivery" hidden><h4>准备交付</h4><label for="delivery-folder">交付项目文件夹</label><input id="delivery-folder" type="text" autocomplete="off" placeholder="选择或输入本机 Git 项目文件夹"><div class="actions"><button id="delivery-prepare" type="button" class="secondary">检查交付准备情况</button><button id="delivery-start" type="button" hidden>开始交付</button></div><p id="delivery-status" role="status"></p><ul id="delivery-blockers"></ul></div>
    </section>
    <section class="panel"><h3>要求修改</h3><p>写下需要改变的业务目标、范围或规则，然后重新生成下一版方案。</p><textarea id="feedback" rows="4" maxlength="4000" placeholder="例如：已开始制作的订单也允许取消，并且需要记录取消原因。"></textarea><div class="actions"><button id="revise" type="button" class="secondary">根据意见修改</button><button id="approve" type="button">批准方案</button></div></section>
  </section><footer>规划批准不会启动执行。</footer>
</main><script src="/customer/app.js"></script></body></html>`
}

export const CUSTOMER_APP_JS = `(() => {
  'use strict'
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
  const freezeResult = document.getElementById('freeze-result')
  const freezeDetails = document.getElementById('freeze-details')
  const delivery = document.getElementById('delivery')
  const deliveryFolder = document.getElementById('delivery-folder')
  const deliveryStatus = document.getElementById('delivery-status')
  const deliveryBlockers = document.getElementById('delivery-blockers')
  const deliveryStart = document.getElementById('delivery-start')
  let current = null
  let prepared = null
  let deliverySerial = 0
  let deliverySession = null
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
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '请求失败')
    return result
  }
  const refreshDeliveryStatus = async () => {
    const session = deliverySession
    if (!session || !prepared || !current || current.status !== 'frozen' ||
      session.runtimePlanId !== prepared.runtimePlanId || session.planId !== current.id ||
      session.version !== current.version) return
    try {
      const response = await fetch('/api/session/configs')
      if (!response.ok) throw new Error('session status unavailable')
      const configs = await response.json()
      const state = configs.find(item => item.configId === session.id)?.status
      if (deliverySession !== session) return
      if (!state) { deliveryStatus.textContent = '工作会话状态暂不可用'; deliveryStart.hidden = true; return }
      if (state === 'COMPLETED') {
        const assessmentResponse = await fetch('/api/delivery/plans/' + encodeURIComponent(session.runtimePlanId) +
          '?planId=' + encodeURIComponent(session.planId) + '&version=' + session.version)
        if (!assessmentResponse.ok) throw new Error('delivery assessment unavailable')
        const assessment = (await assessmentResponse.json()).customerAssessment
        if (deliverySession !== session) return
        deliveryStatus.textContent = assessment?.status === 'CUSTOMER_DELIVERY_COMPLETED' ?
          '客户交付已完成' : '工作会话已完成 · 客户验收待完成'
      } else deliveryStatus.textContent = ({ READY: '工作会话待启动', SCHEDULED: '工作会话已排程',
        RUNNING: '工作会话正在执行', SUSPENDED: '工作会话已暂停，需要处理',
        RECOVERABLE: '工作会话可恢复', FAILED: '工作会话失败', CANCELLED: '工作会话已取消' })[state] ||
        '工作会话状态暂不可用'
      deliveryStart.hidden = true
    } catch { if (deliverySession === session) deliveryStatus.textContent = '工作会话状态暂不可用' }
  }
  const render = (result, scrollTarget = 'plan') => {
    const plan = result.plan || result
    current = plan
    requirement.value = plan.requirement.text
    planElement.hidden = false
    sections.replaceChildren()
    document.getElementById('plan-title').textContent = '开发方案 v' + plan.version
    document.getElementById('plan-status').textContent = ({ draft: '草稿：完整性检查未通过', planning_failed: '规划质量检查未通过，请查看问题并要求修改', needs_customer_input: '等待业务决定', ready_for_approval: plan.version > 1 ? '基于你的回答已更新，等待批准' : '等待批准', approved: '已批准', frozen: 'PLAN FROZEN · 不可修改', superseded: '已由新版替代' })[plan.status] || plan.status
    freezeResult.hidden = plan.status !== 'frozen'
    delivery.hidden = plan.status !== 'frozen'
    deliverySerial += 1
    prepared = null
    deliverySession = null
    deliveryStart.hidden = true
    deliveryStatus.textContent = ''
    deliveryBlockers.replaceChildren()
    if (plan.status === 'frozen') {
      const key = 'novawing-delivery-' + plan.id + '-v' + plan.version
      deliveryFolder.value = localStorage.getItem(key + '-folder') || ''
      const savedPlanId = localStorage.getItem(key)
      try {
        const savedSession = JSON.parse(localStorage.getItem(key + '-session') || 'null')
        if (savedSession && typeof savedSession.id === 'string' && savedSession.runtimePlanId === savedPlanId &&
          savedSession.planId === plan.id && savedSession.version === plan.version) deliverySession = savedSession
      } catch { /* Invalid local state cannot prove delivery status. */ }
      const restoreSerial = deliverySerial
      if (savedPlanId) void fetch('/api/delivery/plans/' + encodeURIComponent(savedPlanId) + '?planId=' + encodeURIComponent(plan.id) + '&version=' + plan.version)
        .then(async response => { if (!response.ok) throw new Error('readiness unavailable'); return response.json() })
        .then(result => {
          if (deliverySerial !== restoreSerial || current?.id !== plan.id || current.version !== plan.version) return
          prepared = result
          deliveryStatus.textContent = result.admission.status === 'READY' ? 'DELIVERY READY' : 'DELIVERY BLOCKED'
          deliveryStart.hidden = !!deliverySession || result.admission.status !== 'READY'
          deliveryBlockers.replaceChildren()
          for (const item of result.admission.blockers) deliveryBlockers.append(node('li', item.message))
          if (deliverySession) void refreshDeliveryStatus()
        }).catch(() => { if (deliverySerial === restoreSerial) deliveryStatus.textContent = '请重新检查交付准备情况。' })
    }
    freezeDetails.textContent = plan.status === 'frozen' ? '方案 v' + plan.version + ' · 冻结时间 ' + plan.frozenAt + ' · 指纹 ' + (plan.approval?.contentHash || '').slice(0, 12) : ''
    const must = plan.clauses.filter(item => item.priority === 'must')
    const coveredTasks = must.filter(item => plan.coverage.some(row => row.requirementId === item.id && row.taskIds.length > 0)).length
    const coveredAcceptance = must.filter(item => plan.coverage.some(row => row.requirementId === item.id && (row.blockingAssertionIds || []).length > 0)).length
    document.getElementById('coverage').textContent = 'MUST 任务覆盖 ' + coveredTasks + '/' + must.length + ' · 独立验收断言覆盖 ' + coveredAcceptance + '/' + must.length
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
    for (const item of plan.acceptancePlan.criteria) { panel.append(node('h4', item.id + ' · ' + item.level + (item.blocking ? ' · 必须通过' : ''))); panel.append(node('p', item.description)); panel.append(node('p', '预期证据：' + item.expectedEvidence, 'muted')); for (const assertion of item.assertions || []) { panel.append(node('h4', assertion.id + ' · ' + assertion.requirementId + (assertion.blocking ? ' · 必须证明' : ''))); panel.append(node('p', assertion.observableBehavior + ' → ' + assertion.expectedOutcome)); panel.append(node('p', '证据：' + assertion.expectedEvidence, 'muted')) } }
    panel = section('风险与假设')
    appendList(panel, plan.risks.map(item => item.description + '；应对：' + item.mitigation))
    appendList(panel, plan.assumptions.map(item => item.statement + '；若不成立：' + item.impactIfFalse))
    questionList.replaceChildren()
    questions.hidden = plan.status !== 'needs_customer_input'
    for (const item of plan.customerQuestions.filter(item => item.blocking)) {
      const label = node('label', item.question)
      const select = node('select')
      select.dataset.questionId = item.id
      select.append(node('option', '请选择'))
      select.firstChild.value = ''
      item.options.forEach((option, index) => { const choice = node('option', option); choice.value = 'option-' + (index + 1); select.append(choice) })
      const custom = node('option', '自定义业务规则')
      custom.value = 'custom'
      select.append(custom)
      const detail = node('textarea')
      detail.dataset.questionId = item.id
      detail.rows = 3
      detail.maxLength = 2000
      detail.placeholder = '请写下完整、准确的业务决定'
      detail.hidden = true
      select.addEventListener('change', () => { detail.hidden = select.value !== 'custom' })
      questionList.append(label, node('p', item.reason), select, detail)
    }
    validationIssues.replaceChildren()
    const issues = [...(result.validation ? result.validation.issues : []), ...(plan.semanticReview ? plan.semanticReview.issues : [])]
    validationElement.hidden = issues.length === 0
    for (const item of issues) validationIssues.append(node('li', item.code + '：' + item.message))
    document.getElementById('approve').disabled = plan.status !== 'ready_for_approval'
    document.getElementById('revise').disabled = plan.status === 'approved' || plan.status === 'frozen'
    if (scrollTarget === 'freeze' && plan.status === 'frozen') freezeResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    else planElement.scrollIntoView({ behavior: 'smooth' })
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
      if (revision) { body.planId = current.id; body.expectedVersion = current.version; body.feedback = feedback.value }
      const result = await post('/api/planning/generate', body)
      render(result)
      feedback.value = ''
      await loadRecent()
    } catch (failure) { error.textContent = failure.message || '规划失败' }
    finally { clearInterval(timer); progress.hidden = true; busy = false }
  }
  document.getElementById('generate').addEventListener('click', () => run(false))
  document.getElementById('revise').addEventListener('click', () => { if (!feedback.value.trim()) { error.textContent = '请先写下修改意见。'; return }; run(true) })
  document.getElementById('answer-revise').addEventListener('click', async () => {
    if (!current || busy) return
    const answers = [...questionList.querySelectorAll('select')].map(select => {
      const answer = { questionId: select.dataset.questionId, selectedOptionId: select.value }
      if (select.value === 'custom') answer.freeformAnswer = [...questionList.querySelectorAll('textarea')].find(item => item.dataset.questionId === select.dataset.questionId)?.value.trim()
      return answer
    })
    if (answers.some(answer => !answer.selectedOptionId || (answer.selectedOptionId === 'custom' && !answer.freeformAnswer))) { error.textContent = '请回答所有业务问题。'; return }
    busy = true; error.textContent = ''; progress.hidden = false
    try {
      await post('/api/planning/answers', { planId: current.id, version: current.version, answers })
      const result = await post('/api/planning/generate', { requirement: current.requirement.text, planId: current.id, expectedVersion: current.version })
      render(result); await loadRecent()
    } catch (failure) { error.textContent = failure.message || '回答或重新规划失败' }
    finally { busy = false; progress.hidden = true }
  })
  document.getElementById('approve').addEventListener('click', async () => {
    if (!current || busy) return
    busy = true; error.textContent = ''
    try { render(await post('/api/planning/approve', { planId: current.id, version: current.version }), 'freeze'); await loadRecent() }
    catch (failure) { error.textContent = failure.message || '批准失败' }
    finally { busy = false }
  })
  document.getElementById('delivery-prepare').addEventListener('click', async () => {
    if (!current || current.status !== 'frozen' || busy) return
    const requestSerial = ++deliverySerial
    prepared = null
    busy = true; error.textContent = ''; deliveryStatus.textContent = '正在检查交付准备情况…'; deliveryStart.hidden = true
    try {
      const response = await fetch('/api/planning/plans/' + encodeURIComponent(current.id) + '/snapshots/' + current.version)
      if (!response.ok) throw new Error('冻结方案无法读取。')
      const snapshot = await response.json()
      prepared = await post('/api/delivery/prepare', { planId: current.id, version: current.version,
        snapshotId: snapshot.id, repositoryRoot: deliveryFolder.value.trim() })
      if (requestSerial !== deliverySerial) { prepared = null; return }
      localStorage.setItem('novawing-delivery-' + current.id + '-v' + current.version, prepared.runtimePlanId)
      localStorage.setItem('novawing-delivery-' + current.id + '-v' + current.version + '-folder', deliveryFolder.value.trim())
      deliveryBlockers.replaceChildren()
      if (prepared.admission.status === 'READY') { deliveryStatus.textContent = 'DELIVERY READY'; deliveryStart.hidden = !!deliverySession }
      else { deliveryStatus.textContent = 'DELIVERY BLOCKED';
        for (const item of prepared.admission.blockers) deliveryBlockers.append(node('li', item.message)) }
    } catch (failure) { if (requestSerial === deliverySerial) {
      prepared = null; deliveryStatus.textContent = 'DELIVERY BLOCKED'; error.textContent = failure.message || '交付检查失败'
    } }
    finally { busy = false }
  })
  deliveryFolder.addEventListener('input', () => {
    deliverySerial += 1; prepared = null; deliverySession = null; deliveryStart.hidden = true
    deliveryStatus.textContent = '请检查交付准备情况。'; deliveryBlockers.replaceChildren()
  })
  deliveryStart.addEventListener('click', async () => {
    if (!current || !prepared || busy) return
    busy = true; error.textContent = ''; deliveryStatus.textContent = '工作会话正在启动'
    try {
      const response = await fetch('/api/planning/plans/' + encodeURIComponent(current.id) + '/snapshots/' + current.version)
      if (!response.ok) throw new Error('冻结方案无法读取。')
      const snapshot = await response.json()
      const result = await post('/api/delivery/start', { planId: current.id, version: current.version,
        snapshotId: snapshot.id, sourcePlanHash: snapshot.planHash.value, runtimePlanId: prepared.runtimePlanId,
        runtimePlanHash: prepared.runtimePlanHash, targetBindingId: prepared.targetBindingId })
      deliverySession = { id: result.workSessionId, runtimePlanId: prepared.runtimePlanId,
        planId: current.id, version: current.version }
      localStorage.setItem('novawing-delivery-' + current.id + '-v' + current.version + '-session',
        JSON.stringify(deliverySession))
      deliveryStatus.textContent = '工作会话正在启动'
      deliveryStart.hidden = true
      void refreshDeliveryStatus()
    } catch (failure) { error.textContent = failure.message || '开始交付失败'; deliveryStatus.textContent = 'DELIVERY BLOCKED'; deliveryStart.hidden = true }
    finally { busy = false }
  })
  const saved = sessionStorage.getItem('novawing-customer-requirement')
  if (saved) { requirement.value = saved; sessionStorage.removeItem('novawing-customer-requirement') }
  if (typeof setInterval === 'function') setInterval(() => { void refreshDeliveryStatus() }, 10000)
  void loadRecent()
})()`

export const CUSTOMER_STYLES_CSS = `:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eef3fb;background:#0c111a}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:radial-gradient(circle at 10% 0%,#1c3551 0,transparent 35%),#0c111a}.shell{max-width:1100px;margin:auto;padding:42px 24px 60px}header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:24px}h1{font-size:clamp(32px,5vw,54px);margin:6px 0}h2{margin:8px 0}h3{margin-top:0}h4{margin:20px 0 6px}p,li{line-height:1.65}.intro,.muted,footer{color:#a5b3c7}.eyebrow{letter-spacing:.16em;color:#89bcf5;font-size:12px;font-weight:700}a{color:#98c9ff;padding:12px}.input-card,.panel{background:#151d2a;border:1px solid #304056;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 12px 36px #0002}label{display:block;font-weight:700;margin-bottom:12px}textarea,select,input{width:100%;padding:15px;border:1px solid #52647c;border-radius:10px;color:#f2f6ff;background:#0d1520;font:inherit;line-height:1.5}textarea{resize:vertical}button{background:#71b8ff;border:0;border-radius:10px;color:#091321;padding:12px 20px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.4;cursor:not-allowed}.secondary{background:#273b52;color:#e4f2ff}.recent-button{background:transparent;color:#bce0ff;text-align:left;padding:6px 0;font-weight:500}.recent-button:hover{text-decoration:underline}.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:16px}.error{color:#ff9d9d;min-height:1.5em}.plan-head{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:32px}.coverage{background:#163b35;color:#b5f5dc;padding:10px 14px;border-radius:999px;font-size:13px}.panel ul{padding-left:22px}footer{text-align:center;margin-top:40px;font-size:12px}@media(max-width:650px){header,.plan-head{display:block}.shell{padding:24px 14px}.input-card,.panel{padding:18px}.actions{flex-wrap:wrap}.coverage{display:inline-block}}`
