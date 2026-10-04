import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { APP_JS, renderHtml } from '../packages/development-guardian/work-session/control-ui/view.js'

class Element {
  readonly children: Element[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, () => unknown>()
  className = ''
  hidden = false
  disabled = false
  value = ''
  private text = ''

  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children.length = 0 }
  appendChild(child: Element): Element { return this.insertBefore(child, null) }
  insertBefore(child: Element, reference: Element | null): Element {
    const previous = this.children.indexOf(child)
    if (previous !== -1) this.children.splice(previous, 1)
    const position = reference === null ? this.children.length : this.children.indexOf(reference)
    assert.ok(position >= 0, 'DOM insertion reference must belong to its parent')
    this.children.splice(position, 0, child)
    return child
  }
  removeChild(child: Element): Element {
    const position = this.children.indexOf(child)
    assert.ok(position >= 0, 'DOM removal target must belong to its parent')
    this.children.splice(position, 1)
    return child
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(name: string, listener: () => unknown): void { this.listeners.set(name, listener) }
}

function harness() {
  const elements = new Map<string, Element>()
  const html = renderHtml({ serverOrigin: 'http://127.0.0.1:4321' })
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/gu)) {
    const element = new Element()
    element.hidden = /\bhidden\b/u.test(match[0])
    elements.set(match[1]!, element)
  }
  elements.get('novawing-bootstrap')!.textContent = JSON.stringify({ })
  const requests: Array<{ path: string; init?: Record<string, unknown> }> = []
  const context = vm.createContext({
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new Element(),
    },
    fetch: async (path: string, init?: Record<string, unknown>) => {
      requests.push({ path, ...(init === undefined ? {} : { init }) })
      return { ok: false, status: 202 }
    },
    EventSource: class { addEventListener(): void {} },
  })
  vm.runInContext(APP_JS, context)
  return {
    html, requests,
    node: (id: string) => {
      assert.ok(elements.has(id), `missing HTML element: ${id}`)
      return elements.get(id)!
    },
    render: context.render as (data: ReturnType<typeof snapshot>) => void,
    formatEta: context.formatEta as (eta: unknown) => string,
  }
}

