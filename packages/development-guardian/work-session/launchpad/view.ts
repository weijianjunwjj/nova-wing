import type { LaunchpadConfigSummary } from './server.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCard(config: LaunchpadConfigSummary): string {
  const taskLabel = config.additionalTaskCount === 0
    ? config.taskId
    : `${config.taskId} + ${config.additionalTaskCount} tasks`
  const gitLabel = [
    config.autoCommit ? 'Auto Commit' : 'Manual Commit',
    config.autoPush ? 'Auto Push' : 'No Auto Push',
  ].join(' · ')
  const emailLabel = config.emailEnabled ? 'Email Enabled' : 'Email Disabled'
  const status = config.status ?? 'READY'
  const recoverable = status === 'RECOVERABLE'
  const buttonLabel = recoverable ? '继续 Work Session' : '打开 Work Session'

  return `
    <article class="session-card" data-config-card="${escapeHtml(config.configId)}">
      <div class="card-head">
        <div>
          <p class="eyebrow">TRUSTED WORK SESSION</p>
          <h2>${escapeHtml(config.project)}</h2>
        </div>
        <div class="card-actions">
          <span class="card-state" data-card-state>${escapeHtml(status)}</span>
          <button class="delete-button" type="button" data-delete-config-id="${escapeHtml(config.configId)}">
            删除
          </button>
        </div>
      </div>

      <div class="task-block">
        <span class="task-id">${escapeHtml(taskLabel)}</span>
        <p title="${escapeHtml(config.goal)}">${escapeHtml(config.goal)}</p>
      </div>

      <dl class="details">
        <div><dt>Branch</dt><dd title="${escapeHtml(config.branch)}">${escapeHtml(config.branch)}</dd></div>
        <div><dt>Reviewer</dt><dd>${escapeHtml(config.reviewer)}</dd></div>
        <div><dt>Executor</dt><dd>${escapeHtml(config.executor)}</dd></div>
        <div><dt>Git</dt><dd>${escapeHtml(gitLabel)}</dd></div>
        <div><dt>Notification</dt><dd>${escapeHtml(emailLabel)}</dd></div>
      </dl>

      <p class="launch-error" data-launch-error role="alert" aria-live="polite"></p>
      <button class="launch-button" type="button" data-config-id="${escapeHtml(config.configId)}">
        <span aria-hidden="true">▶</span>
        <span data-button-label>${escapeHtml(buttonLabel)}</span>
      </button>
    </article>`
}

function renderEmptyState(hidden: boolean): string {
  return `<section class="empty-state" data-empty-state${hidden ? ' hidden' : ''}>
        <p class="eyebrow">NO TRUSTED CONFIGS</p>
        <h2>没有发现可启动的 Work Session</h2>
        <p>请将合法的 JSON 配置放入 NovaWing trusted config directory。</p>
      </section>`
}

