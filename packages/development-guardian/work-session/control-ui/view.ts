/**
 * W005-A Thin Local Control Surface — View
 *
 * 单页 vanilla HTML/CSS/JS，深色克制 control panel。
 *
 * 不引入 React/Vue/Vite/Webpack 或任何前端 toolchain。
 * HTML/CSS/JS 内联在本模块内，避免 build 时的静态资源复制与文件系统路径耦合；
 * 静态资源经 GET / /app.js /styles.css 暴露。
 *
 * 安全约束：
 * - bootstrap token 通过 <script type="application/json"> 注入，不写 console；
 * - CSP script-src 'self'，无 inline script；style-src 'self'，无 inline style；
 * - token 只出现在首次 HTML，不进入 status/SSE/recent events。
 */

export interface ViewBootstrap {
  controlToken: string
  serverOrigin: string
}

/** 渲染 index.html。bootstrap 只注入 controlToken 与 serverOrigin。 */
export function renderHtml(bootstrap: ViewBootstrap): string {
  // 防御：JSON 内容不得包含 "</script>" 截断标签（token/origin 均受控，仍转义 <）。
  const bootstrapJson = JSON.stringify(bootstrap).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NovaWing Work Session 控制台</title>
<link rel="stylesheet" href="/styles.css">
<script type="application/json" id="novawing-bootstrap">${bootstrapJson}</script>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <h1>NovaWing</h1>
    <span class="subtitle">Work Session 控制台</span>
  </div>
  <div id="state-badge" class="badge badge-ready">就绪</div>
</header>

<main>
  <section class="meta-grid">
    <div class="meta">
      <span class="label">项目</span>
      <span id="project" class="value">—</span>
    </div>
    <div class="meta">
      <span class="label">分支</span>
      <span id="branch" class="value">—</span>
    </div>
    <div class="meta">
      <span class="label">限制</span>
      <span id="limits" class="value">—</span>
    </div>
  </section>

  <section id="decision-card" class="card decision" hidden>
    <h2 id="decision-title">需要人工决策</h2>
    <div class="row">
      <span class="label">类别</span>
      <span id="decision-category" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">原因</span>
      <span id="decision-reason" class="value">—</span>
    </div>
    <p id="decision-guidance" class="note"></p>
    <textarea id="decision-input" maxlength="2000" rows="4" hidden></textarea>
    <button id="resume-decision-btn" type="button" class="primary" hidden>提交决策并恢复</button>
    <button id="approve-verification-btn" type="button" class="primary" hidden>批准此验证并继续</button>
    <button id="runtime-repair-btn" type="button" class="primary" hidden>✨ AI 修复并继续</button>
    <button id="resume-resolved-btn" type="button" class="primary" hidden>已处理，恢复</button>
    <button id="resume-paused-btn" type="button" class="primary" hidden>恢复</button>
    <button id="recover-checkpoint-btn" type="button" class="primary" hidden>重新验证并继续</button>
    <span id="resume-note" class="note"></span>
  </section>

  <section id="recoverable-card" class="card decision" hidden>
    <h2 id="recoverable-title">可恢复的 Work Session</h2>
    <div class="row">
      <span class="label">最后活动</span>
      <span id="recoverable-last-activity" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">最后完成 Task</span>
      <span id="recoverable-last-task" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">当前 Task</span>
      <span id="recoverable-current-task" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">当前 Phase</span>
      <span id="recoverable-phase" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">最后可靠 checkpoint</span>
      <span id="recoverable-checkpoint" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">下一步</span>
      <span id="recoverable-next" class="value">—</span>
    </div>
    <button id="resume-recoverable-btn" type="button" class="primary">继续 Work Session</button>
  </section>

  <section class="card">
    <h2>任务（Task）</h2>
    <ol id="task-list" class="task-list"></ol>
  </section>

  <section class="card runtime-overview" aria-label="运行概览">
    <h2>运行概览</h2>
    <dl class="overview-grid">
      <div><dt>状态</dt><dd id="overview-status">就绪</dd></div>
      <div><dt>当前阶段</dt><dd id="overview-phase">等待开始</dd></div>
      <div><dt>创建时间</dt><dd id="created-at">—</dd></div>
      <div><dt>开始方式</dt><dd id="start-mode">立即开始</dd></div>
      <div><dt>实际开始</dt><dd id="started-at">尚未开始</dd></div>
      <div><dt>预计完成</dt><dd id="estimated-completion">正在估算…</dd></div>
      <div><dt>实际完成</dt><dd id="completed-at">尚未完成</dd></div>
      <div><dt>总耗时</dt><dd id="total-elapsed">0 秒</dd></div>
      <div><dt>Executor</dt><dd id="overview-executor">尚未执行</dd></div>
      <div><dt>轮次</dt><dd id="overview-iteration">尚未执行</dd></div>
    </dl>
    <p id="schedule-note" class="note" hidden></p>
    <p id="coding-failover" class="note" hidden></p>
    <p id="execution-last-activity" class="note" hidden></p>
  </section>

  <section class="card" aria-label="活动日志">
    <h2>活动日志</h2>
    <p id="activity-empty" class="note">开始后将在这里显示执行、验证和 checkpoint 进展。</p>
    <ol id="activity-list" class="activity-list" aria-label="运行时间线"></ol>
  </section>

  <details id="debug-panel" class="card debug">
    <summary>Debug</summary>
    <p class="note">完整安全状态与排障证据：runtime、event、provider、verification、checkpoint、humanRequired 和 error。</p>
    <pre id="debug-output"></pre>
  </details>
</main>

<footer class="footer">
  <button id="start-btn" type="button" class="primary">开始</button>
  <button id="pause-btn" type="button" hidden>暂停</button>
  <button id="stop-btn" type="button" hidden>当前 Task 完成后停止</button>
  <span id="start-note" class="note"></span>
</footer>

<script type="module" src="/app.js"></script>
</body>
</html>
`
}

export const APP_JS = `
'use strict'

var bootstrapEl = document.getElementById('novawing-bootstrap')
var controlToken = ''
try {
  var bootstrap = JSON.parse(bootstrapEl ? (bootstrapEl.textContent || '{}') : '{}')
  controlToken = bootstrap.controlToken || ''
} catch (e) {
  // bootstrap 缺失时 mutation fetch 将因缺少 token 而被服务端拒绝
}

function el(id) {
  return document.getElementById(id)
}

function setText(id, text) {
  var node = el(id)
  if (node) node.textContent = text
}

function formatTime(iso) {
  if (!iso) return '--:--:--'
  var d = new Date(iso)
  if (isNaN(d.getTime())) return '--:--:--'
  var hh = String(d.getHours()).padStart(2, '0')
  var mm = String(d.getMinutes()).padStart(2, '0')
  var ss = String(d.getSeconds()).padStart(2, '0')
  return hh + ':' + mm + ':' + ss
}

var BADGE_CLASS = {
  READY: 'badge-ready',
  SCHEDULED: 'badge-ready',
  RUNNING: 'badge-running',
  SUSPENDED: 'badge-suspended',
  RECOVERABLE: 'badge-recoverable',
  COMPLETED: 'badge-completed',
  FAILED: 'badge-failed',
  CANCELLED: 'badge-cancelled'
}

var STATE_LABELS = {
  READY: '就绪',
  SCHEDULED: 'Scheduled · 等待开始',
  RUNNING: '运行中',
  SUSPENDED: '已暂停',
  RECOVERABLE: '可恢复',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
}

var HUMAN_REQUIRED_LABELS = {
  DECISION_REQUIRED: '需要人工决策',
  REPO_DRIFT: 'Repository 状态漂移',
  PERMISSION_REQUIRED: '需要授权',
  CREDENTIAL_REQUIRED: '需要完成凭据或登录设置',
  ENVIRONMENT_REQUIRED: '需要处理运行环境',
  EXECUTOR_RETRY_REQUIRED: 'Executor 需要重新执行',
  SAFETY_BLOCKED: '被安全策略阻止',
  BUDGET_EXHAUSTED: 'Work Session 时间额度已耗尽',
  ACTION_BUDGET_EXHAUSTED: 'Controller action budget 已耗尽',
  STALLED_NO_PROGRESS: 'Executor 未产生实现进展',
  CYCLIC_NO_PROGRESS: 'Controller 检测到无进展循环',
  REVIEWER_PROTOCOL_FAILURE: 'Reviewer 协议失败',
  PLANNING_REQUIRED: '需要补充验证计划',
  BRAIN_INFRASTRUCTURE_FAILED: 'Brain 基础设施故障',
  STALLED: '执行停滞',
  USER_PAUSED: '用户已暂停'
}

var GUARDIAN_PHASE_LABELS = {
  PLANNING: '正在规划验证',
  ANALYZING: '正在分析',
  EXECUTING: 'Executor 执行中',
  VERIFYING: '正在验证',
  RECOVERING: '正在恢复',
  REVIEWING: 'Reviewer 审查',
  FINAL_REVIEW: 'Final Review',
  FINALIZING: '正在完成收尾',
  WAITING: '等待下一阶段',
  WAITING_FOR_ENVIRONMENT: '等待运行环境',
  WAITING_FOR_APPROVAL: '等待审批',
  RECONCILING: '正在核对 Repository',
  UNKNOWN: '状态未知',
  COMPLETED: '已完成',
  HUMAN_REQUIRED: '需要人工处理',
  BRAIN_INFRASTRUCTURE_FAILED: 'Brain 暂时不可用'
}

// 通知内部 enum 保持英文；UI 一律映射为中文，不直接显示 PARTIAL_SUCCESS / ALL_FAILED。
var NOTIFICATION_KIND_LABELS = {
  HUMAN_REQUIRED: '需要人工处理', COMPLETED: '完成', FAILED: '失败', RECOVERY_REQUIRED: '需要恢复'
}

var NOTIFICATION_CHANNEL_LABELS = { EMAIL: '邮件', DESKTOP: '桌面通知' }

var NOTIFICATION_CHANNEL_STATUS_LABELS = {
  SENT: '已发送', FAILED: '发送失败', SKIPPED: '已跳过（不适用）'
}

var NOTIFICATION_OVERALL_LABELS = {
  ALL_SUCCEEDED: '全部成功', PARTIAL_SUCCESS: '部分成功', ALL_FAILED: '全部失败'
}

function displayValue(value, labels) {
  if (value === undefined || value === null || value === '') return '—'
  return (labels && labels[value]) || String(value)
}

function render(snapshot) {
  var cfg = snapshot.configuredSession
  var rt = snapshot.runtime
  setText('project', cfg.targetRepo)
  setText('branch', cfg.branch)
  setText('limits',
    '软限制 ' + cfg.limits.softMinutes + ' 分钟 · 硬限制 ' + cfg.limits.hardMinutes +
    ' 分钟 · 最多 ' + cfg.limits.maxTasks + ' 个 Task')

  var displayState = rt.displayState || rt.state || 'READY'
  var badge = el('state-badge')
  if (badge) {
    badge.textContent = displayValue(displayState, STATE_LABELS)
    badge.className = 'badge ' + (BADGE_CLASS[displayState] || 'badge-ready')
  }

  renderTasks(cfg, rt)
  renderOverview(snapshot)
  renderActivities(snapshot.activities || [])
  // /api/status is already sanitized by the controller. Bootstrap credentials
  // remain separate and never enter this diagnostic snapshot.
  setText('debug-output', JSON.stringify(snapshot, null, 2))
  renderDecision(rt)
  renderRecoverable(rt)
  renderControls(rt, snapshot.controls || {})
}

var EXECUTOR_STATUS_LABELS = {
  NOT_STARTED: '尚未执行', RUNNING: '执行中', COMPLETED: '已完成', FAILED: '执行失败', WAITING: '等待继续'
}

function providerName(value) {
  return ({ codex: 'Codex', deepseek: 'DeepSeek' })[value] || value || ''
}

function localDateTime(value, fallback) {
  if (!value) return fallback || '—'
  var date = new Date(value)
  return isNaN(date.getTime()) ? fallback || '—' : date.toLocaleString()
}

function setNote(id, text) {
  var node = el(id)
  if (node) {
    node.textContent = text
    node.hidden = !text
  }
}

function displayIteration(iteration) {
  var current = iteration && iteration.current
  if (!Number.isInteger(current) || current < 1) return '尚未执行'
  return Number.isInteger(iteration.maximum) && iteration.maximum >= current
    ? current + ' / ' + iteration.maximum : '第 ' + current + ' 轮'
}

function formatEta(eta) {
  if (!eta || !eta.estimatedCompletionAt || isNaN(new Date(eta.estimatedCompletionAt).getTime())) return '正在估算…'
  var text = formatTime(eta.estimatedCompletionAt).slice(0, 5)
  if (eta.adjusted) text += ' · 已调整'
  if (eta.confidence === 'low') return text + ' · 粗略估计'
  return text + (Number.isFinite(eta.uncertaintyMs)
    ? ' · 约 ±' + Math.max(1, Math.ceil(eta.uncertaintyMs / 60000)) + ' 分钟' : ' · 预计')
}

function renderOverview(snapshot) {
  var rt = snapshot.runtime
  var overview = snapshot.runtimeOverview || {}
  var status = overview.status || rt.displayState || rt.state || 'READY'
  setText('overview-status', displayValue(status, STATE_LABELS))
  setText('overview-phase', overview.currentPhase ? displayValue(overview.currentPhase, GUARDIAN_PHASE_LABELS) : '等待开始')
  setText('created-at', localDateTime(overview.createdAt))
  var mode = overview.startMode === 'deepseek_off_peak' ? 'DeepSeek Off-Peak'
    : overview.startMode === 'custom' ? '定时开始' : '立即开始'
  if (overview.scheduledStartAt) mode += ' · ' + localDateTime(overview.scheduledStartAt)
  setText('start-mode', mode)
  setText('started-at', localDateTime(overview.startedAt, '尚未开始'))
  setText('estimated-completion', formatEta(snapshot.eta))
  setText('completed-at', localDateTime(overview.completedAt, '尚未完成'))
  setText('total-elapsed', formatElapsed(overview.totalElapsedMs || 0))
  var executor = overview.executor || {}
  var executorText = [providerName(executor.provider), displayValue(executor.status || 'NOT_STARTED', EXECUTOR_STATUS_LABELS)]
    .filter(Boolean).join(' · ')
  if (executor.model) executorText += ' · ' + executor.model
  setText('overview-executor', executorText)
  setText('overview-iteration', displayIteration(overview.iteration))
  setNote('schedule-note', status === 'SCHEDULED' ? '到点自动开始；等待不计执行时长。请保持 NovaWing 运行；关闭后将在重新打开时补启动。' : '')
  var executions = snapshot.codingExecutions || []
  var execution = executions.find((entry) => entry.taskId === overview.taskId)
  setNote('coding-failover', execution && execution.failoverReason ? 'Codex 配额已耗尽，DeepSeek 接力（本 Task 保持 DeepSeek）。' : '')
  var activity = snapshot.executionActivity || {}
  var lastActivity = overview.lastActivityAt
  var lastText = status === 'RUNNING' && lastActivity ? '最后活动 ' + formatTime(lastActivity)
    + (Number.isFinite(activity.idleMs) ? ' · ' + Math.floor(activity.idleMs / 1000) + ' 秒前' : '') : ''
  if (lastText && activity.idleStatus === 'QUIET') lastText += ' · Executor 仍在运行'
  if (lastText && activity.idleStatus === 'LONG_QUIET') lastText += ' · 正在等待 Executor'
  setNote('execution-last-activity', lastText)
}

var activityRows = new Map()

function renderActivities(activities) {
  var list = el('activity-list')
  if (!list) return
  var activeIds = new Set()
  var items = activities.slice(-80)
  setNote('activity-empty', items.length ? '' : '开始后将在这里显示执行、验证和 checkpoint 进展。')
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (activeIds.has(item.id)) continue
    activeIds.add(item.id)
    var row = activityRows.get(item.id)
    if (!row) {
      row = document.createElement('li')
      row.setAttribute('data-activity-id', item.id)
      var time = document.createElement('time')
      time.className = 'time'
      var mark = document.createElement('span')
      mark.className = 'activity-mark'
      var content = document.createElement('div')
      var label = document.createElement('span')
      label.className = 'activity-label'
      var detail = document.createElement('span')
      detail.className = 'activity-detail'
      content.appendChild(label)
      content.appendChild(detail)
      row.appendChild(time)
      row.appendChild(mark)
      row.appendChild(content)
      activityRows.set(item.id, row)
    }
    var state = item.status || 'completed'
    row.className = 'activity-' + state
    var stateText = state === 'running' ? '进行中' : state === 'completed' ? '已完成' : state === 'human_required' ? '需要人工处理' : '失败'
    row.children[0].textContent = formatTime(item.timestamp)
    row.children[0].setAttribute('datetime', item.timestamp)
    row.children[1].textContent = state === 'running' ? '●' : state === 'completed' ? '✓' : '!'
    row.children[1].setAttribute('aria-label', stateText)
    var parts = [item.label]
    if (Number.isFinite(item.durationMs) && item.durationMs > 0) parts.push(formatElapsed(item.durationMs))
    if (item.checkpointSha) parts.push(item.checkpointSha.slice(0, 7))
    row.children[2].children[0].textContent = parts.join(' · ')
    var details = []
    if (item.provider) details.push(providerName(item.provider))
    if (item.model) details.push(item.model)
    if (Number.isFinite(item.changedFileCount)) details.push(item.changedFileCount + ' 个文件')
    for (var verifier of item.verifiers || []) {
      details.push(verifier.name + ' ' + ({ RUNNING: '执行中', PASSED: '通过', FAILED: '失败' })[verifier.outcome])
    }
    row.children[2].children[1].textContent = details.join(' · ')
    row.children[2].children[1].hidden = details.length === 0
    // Reuse each semantic identity across SSE/poll updates, including the
    // transition from started to completed. Unchanged rows keep their DOM node.
    var position = activeIds.size - 1
    if (list.children[position] !== row) list.insertBefore(row, list.children[position] || null)
  }
  for (var entry of activityRows) {
    if (!activeIds.has(entry[0])) {
      list.removeChild(entry[1])
      activityRows.delete(entry[0])
    }
  }
}

