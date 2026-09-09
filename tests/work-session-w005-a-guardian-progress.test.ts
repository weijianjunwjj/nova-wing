/**
 * W005-A Guardian Progress + HUMAN_REQUIRED Rendering
 *
 * 1. GuardianWorkSessionTaskRunner 注入 onProgress → runGuardianTask fake brain/executor
 *    的 REVIEWING/EXECUTING/FINAL_REVIEW/COMPLETED 到达 control event sink。
 * 2. HUMAN_REQUIRED snapshot 渲染包含 decision card 文案与动态值。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  DelegationPacket,
  ExecutionReport,
  GuardianBrain,
  GuardianExecutor,
} from '../packages/development-guardian/index.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/index.js'
import type { GuardianProgressObserver } from '../packages/development-guardian/progress.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { renderHtml, APP_JS } from '../packages/development-guardian/work-session/control-ui/view.js'
import {
  FakeRuntime,
  makeDefinition,
  makeState,
  startServer,
} from './work-session-w005-a-helpers.js'

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: 'task one',
    instructions: verdict === 'proceed' || verdict === 'revise' ? ['do work'] : [],
    constraints: [],
    verification: ['npm test'],
    doNotDo: [],
  }
}

function report(): ExecutionReport {
  return {
    summary: 'done',
    changedFiles: ['src/a.ts'],
    commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
  }
}

await test('W005-A guardian progress: onProgress reaches controller as GUARDIAN_PHASE', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  // 生产 wiring：factory 拿到 eventSink，接到 runner.onProgress。
  const runtime = new FakeRuntime(makeDefinition())
  let progressSink: GuardianProgressObserver | undefined
  const controller = new WorkSessionControlController({
    createRuntime: (eventSink) => {
      progressSink = eventSink
      return runtime
    },
    pollIntervalMs: 10,
  })

  const runner = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    onProgress: (event) => {
      progressSink?.(event)
    },
  })

  const result = await runner.run({ id: 'T1', goal: 'task one' })
  assert.equal(result.status, 'COMPLETED')

  const phases = controller
    .getRecentEvents()
    .filter((event) => event.type === 'GUARDIAN_PHASE')
    .map((event) => event.data.phase)
  for (const phase of ['REVIEWING', 'EXECUTING', 'FINAL_REVIEW', 'COMPLETED']) {
    assert.ok(phases.includes(phase), `missing guardian phase: ${phase}`)
  }
  assert.equal(controller.getSnapshot().guardian.phase, 'COMPLETED')
})

test('Recent Activity folds only consecutive Guardian events with identical safe presentation fields', () => {
  const runtime = new FakeRuntime(makeDefinition())
  let progressSink: GuardianProgressObserver | undefined
  const controller = new WorkSessionControlController({
    createRuntime: (eventSink) => {
      progressSink = eventSink
      return runtime
    },
  })

  progressSink?.({ phase: 'EXECUTING', status: 'completed', iteration: 1, elapsedMs: 2_700 })
  progressSink?.({ phase: 'EXECUTING', status: 'completed', iteration: 1, elapsedMs: 2_700.004 })
  progressSink?.({ phase: 'EXECUTING', status: 'completed', iteration: 2, elapsedMs: 2_700 })

  const guardianEvents = controller.getRecentEvents().filter((event) => event.type === 'GUARDIAN_PHASE')
  assert.equal(guardianEvents.length, 2, 'identical rendered consecutive event is folded')
  assert.equal(guardianEvents[1]?.data.iteration, 2, 'a different iteration must remain visible')
  controller.close()
})

test('V2 progress uses neutral TASK_PHASE telemetry while V1 retains GUARDIAN_PHASE compatibility', () => {
  const runtime = new FakeRuntime(makeDefinition({ controlPlane: 'v2' }))
  let progressSink: GuardianProgressObserver | undefined
  const controller = new WorkSessionControlController({
    createRuntime: (eventSink) => { progressSink = eventSink; return runtime },
  })
  progressSink?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0 })
  assert.equal(controller.getRecentEvents().at(-1)?.type, 'TASK_PHASE')
  assert.equal(controller.getRecentEvents().some((event) => event.type === 'GUARDIAN_PHASE'), false)
  controller.close()
})

await test('W005-A HUMAN_REQUIRED rendering: decision card shows category and reason', async () => {
  // 1. HTML 静态包含 decision card 标题与占位元素。
  const html = renderHtml({ controlToken: 'tok', serverOrigin: 'http://127.0.0.1:4317' })
  assert.ok(html.includes('需要人工决策'))
  assert.ok(html.includes('decision-category'))
  assert.ok(html.includes('decision-reason'))

  // 2. app.js 把 humanRequired.category / reason 渲染进 decision card。
  assert.ok(APP_JS.includes('rt.humanRequired'), 'app.js reads humanRequired')
  assert.ok(APP_JS.includes('decision-category'))
  assert.ok(APP_JS.includes('decision-reason'))

  // 3. snapshot 携带渲染所需动态值。
  const s = await startServer()
  try {
    s.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
    })
    const snapshot = s.controller.getSnapshot()
    assert.equal(snapshot.runtime.state, 'SUSPENDED')
    assert.equal(snapshot.runtime.humanRequired?.category, 'DECISION_REQUIRED')
    assert.equal(snapshot.runtime.humanRequired?.reason, 'choose database mode')
  } finally {
    await s.server.close()
  }
})

test('Brain infrastructure suspension is distinct and accepts only checkpoint recovery', () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({
    state: 'SUSPENDED',
    currentTaskId: 'T1',
    suspensionReason: 'BRAIN_INFRASTRUCTURE_FAILED',
    brainFailure: {
      stage: 'BRAIN_REVIEW',
      category: 'TRANSPORT',
      rootCause: 'ask-bridge unavailable',
      adapter: 'ask-bridge/chatgpt',
      requestedModel: 'GPT-5.6 Sol',
      requestedReasoning: 'high',
      retryable: true,
      degraded: false,
      fingerprint: 'brain-transport:ask-bridge-unavailable',
    },
  })
  const controller = new WorkSessionControlController({ createRuntime: () => runtime })

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.runtime.humanRequired, undefined)
  assert.equal(snapshot.runtime.suspensionReason, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.equal(snapshot.runtime.brainFailure?.stage, 'BRAIN_REVIEW')
  assert.match(snapshot.runtime.brainFailure?.safeMessage ?? '', /Brain 尚未完成 Review/)
  assert.equal(controller.resume({ decision: 'pretend this is a decision' }).accepted, false)
  assert.equal(controller.resume({ approval: true }).accepted, false)
  assert.equal(controller.resume({}).accepted, true)
  assert.deepEqual(runtime.resumeInputs, [{}])
  controller.close()
})