export function renderLaunchpadHtml(input: {
  configs: readonly LaunchpadConfigSummary[]
  launchToken: string
  serverOrigin: string
}): string {
  const bootstrap = JSON.stringify({
    launchToken: input.launchToken,
    serverOrigin: input.serverOrigin,
  }).replaceAll('<', '\\u003c')
  const content = `<section class="session-grid" data-session-list aria-label="Trusted Work Sessions"${input.configs.length === 0 ? ' hidden' : ''}>
        ${input.configs.map(renderCard).join('\n')}
      </section>
      ${renderEmptyState(input.configs.length > 0)}`

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NovaWing Launchpad</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="brand"><span aria-hidden="true">✦</span> NovaWing Launchpad</p>
        <p class="subtitle">Autonomous Development Guardian</p>
      </div>
      <div class="system-ready"><span>SYSTEM READY</span><i aria-hidden="true"></i></div>
    </header>
    <section class="composer" aria-labelledby="composer-title">
      <button class="composer-toggle" type="button" data-composer-toggle aria-expanded="false">
        <span aria-hidden="true">＋</span> 新建 Work Session
      </button>
      <form class="composer-form" data-composer-form hidden novalidate>
        <div class="composer-heading">
          <p class="eyebrow">NEW WORK SESSION</p>
          <h2 id="composer-title">新建 Work Session</h2>
        </div>
        <label>项目目录<input name="targetRepo" type="text" autocomplete="off" placeholder="D:\\VSCode\\fly-weave" required></label>
        <label>分支<input name="branch" type="text" readonly value="填写项目目录后自动检测"></label>
        <div class="composer-tasks" data-composer-tasks>
          <fieldset class="composer-task" data-composer-task>
            <legend>Task 1</legend>
            <label>Task ID<input data-task-id type="text" maxlength="64" pattern="[A-Za-z0-9._-]+" autocomplete="off" required placeholder="T011"></label>
            <label>Task<textarea data-task-goal rows="6" required placeholder="描述本次需要完成的工作…"></textarea></label>
            <button class="task-remove" type="button" data-remove-task hidden>删除 Task</button>
          </fieldset>
        </div>
        <button class="task-add" type="button" data-add-task>＋ 添加 Task</button>
        <label>允许修改路径<textarea name="allowedPaths" rows="3" placeholder="apps/api/**\ntests/**" required></textarea><span class="field-hint">每行一条，相对于仓库根目录。</span></label>
        <div class="composer-grid">
          <label>Executor<input name="executorModel" type="text" value="sonnet" required></label>
          <label>Soft Limit（分钟）<input name="softMinutes" type="number" min="0" max="1440" value="45" required></label>
          <label>Hard Limit（分钟）<input name="hardMinutes" type="number" min="1" max="1440" value="90" required></label>
        </div>
        <div class="checks">
          <label><input name="autoCommit" type="checkbox" checked> Auto Commit</label>
          <label><input name="autoPush" type="checkbox"> Auto Push</label>
          <label><input name="emailEnabled" type="checkbox"> 邮件通知（完成 / 失败 / 需人工）</label>
        </div>
        <p class="push-remote" data-push-remote hidden></p>
        <details>
          <summary>高级 Guardian 规则</summary>
          <label>Constraints（可选，每行一条）<textarea name="constraints" rows="2"></textarea></label>
          <label>Acceptance criteria（可选，每行一条）<textarea name="acceptanceCriteria" rows="2"></textarea></label>
          <label>Do not do（可选，每行一条）<textarea name="doNotDo" rows="2"></textarea></label>
          <label>Forbidden paths（可选，每行一条；会附加到安全默认值）<textarea name="forbiddenPaths" rows="2"></textarea></label>
        </details>
        <p class="launch-error" data-composer-error role="alert" aria-live="polite"></p>
        <button class="launch-button" type="submit" data-composer-submit>创建并启动</button>
      </form>
    </section>
    <h2 class="existing-heading">已有 Trusted Work Sessions</h2>
    ${content}
    <footer>LOCAL CONTROL SURFACE · 127.0.0.1</footer>
  </main>
  <script id="novawing-bootstrap" type="application/json">${bootstrap}</script>
  <script src="/app.js"></script>
</body>
</html>`
}

export const LAUNCHPAD_APP_JS = `
(() => {
  'use strict'

  const bootstrapElement = document.getElementById('novawing-bootstrap')
  if (!bootstrapElement) return

  let bootstrap
  try {
    bootstrap = JSON.parse(bootstrapElement.textContent || '{}')
  } catch {
    return
  }

  const mutationHeaders = () => ({
    'Content-Type': 'application/json',
    'X-NovaWing-Launchpad-Token': bootstrap.launchToken,
  })
  const buttons = Array.from(document.querySelectorAll('[data-config-id]'))
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const configId = button.dataset.configId
      const card = button.closest('[data-config-card]')
      const label = button.querySelector('[data-button-label]')
      const state = card && card.querySelector('[data-card-state]')
      const error = card && card.querySelector('[data-launch-error]')
      if (!configId || !label || !state || !error) return

      const originalState = state.textContent
      const originalLabel = label.textContent
      button.disabled = true
      label.textContent = '正在打开 NovaWing...'
      state.textContent = 'STARTING'
      state.classList.add('is-starting')
      error.textContent = ''

      try {
        const response = await fetch('/api/session/start', {
          method: 'POST',
          headers: mutationHeaders(),
          body: JSON.stringify({ configId }),
        })
        const result = await response.json()
        if (!response.ok || result.accepted !== true || typeof result.controlUrl !== 'string') {
          throw new Error('launch rejected')
        }
        window.location.assign(result.controlUrl)
      } catch {
        button.disabled = false
        label.textContent = originalLabel
        state.textContent = originalState
        state.classList.remove('is-starting')
        error.textContent = 'Work Session 启动失败'
      }
    })
  }

  const deleteButtons = Array.from(document.querySelectorAll('[data-delete-config-id]'))
  for (const button of deleteButtons) {
    button.addEventListener('click', async () => {
      const configId = button.dataset.deleteConfigId
      const card = button.closest('[data-config-card]')
      const error = card && card.querySelector('[data-launch-error]')
      if (!configId || !card || !error) return
      if (!window.confirm('确定删除这个 Work Session 吗？此操作只删除 NovaWing Launchpad 配置，不会删除项目代码。')) return

      button.disabled = true
      button.textContent = '正在删除…'
      error.textContent = ''
      try {
        const response = await fetch('/api/session/delete', {
          method: 'POST',
          headers: mutationHeaders(),
          body: JSON.stringify({ configId }),
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok || result.deleted !== true) {
          error.textContent = response.status === 409 && result.error === 'SESSION_ACTIVE'
            ? 'Work Session 正在运行，请先结束后再删除。'
            : 'Work Session 删除失败'
          button.disabled = false
          button.textContent = '删除'
          return
        }
        card.remove()
        const sessionList = document.querySelector('[data-session-list]')
        if (sessionList && !sessionList.querySelector('[data-config-card]')) {
          sessionList.hidden = true
          const emptyState = document.querySelector('[data-empty-state]')
          if (emptyState) emptyState.hidden = false
        }
      } catch {
        error.textContent = 'Work Session 删除失败'
        button.disabled = false
        button.textContent = '删除'
      }
    })
  }

  const toggle = document.querySelector('[data-composer-toggle]')
  const form = document.querySelector('[data-composer-form]')
  if (!toggle || !form) return
  toggle.addEventListener('click', () => {
    const open = form.hidden
    form.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) form.elements.targetRepo.focus()
  })

  const branch = form.elements.branch
  const targetRepo = form.elements.targetRepo
  const taskContainer = form.querySelector('[data-composer-tasks]')
  const addTask = form.querySelector('[data-add-task]')
  const autoCommit = form.elements.autoCommit
  const autoPush = form.elements.autoPush
  const softMinutes = form.elements.softMinutes
  const hardMinutes = form.elements.hardMinutes
  const pushRemote = form.querySelector('[data-push-remote]')
  const error = form.querySelector('[data-composer-error]')
  const lines = (value) => value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean)
  let branchTimer
  let discoveredPushRemote
  const taskRows = () => Array.from(taskContainer.querySelectorAll('[data-composer-task]'))
  let suggestedSoftMinutes = 45
  let suggestedHardMinutes = 90
  const updateTaskRows = () => {
    const rows = taskRows()
    for (const [index, row] of rows.entries()) {
      row.querySelector('legend').textContent = 'Task ' + (index + 1)
      row.querySelector('[data-remove-task]').hidden = rows.length === 1
    }
    addTask.disabled = rows.length >= 10
    const nextSoftMinutes = rows.length === 1 ? 45 : Math.max(45, rows.length * 30)
    const nextHardMinutes = rows.length === 1 ? 90 : Math.max(90, rows.length * 60)
    if (Number(softMinutes.value) === suggestedSoftMinutes) softMinutes.value = String(nextSoftMinutes)
    if (Number(hardMinutes.value) === suggestedHardMinutes) hardMinutes.value = String(nextHardMinutes)
    suggestedSoftMinutes = nextSoftMinutes
    suggestedHardMinutes = nextHardMinutes
  }
  const attachTaskRow = (row) => {
    const taskId = row.querySelector('[data-task-id]')
    const goal = row.querySelector('[data-task-goal]')
    let taskIdEdited = false
    taskId.addEventListener('input', () => {
      taskIdEdited = true
      taskId.removeAttribute('aria-invalid')
      if (error.textContent.startsWith('请填写有效的 Task ID')) error.textContent = ''
    })
    goal.addEventListener('input', () => {
      if (taskIdEdited || taskId.value.trim()) return
      const suggested = goal.value.match(/^\\s*([A-Za-z0-9._-]{1,64})(?:\\s*[:：-]|\\s+)/u)
      if (suggested) taskId.value = suggested[1]
    })
    row.querySelector('[data-remove-task]').addEventListener('click', () => {
      if (taskRows().length === 1) return
      row.remove()
      updateTaskRows()
    })
  }
  attachTaskRow(taskRows()[0])
  addTask.addEventListener('click', () => {
    if (taskRows().length >= 10) return
    const row = taskRows()[0].cloneNode(true)
    row.querySelector('[data-task-id]').value = ''
    row.querySelector('[data-task-goal]').value = ''
    row.querySelector('[data-remove-task]').hidden = false
    taskContainer.appendChild(row)
    attachTaskRow(row)
    updateTaskRows()
    row.querySelector('[data-task-id]').focus()
  })
  updateTaskRows()
  const updatePushRemote = () => {
    if (!autoPush.checked) { pushRemote.hidden = true; return }
    if (discoveredPushRemote) {
      pushRemote.textContent = '将推送到：' + discoveredPushRemote.name + ' · ' + discoveredPushRemote.expectedUrl
    } else {
      pushRemote.textContent = '无法确定 origin push 远端；请先检查项目 remote 后再启用 Auto Push。'
    }
    pushRemote.hidden = false
  }
  autoPush.addEventListener('change', () => {
    if (autoPush.checked) autoCommit.checked = true
    updatePushRemote()
  })
  autoCommit.addEventListener('change', () => {
    if (!autoCommit.checked) autoPush.checked = false
    updatePushRemote()
  })
  form.elements.allowedPaths.addEventListener('input', () => {
    form.elements.allowedPaths.removeAttribute('aria-invalid')
    if (error.textContent === '请填写至少一个允许修改路径。') error.textContent = ''
  })
  targetRepo.addEventListener('input', () => {
    branch.value = '正在检测…'
    discoveredPushRemote = undefined
    updatePushRemote()
    clearTimeout(branchTimer)
    branchTimer = setTimeout(async () => {
      try {
        const response = await fetch('/api/session/branch', {
          method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ targetRepo: targetRepo.value }),
        })
        const result = await response.json()
        branch.value = response.ok ? result.branch : '无法检测分支'
        discoveredPushRemote = response.ok && result.pushRemoteStatus === 'available' ? result.pushRemote : undefined
        updatePushRemote()
      } catch { branch.value = '无法检测分支' }
    }, 350)
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = form.querySelector('[data-composer-submit]')
    const allowedPaths = lines(form.elements.allowedPaths.value)
    const tasks = taskRows().map((row) => ({
      id: row.querySelector('[data-task-id]').value.trim(),
      goal: row.querySelector('[data-task-goal]').value,
    }))
    const invalidTask = tasks.find((task) => !/^[A-Za-z0-9._-]{1,64}$/.test(task.id) || task.goal.trim().length === 0)
    if (invalidTask) {
      error.textContent = !/^[A-Za-z0-9._-]{1,64}$/.test(invalidTask.id)
        ? '请填写有效的 Task ID（仅允许字母、数字、点、下划线和连字符）。'
        : '请填写有效的 Task 描述。'
      const row = taskRows()[tasks.indexOf(invalidTask)]
      const field = row.querySelector(!/^[A-Za-z0-9._-]{1,64}$/.test(invalidTask.id) ? '[data-task-id]' : '[data-task-goal]')
      field.setAttribute('aria-invalid', 'true')
      field.focus()
      return
    }
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
      error.textContent = 'Task ID 不得重复。'
      return
    }
    if (allowedPaths.length === 0) {
      error.textContent = '请填写至少一个允许修改路径。'
      form.elements.allowedPaths.setAttribute('aria-invalid', 'true')
      form.elements.allowedPaths.focus()
      return
    }
    if (autoPush.checked && !discoveredPushRemote) {
      error.textContent = '无法确定 Auto Push 的 origin 远端，请先检查项目 remote。'
      return
    }
    submit.disabled = true
    error.textContent = ''
    const optionalPolicy = (name) => {
      const value = lines(form.elements[name].value)
      return value.length === 0 ? {} : { [name]: value }
    }
    const requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-zA-Z0-9_-]/g, '')
    try {
      const response = await fetch('/api/session/create', {
        method: 'POST', headers: mutationHeaders(),
        body: JSON.stringify({
          requestId, targetRepo: targetRepo.value, tasks,
          executorModel: form.elements.executorModel.value,
          softMinutes: Number(form.elements.softMinutes.value), hardMinutes: Number(form.elements.hardMinutes.value),
          autoCommit: autoCommit.checked, autoPush: autoPush.checked,
          ...(autoPush.checked ? { pushRemote: discoveredPushRemote } : {}),
          emailEnabled: form.elements.emailEnabled.checked,
          guardian: { allowedPaths, ...optionalPolicy('constraints'), ...optionalPolicy('acceptanceCriteria'), ...optionalPolicy('doNotDo'), ...optionalPolicy('forbiddenPaths') },
        }),
      })
      const result = await response.json()
      if (!response.ok || result.accepted !== true || typeof result.controlUrl !== 'string') {
        throw new Error(result.message || 'Work Session 启动失败')
      }
      window.location.assign(result.controlUrl)
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : 'Work Session 启动失败'
      submit.disabled = false
    }
  })
})()
`

export const LAUNCHPAD_STYLES_CSS = `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #080b11;
  color: #f3f6fb;
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

