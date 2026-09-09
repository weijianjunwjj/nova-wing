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
      <span class="label">已运行时间</span>
      <span id="active-time" class="value">00:00</span>
    </div>
    <div class="meta">
      <span class="label">限制</span>
      <span id="limits" class="value">—</span>
    </div>
  </section>

  <section class="card" aria-label="Execution">
    <h2>Execution</h2>
    <p id="coding-execution" class="note">尚未选择 Executor</p>
    <p id="coding-failover" class="note"></p>
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
    <button id="resume-resolved-btn" type="button" class="primary" hidden>已处理，恢复</button>
    <button id="resume-paused-btn" type="button" class="primary" hidden>恢复</button>
    <button id="recover-checkpoint-btn" type="button" class="primary" hidden>重新验证并继续</button>
    <span id="resume-note" class="note"></span>
  </section>

  <section class="card" aria-label="开始时间">
    <h2>开始时间</h2>
    <div class="row"><span class="label">创建 / Created</span><span id="created-at" class="value">—</span></div>
    <div class="row"><span class="label">计划 / Scheduled Start</span><span id="scheduled-at" class="value">—</span></div>
    <div class="row"><span class="label">来源 / Reason</span><span id="schedule-source" class="value">—</span></div>
    <div class="row"><span class="label">实际 / Actual Start</span><span id="started-at" class="value">—</span></div>
    <div class="row"><span class="label">完成 / Completed</span><span id="completed-at" class="value">—</span></div>
    <p id="schedule-note" class="note"></p>
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

  <section class="card">
    <h2>当前活动</h2>
    <div class="row">
      <span class="label">Guardian</span>
      <span id="guardian-phase" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">轮次</span>
      <span id="guardian-iteration" class="value">—</span>
    </div>
    <p id="guardian-detail" class="detail">—</p>
  </section>

  <section class="card">
    <h2>最近活动</h2>
    <ul id="recent-list" class="recent-list"></ul>
  </section>

  <section class="card">
    <h2>执行日志</h2>
    <ul id="ledger-list" class="recent-list"></ul>
  </section>

  <details class="card debug">
    <summary>Debug</summary>
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

function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '00:00'
  var totalSeconds = Math.floor(ms / 1000)
  var h = Math.floor(totalSeconds / 3600)
  var m = Math.floor((totalSeconds % 3600) / 60)
  var s = totalSeconds % 60
  var mm = String(m).padStart(2, '0')
  var ss = String(s).padStart(2, '0')
  return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss
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
  REVIEWER_PROTOCOL_FAILURE: 'Reviewer 协议失败',
  BRAIN_INFRASTRUCTURE_FAILED: 'Brain 基础设施故障',
  STALLED: '执行停滞',
  USER_PAUSED: '用户已暂停'
}

var GUARDIAN_PHASE_LABELS = {
  EXECUTING: 'Executor 执行中',
  VERIFYING: '正在验证',
  RECOVERING: '正在恢复',
  REVIEWING: 'Reviewer 审查',
  FINAL_REVIEW: 'Final Review',
  COMPLETED: '已完成',
  HUMAN_REQUIRED: '需要人工处理',
  BRAIN_INFRASTRUCTURE_FAILED: 'Brain 暂时不可用'
}

var GUARDIAN_STATUS_LABELS = {
  active: '进行中',
  completed: '已完成',
  failed: '失败',
  suspended: '已暂停'
}

function displayValue(value, labels) {
  if (value === undefined || value === null || value === '') return '—'
  return (labels && labels[value]) || String(value)
}