function renderControls(rt, controls) {
  var displayState = rt.displayState || rt.state || 'READY'
  var startBtn = el('start-btn')
  var pauseBtn = el('pause-btn')
  var stopBtn = el('stop-btn')
  if (startBtn) {
    startBtn.hidden = rt.started === true || displayState === 'SCHEDULED' || displayState === 'CANCELLED'
  }
  if (pauseBtn) {
    pauseBtn.hidden = displayState !== 'RUNNING'
    pauseBtn.disabled = controls.pauseRequested === true
    pauseBtn.textContent = controls.pauseRequested === true ? '已请求暂停' : '暂停'
  }
  if (stopBtn) {
    stopBtn.hidden = displayState !== 'RUNNING' && displayState !== 'SCHEDULED'
    stopBtn.disabled = controls.stopAfterTaskRequested === true
    stopBtn.textContent = controls.stopAfterTaskRequested === true
      ? '已请求停止'
      : displayState === 'SCHEDULED' ? '取消计划' : '当前 Task 完成后停止'
  }
  if (displayState === 'SUSPENDED' && rt.suspensionReason === 'USER_PAUSED') {
    setText('start-note', '已由你暂停')
  }
}

function renderRecoverable(rt) {
  var card = el('recoverable-card')
  if (!card) return
  var summary = rt.recoverableSummary
  if (rt.displayState !== 'RECOVERABLE' || !summary) {
    card.hidden = true
    return
  }
  card.hidden = false
  setText('recoverable-last-activity', summary.lastActivityAt ? formatTime(summary.lastActivityAt) : '—')
  setText('recoverable-last-task', summary.lastCompletedTaskId || '—')
  setText('recoverable-current-task', summary.currentTaskId || '—')
  setText('recoverable-phase', displayValue(summary.currentPhase, GUARDIAN_PHASE_LABELS))
  setText('recoverable-checkpoint', summary.lastReliableCheckpoint || '—')
  setText('recoverable-next', rt.durableVerificationRecovery
    ? rt.durableVerificationRecovery.message
    : (summary.nextResumableAction || '—'))
}

