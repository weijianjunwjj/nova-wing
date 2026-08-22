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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NovaWing — Development Guardian</title>
<link rel="stylesheet" href="/styles.css">
<script type="application/json" id="novawing-bootstrap">${bootstrapJson}</script>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <h1>NovaWing</h1>
    <span class="subtitle">Development Guardian</span>
  </div>
  <div id="state-badge" class="badge badge-ready">READY</div>
</header>

<main>
  <section class="meta-grid">
    <div class="meta">
      <span class="label">Project</span>
      <span id="project" class="value">—</span>
    </div>
    <div class="meta">
      <span class="label">Branch</span>
      <span id="branch" class="value">—</span>
    </div>
    <div class="meta">
      <span class="label">Active time</span>
      <span id="active-time" class="value">00:00</span>
    </div>
    <div class="meta">
      <span class="label">Limits</span>
      <span id="limits" class="value">—</span>
    </div>
  </section>

  <section id="decision-card" class="card decision" hidden>
    <h2 id="decision-title">Needs your decision</h2>
    <div class="row">
      <span class="label">Category</span>
      <span id="decision-category" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">Reason</span>
      <span id="decision-reason" class="value">—</span>
    </div>
    <p id="decision-guidance" class="note"></p>
    <textarea id="decision-input" maxlength="2000" rows="4" hidden></textarea>
    <button id="resume-decision-btn" type="button" class="primary" hidden>Resume with decision</button>
    <button id="resume-resolved-btn" type="button" class="primary" hidden>I've resolved it — Resume</button>
    <button id="resume-paused-btn" type="button" class="primary" hidden>Resume</button>
    <span id="resume-note" class="note"></span>
  </section>

  <section class="card">
    <h2>Tasks</h2>
    <ol id="task-list" class="task-list"></ol>
  </section>

  <section class="card">
    <h2>Current Activity</h2>
    <div class="row">
      <span class="label">Guardian</span>
      <span id="guardian-phase" class="value">—</span>
    </div>
    <div class="row">
      <span class="label">Iteration</span>
      <span id="guardian-iteration" class="value">—</span>
    </div>
    <p id="guardian-detail" class="detail">—</p>
  </section>

  <section class="card">
    <h2>Recent Activity</h2>
    <ul id="recent-list" class="recent-list"></ul>
  </section>

  <details class="card debug">
    <summary>Debug</summary>
    <pre id="debug-output"></pre>
  </details>
</main>

<footer class="footer">
  <button id="start-btn" type="button" class="primary">Start</button>
  <button id="pause-btn" type="button" hidden>Pause</button>
  <button id="stop-btn" type="button" hidden>Stop after task</button>
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
  RUNNING: 'badge-running',
  SUSPENDED: 'badge-suspended',
  COMPLETED: 'badge-completed',
  FAILED: 'badge-failed',
  CANCELLED: 'badge-cancelled'
}

function render(snapshot) {
  var cfg = snapshot.configuredSession
  var rt = snapshot.runtime
  var guardian = snapshot.guardian || {}

  setText('project', cfg.targetRepo)
  setText('branch', cfg.branch)
  setText('active-time', formatDuration(rt.activeElapsedMs))
  setText('limits',
    'Soft ' + cfg.limits.softMinutes + 'm · Hard ' + cfg.limits.hardMinutes +
    'm · Max Tasks ' + cfg.limits.maxTasks)

  var state = rt.state || 'READY'
  var badge = el('state-badge')
  if (badge) {
    badge.textContent = state
    badge.className = 'badge ' + (BADGE_CLASS[state] || 'badge-ready')
  }

  renderTasks(cfg, rt)
  renderGuardian(guardian)
  renderRecent(snapshot.recentEvents || [])
  renderDecision(rt)
  renderControls(rt, snapshot.controls || {})
}

