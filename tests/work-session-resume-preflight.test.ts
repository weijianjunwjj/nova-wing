import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

test('failed shell preflight preserves the suspension, then repaired Resume continues exactly once', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({
    state: 'SUSPENDED',
    currentTaskId: 'T1',
    suspensionReason: 'BRAIN_INFRASTRUCTURE_FAILED',
    brainFailure: {
      stage: 'BRAIN_REVIEW', category: 'TRANSPORT', rootCause: 'local diagnostic',
      adapter: 'ask-bridge', retryable: false, degraded: false,
      fingerprint: 'brain-transport:test', failureType: 'BRAIN_TRANSPORT_FAILED',
      safeMessage: 'Brain transport 不可用；当前 checkpoint 已保留。',
    },
  })
  let shellReady = false
  let preflightCalls = 0
  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    beforeResume: async () => {
      preflightCalls += 1
      if (!shellReady) throw new Error('SHELL_ENVIRONMENT_INVALID')
    },
    pollIntervalMs: 10_000,
  })

  try {
    assert.equal(controller.resume({}).accepted, true)
    await controller.getResumePromise()
    assert.equal(runtime.resumeCalls, 0, 'preflight failure must not cross the runtime checkpoint')
    assert.equal(runtime.state.state, 'SUSPENDED')

    shellReady = true
    assert.equal(controller.resume({}).accepted, true)
    assert.equal(controller.resume({}).accepted, false, 'double Resume must be idempotently rejected')
    await controller.getResumePromise()
    assert.equal(preflightCalls, 2)
    assert.equal(runtime.resumeCalls, 1, 'repair resumes the existing checkpoint exactly once')
  } finally {
    controller.close()
  }
})