function renderTasks(cfg, rt) {
  var completed = new Set(rt.completedTaskIds || [])
  var list = el('task-list')
  if (!list) return
  list.textContent = ''
  for (var i = 0; i < cfg.tasks.length; i++) {
    var task = cfg.tasks[i]
    var isCompleted = completed.has(task.id)
    var isCurrent = rt.currentTaskId === task.id
    var li = document.createElement('li')
    li.className = isCompleted ? 'done' : (isCurrent ? 'current' : 'pending')

    var marker = document.createElement('span')
    marker.className = 'mark'
    marker.textContent = isCompleted ? '✓' : (isCurrent ? '●' : '○')

    var label = document.createElement('span')
    label.className = 'task-label'
    label.textContent = task.id + ' ' + task.goal + (rt.state === 'SCHEDULED' ? ' · Scheduled' : '')

    li.appendChild(marker)
    li.appendChild(label)
    list.appendChild(li)
  }
}

function formatElapsed(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '0 秒'
  if (ms === 0) return '0 秒'
  if (ms < 1000) return String(Number(ms.toFixed(2))) + ' 毫秒'
  if (ms < 60000) return String(Number((ms / 1000).toFixed(1))) + ' 秒'
  var seconds = Math.floor(ms / 1000)
  var hours = Math.floor(seconds / 3600)
  var minutes = Math.floor(seconds % 3600 / 60)
  var rest = seconds % 60
  return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + (rest ? rest + '秒' : '')
}

