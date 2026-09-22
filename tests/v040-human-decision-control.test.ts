/**
 * v0.4.0 Phase 4: HUMAN_REQUIRED BUSINESS_DECISION closure.
 *
 * The single shipped seam is a task-/generation-bound PendingHumanAction. These
 * tests pin the boundary: only a pure BUSINESS_DECISION may be answered in-Session,
 * and every permission-class suspension stays manual.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_JS, renderHtml } from '../packages/development-guardian/work-session/control-ui/view.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { derivePendingHumanAction, ANSWERED_BUSINESS_DECISION_REPEATED } from '../packages/development-guardian/work-session/autonomous-diagnosis.js'
import type { PendingHumanAction, WorkSessionDefinition, WorkSessionDurableState } from '../packages/development-guardian/work-session/model.js'
import type { WorkSessionTaskRunContext } from '../packages/development-guardian/work-session/task-runner.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

const BUSINESS_REASON = '恢复需要你的决定或授权：BUSINESS_DECISION'

function pendingAction(prompt: string, options?: readonly string[]): PendingHumanAction {
  return {
    type: 'BUSINESS_DECISION', sessionId: 'w005a-session', taskId: 'T1', generation: 2, prompt,
    ...(options === undefined ? {} : { options }),
  }
}

/** Recording full resume input is how the browser-supplied scope becomes provable. */
class RecordingRuntime extends FakeRuntime {
  readonly submitted: Array<{ decision?: string; approval?: boolean; taskId?: string; generation?: number }> = []
  override async resume(input: { decision?: string; approval?: boolean; taskId?: string; generation?: number }): Promise<WorkSessionDurableState> {
    this.submitted.push(input)
    return super.resume(input)
  }
}

async function serve(state: WorkSessionDurableState) {
  const runtime = new RecordingRuntime(makeDefinition())
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, pollIntervalMs: 10 })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await server.start()
  runtime.state = state
  return { runtime, controller, server, address, token: server.getTokenForTest() }
}

const businessServer = (overrides: Partial<WorkSessionDurableState> = {}) => serve(makeState({
  state: 'SUSPENDED',
  currentTaskId: 'T1',
  humanRequiredGeneration: 2,
  humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
  pendingHumanAction: pendingAction('选择部署环境', ['staging', 'production']),
  ...overrides,
}))