function renderControls(rt, controls) {
  var state = rt.state || 'READY'
  var startBtn = el('start-btn')
  var pauseBtn = el('pause-btn')
  var stopBtn = el('stop-btn')
  if (startBtn) {
    startBtn.hidden = rt.started === true
  }
  if (pauseBtn) {
    pauseBtn.hidden = state !== 'RUNNING'
    pauseBtn.disabled = controls.pauseRequested === true
    pauseBtn.textContent = controls.pauseRequested === true ? 'Pause requested' : 'Pause'
  }
  if (stopBtn) {
    stopBtn.hidden = state !== 'RUNNING'
    stopBtn.disabled = controls.stopAfterTaskRequested === true
    stopBtn.textContent = controls.stopAfterTaskRequested === true
      ? 'Stop requested'
      : 'Stop after task'
  }
  if (state === 'SUSPENDED' && rt.suspensionReason === 'USER_PAUSED') {
    setText('start-note', 'Paused by you')
  }
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
    label.textContent = task.id + ' ' + task.goal

    li.appendChild(marker)
    li.appendChild(label)
    list.appendChild(li)
  }
}

function renderGuardian(guardian) {
  setText('guardian-phase', guardian.phase || '—')
  setText('guardian-iteration',
    guardian.iteration === undefined ? '—' : String(guardian.iteration))
  setText('guardian-detail', guardian.status || '—')
}

function summarize(data) {
  if (!data || typeof data !== 'object') return ''
  var keys = Object.keys(data)
  if (keys.length === 0) return ''
  var parts = []
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]
    parts.push(k + '=' + data[k])
  }
  return parts.join(' ')
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

    var type = document.createElement('span')
    type.className = 'event-type'
    type.textContent = ev.type

    var data = document.createElement('span')
    data.className = 'event-data'
    data.textContent = summarize(ev.data)

    li.appendChild(time)
    li.appendChild(type)
    li.appendChild(data)
    list.appendChild(li)
  }

  var debug = el('debug-output')
  if (debug) debug.textContent = JSON.stringify(events, null, 2)
}

function renderDecision(rt) {
  var card = el('decision-card')
  if (!card) return
  var hr = rt.humanRequired
  var category = hr ? hr.category : ''
  var userPaused = rt.state === 'SUSPENDED' && rt.suspensionReason === 'USER_PAUSED'
  if (rt.state === 'SUSPENDED' && (hr || userPaused)) {
    card.hidden = false
    setText('decision-title', userPaused ? 'Paused by you' : 'Needs your decision')
    setText('decision-category', userPaused ? 'USER_PAUSED' : (category || '—'))
    setText('decision-reason', userPaused ? 'Resume from the saved checkpoint when ready.' : (hr.reason || '—'))

    var input = el('decision-input')
    var decisionBtn = el('resume-decision-btn')
    var resolvedBtn = el('resume-resolved-btn')
    var pausedBtn = el('resume-paused-btn')
    var needsDecision = category === 'DECISION_REQUIRED' || category === 'STALLED'
    var resolvedAck = category === 'ENVIRONMENT_REQUIRED' || category === 'CREDENTIAL_REQUIRED'
    if (input) input.hidden = !needsDecision
    if (decisionBtn) decisionBtn.hidden = !needsDecision
    if (resolvedBtn) resolvedBtn.hidden = !resolvedAck
    if (pausedBtn) pausedBtn.hidden = !userPaused

    if (resolvedAck) {
      setText('decision-guidance', 'Complete the required action outside NovaWing. Do not enter credentials here.')
    } else if (category === 'PERMISSION_REQUIRED') {
      setText('decision-guidance', 'Update trusted project permissions first.')
    } else if (category === 'BUDGET_EXHAUSTED') {
      setText('decision-guidance', 'Start a new Session with newly approved limits.')
    } else if (category === 'REPO_DRIFT') {
      setText('decision-guidance', 'Repository recovery or explicit adoption is required.')
    } else if (category === 'SAFETY_BLOCKED') {
      setText('decision-guidance', 'This safety block cannot be resumed generically.')
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
      if (note) note.textContent = 'Session started'
    } else if (res.status === 409) {
      if (note) note.textContent = 'Session already started'
    } else if (res.status === 403) {
      if (note) note.textContent = 'Start rejected (forbidden)'
    } else if (note) {
      note.textContent = 'Start failed: ' + res.status
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
    if (note) note.textContent = res.status === 202 ? 'Resume requested' : 'Resume rejected'
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
var resumeResolvedBtn = el('resume-resolved-btn')
if (resumeResolvedBtn) resumeResolvedBtn.addEventListener('click', function () {
  resumeSession({ approval: true })
})
var resumePausedBtn = el('resume-paused-btn')
if (resumePausedBtn) resumePausedBtn.addEventListener('click', function () {
  resumeSession({})
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