body {
  margin: 0;
  min-width: 720px;
  min-height: 100vh;
  background:
    radial-gradient(circle at 18% 8%, rgba(72, 105, 167, .12), transparent 34%),
    radial-gradient(circle at 84% 80%, rgba(49, 118, 105, .08), transparent 32%),
    #080b11;
}

.shell {
  width: min(1180px, calc(100% - 72px));
  min-height: 100vh;
  margin: 0 auto;
  padding: 48px 0 28px;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 38px;
}

.brand {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -.02em;
}

.brand span { color: #92b7ff; }

.subtitle {
  margin: 8px 0 0;
  color: #7f899a;
  font-size: 13px;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.system-ready {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
  color: #98a3b4;
  font: 600 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: .12em;
}

.system-ready i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #57d99a;
  box-shadow: 0 0 0 5px rgba(87, 217, 154, .08);
  animation: ready-pulse 2.8s ease-in-out infinite;
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
  align-items: start;
}

.composer {
  margin-bottom: 34px;
  border: 1px solid rgba(146, 183, 255, .22);
  border-radius: 18px;
  background: rgba(18, 23, 33, .82);
  box-shadow: 0 20px 55px rgba(0, 0, 0, .18);
}

.composer-toggle {
  width: 100%; padding: 19px 24px; border: 0; background: transparent; color: #cfe0ff;
  cursor: pointer; font: 650 15px/1 "Segoe UI", sans-serif; text-align: left;
}

.composer-toggle span { color: #92b7ff; font-size: 21px; vertical-align: -1px; }
.composer-form { padding: 0 24px 26px; }
.composer-heading { margin: 5px 0 22px; }
.composer-heading h2, .existing-heading { font-size: 20px; }
.composer-form label { display: grid; gap: 8px; margin: 15px 0; color: #b9c4d4; font-size: 13px; }
.composer-form input[type="text"], .composer-form input[type="number"], .composer-form textarea {
  width: 100%; border: 1px solid rgba(151, 170, 202, .2); border-radius: 9px;
  padding: 11px 12px; background: rgba(7, 10, 15, .55); color: #e8eef8;
  font: 14px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.composer-form textarea { resize: vertical; }
.composer-form [aria-invalid="true"] { border-color: #ef9b9b; box-shadow: 0 0 0 2px rgba(239, 155, 155, .15); }
.composer-form input[readonly] { color: #8ea0b9; }
.field-hint { color: #7f899a; font-size: 12px; }
.composer-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 14px; }
.composer-grid label { margin: 0; }
.checks { display: flex; flex-wrap: wrap; gap: 18px; margin: 20px 0; color: #c7cfdb; font-size: 13px; }
.checks label { display: flex; align-items: center; gap: 7px; margin: 0; }
.push-remote { margin: -8px 0 18px; color: #a9c7ff; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.composer details { border-top: 1px solid rgba(151, 170, 202, .1); padding-top: 18px; }
.composer summary { cursor: pointer; color: #a9c7ff; font-size: 13px; }
.composer details p { color: #7f899a; font-size: 12px; line-height: 1.5; }
.existing-heading { margin: 0 0 16px; color: #c7cfdb; }

.session-card,
.empty-state {
  border: 1px solid rgba(151, 170, 202, .14);
  border-radius: 18px;
  background: rgba(18, 23, 33, .82);
  box-shadow: 0 20px 55px rgba(0, 0, 0, .24);
}

.session-card { padding: 26px; }

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.card-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #70809a;
  font: 600 10px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: .14em;
}

h2 {
  margin: 0;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: -.02em;
}

.card-state {
  flex: 0 0 auto;
  padding: 7px 10px;
  border: 1px solid rgba(87, 217, 154, .2);
  border-radius: 999px;
  background: rgba(87, 217, 154, .07);
  color: #72e7ad;
  font: 650 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: .1em;
}

.card-state.is-starting {
  border-color: rgba(146, 183, 255, .25);
  background: rgba(146, 183, 255, .08);
  color: #a9c7ff;
}

.delete-button {
  padding: 7px 11px;
  border: 1px solid rgba(239, 155, 155, .24);
  border-radius: 8px;
  background: rgba(239, 155, 155, .055);
  color: #d8a0a0;
  cursor: pointer;
  font: 600 12px/1 "Segoe UI", sans-serif;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, opacity 140ms ease;
}

.delete-button:hover:not(:disabled) {
  border-color: rgba(239, 155, 155, .5);
  background: rgba(239, 155, 155, .11);
  color: #f1b4b4;
}

.delete-button:focus-visible { outline: 2px solid #ef9b9b; outline-offset: 3px; }
.delete-button:disabled { cursor: wait; opacity: .58; }

.task-block {
  margin: 24px 0;
  padding: 17px 18px;
  border: 1px solid rgba(151, 170, 202, .1);
  border-radius: 13px;
  background: rgba(7, 10, 15, .46);
}

.task-id {
  display: block;
  margin-bottom: 7px;
  color: #a9c7ff;
  font: 650 13px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
}

.task-block p {
  overflow: hidden;
  display: -webkit-box;
  margin: 0;
  color: #e5eaf2;
  font-size: 15px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.details { margin: 0; }

.details div {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 16px;
  min-height: 37px;
  align-items: center;
  border-bottom: 1px solid rgba(151, 170, 202, .075);
}

.details div:last-child { border-bottom: 0; }

.details dt {
  color: #697487;
  font-size: 12px;
}

.details dd {
  overflow: hidden;
  margin: 0;
  color: #c7cfdb;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.launch-error {
  min-height: 20px;
  margin: 14px 0 8px;
  color: #ef9b9b;
  font-size: 12px;
  text-align: center;
}

.launch-button {
  width: 100%;
  height: 50px;
  border: 1px solid rgba(146, 183, 255, .3);
  border-radius: 12px;
  background: linear-gradient(180deg, #345d9f, #294d85);
  box-shadow: 0 10px 28px rgba(32, 72, 134, .2);
  color: #fff;
  cursor: pointer;
  font: 650 14px/1 "Segoe UI", sans-serif;
  letter-spacing: .02em;
  transition: transform 140ms ease, filter 140ms ease, opacity 140ms ease;
}

.launch-button span:first-child { margin-right: 8px; font-size: 11px; }
.launch-button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.07); }
.launch-button:focus-visible { outline: 2px solid #92b7ff; outline-offset: 3px; }
.launch-button:disabled { cursor: wait; opacity: .64; }

.empty-state {
  padding: 72px 28px;
  text-align: center;
}

.empty-state p:last-child { margin: 14px 0 0; color: #7f899a; }

footer {
  margin-top: auto;
  padding-top: 34px;
  color: #485264;
  font: 600 10px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: .14em;
  text-align: center;
}

@keyframes ready-pulse {
  0%, 100% { opacity: .72; }
  50% { opacity: 1; }
}

@media (max-width: 900px) {
  body { min-width: 0; }
  .shell { width: min(100% - 32px, 680px); padding-top: 28px; }
  .session-grid { grid-template-columns: 1fr; }
  .composer-grid { grid-template-columns: 1fr; }
  .system-ready span { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