async function post(
  address: { url: string }, token: string, path: string, body: unknown,
  options: { origin?: string; authorized?: boolean } = {},
): Promise<number> {
  const response = await fetch(`${address.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      ...(options.authorized === false ? {} : { 'X-NovaWing-Control-Token': token }),
    },
    body: JSON.stringify(body),
  })
  await response.text()
  return response.status
}

const answer = (overrides: Record<string, unknown> = {}) => ({ taskId: 'T1', generation: 2, decision: 'staging', ...overrides })

test('v040: only a pure business decision becomes a pending human action', () => {
  const base = {
    recoverable: false, diagnosis: '需要产品选择', strategy: 'NONE' as const, instructions: '',
    requiresHuman: true, humanReason: '选择部署环境', requiredAuthority: ['BUSINESS_DECISION' as const], paths: [], commands: [],
  }
  assert.deepEqual(derivePendingHumanAction(base), { type: 'BUSINESS_DECISION', prompt: '选择部署环境' })
  // No authority at all is an ordinary manual stop, never a structured answer request.
  assert.equal(derivePendingHumanAction({ ...base, requiredAuthority: [] }), undefined)
  for (const authority of [
    'EXPAND_ALLOWED_PATHS', 'FORBIDDEN_PATH', 'COMMAND_APPROVAL', 'CREDENTIALS',
    'DESTRUCTIVE_ACTION', 'REMOTE_HISTORY', 'EXTRA_BUDGET',
  ] as const) {
    assert.equal(derivePendingHumanAction({ ...base, requiredAuthority: [authority] }), undefined, authority)
  }
  // A business decision that also asks for authority must stay entirely manual.
  assert.equal(derivePendingHumanAction({ ...base, requiredAuthority: ['BUSINESS_DECISION', 'EXTRA_BUDGET'] }), undefined)
  assert.equal(derivePendingHumanAction({ ...base, humanReason: null })?.prompt, '需要产品选择')
})

test('v040 A: a business decision is accepted only through its dedicated endpoint and resumes once', async () => {
  const app = await businessServer()
  try {
    const pending = app.controller.getSnapshot().runtime.pendingHumanAction
    assert.equal(pending?.type, 'BUSINESS_DECISION')
    assert.equal(pending?.taskId, 'T1')
    assert.equal(pending?.generation, 2)

    // The generic resume must never consume a permission-class suspension.
    assert.equal(await post(app.address, app.token, '/api/session/resume', answer()), 409)
    assert.equal(app.runtime.submitted.length, 0)

    assert.equal(await post(app.address, app.token, '/api/session/human-decision', { ...answer(), extra: 'x' }), 400)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer(), { authorized: false }), 403)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer(), { origin: 'http://evil.example' }), 403)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer({ decision: '' })), 400)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer({ decision: '  ' })), 400)

    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 202)
    assert.deepEqual(app.runtime.submitted[0], { decision: 'staging', taskId: 'T1', generation: 2 })
  } finally { await app.server.close() }
})

test('v040 B: a stale generation never starts a recovery', async () => {
  const app = await businessServer()
  try {
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer({ generation: 1 })), 409)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer({ taskId: 'T2' })), 409)
    assert.equal(app.runtime.submitted.length, 0)
    assert.equal(app.runtime.resumeCalls, 0)
  } finally { await app.server.close() }
})

test('v040 C: a duplicate submit never starts a second recovery', async () => {
  const app = await businessServer()
  try {
    app.runtime.deferResume()
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 202)
    assert.equal(app.controller.getSnapshot().runtime.recoveryInProgress, true)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 409)
    assert.equal(app.runtime.resumeCalls, 1)
    app.runtime.resumeDeferred!.resolve(app.runtime.state!)
    await app.controller.getResumePromise()
    assert.equal(app.runtime.resumeCalls, 1)
  } finally { await app.server.close() }
})

for (const [label, reason] of [
  ['command authorization', '恢复需要你的决定或授权：COMMAND_APPROVAL'],
  ['scope expansion', '恢复建议超出当前路径授权：src/** ; 恢复需要你的决定或授权：EXPAND_ALLOWED_PATHS'],
  ['business decision mixed with authority', '恢复需要你的决定或授权：BUSINESS_DECISION, EXPAND_ALLOWED_PATHS'],
] as const) {
  test(`v040 D/E: ${label} is refused by the business decision endpoint`, async () => {
    const app = await serve(makeState({
      state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
      humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason },
    }))
    try {
      assert.equal(app.controller.getSnapshot().runtime.pendingHumanAction, undefined)
      assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 409)
      assert.equal(app.runtime.resumeCalls, 0)
    } finally { await app.server.close() }
  })
}

test('v040 F: CREDENTIAL_REQUIRED is refused by the business decision endpoint', async () => {
  const app = await serve(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'CREDENTIAL_REQUIRED', reason: '需要完成凭据或登录设置' },
  }))
  try {
    assert.equal(app.controller.getSnapshot().runtime.pendingHumanAction, undefined)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 409)
    assert.equal(app.runtime.resumeCalls, 0)
  } finally { await app.server.close() }
})

test('v040 G: USER_PAUSED never exposes or accepts a business decision', async () => {
  const app = await serve(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    suspensionReason: 'USER_PAUSED',
  }))
  try {
    assert.equal(app.controller.getSnapshot().runtime.pendingHumanAction, undefined)
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 409)
    assert.equal(app.runtime.resumeCalls, 0)
  } finally { await app.server.close() }
})

test('v040 H: a closing controller refuses the business decision', async () => {
  const runtime = new RecordingRuntime(makeDefinition())
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, pollIntervalMs: 10 })
  runtime.state = makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: pendingAction('选择部署环境'),
  })
  await controller.close()
  const result = controller.submitHumanDecision({ taskId: 'T1', generation: 2, decision: 'staging' })
  assert.equal(result.accepted, false)
  assert.match(result.reason ?? '', /closing/u)
  assert.equal(runtime.resumeCalls, 0)
})

test('v040 I: the answer travels as typed, identity-bound evidence and the recovery is consumed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v040-decision-'))
  const definition: WorkSessionDefinition = {
    id: 'business-decision', targetRepo: process.cwd(), branch: 'fixture',
    tasks: [{ id: 'T1', goal: 'choose the deployment environment' }],
    limits: { softMinutes: 20, hardMinutes: 30, maxTasks: 1 },
  }
  const storageUrl = `file:${join(directory, 'session.db')}`
  const ask = (prompt: string) => ({
    status: 'HUMAN_REQUIRED' as const,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
    pendingHumanAction: { type: 'BUSINESS_DECISION' as const, prompt },
  })
  let runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: { async run() { return ask('选择部署环境') } } })
  try {
    const suspended = await runtime.start()
    assert.equal(suspended.state, 'SUSPENDED')
    assert.equal(suspended.pendingHumanAction?.type, 'BUSINESS_DECISION')
    assert.equal(suspended.pendingHumanAction?.sessionId, definition.id)
    assert.equal(suspended.pendingHumanAction?.taskId, 'T1')
    assert.equal(suspended.pendingHumanAction?.generation, suspended.humanRequiredGeneration)
    assert.equal(suspended.taskRecoveryInstructions, undefined)
    const grown = suspended.humanRequiredGeneration!
    await runtime.close()

    let observed: {
      resume?: { decision?: string } | undefined
      context?: WorkSessionTaskRunContext | undefined
    } = {}
    runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: {
      async run(_task, resume, _checkpoint, context) {
        observed = { resume, context }
        return { status: 'COMPLETED' as const }
      },
    } })
    const hydrated = await runtime.loadPersistedState()
    assert.equal(hydrated?.pendingHumanAction?.prompt, '选择部署环境')

    const resumed = await runtime.resume({ decision: 'staging', taskId: 'T1', generation: grown })

    // I: the operator answer is not just a recovered instruction string — it reaches the
    // runner as typed evidence whose task/generation come from the durable pending action.
    assert.deepEqual(observed.context?.answeredHumanAction, {
      type: 'BUSINESS_DECISION', sessionId: definition.id, taskId: 'T1', generation: grown, decision: 'staging',
    })
    assert.deepEqual(observed.context?.recoveryInstructions, ['staging'])
    assert.equal(observed.resume?.decision, 'staging')

    // I: the recovery is consumed — no second identical decision page, the Session moves on.
    assert.equal(resumed.state, 'COMPLETED')
    assert.equal(resumed.pendingHumanAction, undefined)
    assert.equal(resumed.taskRecoveryInstructions?.T1?.[0]?.instruction, 'staging')
    assert.equal(resumed.taskRecoveryInstructions?.T1?.[0]?.generation, grown)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})

test('v040 J: a repeated BUSINESS_DECISION is a blocked protocol violation that no control re-opens', async () => {
  const app = await serve(makeState({
    state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 2,
    humanRequired: { category: 'RECOVERY_BLOCKED', reason: ANSWERED_BUSINESS_DECISION_REPEATED },
  }))
  try {
    // No pending action exists, so the UI cannot render another business decision card.
    assert.equal(app.controller.getSnapshot().runtime.pendingHumanAction, undefined)
    // Neither control can start another recovery, so the generation cannot keep climbing.
    assert.equal(await post(app.address, app.token, '/api/session/human-decision', answer()), 409)
    assert.equal(await post(app.address, app.token, '/api/session/resume', answer()), 409)
    assert.equal(app.runtime.resumeCalls, 0)
  } finally { await app.server.close() }
})

// --- Control UI: the business decision is the only in-Session answer affordance ---

class Element {
  readonly children: Element[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, () => unknown>()
  className = ''
  hidden = false
  disabled = false
  value = ''
  private text = ''
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children.length = 0 }
  appendChild(child: Element): Element { this.children.push(child); return child }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(name: string, listener: () => unknown): void { this.listeners.set(name, listener) }
}

function uiHarness() {
  const elements = new Map<string, Element>()
  const html = renderHtml({ controlToken: 'private-test-token', serverOrigin: 'http://127.0.0.1:4321' })
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/gu)) {
    const element = new Element()
    element.hidden = /\bhidden\b/u.test(match[0])
    elements.set(match[1]!, element)
  }
  elements.get('novawing-bootstrap')!.textContent = JSON.stringify({ controlToken: 'private-test-token' })
  const requests: Array<{ path: string; init?: Record<string, unknown> }> = []
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new Element() },
    fetch: async (path: string, init?: Record<string, unknown>) => {
      requests.push({ path, ...(init === undefined ? {} : { init }) })
      return { ok: false, status: 202 }
    },
    EventSource: class { addEventListener(): void {} },
  })
  vm.runInContext(APP_JS, context)
  return {
    requests,
    node: (id: string) => {
      assert.ok(elements.has(id), `missing HTML element: ${id}`)
      return elements.get(id)!
    },
    render: context.render as (data: unknown) => void,
  }
}

function uiSnapshot(runtime: Record<string, unknown>) {
  return {
    configuredSession: {
      id: 'w005a-session', targetRepo: 'D:/repo', branch: 'feat/ui', controlPlane: 'v2',
      tasks: [{ id: 'T1', goal: 'choose the deployment environment' }],
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    runtime: { started: true, state: 'SUSPENDED', currentTaskId: 'T1', completedTaskIds: [], ...runtime },
    runtimeOverview: {},
    activities: [],
    executionActivity: { idleMs: 0, idleStatus: 'ACTIVE' },
    executionLedger: [],
    debug: {},
    controls: {},
    recentEvents: [],
  }
}

const PENDING_SNAPSHOT = { type: 'BUSINESS_DECISION', taskId: 'T1', generation: 2, prompt: '选择部署环境', options: ['staging', 'production'] }

test('v040 UI: option buttons submit the exact bound answer through the dedicated endpoint', async () => {
  const h = uiHarness()
  h.render(uiSnapshot({
    humanRequiredGeneration: 2, pendingHumanAction: PENDING_SNAPSHOT,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
  }))
  assert.equal(h.node('decision-card').hidden, false)
  assert.equal(h.node('decision-title').textContent, '需要你的决定')
  assert.equal(h.node('decision-category').textContent, '业务决定')
  assert.equal(h.node('decision-reason').textContent, '选择部署环境')
  assert.equal(h.node('decision-input').hidden, true, 'a closed option set uses buttons, not free text')
  assert.equal(h.node('submit-human-decision-btn').hidden, true)

  const options = h.node('business-decision-options')
  assert.equal(options.hidden, false)
  assert.deepEqual(options.children.map((child) => child.textContent), ['staging', 'production'])

  await options.children[0]!.listeners.get('click')!()
  const request = h.requests.find((item) => item.path === '/api/session/human-decision')
  assert.ok(request, 'the option button posts to the dedicated endpoint')
  assert.deepEqual(JSON.parse((request.init as { body: string }).body),
    { taskId: 'T1', generation: 2, decision: 'staging' })
})

test('v040 UI: a free-form business decision uses an explicit input and submit button', () => {
  const h = uiHarness()
  h.render(uiSnapshot({
    humanRequiredGeneration: 2,
    pendingHumanAction: { type: 'BUSINESS_DECISION', taskId: 'T1', generation: 2, prompt: '选择部署环境' },
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: BUSINESS_REASON },
  }))
  assert.equal(h.node('business-decision-options').hidden, true)
  assert.equal(h.node('decision-input').hidden, false)
  assert.equal(h.node('decision-input-label').textContent, '输入你的决定')
  assert.equal(h.node('submit-human-decision-btn').hidden, false)
  assert.match(h.node('decision-guidance').textContent, /不会替你选择业务方案/u)
})

test('v040 UI: permission-class and USER_PAUSED suspensions never show the decision input', () => {
  const h = uiHarness()
  h.render(uiSnapshot({
    humanRequiredGeneration: 1,
    humanRequired: { category: 'RECOVERY_REQUIRES_AUTHORIZATION', reason: '恢复需要你的决定或授权：COMMAND_APPROVAL' },
  }))
  assert.equal(h.node('business-decision-options').hidden, true)
  assert.equal(h.node('decision-input').hidden, true)
  assert.equal(h.node('submit-human-decision-btn').hidden, true)
  assert.equal(h.node('resume-decision-btn').hidden, true)

  h.render(uiSnapshot({ humanRequiredGeneration: 1, suspensionReason: 'USER_PAUSED', pendingHumanAction: PENDING_SNAPSHOT }))
  assert.equal(h.node('business-decision-options').hidden, true)
  assert.equal(h.node('decision-input').hidden, true)
  assert.equal(h.node('submit-human-decision-btn').hidden, true)

  h.render(uiSnapshot({ humanRequiredGeneration: 1, humanRequired: { category: 'CREDENTIAL_REQUIRED', reason: '需要完成凭据或登录设置' } }))
  assert.equal(h.node('business-decision-options').hidden, true)
  assert.equal(h.node('decision-input').hidden, true)
  assert.equal(h.node('submit-human-decision-btn').hidden, true)
})
