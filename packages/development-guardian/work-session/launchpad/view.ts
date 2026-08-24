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

  return `
    <article class="session-card" data-config-card="${escapeHtml(config.configId)}">
      <div class="card-head">
        <div>
          <p class="eyebrow">TRUSTED WORK SESSION</p>
          <h2>${escapeHtml(config.project)}</h2>
        </div>
        <span class="card-state" data-card-state>READY</span>
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
        <span data-button-label>启动 Work Session</span>
      </button>
    </article>`
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
  const content = input.configs.length === 0
    ? `<section class="empty-state">
        <p class="eyebrow">NO TRUSTED CONFIGS</p>
        <h2>没有发现可启动的 Work Session</h2>
        <p>请将合法的 JSON 配置放入 NovaWing trusted config directory。</p>
      </section>`
    : `<section class="session-grid" aria-label="Trusted Work Sessions">
        ${input.configs.map(renderCard).join('\n')}
      </section>`

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

  const buttons = Array.from(document.querySelectorAll('[data-config-id]'))
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const configId = button.dataset.configId
      const card = button.closest('[data-config-card]')
      const label = button.querySelector('[data-button-label]')
      const state = card && card.querySelector('[data-card-state]')
      const error = card && card.querySelector('[data-launch-error]')
      if (!configId || !label || !state || !error) return

      button.disabled = true
      label.textContent = '正在启动 NovaWing...'
      state.textContent = 'STARTING'
      state.classList.add('is-starting')
      error.textContent = ''

      try {
        const response = await fetch('/api/session/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-NovaWing-Launchpad-Token': bootstrap.launchToken,
          },
          body: JSON.stringify({ configId }),
        })
        const result = await response.json()
        if (!response.ok || result.accepted !== true || typeof result.controlUrl !== 'string') {
          throw new Error('launch rejected')
        }
        window.location.assign(result.controlUrl)
      } catch {
        button.disabled = false
        label.textContent = '启动 Work Session'
        state.textContent = 'READY'
        state.classList.remove('is-starting')
        error.textContent = 'Work Session 启动失败'
      }
    })
  }
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
  .system-ready span { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