function snapshot() {
  return {
    configuredSession: {
      id: 'S1', targetRepo: 'D:/repo', branch: 'feat/ui', controlPlane: 'v2',
      tasks: [{ id: 'T1', goal: 'Implement requested UI' }],
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    runtime: { started: true, state: 'RUNNING', currentTaskId: 'T1', completedTaskIds: [] } as Record<string, unknown>,
    runtimeOverview: {
      taskId: 'T1', status: 'RUNNING', currentPhase: 'EXECUTING',
      createdAt: '2026-09-17T08:00:13.000Z', startMode: 'immediate',
      startedAt: '2026-09-17T08:00:13.000Z', completedAt: undefined as string | undefined,
      scheduledStartAt: undefined as string | undefined,
      totalElapsedMs: 377000,
      executor: { provider: 'codex', status: 'RUNNING', model: undefined as string | undefined },
      iteration: { current: 1, maximum: 2 as number | undefined },
      lastActivityAt: '2026-09-17T08:06:28.000Z',
    },
    eta: {
      estimatedCompletionAt: '2026-09-17T08:10:00.000Z', confidence: 'medium',
      uncertaintyMs: 180000, adjusted: false,
    },
    activities: [] as Array<{
      id: string; timestamp: string; status: string; label: string;
      durationMs?: number; provider?: string; model?: string; checkpointSha?: string;
      verifiers?: Array<{ name: string; outcome: string }>;
    }>,
    executionActivity: { idleMs: 2000, idleStatus: 'ACTIVE' },
    executionLedger: [] as Array<Record<string, unknown>>,
    debug: {} as Record<string, unknown>,
    controls: {} as Record<string, unknown>,
  }
}

test('runtime UI has one overview, one semantic timeline and collapsed full Debug', () => {
  const h = harness()
  assert.equal((h.html.match(/<h2>运行概览<\/h2>/gu) ?? []).length, 1)
  assert.equal((h.html.match(/<h2>活动日志<\/h2>/gu) ?? []).length, 1)
  assert.equal((h.html.match(/<dt>/gu) ?? []).length, 10)
  assert.ok(h.html.indexOf('<h2>运行概览') < h.html.indexOf('<h2>活动日志'))
  assert.ok(h.html.indexOf('<h2>活动日志') < h.html.indexOf('<summary>Debug'))
  for (const removed of ['Execution Activity Feed', 'Raw Runtime Log', '<h2>开始时间', '<h2>当前活动', 'recent-list', 'ledger-list']) {
    assert.ok(!h.html.includes(removed), `${removed} must not remain as a parallel UI section`)
  }
  assert.match(h.html, /<details id="debug-panel" class="card debug">/u)
  assert.ok(!/<details[^>]*\bopen\b/u.test(h.html), 'Debug is collapsed by default')
  const s = snapshot()
  s.debug = {
    taskStates: { T1: { verificationPlan: { commands: ['npm test'] }, checkpoint: { commitSha: 'c08d459' } } },
    taskEvents: { T1: [{ eventId: 'event-1', type: 'AGENT_COMPLETED', provider: 'codex' }] },
    humanRequired: { category: 'ENVIRONMENT_REQUIRED' }, error: { reasonCode: 'ENV_UNAVAILABLE' },
  }
  s.executionLedger = Array.from({ length: 45 }, (_, i) => ({ eventId: i + 1, eventType: 'PHASE_STARTED' }))
  h.render(s)
  const debug = JSON.parse(h.node('debug-output').textContent)
  assert.deepEqual(debug.debug, s.debug)
  assert.deepEqual(debug.runtime, s.runtime)
  assert.equal(debug.executionLedger.length, 45)
  assert.ok(!h.node('debug-output').textContent.includes('private-test-token'))
})

test('semantic phase rows update in place and polling never duplicates same-second independent actions', () => {
  const h = harness()
  const s = snapshot()
  s.activities = [{ id: 'S1:T1:execute:1', timestamp: '2026-09-17T08:00:14.000Z', status: 'running', label: 'Executor 开始执行', provider: 'codex' }]
  h.render(s)
  const first = h.node('activity-list').children[0]!
  assert.equal(first.attributes.get('data-activity-id'), 'S1:T1:execute:1')
  assert.equal(first.children[1]!.attributes.get('aria-label'), '进行中')
  s.activities[0] = { ...s.activities[0]!, status: 'completed', label: 'Executor 完成', durationMs: 374000 }
  s.activities.push(
    { id: 'S1:T1:verify:1', timestamp: '2026-09-17T08:06:30.000Z', status: 'completed', label: '验证通过', durationMs: 2000, verifiers: [{ name: 'typecheck', outcome: 'PASSED' }] },
    { id: 'S1:T1:checkpoint:c08d459', timestamp: '2026-09-17T08:06:30.000Z', status: 'completed', label: '已创建 checkpoint', checkpointSha: 'c08d459abcd' },
  )
  h.render(s)
  h.render(s)
  const rows = h.node('activity-list').children
  assert.equal(rows.length, 3)
  assert.equal(rows[0], first, 'completion updates the original Executor DOM node')
  assert.match(first.textContent, /Executor 完成 · 6分14秒/u)
  assert.match(rows[1]!.textContent, /验证通过 · 2 秒/u)
  assert.match(rows[1]!.textContent, /typecheck 通过/u)
  assert.match(rows[2]!.textContent, /checkpoint · c08d459/u)
  assert.equal(first.children[1]!.attributes.get('aria-label'), '已完成')
  const checkpoint = rows[2]!
  s.activities = [s.activities[2]!, s.activities[0]!]
  h.render(s)
  assert.equal(rows.length, 2)
  assert.equal(rows[0], checkpoint)
  assert.equal(rows[1], first)
})

test('completed overview keeps actual duration, provider completion and final Executor cycle', () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'COMPLETED'
  s.runtimeOverview.status = 'COMPLETED'
  s.runtimeOverview.currentPhase = 'COMPLETED'
  s.runtimeOverview.completedAt = '2026-09-17T08:06:30.000Z'
  s.runtimeOverview.executor.status = 'COMPLETED'
  h.render(s)
  assert.equal(h.node('total-elapsed').textContent, '6分17秒')
  assert.equal(h.node('overview-executor').textContent, 'Codex · 已完成')
  assert.equal(h.node('overview-iteration').textContent, '1 / 2')
  assert.equal(h.node('overview-phase').textContent, '已完成')
  assert.equal(h.node('execution-last-activity').hidden, true)
  assert.equal(h.node('execution-last-activity').textContent, '')
  s.executionActivity.idleMs += 60000
  h.render(s)
  assert.equal(h.node('total-elapsed').textContent, '6分17秒')
  assert.equal(h.node('completed-at').textContent, new Date(s.runtimeOverview.completedAt).toLocaleString())
  assert.equal(h.node('created-at').textContent, new Date(s.runtimeOverview.createdAt).toLocaleString())
})