function render(snapshot) {
  var cfg = snapshot.configuredSession
  var rt = snapshot.runtime
  var guardian = snapshot.guardian || {}
  var executions = snapshot.codingExecutions || []
  var execution = executions.find((entry) => entry.taskId === rt.currentTaskId) || executions[executions.length - 1]
  setText('coding-execution', execution ? execution.taskId + ' · ' + execution.mode.toUpperCase() + ' · '
    + (execution.activeExecutor || '等待开始') + (execution.model ? ' · ' + execution.model : '')
    + (execution.reasoningEffort ? ' · ' + execution.reasoningEffort : '') : '尚未选择 Executor')
  setText('coding-failover', execution && execution.failoverReason
    ? 'Codex quota exhausted → DeepSeek 接力（本 Task 保持 DeepSeek）'
    : execution && execution.lastError || '')
  var localTime = (value) => value ? new Date(value).toLocaleString() : '—'
  setText('created-at', localTime(rt.createdAt))
  setText('scheduled-at', localTime(rt.scheduledStartAt))
  setText('started-at', localTime(rt.startedAt))
  setText('completed-at', localTime(rt.completedAt))
  setText('schedule-source', rt.scheduleSource === 'deepseek_off_peak' ? 'DeepSeek 闲时 · Off-Peak' : rt.scheduleSource === 'custom' ? '自定义时间' : '立即开始')
  setText('schedule-note', rt.state === 'SCHEDULED' ? '到点自动开始；等待不计执行时长。请保持 NovaWing 运行；关闭后将在重新打开时补启动。' : '')

  setText('project', cfg.targetRepo)
  setText('branch', cfg.branch)
  setText('active-time', formatDuration(rt.activeElapsedMs))
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
  renderGuardian(guardian)
  renderRecent(snapshot.recentEvents || [])
  renderLedger(snapshot.executionLedger || [])
  renderDecision(rt)
  renderRecoverable(rt)
  renderControls(rt, snapshot.controls || {})
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

function renderGuardian(guardian) {
  setText('guardian-phase', displayValue(guardian.phase, GUARDIAN_PHASE_LABELS))
  setText('guardian-iteration',
    displayIteration(guardian.phase, guardian.iteration))
  setText('guardian-detail', displayValue(guardian.status, GUARDIAN_STATUS_LABELS))
}

function displayIteration(phase, iteration) {
  if (typeof iteration !== 'number' || phase === 'PREPARING') return '—'
  if (phase === 'REVIEWING') return '第 ' + (iteration + 1) + ' 轮'
  return iteration > 0 ? '第 ' + iteration + ' 轮' : '—'
}

function formatElapsed(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return ''
  var value = ms < 1000 ? ms : (ms < 60000 ? ms / 1000 : ms / 60000)
  var unit = ms < 1000 ? '毫秒' : (ms < 60000 ? '秒' : '分钟')
  return String(Number((Math.round(value * 100) / 100).toFixed(2))) + ' ' + unit
}

function summarizeEvent(ev) {
  var data = ev.data && typeof ev.data === 'object' ? ev.data : {}
  if (ev.type === 'GUARDIAN_PHASE' || ev.type === 'TASK_PHASE') {
    var parts = [displayValue(data.phase, GUARDIAN_PHASE_LABELS)]
    if (data.status !== undefined) parts.push(displayValue(data.status, GUARDIAN_STATUS_LABELS))
    var iteration = displayIteration(data.phase, data.iteration)
    if (iteration !== '—') parts.push(iteration)
    var elapsed = formatElapsed(data.elapsedMs)
    if (elapsed) parts.push(elapsed)
    return parts.join(' · ')
  }
  var eventLabels = {
    SESSION_STARTED: 'Work Session 已开始', SESSION_STATE_CHANGED: 'Work Session 状态已更新',
    SCHEDULE_CANCELLED: '计划已取消',
    TASK_STARTED: 'Task 已开始', TASK_COMPLETED: 'Task 已完成',
    CHECKPOINT_COMMITTED: 'Git checkpoint 已提交', CHECKPOINT_PUSHED: 'Git checkpoint 已推送',
    HUMAN_REQUIRED: '需要人工处理', SESSION_COMPLETED: 'Work Session 已完成',
    BRAIN_INFRASTRUCTURE_FAILED: 'Brain 暂时不可用',
    SESSION_FAILED: 'Work Session 失败', PAUSE_REQUESTED: '已请求暂停',
    SESSION_PAUSED: 'Work Session 已暂停', STOP_AFTER_TASK_REQUESTED: '当前 Task 完成后停止已请求',
    SESSION_RESUME_REQUESTED: '已请求恢复', SESSION_RESUMED: 'Work Session 已恢复',
    NOTIFICATION_SENT: '通知已发送', NOTIFICATION_FAILED: '通知发送失败'
  }
  var summary = eventLabels[ev.type] || String(ev.type || '')
  var details = []
  if (data.taskId !== undefined && data.taskId !== null) details.push('Task：' + data.taskId)
  if (data.category !== undefined) details.push('类别：' + displayValue(data.category, HUMAN_REQUIRED_LABELS))
  if (data.state !== undefined) details.push('状态：' + displayValue(data.state, STATE_LABELS))
  if (data.message !== undefined) details.push(String(data.message))
  return details.length === 0 ? summary : summary + ' · ' + details.join(' · ')
}

function renderRecent(events) {
  var list = el('recent-list')
  if (!list) return
  list.textContent = ''
  var tail = events.slice(-40)
  for (var i = 0; i < tail.length; i++) {
    var ev = tail[i]
    var li = document.createElement('li')

    var time = document.createElement('span')
    time.className = 'time'
    time.textContent = formatTime(ev.timestamp)

    var data = document.createElement('span')
    data.className = 'event-data'
    data.textContent = summarizeEvent(ev)

    li.appendChild(time)
    li.appendChild(data)
    list.appendChild(li)
  }

  var debug = el('debug-output')
  if (debug) debug.textContent = JSON.stringify(events, null, 2)
}

var FAILURE_STAGE_LABELS = {
  REVIEWER: 'Reviewer', EXECUTOR: 'Executor', VERIFICATION: 'Verification',
  FINAL_REVIEW: 'Final Review', GIT_COMMIT: 'Git Commit', GIT_PUSH: 'Git Push',
  RUNTIME: 'Runtime', NOTIFICATION: 'Notification', UNKNOWN: 'Unknown'
}

function summarizeLedgerEvent(ev) {
  if (ev.eventType === 'SESSION_FAILED') {
    return [
      displayValue(ev.failureStage, FAILURE_STAGE_LABELS),
      '失败',
      displayValue(ev.failureCategory),
      displayValue(ev.safeMessage)
    ].join(' · ')
  }
  if (ev.eventType === 'GIT_COMMIT_COMPLETED') {
    return 'Git Commit 已完成 · Task：' + displayValue(ev.taskId) + ' · SHA：' + displayValue(ev.commitSha)
  }
  if (ev.eventType === 'GIT_PUSH_COMPLETED') {
    return 'Git Push 已完成 · Task：' + displayValue(ev.taskId) + ' · SHA：' + displayValue(ev.pushSha)
  }
  if (ev.eventType === 'CHECKPOINT_RECOVERY_REQUESTED' ||
      ev.eventType === 'CHECKPOINT_RECOVERY_COMPLETED' ||
      ev.eventType === 'CHECKPOINT_RECOVERY_FAILED') {
    return 'Git checkpoint 恢复 · Task：' + displayValue(ev.taskId) +
      ' · ' + displayValue(ev.recoveryAction) + ' · ' + displayValue(ev.status)
  }
  if (ev.eventType === 'NOTIFICATION_SENT' || ev.eventType === 'NOTIFICATION_FAILED') {
    return displayValue(ev.notificationKind) + ' 通知' +
      (ev.eventType === 'NOTIFICATION_SENT' ? '已发送' : '发送失败')
  }
  var parts = [displayValue(ev.eventType)]
  if (ev.taskId) parts.push('Task：' + ev.taskId)
  if (ev.phase) parts.push(displayValue(ev.phase, GUARDIAN_PHASE_LABELS))
  if (ev.status) parts.push(displayValue(ev.status, GUARDIAN_STATUS_LABELS))
  return parts.join(' · ')
}

function renderLedger(events) {
  var list = el('ledger-list')
  if (!list) return
  list.textContent = ''
  var tail = events.slice(-30)
  for (var i = 0; i < tail.length; i++) {
    var ev = tail[i]
    var li = document.createElement('li')
    var time = document.createElement('span')
    time.className = 'time'
    time.textContent = formatTime(ev.timestamp)
    var data = document.createElement('span')
    data.className = 'event-data'
    data.textContent = summarizeLedgerEvent(ev)
    li.appendChild(time)
    li.appendChild(data)
    list.appendChild(li)
  }
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
    var resolvedBtn = el('resume-resolved-btn')
    var pausedBtn = el('resume-paused-btn')
    var recoveryBtn = el('recover-checkpoint-btn')
    var needsDecision = !verificationApproval && (category === 'DECISION_REQUIRED' || category === 'STALLED')
    var resolvedAck = category === 'ENVIRONMENT_REQUIRED' || category === 'CREDENTIAL_REQUIRED' || category === 'EXECUTOR_RETRY_REQUIRED'
    if (input) input.hidden = !needsDecision
    if (decisionBtn) decisionBtn.hidden = !needsDecision
    if (approvalBtn) approvalBtn.hidden = !verificationApproval
    if (resolvedBtn) {
      resolvedBtn.hidden = !resolvedAck
      resolvedBtn.textContent = category === 'EXECUTOR_RETRY_REQUIRED' ? '重新执行 Executor' : '已处理，恢复'
    }
    if (pausedBtn) {
      pausedBtn.hidden = !userPaused && !brainUnavailable
      pausedBtn.textContent = brainUnavailable ? '修复后恢复' : '恢复'
    }
    if (recoveryBtn) recoveryBtn.hidden = !checkpointRecovery

    if (verificationApproval) {
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
  grid-template-columns: repeat(4, 1fr);
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

.detail {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  margin: 4px 0 0;
}

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

.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.recent-list li {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 12px;
}

.recent-list .time { color: var(--muted); flex: none; }
.recent-list .event-type { color: var(--accent); flex: none; width: 190px; }
.recent-list .event-data { color: var(--text); word-break: break-all; }

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
  .meta-grid { grid-template-columns: repeat(2, 1fr); }
}
`
