import type { LaunchpadConfigSummary } from './server.js'
import type { DependencyHealthReport } from '../dependency-health.js'
import { DEEPSEEK_PRICING_SCHEDULE, getDeepSeekPricingPeriod } from '../schedule-policy.js'
import { CODEX_MODEL_OPTIONS, CODING_EXECUTOR_DEFAULTS, codexModelOption } from '../../coding-executor-config.js'
import { MAX_TASK_BRIEF_CHARS } from './task-brief.js'

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
        ${config.scheduledStartAt == null ? '' : `<div><dt>计划开始</dt><dd><time data-local-time datetime="${escapeHtml(config.scheduledStartAt)}">${escapeHtml(config.scheduledStartAt)}</time></dd></div>`}
        ${config.scheduleSource === 'deepseek_off_peak' ? '<div><dt>调度来源</dt><dd>DeepSeek 闲时 · Off-Peak</dd></div>' : ''}
        <div><dt>Branch</dt><dd title="${escapeHtml(config.branch)}">${escapeHtml(config.branch)}</dd></div>
        <div><dt>Reviewer</dt><dd>${escapeHtml(config.reviewer)}</dd></div>
        <div><dt>Executor</dt><dd>${escapeHtml(config.executorMode ?? 'deepseek')} · ${escapeHtml(config.executorMode === 'deepseek' || config.executorMode === undefined ? config.executor : (codexModelOption(config.codexModel ?? CODING_EXECUTOR_DEFAULTS.codex.model)?.label ?? config.codexModel ?? CODING_EXECUTOR_DEFAULTS.codex.model) + ' · ' + (config.codexReasoningEffort ?? CODING_EXECUTOR_DEFAULTS.codex.reasoningEffort))}</dd></div>
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

/** The topbar reports preflighted component availability, never task activity. */
function launchpadAvailability(report: DependencyHealthReport | undefined, id: 'CORE' | 'BRAIN' | 'EXECUTOR'): string {
  const state = report?.dependencies.find((item) => item.id === id)?.state
  return state ?? 'UNKNOWN'
}