test('Executor cycles display planning, Golden execution/retry and Advanced/resumed semantics', () => {
  const h = harness()
  const s = snapshot()
  s.runtimeOverview.iteration.current = 0
  s.runtimeOverview.executor.status = 'NOT_STARTED'
  h.render(s)
  assert.equal(h.node('overview-iteration').textContent, '尚未执行')
  s.runtimeOverview.iteration.current = 1
  s.runtimeOverview.executor.status = 'RUNNING'
  h.render(s)
  assert.equal(h.node('overview-iteration').textContent, '1 / 2')
  assert.equal(h.node('overview-executor').textContent, 'Codex · 执行中')
  s.runtimeOverview.iteration.current = 2
  h.render(s)
  assert.equal(h.node('overview-iteration').textContent, '2 / 2')
  s.runtimeOverview.iteration = { current: 3, maximum: undefined }
  s.runtime.state = 'RECOVERABLE'
  s.runtimeOverview.status = 'RECOVERABLE'
  h.render(s)
  assert.equal(h.node('overview-iteration').textContent, '第 3 轮')
})

test('ETA shows local first estimate, adjustment and low-confidence fallback without a dash', () => {
  const h = harness()
  const s = snapshot()
  h.render(s)
  const date = new Date(s.eta.estimatedCompletionAt)
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  assert.equal(h.node('estimated-completion').textContent, `${time} · 约 ±3 分钟`)
  s.eta.adjusted = true
  h.render(s)
  assert.equal(h.node('estimated-completion').textContent, `${time} · 已调整 · 约 ±3 分钟`)
  s.eta.confidence = 'low'
  h.render(s)
  assert.equal(h.node('estimated-completion').textContent, `${time} · 已调整 · 粗略估计`)
  assert.equal(h.formatEta(undefined), '正在估算…')
  assert.equal(h.formatEta({ estimatedCompletionAt: 'invalid' }), '正在估算…')
})

test('start modes show schedule only when real and retain cancellation controls', () => {
  const h = harness()
  const s = snapshot()
  h.render(s)
  assert.equal(h.node('start-mode').textContent, '立即开始')
  s.runtime.state = 'SCHEDULED'
  s.runtimeOverview.status = 'SCHEDULED'
  s.runtimeOverview.startMode = 'custom'
  s.runtimeOverview.scheduledStartAt = '2026-09-18T08:00:00.000Z'
  h.render(s)
  assert.equal(h.node('start-mode').textContent, '定时开始 · ' + new Date(s.runtimeOverview.scheduledStartAt).toLocaleString())
  assert.equal(h.node('schedule-note').hidden, false)
  assert.equal(h.node('stop-btn').hidden, false)
  assert.equal(h.node('stop-btn').textContent, '取消计划')
  s.runtimeOverview.startMode = 'deepseek_off_peak'
  s.runtimeOverview.scheduledStartAt = undefined
  h.render(s)
  assert.equal(h.node('start-mode').textContent, 'DeepSeek Off-Peak')
})

test('existing control buttons retain authenticated endpoint handlers', async () => {
  const h = harness()
  const routes = [
    ['start-btn', '/api/session/start'], ['pause-btn', '/api/session/pause'],
    ['stop-btn', '/api/session/stop-after-task'], ['approve-verification-btn', '/api/session/approve-verification'],
    ['runtime-repair-btn', '/api/session/runtime-repair'], ['recover-checkpoint-btn', '/api/session/recover-checkpoint'],
    ['resume-recoverable-btn', '/api/session/resume-recoverable'], ['resume-resolved-btn', '/api/session/resume'],
    ['resume-paused-btn', '/api/session/resume'], ['resume-decision-btn', '/api/session/resume'],
  ] as const
  h.node('decision-input').value = 'Use the approved migration plan'
  for (const [id, path] of routes) {
    const click = h.node(id).listeners.get('click')
    assert.ok(click, `${id} remains actionable`)
    await click()
    const request = h.requests.filter(entry => entry.init !== undefined).at(-1)!
    assert.equal(request.path, path)
    assert.equal(request.init?.method, 'POST')
    assert.equal(request.init?.credentials ?? 'same-origin', 'same-origin')
  }
  assert.equal(h.requests.at(-2)?.init?.body, JSON.stringify({ decision: 'Use the approved migration plan' }))
})

