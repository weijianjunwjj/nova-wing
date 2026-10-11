/**
 * W005-A Guardian Progress + HUMAN_REQUIRED Rendering
 *
 * 1. GuardianWorkSessionTaskRunner 注入 onProgress → runGuardianTask fake brain/executor
 *    的 REVIEWING/EXECUTING/FINAL_REVIEW/COMPLETED 到达 control event sink。
 * 2. HUMAN_REQUIRED snapshot 渲染包含 decision card 文案与动态值。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { GuardianProgressObserver } from '../packages/development-guardian/progress.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { renderHtml, APP_JS } from '../packages/development-guardian/work-session/control-ui/view.js'
import {
  FakeRuntime,
  makeDefinition,
  makeState,
  startServer,
} from './work-session-w005-a-helpers.js'

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
  const v2Runtime = new FakeRuntime(makeDefinition({ controlPlane: 'v2' }))
  let v2ProgressSink: GuardianProgressObserver | undefined
  const v2Controller = new WorkSessionControlController({
    createRuntime: (eventSink) => { v2ProgressSink = eventSink; return v2Runtime },
  })
  v2ProgressSink?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0 })
  assert.equal(v2Controller.getSnapshot().configuredSession.controlPlane, 'v2')
  assert.equal(v2Controller.getRecentEvents().at(-1)?.type, 'TASK_PHASE')
  assert.equal(v2Controller.getRecentEvents().some((event) => event.type === 'GUARDIAN_PHASE'), false)

  const v1Runtime = new FakeRuntime(makeDefinition({ controlPlane: 'v1' }))
  let v1ProgressSink: GuardianProgressObserver | undefined
  const v1Controller = new WorkSessionControlController({
    createRuntime: (eventSink) => { v1ProgressSink = eventSink; return v1Runtime },
  })
  v1ProgressSink?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0 })
  assert.equal(v1Controller.getSnapshot().configuredSession.controlPlane, 'v1')
  assert.equal(v1Controller.getRecentEvents().at(-1)?.type, 'GUARDIAN_PHASE')

  v2Controller.close()
  v1Controller.close()
})

await test('W005-A HUMAN_REQUIRED rendering: decision card shows category and reason', async () => {
  // 1. HTML 静态包含 decision card 标题与占位元素。
  const html = renderHtml({ controlToken: 'tok', serverOrigin: 'http://127.0.0.1:4317' })
  assert.ok(html.includes('需要你的决定'))
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