export function renderLaunchpadHtml(input: {
  configs: readonly LaunchpadConfigSummary[]
  launchToken: string
  serverOrigin: string
  dependencyHealth?: DependencyHealthReport
  initialExecutorMode?: 'codex' | 'deepseek'
}): string {
  const initialExecutorMode = input.initialExecutorMode ?? 'codex'
  const executorOptions = [
    ['codex', 'Codex'], ['deepseek', 'DeepSeek'], ['auto', 'Auto'],
  ].map(([value, label]) => `<option value="${value}"${value === initialExecutorMode ? ' selected' : ''}>${label}</option>`).join('')
  const codexModelOptions = CODEX_MODEL_OPTIONS.map((option) =>
    `<option value="${escapeHtml(option.id)}"${option.id === CODING_EXECUTOR_DEFAULTS.codex.model ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')
  const bootstrap = JSON.stringify({
    launchToken: input.launchToken,
    serverOrigin: input.serverOrigin,
    initialExecutorMode,
  }).replaceAll('<', '\\u003c')
  const content = `<section class="analytics-panel" aria-label="最近任务统计">
        <div class="analytics-head"><div><p class="eyebrow">TASK RUN ANALYTICS</p><h2>最近任务</h2></div>
        <label>范围<select data-analytics-limit><option value="5">最近 5 个</option><option value="10">最近 10 个</option><option value="20">最近 20 个</option></select></label></div>
        <div class="analytics-grid" data-analytics-summary><p>正在读取运行统计…</p></div>
        <div data-analytics-runs></div>
        <div data-analytics-reasons><p>正在读取常见问题…</p></div>
      </section>
      <section class="session-grid" data-session-list aria-label="Trusted Work Sessions"${input.configs.length === 0 ? ' hidden' : ''}>
        ${input.configs.map(renderCard).join('\n')}
      </section>
      ${renderEmptyState(input.configs.length > 0)}`
  const componentStates = (['CORE', 'BRAIN', 'EXECUTOR'] as const).map((id) => [id, launchpadAvailability(input.dependencyHealth, id)] as const)
  const healthState = componentStates.some(([, state]) => state === 'UNAVAILABLE' || state === 'DEGRADED')
    ? 'DEGRADED'
    : componentStates.every(([, state]) => state === 'READY') ? 'READY' : 'UNKNOWN'
  const health = componentStates.map(([id, state]) => {
    return `<span data-dependency-health="${id}">${id === 'CORE' ? 'NovaWing Core' : id}: ${escapeHtml(state)}</span>`
  }).join(' · ')

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
      <div class="system-ready" data-system-health="${healthState}"><span>SYSTEM ${healthState}</span><i aria-hidden="true"></i></div>
    </header>
    <p class="subtitle" data-dependency-summary>${health}</p>
    <section class="composer" aria-labelledby="composer-title">
      <button class="composer-toggle" type="button" data-composer-toggle aria-expanded="false">
        <span aria-hidden="true">＋</span> 新建 Work Session
      </button>
      <form class="composer-form" data-composer-form hidden novalidate>
        <div class="composer-heading">
          <p class="eyebrow">NEW WORK SESSION</p>
          <h2 id="composer-title">新建 Work Session</h2>
        </div>
        <section class="task-brief" aria-labelledby="task-brief-title">
          <div><p class="eyebrow">TASK BRIEF / QUICK FILL</p><h3 id="task-brief-title">一次性描述任务</h3></div>
          <textarea data-task-brief data-task-brief-max="${MAX_TASK_BRIEF_CHARS}" rows="7" placeholder="粘贴完整任务描述、项目路径、限制、验证要求等；原始 Brief 会保留在此处，识别结果只会填入下方表单，仍需由你确认并创建。"></textarea>
          <div class="task-brief-actions"><button class="task-add" type="button" data-task-brief-fill>识别并填充</button><button class="task-add" type="button" data-smart-model>智能推荐模型</button></div>
          <p class="field-hint task-brief-result" data-task-brief-result aria-live="polite">Quick Fill 不会自动创建或启动任务。</p>
        </section>
        <label>项目目录<input name="targetRepo" type="text" autocomplete="off" placeholder="D:\\VSCode\\fly-weave" required></label>
        <label>分支<input name="branch" type="text" autocomplete="off" value="填写项目目录后自动检测"><span class="field-hint">默认自动检测；Task Brief 指定的分支必须与项目当前 checkout 一致。</span></label>
        <div class="composer-tasks" data-composer-tasks>
          <fieldset class="composer-task" data-composer-task>
            <legend>Task 1</legend>
            <label>Task ID<input data-task-id type="text" maxlength="64" pattern="[A-Za-z0-9._-]+" autocomplete="off" required placeholder="T011"></label>
            <label>Task<textarea data-task-goal rows="6" maxlength="8000" required placeholder="描述本次需要完成的工作…"></textarea><span class="field-hint" data-task-goal-count>0 / 8000</span></label>
            <button class="task-remove" type="button" data-remove-task hidden>删除 Task</button>
          </fieldset>
        </div>
        <button class="task-add" type="button" data-add-task>＋ 添加 Task</button>
        <label>允许修改路径<textarea name="allowedPaths" rows="3" placeholder="apps/api/**\ntests/**" required></textarea><span class="field-hint">每行一条，相对于仓库根目录。</span></label>
        <div class="composer-grid">
          <label>Executor<select name="executorMode">${executorOptions}</select><span class="field-hint" data-executor-hint></span></label>
          <label data-deepseek-model>DeepSeek runtime model alias<input name="executorModel" type="text" value="sonnet" required><span class="field-hint">沿用本机 Claude CLI → DeepSeek 配置</span></label>
          <label data-codex-model>Model<select name="codexModel">${codexModelOptions}</select><span class="field-hint" data-model-advisor>Auto · GPT-5.6 Terra · High</span></label>
          <label data-codex-reasoning>Reasoning<select name="codexReasoningEffort"><option value="high" selected>High</option></select></label>
          <label>Soft Limit（分钟）<input name="softMinutes" type="number" min="0" max="1440" value="45" required></label>
          <label>Hard Limit（分钟）<input name="hardMinutes" type="number" min="1" max="1440" value="90" required></label>
        </div>
        <div class="checks">
          <fieldset class="start-time">
            <legend>开始时间 / Start Time</legend>
            <div class="schedule-options">
              <label><input type="radio" name="startMode" value="immediate" checked>立即开始</label>
              <label data-off-peak-option hidden><input type="radio" name="startMode" value="deepseek_off_peak">DeepSeek 闲时 <small data-off-peak-label></small></label>
              <label><input type="radio" name="startMode" value="custom">自定义时间</label>
            </div>
            <label data-custom-time hidden>本地开始时间<input type="datetime-local" name="customStartAt"><span class="field-hint" data-local-zone></span></label>
            <p class="field-hint" data-schedule-hint>默认立即开始，不改变现有执行方式。</p>
          </fieldset>
        </div>
        <div class="checks">
          <label><input name="autoCommit" type="checkbox" checked> Auto Commit</label>
          <label><input name="autoPush" type="checkbox"> Auto Push</label>
          <label><input name="emailEnabled" type="checkbox" checked> 邮件通知（完成 / 失败 / 需人工）</label>
        </div>
        <p class="push-remote" data-push-remote hidden></p>
        <details>
          <summary>高级 Guardian 规则</summary>
          <label>Constraints（可选，每行一条）<textarea name="constraints" rows="2"></textarea></label>
          <label>Acceptance criteria（可选，每行一条）<textarea name="acceptanceCriteria" rows="2"></textarea></label>
          <label>Required evidence bindings（每行：criterion =&gt; verifier command）<textarea name="acceptanceEvidenceBindings" rows="3" placeholder="npm test passes. => npm test"></textarea><span class="field-hint">criterion 必须与 Acceptance criteria 完全一致；同一 criterion 可写多行。</span></label>
          <label>Do not do（可选，每行一条）<textarea name="doNotDo" rows="2"></textarea></label>
          <label>Forbidden paths（可选，每行一条；会附加到安全默认值）<textarea name="forbiddenPaths" rows="2"></textarea></label>
        </details>
        <p class="launch-progress" data-composer-progress role="status" aria-live="polite" hidden></p>
        <p class="launch-error" data-composer-error role="alert" aria-live="polite"></p>
        <button class="repair-button" type="button" data-composer-repair hidden>AI 修复并重试</button>
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
  const DEEPSEEK_PRICING_SCHEDULE = ${JSON.stringify(DEEPSEEK_PRICING_SCHEDULE)}
  const CODEX_MODEL_OPTIONS = ${JSON.stringify(CODEX_MODEL_OPTIONS)}
  const getDeepSeekPricingPeriod = ${getDeepSeekPricingPeriod.toString()}

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
  for (const time of document.querySelectorAll('[data-local-time]')) {
    time.textContent = new Date(time.getAttribute('datetime')).toLocaleString()
  }
  if (typeof setInterval === 'function') setInterval(async () => {
    try {
      const response = await fetch('/api/session/configs')
      if (!response.ok) return
      const configs = await response.json()
      for (const card of document.querySelectorAll('[data-config-card]')) {
        const config = configs.find((item) => item.configId === card.dataset.configCard)
        const state = card.querySelector('[data-card-state]')
        if (config && state) state.textContent = config.status || 'READY'
      }
    } catch { /* A disconnected page does not own scheduling. */ }
  }, 10000)
  const analyticsLimit = document.querySelector('[data-analytics-limit]')
  const analyticsSummary = document.querySelector('[data-analytics-summary]')
  const analyticsRuns = document.querySelector('[data-analytics-runs]')
  const analyticsReasons = document.querySelector('[data-analytics-reasons]')
  const durationZh = (ms) => ms == null ? '未知' : Math.round(ms / 60000) + ' 分钟'
  const triZh = (value) => value == null ? '不适用' : value ? '是' : '否'
  const loadAnalytics = async () => {
    if (!analyticsLimit || !analyticsSummary || !analyticsRuns) return
    try {
      const response = await fetch('/api/analytics/recent?limit=' + analyticsLimit.value)
      if (!response.ok) throw new Error('unavailable')
      const result = await response.json(), a = result.aggregate
      const rate = a.zeroHumanCompletionRate == null ? '未知' : Math.round(a.zeroHumanCompletionRate * 100) + '%'
      const zeroHuman = a.completedCount === 0 ? '不适用' : a.zeroHumanCompletionCount + ' / ' + a.completedCount + ' · ' + rate
      const values = [['完成', a.completedCount + ' / ' + a.taskCount], ['零人工完成', zeroHuman],
        ['首次通过', a.firstPassSuccessCount + ' / ' + a.taskCount], ['人工决策', a.humanDecisionCount + ' 次'], ['AI 修复', a.aiRepairCount + ' 次'],
        ['运行时修复', a.runtimeRepairCount + ' 次'], ['平均总耗时', durationZh(a.averageTotalDurationMs)], ['平均执行耗时', durationZh(a.averageExecuteDurationMs)],
        ['平均审查耗时', durationZh(a.averageReviewDurationMs)], ['验证失败', a.verificationFailureCount + ' 次'], ['审查失败', a.reviewFailureCount + ' 次'], ['Provider 切换', a.providerSwitchCount + ' 次']]
      analyticsSummary.replaceChildren(...values.map(([label, value]) => { const item=document.createElement('div'); const name=document.createElement('span'); const data=document.createElement('strong'); name.textContent=label; data.textContent=value; item.append(name,data); return item }))
      analyticsRuns.replaceChildren(...result.summaries.map((run) => { const details=document.createElement('details'); const title=document.createElement('summary'); title.textContent=run.taskId + ' · ' + (run.finalStatus==='COMPLETED'?'已完成':run.finalStatus==='FAILED'?'失败':run.finalStatus) + ' · ' + durationZh(run.totalDurationMs); const body=document.createElement('p'); body.textContent='执行 Provider：' + (run.implementerProviders.join('、')||'未知') + '｜审查 Provider：' + (run.reviewerProviders.join('、')||'无') + '｜零人工完成：' + triZh(run.zeroHumanCompletion) + '｜人工决策：' + run.humanDecisionCount + ' 次｜首次通过：' + (run.firstPassSuccess==null?'未知':run.firstPassSuccess?'是':'否') + '｜Commit：' + (run.commitHash ? run.commitHash.slice(0,8) : run.commitResult); details.append(title,body); return details }))
      if (analyticsReasons) {
        const reasonsResponse = await fetch('/api/analytics/reasons?class=actionable&limit=5')
        const reasons = reasonsResponse.ok ? await reasonsResponse.json() : []
        const items = Array.isArray(reasons) ? reasons : []
        if (items.length === 0) { analyticsReasons.textContent = '最近范围内没有异常或修复原因。' }
        else {
          const heading = document.createElement('p'); heading.className = 'eyebrow'; heading.textContent = '常见问题 / 修复原因'
          const list = document.createElement('ul')
          for (const item of items) { const li = document.createElement('li'); li.textContent = item.reasonCode + ' · ' + item.count + ' 次'; list.append(li) }
          analyticsReasons.replaceChildren(heading, list)
        }
      }
    } catch { analyticsSummary.textContent='运行统计暂不可用；不会影响 Task 执行。'; analyticsRuns.replaceChildren(); analyticsReasons?.replaceChildren() }
  }
  analyticsLimit?.addEventListener('change', loadAnalytics)
  void loadAnalytics()
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
  const customTime = form.elements.customStartAt
  const customLabel = form.querySelector('[data-custom-time]')
  const scheduleHint = form.querySelector('[data-schedule-hint]')
  const pricingLabel = form.querySelector('[data-off-peak-label]')
  const codexModel = form.elements.codexModel
  const codexReasoning = form.elements.codexReasoningEffort
  const modelAdvisor = form.querySelector('[data-model-advisor]')
  let modelMode = 'auto'
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  form.querySelector('[data-local-zone]').textContent = '时区：' + localZone + '；过去或当前时间将立即开始。'
  const synchronizeCodexReasoning = () => {
    const option = CODEX_MODEL_OPTIONS.find((candidate) => candidate.id === codexModel.value)
    if (!option) return
    const previous = codexReasoning.value
    codexReasoning.replaceChildren(...option.supportedReasoningEfforts.map((effort) => {
      const element = document.createElement('option')
      element.value = effort
      element.textContent = effort[0].toUpperCase() + effort.slice(1)
      return element
    }))
    codexReasoning.value = option.supportedReasoningEfforts.includes(previous)
      ? previous
      : (option.supportedReasoningEfforts.includes('high') ? 'high' : option.supportedReasoningEfforts[0])
  }
  const updateSchedule = () => {
    const executor = form.elements.executorMode.value
    const selectedCodexModel = CODEX_MODEL_OPTIONS.find((option) => option.id === codexModel.value)
    synchronizeCodexReasoning()
    form.querySelector('[data-deepseek-model]').hidden = executor !== 'deepseek'
    form.querySelector('[data-codex-model]').hidden = executor === 'deepseek'
    form.querySelector('[data-codex-reasoning]').hidden = executor === 'deepseek'
    form.querySelector('[data-off-peak-option]').hidden = executor !== 'deepseek'
    form.querySelector('[data-executor-hint]').textContent = executor === 'auto'
      ? '优先使用 Codex；额度耗尽时由 DeepSeek 接力'
      : executor === 'codex' ? (selectedCodexModel ? selectedCodexModel.label + ' · ' + codexReasoning.value + ' · 仅使用 Codex' : '仅使用 Codex')
      : 'DeepSeek API · 沿用本机执行配置'
    if (executor !== 'deepseek' && form.elements.startMode.value === 'deepseek_off_peak') form.querySelector('[name="startMode"][value="immediate"]').checked = true
    const mode = form.elements.startMode.value
    const pricing = getDeepSeekPricingPeriod(new Date())
    pricingLabel.textContent = pricing.nextOffPeakAt
      ? pricing.nextOffPeakAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' 开始（北京时间）· 省约 50%'
      : pricing.reason === 'weekend' ? '周末全天闲时' : '当前已是闲时'
    customLabel.hidden = mode !== 'custom'
    if (mode === 'custom' && !customTime.value) {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      customTime.value = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes())
    }
    scheduleHint.textContent = mode === 'deepseek_off_peak'
      ? '按北京时间计算；闲时 API 单价约为高峰的一半。此快捷项不会切换模型，仅适用于实际使用 DeepSeek API 的调用；任务跨入高峰后按当时价格计费。'
      : mode === 'custom' ? '到点自动开始；等待不计入执行时限。NovaWing 关闭期间不执行，重新打开后补启动。'
      : '默认立即开始，不改变现有执行方式。'
    form.querySelector('[data-composer-submit]').textContent = mode === 'immediate' || (mode === 'deepseek_off_peak' && !pricing.nextOffPeakAt)
      ? '创建并启动' : '创建并安排'
  }
  const setModelAdvisor = (recommendation, mode) => {
    if (!recommendation || !modelAdvisor) return
    modelMode = mode
    codexModel.value = recommendation.model
    synchronizeCodexReasoning()
    codexReasoning.value = recommendation.reasoningEffort
    modelAdvisor.textContent = (mode === 'manual' ? '手动选择 · ' : mode === 'explicit' ? 'Task Brief 明确指定 · ' : '智能推荐 · ') + recommendation.reason
    updateSchedule()
  }
  for (const radio of form.querySelectorAll('[name="startMode"]')) radio.addEventListener('change', updateSchedule)
  form.elements.executorMode.addEventListener('change', updateSchedule)
  codexModel.addEventListener('change', () => { modelMode = 'manual'; if (modelAdvisor) modelAdvisor.textContent = '手动选择；点击“智能推荐模型”可恢复 Auto。'; updateSchedule() })
  codexReasoning.addEventListener('change', () => { modelMode = 'manual'; if (modelAdvisor) modelAdvisor.textContent = '手动选择；点击“智能推荐模型”可恢复 Auto。' })
  updateSchedule()
  setInterval(updateSchedule, 30000)
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
  const progress = form.querySelector('[data-composer-progress]')
  let progressTimer
  // 创建并启动可能包含自动契约修复；用分阶段文案替代先出现红色错误页。
  const startProgress = () => {
    if (!progress) return
    const steps = ['正在检查 Task Contract…', '正在自动修复配置…', '修复完成，正在启动 Session…']
    let index = 0
    progress.hidden = false
    progress.textContent = steps[0]
    const advance = () => {
      if (index >= steps.length - 1) return
      index += 1
      progress.textContent = steps[index]
      progressTimer = setTimeout(advance, 2200)
    }
    progressTimer = setTimeout(advance, 1500)
  }
  const stopProgress = () => {
    clearTimeout(progressTimer)
    if (!progress) return
    progress.hidden = true
    progress.textContent = ''
  }
  // 只有最终无法安全修复时才展示自动修复的失败详情。
  const autoRepairMessage = (result) => {
    const attempt = result && result.autoRepair
    if (!attempt) return ''
    const headline = attempt.result === 'AUTO_REPAIR_EXHAUSTED'
      ? '自动修复已达上限，仍未通过校验。'
      : '自动修复未能通过校验。'
    const cycles = '（已尝试 ' + attempt.cycles + '/' + attempt.maxCycles + ' 轮）'
    const reason = attempt.reason ? ' 原因：' + attempt.reason : ''
    return '\\n' + headline + cycles + reason
  }
  const repairButton = form.querySelector('[data-composer-repair]')
  const briefInput = form.querySelector('[data-task-brief]')
  const briefFill = form.querySelector('[data-task-brief-fill]')
  const smartModel = form.querySelector('[data-smart-model]')
  const briefResult = form.querySelector('[data-task-brief-result]')
  const lines = (value) => value.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean)
  let branchTimer
  let discoveredPushRemote
  let lastComposerBody = null
  const discoverTargetRepo = (preserveBranch = false) => {
    if (!preserveBranch) branch.value = '正在检测…'
    discoveredPushRemote = undefined
    updatePushRemote()
    clearTimeout(branchTimer)
    branchTimer = setTimeout(async () => {
      try {
        const response = await fetch('/api/session/branch', {
          method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ targetRepo: targetRepo.value }),
        })
        const result = await response.json()
        if (!preserveBranch) branch.value = response.ok ? result.branch : '无法检测分支'
        discoveredPushRemote = response.ok && result.pushRemoteStatus === 'available' ? result.pushRemote : undefined
        updatePushRemote()
      } catch { if (!preserveBranch) branch.value = '无法检测分支' }
    }, 350)
  }
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
    const goalCount = row.querySelector('[data-task-goal-count]')
    let taskIdEdited = false
    taskId.addEventListener('input', () => {
      taskIdEdited = true
      taskId.removeAttribute('aria-invalid')
      if (error.textContent.startsWith('请填写有效的 Task ID')) error.textContent = ''
    })
    goal.addEventListener('input', () => {
      goalCount.textContent = goal.value.length + ' / 8000'
      goal.removeAttribute('aria-invalid')
      if (error.textContent.startsWith('Task 描述过长')) error.textContent = ''
      if (taskIdEdited || taskId.value.trim()) return
      const suggested = goal.value.match(/^\\s*([A-Za-z0-9._-]{1,64})(?:\\s*[:：-]|\\s+)/u)
      if (suggested) taskId.value = suggested[1]
    })
    goalCount.textContent = goal.value.length + ' / 8000'
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
  // A repair retries the exact payload that failed. Once the operator edits the
  // form that payload is stale, so the affordance is withdrawn until the next
  // create attempt re-proves the failure.
  form.addEventListener('input', () => {
    lastComposerBody = null
    if (repairButton) repairButton.hidden = true
  })
  targetRepo.addEventListener('input', () => discoverTargetRepo())
  const requestBriefAnalysis = async (brief) => {
    const maxBriefChars = Number(briefInput.dataset.taskBriefMax)
    if (Number.isSafeInteger(maxBriefChars) && brief.length > maxBriefChars) {
      throw new Error('Task Brief 超过 ' + maxBriefChars + ' 字符，未进行解析或截断。请拆分或精简后重试。')
    }
    const response = await fetch('/api/session/brief', {
      method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ brief, executorMode: form.elements.executorMode.value }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.fields) throw new Error('Task Brief 无法识别，请继续手动填写表单。')
    return result
  }
  const applyBriefAnalysis = (result, fillFields) => {
    const fields = result.fields || {}
    if (fillFields) {
      targetRepo.value = fields.targetRepo || ''
      branch.value = fields.branch || ''
      const firstTask = taskRows()[0]
      if (fields.taskInstructions) {
        const goal = firstTask.querySelector('[data-task-goal]')
        goal.value = fields.taskInstructions
        goal.dispatchEvent(new Event('input'))
      }
      firstTask.querySelector('[data-task-id]').value = fields.taskId || ''
      form.elements.allowedPaths.value = (Array.isArray(fields.allowedPaths) ? fields.allowedPaths : []).join('\\n')
      form.elements.forbiddenPaths.value = (Array.isArray(fields.forbiddenPaths) ? fields.forbiddenPaths : []).join('\\n')
      form.elements.constraints.value = (Array.isArray(fields.constraints) ? fields.constraints : []).join('\\n')
      form.elements.acceptanceCriteria.value = (Array.isArray(fields.acceptanceCriteria) ? fields.acceptanceCriteria : []).join('\\n')
      form.elements.acceptanceEvidenceBindings.value = (Array.isArray(fields.acceptanceEvidenceBindings) ? fields.acceptanceEvidenceBindings : []).flatMap((binding) => Array.isArray(binding.requiredEvidence) ? binding.requiredEvidence.map((evidence) => binding.criterion + ' => ' + evidence) : []).join('\\n')
      form.elements.doNotDo.value = (Array.isArray(fields.doNotDo) ? fields.doNotDo : []).join('\\n')
      if (fields.executorMode) form.elements.executorMode.value = fields.executorMode
      if (Number.isFinite(fields.softMinutes)) softMinutes.value = String(fields.softMinutes)
      if (Number.isFinite(fields.hardMinutes)) hardMinutes.value = String(fields.hardMinutes)
      if (fields.startMode === 'immediate') form.querySelector('[name="startMode"][value="immediate"]').checked = true
      if (fields.startMode === 'custom' && fields.customStartAt) {
        form.querySelector('[name="startMode"][value="custom"]').checked = true
        customTime.value = fields.customStartAt
      }
      if (typeof fields.autoCommit === 'boolean') autoCommit.checked = fields.autoCommit
      if (typeof fields.autoPush === 'boolean') autoPush.checked = fields.autoPush
      if (typeof fields.emailEnabled === 'boolean') form.elements.emailEnabled.checked = fields.emailEnabled
      if (fields.targetRepo) discoverTargetRepo(Boolean(fields.branch))
      updatePushRemote()
      updateSchedule()
    }
    if (result.modelRecommendation) {
      const mode = result.modelRecommendation.modelExplicit || result.modelRecommendation.reasoningExplicit ? 'explicit' : 'auto'
      setModelAdvisor(result.modelRecommendation, mode)
    }
    const recognized = Array.isArray(result.recognized) && result.recognized.length ? '已识别：' + result.recognized.join('、') + '。' : '未识别到可安全填充的字段。'
    const warnings = Array.isArray(result.warnings) && result.warnings.length ? ' ' + result.warnings.join(' ') : ''
    briefResult.textContent = recognized + warnings + (fillFields ? ' 未识别的项目、分支、Task ID 和权限字段已清空，请核对后创建。' : '')
  }
  briefFill.addEventListener('click', async () => {
    const brief = briefInput.value.trim()
    if (!brief) { briefResult.textContent = '请先输入 Task Brief。'; briefInput.focus(); return }
    briefFill.disabled = true
    briefResult.textContent = '正在识别并验证字段…'
    try { applyBriefAnalysis(await requestBriefAnalysis(brief), true) }
    catch (cause) {
      applyBriefAnalysis({ fields: {} }, true)
      briefResult.textContent = (cause instanceof Error ? cause.message : 'Task Brief 无法识别。') + ' 项目、分支、Task ID 和权限字段已清空，请重新填写。'
    }
    finally { briefFill.disabled = false }
  })
  smartModel.addEventListener('click', async () => {
    const firstTask = taskRows()[0]
    const brief = briefInput.value.trim() || firstTask.querySelector('[data-task-goal]').value.trim()
    if (!brief) { briefResult.textContent = '请先填写 Task Brief 或 Task 描述。'; return }
    smartModel.disabled = true
    try { applyBriefAnalysis(await requestBriefAnalysis(brief), false) }
    catch (cause) { briefResult.textContent = cause instanceof Error ? cause.message : '智能推荐不可用，已保留当前选择。' }
    finally { smartModel.disabled = false }
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = form.querySelector('[data-composer-submit]')
    const allowedPaths = lines(form.elements.allowedPaths.value)
    const tasks = taskRows().map((row) => ({
      id: row.querySelector('[data-task-id]').value.trim(),
      goal: row.querySelector('[data-task-goal]').value,
    }))
    const tooLongTask = tasks.find((task) => task.goal.length > 8000)
    if (tooLongTask) {
      error.textContent = 'Task 描述过长，最大 8000 字符。'
      const field = taskRows()[tasks.indexOf(tooLongTask)].querySelector('[data-task-goal]')
      field.setAttribute('aria-invalid', 'true')
      field.focus()
      return
    }
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
    const evidenceBindingsPolicy = () => {
      const rows = lines(form.elements.acceptanceEvidenceBindings.value)
      if (rows.length === 0) return {}
      const grouped = new Map()
      rows.forEach((row) => {
        const separator = row.indexOf('=>')
        const criterion = separator < 0 ? '' : row.slice(0, separator).trim()
        const evidence = separator < 0 ? '' : row.slice(separator + 2).trim()
        if (!criterion || !evidence) throw new Error('Evidence binding 必须使用 criterion => verifier command 格式。')
        const values = grouped.get(criterion) || []
        if (!values.includes(evidence)) values.push(evidence)
        grouped.set(criterion, values)
      })
      return { acceptanceEvidenceBindings: Array.from(grouped, ([criterion, requiredEvidence]) => ({ criterion, requiredEvidence })) }
    }
    const requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-zA-Z0-9_-]/g, '')
    try {
      const mode = form.elements.startMode.value
      const instant = mode === 'deepseek_off_peak'
        ? getDeepSeekPricingPeriod(new Date()).nextOffPeakAt
        : mode === 'custom' ? new Date(customTime.value) : null
      if (instant && !Number.isFinite(instant.getTime())) throw new Error('请选择有效的自定义开始时间。')
      lastComposerBody = {
        requestId, targetRepo: targetRepo.value, tasks, directPathEnabled: true, goldenPathEnabled: true,
        ...( /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch.value) && !branch.value.includes('..') && !branch.value.endsWith('.lock') && !branch.value.includes('@{') ? { branch: branch.value } : {} ),
        scheduled_start_at: instant ? instant.toISOString() : null,
        schedule_source: mode,
        executorModel: form.elements.executorModel.value,
        executorMode: form.elements.executorMode.value,
        codexModel: form.elements.codexModel.value,
        codexReasoningEffort: form.elements.codexReasoningEffort.value,
        softMinutes: Number(form.elements.softMinutes.value), hardMinutes: Number(form.elements.hardMinutes.value),
        autoCommit: autoCommit.checked, autoPush: autoPush.checked,
        ...(autoPush.checked ? { pushRemote: discoveredPushRemote } : {}),
        emailEnabled: form.elements.emailEnabled.checked,
        guardian: { allowedPaths, ...optionalPolicy('constraints'), ...optionalPolicy('acceptanceCriteria'), ...evidenceBindingsPolicy(), ...optionalPolicy('doNotDo'), ...optionalPolicy('forbiddenPaths') },
      }
      if (repairButton) repairButton.hidden = true
      startProgress()
      const response = await fetch('/api/session/create', {
        method: 'POST', headers: mutationHeaders(),
        body: JSON.stringify(lastComposerBody),
      })
      const result = await response.json()
      if (!response.ok || result.accepted !== true || typeof result.controlUrl !== 'string') {
        if (result.error === 'TASK_CONTRACT_INVALID' && result.repairable === true && repairButton) {
          repairButton.hidden = false
        }
        const contractMessage = result.error === 'TASK_CONTRACT_INVALID' && Array.isArray(result.issues)
          ? result.issues.map((issue) => [issue.issueCode, issue.criterion, issue.reason].filter(Boolean).join(' · ')).join('\\n')
          : ''
        throw new Error((contractMessage || result.message || 'Work Session 启动失败') + autoRepairMessage(result))
      }
      stopProgress()
      window.location.assign(result.controlUrl)
    } catch (cause) {
      stopProgress()
      error.textContent = cause instanceof Error ? cause.message : 'Work Session 启动失败'
      submit.disabled = false
    }
  })

  if (repairButton) repairButton.addEventListener('click', async () => {
    if (!lastComposerBody) { repairButton.hidden = true; return }
    repairButton.disabled = true
    repairButton.textContent = 'AI 正在修复…'
    error.textContent = ''
    try {
      const response = await fetch('/api/session/repair', {
        method: 'POST', headers: mutationHeaders(), body: JSON.stringify(lastComposerBody),
      })
      const result = await response.json()
      if (response.ok && result.accepted === true && typeof result.controlUrl === 'string') {
        window.location.assign(result.controlUrl)
        return
      }
      const contractMessage = result.error === 'TASK_CONTRACT_INVALID' && Array.isArray(result.issues)
        ? result.issues.map((issue) => [issue.issueCode, issue.criterion, issue.reason].filter(Boolean).join(' · ')).join('\\n')
        : ''
      const attempt = result.repairAttempt
      const attemptMessage = attempt
        ? 'AI 修复尝试' + (attempt.classification === 'REPAIRED' ? '已通过机械校验但复检失败' : attempt.classification === 'NOVAWING_PRODUCT_BUG' ? '判定为 NovaWing 产品缺陷（已生成结构化修复任务，未改动 NovaWing）' : '被安全拒绝') + (attempt.reason ? '：' + attempt.reason : '') + (attempt.structuredRepairTask ? '（' + attempt.structuredRepairTask.taskId + '）' : '')
        : ''
      error.textContent = (contractMessage || result.message || 'AI 修复并重试失败') + (attemptMessage ? '\\n' + attemptMessage : '')
    } catch {
      error.textContent = 'AI 修复并重试失败'
    } finally {
      repairButton.disabled = false
      repairButton.textContent = 'AI 修复并重试'
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
.analytics-panel { margin-bottom: 24px; padding: 24px; border: 1px solid rgba(151,170,202,.14); border-radius: 18px; background: rgba(18,23,33,.82); }
.analytics-head { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.analytics-head h2 { margin:0; }
.analytics-head label { color:#9da8b9; font-size:12px; }
.analytics-head select { margin-left:8px; }
.analytics-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:18px; }
.analytics-grid div { padding:12px; border-radius:10px; background:rgba(146,183,255,.06); }
.analytics-grid span,.analytics-grid strong { display:block; }
.analytics-grid span { color:#7f899a; font-size:11px; }
.analytics-grid strong { margin-top:5px; color:#e5ebf5; }
[data-analytics-runs] details { margin-top:10px; color:#c7cfdb; }
[data-analytics-runs] p { color:#8f9aad; }
[data-analytics-reasons] { margin-top:14px; color:#c7cfdb; }
[data-analytics-reasons] p { color:#8f9aad; }
[data-analytics-reasons] ul { margin:6px 0 0; padding-left:18px; color:#c7cfdb; }

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
.task-brief { margin: 0 0 24px; padding: 18px; border: 1px solid rgba(146, 183, 255, .22); border-radius: 12px; background: rgba(72, 105, 167, .07); }
.task-brief h3 { margin: 0; color: #d9e7ff; font-size: 16px; }
.task-brief textarea { margin-top: 14px; }
.task-brief-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.task-brief-actions .task-add { width: auto; margin: 0; }
.task-brief-result { min-height: 18px; margin: 12px 0 0; line-height: 1.5; }
.composer-form label { display: grid; gap: 8px; margin: 15px 0; color: #b9c4d4; font-size: 13px; }
.composer-form input[type="text"], .composer-form input[type="number"], .composer-form textarea, .composer-form select {
  width: 100%; border: 1px solid rgba(151, 170, 202, .2); border-radius: 9px;
  padding: 11px 12px; background: rgba(7, 10, 15, .55); color: #e8eef8;
  font: 14px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.composer-form textarea { resize: vertical; }
.composer-form [aria-invalid="true"] { border-color: #ef9b9b; box-shadow: 0 0 0 2px rgba(239, 155, 155, .15); }
.composer-form input[readonly] { color: #8ea0b9; }
.field-hint { color: #7f899a; font-size: 12px; }
.composer-form select { color-scheme: dark; }
.composer-grid { display: grid; grid-template-columns: 2fr 2fr 1fr 1fr; gap: 14px; align-items: start; }
.composer-grid:has([data-deepseek-model][hidden]) { grid-template-columns: 2fr 1fr 1fr; }
.composer-grid label { margin: 0; }
.checks { display: flex; flex-wrap: wrap; gap: 18px; margin: 20px 0; color: #c7cfdb; font-size: 13px; }
.checks label { display: flex; align-items: center; gap: 7px; margin: 0; }
.start-time { width: 100%; border: 1px solid rgba(151,170,202,.2); border-radius: 10px; padding: 14px; }
.schedule-options { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 14px; }
.schedule-options label { padding: 10px; border: 1px solid rgba(151,170,202,.2); border-radius: 8px; cursor: pointer; flex-wrap: wrap; }
.schedule-options label:has(input:checked) { border-color: #92b7ff; background: rgba(146,183,255,.1); }
.schedule-options small { color: #9eacc1; }
.start-time input[type="datetime-local"] { color-scheme: dark; padding: 8px; border: 1px solid #52627c; border-radius: 6px; background: #111925; color: #e8eef8; }
.start-time .field-hint { line-height: 1.6; }
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

/* 正常可修复的契约只显示进度，不先闪出红色错误块。 */
.launch-progress {
  min-height: 20px;
  margin: 14px 0 8px;
  color: #9fc4ff;
  font-size: 12px;
  text-align: center;
}

.repair-button {
  width: 100%;
  height: 42px;
  margin: 0 0 10px;
  border: 1px solid rgba(87, 217, 154, .3);
  border-radius: 11px;
  background: linear-gradient(180deg, #1e6b4f, #18563f);
  color: #dffcf0;
  cursor: pointer;
  font: 650 13px/1 "Segoe UI", sans-serif;
  letter-spacing: .02em;
  transition: transform 140ms ease, filter 140ms ease, opacity 140ms ease;
}

.repair-button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.07); }
.repair-button:focus-visible { outline: 2px solid #57d99a; outline-offset: 3px; }
.repair-button:disabled { cursor: wait; opacity: .64; }

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
  .analytics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .composer-grid, .composer-grid:has([data-deepseek-model][hidden]) { grid-template-columns: 1fr; }
  .system-ready span { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