function renderDecision(rt) {
  var card = el('decision-card')
  if (!card) return
  var hr = rt.humanRequired
  var brainFailure = rt.brainFailure
  var category = hr ? hr.category : ''
  var userPaused = rt.state === 'SUSPENDED' && rt.suspensionReason === 'USER_PAUSED'
  var brainUnavailable = rt.state === 'SUSPENDED' &&
    rt.suspensionReason === 'BRAIN_INFRASTRUCTURE_FAILED' && brainFailure
  var checkpointRecovery = rt.recovery && rt.recovery.available === true
  var verificationApproval = rt.pendingVerificationApproval
  var durableVerificationRecovery = rt.durableVerificationRecovery &&
    rt.durableVerificationRecovery.available === true
  if (durableVerificationRecovery) {
    card.hidden = true
    return
  }
  if ((rt.state === 'SUSPENDED' && (hr || userPaused || brainUnavailable)) || checkpointRecovery) {
    card.hidden = false
    setText('decision-title', verificationApproval ? '需要验证授权' : checkpointRecovery
      ? 'Git checkpoint 推送未确认'
      : brainUnavailable
      ? 'Brain 暂时不可用'
      : (userPaused ? '已由你暂停' : '需要人工处理'))
    setText('decision-category', verificationApproval ? '验证授权' : checkpointRecovery
      ? 'Git Push'
      : brainUnavailable
      ? 'Brain Review · ' + displayValue(brainFailure.category)
      : displayValue(userPaused ? 'USER_PAUSED' : category, HUMAN_REQUIRED_LABELS))
    setText('decision-reason', verificationApproval
      ? 'Task: ' + verificationApproval.taskId + '；验证命令：' + verificationApproval.command
      : checkpointRecovery
      ? '当前 Task 已产生本地 checkpoint commit，但远端推送未确认。'
      : brainUnavailable
      ? brainFailure.safeMessage
      : (userPaused ? '准备就绪后可从已保存的 checkpoint 恢复。' : (hr.reason || '—')))

    var input = el('decision-input')
    var decisionBtn = el('resume-decision-btn')
    var approvalBtn = el('approve-verification-btn')
    var repairBtn = el('runtime-repair-btn')
    var resolvedBtn = el('resume-resolved-btn')
    var pausedBtn = el('resume-paused-btn')
    var recoveryBtn = el('recover-checkpoint-btn')
    var budgetRecovery = rt.actionBudgetRecovery
    var needsDecision = !verificationApproval && (category === 'DECISION_REQUIRED' || category === 'STALLED' ||
      (category === 'ACTION_BUDGET_EXHAUSTED' && budgetRecovery && budgetRecovery.available === true))
    var resolvedAck = category === 'ENVIRONMENT_REQUIRED' || category === 'CREDENTIAL_REQUIRED' || category === 'EXECUTOR_RETRY_REQUIRED'
    var repair = rt.runtimeRepair
    if (input) input.hidden = !needsDecision
    if (decisionBtn) decisionBtn.hidden = !needsDecision
    if (approvalBtn) approvalBtn.hidden = !verificationApproval
    if (repairBtn) {
      repairBtn.hidden = !(repair && repair.available === true)
      repairBtn.disabled = !!(repair && repair.inProgress === true)
      repairBtn.textContent = (repair && repair.inProgress === true) ? '正在诊断运行环境…' : '✨ AI 修复并继续'
    }
    if (resolvedBtn) {
      resolvedBtn.hidden = !resolvedAck
      resolvedBtn.textContent = category === 'EXECUTOR_RETRY_REQUIRED' ? '重新执行 Executor' : '已处理，恢复'
    }
    if (pausedBtn) {
      pausedBtn.hidden = !userPaused && !brainUnavailable
      pausedBtn.textContent = brainUnavailable ? '修复后恢复' : '恢复'
    }
    if (recoveryBtn) recoveryBtn.hidden = !checkpointRecovery

    var repairFailure = repair && repair.available === true && repair.lastOutcome && repair.lastOutcome.classification !== 'REPAIRED'
    if (repair && repair.inProgress === true) {
      setText('decision-guidance', '正在诊断 → 检查 Provider → 寻找独立 Reviewer → 修复成功 → 恢复 Session')
    } else if (repairFailure) {
      setText('decision-guidance', 'AI 修复失败：' + (repair.lastOutcome.reason || repair.lastOutcome.classification) + '。可修复后重试，或手动处理。')
    } else if (verificationApproval) {
      setText('decision-guidance', '此命令由 Reviewer 要求，用于完成当前 Task 的 deterministic verification。授权仅对当前 Task 的这一条命令生效。')
    } else if (checkpointRecovery) {
      setText('decision-guidance', 'NovaWing 将先重新验证远端状态；不会重新执行当前 Task。')
    } else if (brainUnavailable) {
      setText('decision-guidance', '修复 browser/Bridge 基础设施后，可从已有 checkpoint 继续当前 Brain Review；不会重新执行已完成的 Executor 工作。')
    } else if (resolvedAck) {
      setText('decision-guidance', category === 'EXECUTOR_RETRY_REQUIRED'
        ? '此前执行没有 workspace inspection、文件改动或可信工具证据。将保留原 Task ID、任务范围和 recovery lineage，重新执行 Executor。'
        : category === 'ENVIRONMENT_REQUIRED'
        ? ((hr.reason || '').indexOf('EXECUTOR_ENVIRONMENT_UNAVAILABLE:') === 0
          ? 'Executor 尚未启动。请按上方原因修复标明的 preflight 项后，从原 Task 重新尝试。'
          : '代码执行阶段已经完成。修复外部服务或本地 runtime 后，NovaWing 只重试失败的 deterministic verification，不会重新运行 Executor。')
        : '请在 NovaWing 外完成所需操作。请勿在此输入凭据。')
    } else if (category === 'PERMISSION_REQUIRED') {
      setText('decision-guidance', '请先更新受信任的项目权限。')
    } else if (category === 'BUDGET_EXHAUSTED') {
      setText('decision-guidance', '请以新批准的限制启动新的 Work Session。')
    } else if (category === 'REPO_DRIFT') {
      setText('decision-guidance', '需要执行 Repository 恢复或显式采纳。')
    } else if (category === 'SAFETY_BLOCKED') {
      setText('decision-guidance', '此安全阻止无法通过通用方式恢复。')
    } else if (category === 'REVIEWER_PROTOCOL_FAILURE') {
      setText('decision-guidance', 'Reviewer 在有限恢复后仍返回格式错误的协议数据。检查 Reviewer 服务后启动新的 Work Session。')
    } else {
      setText('decision-guidance', '')
    }
  } else {
    card.hidden = true
  }
}