test('engineering Human Required exposes scoped recovery and instructions with usable failure evidence', async () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.humanRequired = { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'Internal English reason enum' }
  s.runtime.humanRequiredGeneration = 4
  s.runtime.autonomousRecovery = { available: true, exhausted: false }
  s.runtime.verificationFailure = { command: 'npm test', classification: 'CODE_FAILURE', exitCode: 1 }
  s.runtimeOverview.executor.status = 'COMPLETED'
  s.runtimeOverview.iteration.current = 2
  s.debug = { taskEvents: { T1: [
    { type: 'AGENT_DISPATCHED', action: 'EXECUTE' }, { type: 'VERIFICATION_FAILED' },
    { type: 'AGENT_DISPATCHED', action: 'EXECUTE' }, { type: 'NO_IMPLEMENTATION_PROGRESS' },
  ] }, taskStates: { T1: { gitState: { changedFiles: ['src/app.ts'], headSha: 'abcdef0123' } } } }
  h.render(s)
  assert.equal(h.node('decision-title').textContent, '需要你的决定')
  assert.equal(h.node('diagnose-continue-btn').hidden, false)
  assert.equal(h.node('diagnose-continue-btn').disabled, false)
  assert.equal(h.node('decision-input').hidden, false)
  assert.equal(h.node('resume-decision-btn').hidden, false)
  assert.match(h.html, /提交指令并继续/u)
  assert.match(h.html, /AI 诊断并继续/u)
  assert.doesNotMatch(h.node('decision-category').textContent, /CODE_FAILURE/u)
  assert.doesNotMatch(h.node('decision-reason').textContent, /Internal English/u)
  assert.match(h.node('decision-attempts').textContent, /第 1 轮 Executor.*验证未通过.*第 2 轮 Executor.*没有产生新的有效修改/u)
  assert.match(h.node('decision-verification').textContent, /npm test.*退出码 1/u)
  assert.match(h.node('decision-changes').textContent, /src\/app.ts.*abcdef01/u)
  assert.equal(h.node('overview-phase').textContent, '等待人工处理')
  assert.equal(h.node('overview-status').textContent, '等待人工处理 · 已暂停')
  assert.equal(h.node('overview-executor').textContent, 'Codex · 已完成')
  assert.equal(h.node('overview-iteration').textContent, '2 / 2')
  await h.node('diagnose-continue-btn').listeners.get('click')!()
  let request = h.requests.filter(entry => entry.init !== undefined).at(-1)!
  assert.equal(request.path, '/api/session/resume')
  assert.deepEqual(JSON.parse(request.init!.body as string), { recovery: 'diagnose', taskId: 'T1', generation: 4 })
  h.node('decision-input').value = '只修改 src，不要修改 tests，重新检查 verifier stderr 后继续。'
  await h.node('resume-decision-btn').listeners.get('click')!()
  request = h.requests.filter(entry => entry.init !== undefined).at(-1)!
  assert.deepEqual(JSON.parse(request.init!.body as string), {
    decision: '只修改 src，不要修改 tests，重新检查 verifier stderr 后继续。', taskId: 'T1', generation: 4,
  })
  assert.equal(request.init!.credentials ?? 'same-origin', 'same-origin')
  assert.equal(h.node('decision-input').value, '', 'accepted instructions are not left for accidental repeat submission')
})

test('recovery progress and exhausted recovery remain actionable without claiming a new Task or new quota', () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.humanRequired = { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'repair failed' }
  s.runtime.autonomousRecovery = { available: false, exhausted: true }
  h.render(s)
  assert.equal(h.node('diagnose-continue-btn').hidden, false)
  assert.equal(h.node('diagnose-continue-btn').disabled, true)
  assert.equal(h.node('decision-input').hidden, false)
  assert.equal(h.node('resume-decision-btn').disabled, false)
  assert.match(h.node('decision-guidance').textContent, /额度已用完.*不会重置恢复额度/u)
  s.runtime.recoveryInProgress = true
  h.render(s)
  assert.equal(h.node('decision-title').textContent, '正在恢复当前任务')
  assert.equal(h.node('overview-phase').textContent, '正在恢复')
  assert.equal(h.node('resume-decision-btn').disabled, true)
  assert.equal(h.node('decision-input').disabled, true)
  assert.match(h.node('decision-guidance').textContent, /保留验证计划、失败证据与执行历史/u)
})