async function refresh() {
  try {
    var res = await fetch('/api/status')
    if (!res.ok) return
    var snapshot = await res.json()
    render(snapshot)
  } catch (e) {
    // 瞬时失败静默忽略；SSE 会持续驱动刷新
  }
}

async function start() {
  var btn = el('start-btn')
  if (btn) btn.disabled = true
  try {
    var res = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'X-NovaWing-Control-Token': controlToken }
    })
    var note = el('start-note')
    if (res.status === 202) {
      if (note) note.textContent = 'Work Session 已开始'
    } else if (res.status === 409) {
      if (note) note.textContent = 'Work Session 已开始'
    } else if (res.status === 403) {
      if (note) note.textContent = '开始被拒绝（无权限）'
    } else if (note) {
      note.textContent = '开始失败：' + res.status
    }
  } finally {
    if (btn) btn.disabled = false
  }
  refresh()
}

async function requestControl(path) {
  try {
    await fetch(path, {
      method: 'POST',
      headers: { 'X-NovaWing-Control-Token': controlToken }
    })
  } finally {
    refresh()
  }
}

async function resumeSession(payload) {
  var note = el('resume-note')
  try {
    var res = await fetch('/api/session/resume', {
      method: 'POST',
      headers: {
        'X-NovaWing-Control-Token': controlToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    if (note) note.textContent = res.status === 202 ? '已请求恢复' : '恢复被拒绝'
  } finally {
    refresh()
  }
}

async function resumeRecoverableSession(payload) {
  try {
    await fetch('/api/session/resume-recoverable', {
      method: 'POST',
      headers: {
        'X-NovaWing-Control-Token': controlToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    })
  } finally {
    refresh()
  }
}

var startBtn = el('start-btn')
if (startBtn) startBtn.addEventListener('click', start)
var pauseBtn = el('pause-btn')
if (pauseBtn) pauseBtn.addEventListener('click', function () {
  pauseBtn.disabled = true
  requestControl('/api/session/pause')
})
var stopBtn = el('stop-btn')
if (stopBtn) stopBtn.addEventListener('click', function () {
  stopBtn.disabled = true
  requestControl('/api/session/stop-after-task')
})
var resumeDecisionBtn = el('resume-decision-btn')
if (resumeDecisionBtn) resumeDecisionBtn.addEventListener('click', function () {
  var input = el('decision-input')
  var decision = input ? input.value.trim() : ''
  if (decision.length > 0) resumeSession({ decision: decision })
})
var approveVerificationBtn = el('approve-verification-btn')
if (approveVerificationBtn) approveVerificationBtn.addEventListener('click', async function () {
  approveVerificationBtn.disabled = true
  try { await requestControl('/api/session/approve-verification') } finally { approveVerificationBtn.disabled = false }
})
var resumeResolvedBtn = el('resume-resolved-btn')
if (resumeResolvedBtn) resumeResolvedBtn.addEventListener('click', function () {
  resumeSession({ approval: true })
})
var runtimeRepairBtn = el('runtime-repair-btn')
if (runtimeRepairBtn) runtimeRepairBtn.addEventListener('click', async function () {
  runtimeRepairBtn.disabled = true
  try { await requestControl('/api/session/runtime-repair') } finally { runtimeRepairBtn.disabled = false }
})
var resumePausedBtn = el('resume-paused-btn')
if (resumePausedBtn) resumePausedBtn.addEventListener('click', function () {
  resumeSession({})
})
var resumeRecoverableBtn = el('resume-recoverable-btn')
if (resumeRecoverableBtn) resumeRecoverableBtn.addEventListener('click', async function () {
  resumeRecoverableBtn.disabled = true
  try {
    await resumeRecoverableSession({})
  } finally {
    resumeRecoverableBtn.disabled = false
  }
})
var recoverCheckpointBtn = el('recover-checkpoint-btn')
if (recoverCheckpointBtn) recoverCheckpointBtn.addEventListener('click', async function () {
  recoverCheckpointBtn.disabled = true
  try {
    await requestControl('/api/session/recover-checkpoint')
  } finally {
    recoverCheckpointBtn.disabled = false
  }
})

refresh()

var es = new EventSource('/api/events')
es.addEventListener('connected', refresh)
es.addEventListener('snapshot', refresh)
es.addEventListener('guardian', refresh)
es.addEventListener('activity', refresh)
es.onerror = function () {
  // EventSource 自带重连；无显式 offline 处理
}
`

export const STYLES_CSS = `
:root {
  --bg: #0e1013;
  --panel: #16191f;
  --panel-2: #1c2027;
  --border: #262b34;
  --text: #e7e9ee;
  --muted: #8b93a3;
  --accent: #5b8cff;
  --ok: #4ade80;
  --warn: #facc15;
  --danger: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
}

.brand h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.2px;
}

.brand .subtitle {
  color: var(--muted);
  font-size: 12px;
}

.badge {
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

.badge-ready { color: var(--muted); }
.badge-running { color: var(--ok); border-color: rgba(74, 222, 128, 0.35); }
.badge-suspended { color: var(--warn); border-color: rgba(250, 204, 21, 0.35); }
.badge-recoverable { color: #fb923c; border-color: rgba(251, 146, 60, 0.35); }
.badge-completed { color: var(--accent); border-color: rgba(91, 140, 255, 0.35); }
.badge-failed { color: var(--danger); border-color: rgba(248, 113, 113, 0.35); }
.badge-cancelled { color: var(--muted); }

main {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px;
  display: grid;
  gap: 16px;
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr;
  gap: 12px;
}

.meta {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 18px;
}

.card h2 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
}

.label {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.value {
  font-family: var(--mono);
  font-size: 13px;
  word-break: break-all;
}

.row {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 6px 0;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 28px;
  margin: 0;
}

.overview-grid > div { min-width: 0; }
.overview-grid dt { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.overview-grid dd { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.overview-grid > div:nth-child(-n+2) dd { font-size: 15px; font-weight: 600; }
.runtime-overview .note { margin-bottom: 0; }

.activity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  max-height: 440px;
  overflow-y: auto;
}

.activity-list li {
  display: grid;
  grid-template-columns: 62px 14px minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.activity-list li:last-child { border-bottom: 0; }
.activity-list .time { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.activity-mark { color: var(--ok); }
.activity-running .activity-mark { color: var(--accent); }
.activity-failed .activity-mark { color: var(--danger); }
.activity-human_required .activity-mark { color: var(--warn); }
.activity-label, .activity-detail { display: block; overflow-wrap: anywhere; }
.activity-detail { color: var(--muted); font-size: 12px; margin-top: 3px; }
.activity-detail[hidden] { display: none; }

.task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.task-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--panel-2);
  border: 1px solid transparent;
}

.task-list li.done { color: var(--muted); }
.task-list li.current { border-color: var(--accent); }
.task-list li .mark { font-family: var(--mono); width: 14px; color: var(--accent); }
.task-list li.done .mark { color: var(--ok); }
.task-list li.pending .mark { color: var(--muted); }
.task-list li .task-label { font-family: var(--mono); font-size: 13px; }

.decision {
  border-color: var(--warn);
  background: rgba(250, 204, 21, 0.06);
}

.decision h2 { color: var(--warn); }

.decision textarea {
  width: 100%;
  margin: 8px 0 10px;
  padding: 9px 10px;
  resize: vertical;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: 13px/1.5 var(--mono);
}

.debug pre {
  margin: 12px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.debug summary { cursor: pointer; color: var(--muted); }

.footer {
  max-width: 920px;
  margin: 0 auto;
  padding: 0 24px 32px;
  display: flex;
  align-items: center;
  gap: 12px;
}

button.primary {
  background: var(--accent);
  color: #0b0d12;
  border: none;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

button {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 14px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.note {
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 760px) {
  .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .meta-grid > :last-child { grid-column: 1 / -1; }
  .overview-grid { gap: 14px 18px; }
  .footer { flex-wrap: wrap; }
}

@media (max-width: 420px) {
  main { padding: 16px 12px; }
  .overview-grid { grid-template-columns: 1fr; }
  .activity-list li { gap: 8px; }
}
`