test('permission requests only expose dedicated approval and durable rejection controls', async () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.humanRequired = { category: 'PERMISSION_REQUIRED', reason: 'Exact verifier authorization required' }
  s.runtime.pendingVerificationApproval = { taskId: 'T1', command: 'npm test', generation: 3 }
  h.render(s)
  assert.equal(h.node('approve-verification-btn').hidden, false)
  assert.equal(h.node('reject-verification-btn').hidden, false)
  assert.equal(h.node('decision-input').hidden, true)
  assert.equal(h.node('resume-decision-btn').hidden, true)
  assert.equal(h.node('diagnose-continue-btn').hidden, true)
  await h.node('reject-verification-btn').listeners.get('click')!()
  const request = h.requests.filter(entry => entry.init !== undefined).at(-1)!
  assert.equal(request.path, '/api/session/reject-verification')
  assert.equal(request.init!.credentials ?? 'same-origin', 'same-origin')
  assert.match(h.node('resume-note').textContent, /已拒绝授权.*保持暂停/u)
  s.runtime.pendingVerificationApproval = { taskId: 'T1', command: 'npm test', generation: 3, status: 'REJECTED' }
  h.render(s)
  assert.equal(h.node('approve-verification-btn').disabled, true)
  assert.equal(h.node('reject-verification-btn').disabled, true)
  assert.match(h.node('decision-guidance').textContent, /已拒绝.*证据已保留/u)
  delete s.runtime.pendingVerificationApproval
  h.render(s)
  assert.equal(h.node('decision-title').textContent, '需要授权')
  assert.equal(h.node('approve-verification-btn').hidden, true, 'an unspecified permission cannot receive a generic grant')
  assert.equal(h.node('decision-input').hidden, true)
})

test('polling preserves a draft within its exact Task and clears it when Task or decision generation changes', () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.humanRequired = { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'failed' }
  s.runtime.humanRequiredGeneration = 1
  h.render(s)
  h.node('decision-input').value = 'T1-only instruction'
  h.render(s)
  assert.equal(h.node('decision-input').value, 'T1-only instruction')
  s.runtime.currentTaskId = 'T2'
  h.render(s)
  assert.equal(h.node('decision-input').value, '')
  h.node('decision-input').value = 'old generation'
  s.runtime.humanRequiredGeneration = 2
  h.render(s)
  assert.equal(h.node('decision-input').value, '')
})

test('current terminal and paused runtime states override stale historical UI phases', () => {
  const h = harness()
  const s = snapshot()
  for (const [state, label] of [['FAILED', '运行失败'], ['COMPLETED', '已完成'], ['RECOVERABLE', '等待恢复'], ['PAUSED', '已暂停']]) {
    s.runtime.state = state
    h.render(s)
    assert.equal(h.node('overview-phase').textContent, label)
  }
  s.runtime.state = 'COMPLETED'
  s.runtime.recoveryInProgress = true
  h.render(s)
  assert.equal(h.node('overview-phase').textContent, '已完成', 'completion wins even before the resume promise has settled')
  assert.equal(h.node('decision-card').hidden, true)
})

test('unresolved Human Required after restart has one actionable decision card rather than a competing generic resume', () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.displayState = 'RECOVERABLE'
  s.runtime.humanRequired = { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'failed' }
  s.runtime.autonomousRecovery = { available: true, exhausted: false }
  s.runtime.recoverableSummary = { currentTaskId: 'T1', currentPhase: 'EXECUTING' }
  h.render(s)
  assert.equal(h.node('decision-card').hidden, false)
  assert.equal(h.node('recoverable-card').hidden, true)
  assert.equal(h.node('overview-phase').textContent, '等待人工处理')
})

test('domain recovery projection is the single eligibility source and authority failures never receive generic approval', () => {
  const h = harness()
  const s = snapshot()
  s.runtime.state = 'SUSPENDED'
  s.runtime.humanRequired = { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'failed' }
  s.runtime.autonomousRecovery = { available: false, exhausted: false }
  h.render(s)
  assert.equal(h.node('diagnose-continue-btn').hidden, false)
  assert.equal(h.node('diagnose-continue-btn').disabled, true)
  s.runtime.humanRequired = { category: 'ACTION_BUDGET_EXHAUSTED', reason: 'bounded recovery exhausted' }
  s.runtime.autonomousRecovery = { available: false, exhausted: true }
  h.render(s)
  assert.equal(h.node('decision-input').hidden, false, 'exhaustion still permits durable instructions')
  delete s.runtime.autonomousRecovery
  s.runtime.humanRequired = { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: 'EXPAND_ALLOWED_PATHS' }
  h.render(s)
  assert.equal(h.node('diagnose-continue-btn').hidden, true)
  assert.equal(h.node('decision-input').hidden, true)
  assert.equal(h.node('approve-verification-btn').hidden, true)
  assert.doesNotMatch(h.node('decision-category').textContent + h.node('decision-reason').textContent, /RECOVERY_REQUIRES_AUTHORIZATION|EXPAND_ALLOWED_PATHS/u)
  assert.match(h.node('decision-guidance').textContent, /受信任的项目配置.*不会替你批准/u)
})
