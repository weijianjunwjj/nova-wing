import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import type { WorkSessionDefinition } from '../packages/development-guardian/work-session/model.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { makeState, startServer } from './work-session-w005-a-helpers.js'

test('v031: supplemental instructions survive runtime recreation and never reach the next task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v031-instructions-'))
  const definition: WorkSessionDefinition = {
    id: 'durable-instructions', targetRepo: process.cwd(), branch: 'fixture',
    tasks: [{ id: 'T1', goal: 'first' }, { id: 'T2', goal: 'second' }],
    limits: { softMinutes: 20, hardMinutes: 30, maxTasks: 2 },
  }
  const storageUrl = `file:${join(directory, 'session.db')}`
  let runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: {
    async run(_task, _resume, _checkpoint, context) {
      assert.deepEqual(context?.recoveryInstructions ?? [], [])
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'test failure' } }
    },
  } })
  try {
    const first = await runtime.start()
    await runtime.close()
    runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: {
      async run(task, resume, _checkpoint, context) {
        assert.equal(task.id, 'T1')
        assert.equal(resume.decision, '只修改 src，不修改 tests')
        assert.deepEqual(context?.recoveryInstructions, ['只修改 src，不修改 tests'])
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'still failing' } }
      },
    } })
    await runtime.loadPersistedState()
    await assert.rejects(runtime.resume({ decision: 'wrong task', taskId: 'T2', generation: first.humanRequiredGeneration! }), /current task/)
    const suspended = await runtime.resume({ decision: '只修改 src，不修改 tests', taskId: 'T1', generation: first.humanRequiredGeneration! })
    assert.equal(suspended.sessionId, definition.id)
    assert.equal(suspended.taskRecoveryInstructions?.T1?.[0]?.sessionId, definition.id)
    assert.equal(suspended.taskRecoveryInstructions?.T2, undefined)
    await runtime.close()
    const observed: string[] = []
    runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: {
      async run(task, resume, _checkpoint, context) {
        observed.push(task.id)
        if (task.id === 'T1') {
          assert.deepEqual(context?.recoveryInstructions, ['只修改 src，不修改 tests'])
          assert.equal(resume.recovery, 'diagnose')
        } else {
          assert.deepEqual(context?.recoveryInstructions, [])
          assert.equal(resume, undefined)
        }
        return { status: 'COMPLETED' }
      },
    } })
    const hydrated = await runtime.loadPersistedState()
    assert.equal(hydrated?.taskRecoveryInstructions?.T1?.[0]?.instruction, '只修改 src，不修改 tests')
    const completed = await runtime.resume({ recovery: 'diagnose', taskId: 'T1', generation: hydrated!.humanRequiredGeneration! })
    assert.equal(completed.state, 'COMPLETED')
    assert.deepEqual(observed, ['T1', 'T2'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})

test('v031: diagnosis HTTP uses existing token/Origin gates, task generation and bounded recovery', async () => {
  const app = await startServer()
  try {
    const taskState = createTaskStateV2(app.runtime.definition, app.runtime.definition.tasks[0]!)
    app.runtime.state = makeState({ state: 'SUSPENDED', currentTaskId: 'T1', humanRequiredGeneration: 3,
      humanRequired: { category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'test failed' }, taskStatesV2: { T1: taskState } })
    const post = async (body: unknown, authorized = true, origin = app.address.url) => {
      const response = await fetch(`${app.address.url}/api/session/resume`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...(authorized ? { 'Cookie': app.token } : {}) },
        body: JSON.stringify(body) })
      await response.text()
      return response.status
    }
    const input = { recovery: 'diagnose', taskId: 'T1', generation: 3 }
    assert.equal(await post(input, false), 403)
    assert.equal(await post(input, true, 'http://evil.example'), 403)
    assert.equal(await post({ ...input, taskId: 'T2' }), 409)
    assert.equal(await post({ ...input, generation: 2 }), 409)
    assert.equal(await post({ recovery: 'diagnose' }), 400)
    assert.equal(await post({ decision: 'an unscoped instruction' }), 409)
    assert.equal(app.runtime.resumeCalls, 0)
    app.runtime.deferResume()
    assert.equal(await post(input), 202)
    assert.equal(app.controller.getSnapshot().runtime.recoveryInProgress, true)
    assert.deepEqual(app.runtime.resumeInputs[0], input)
    assert.equal(await post(input), 409)
    app.runtime.resumeDeferred!.resolve(app.runtime.state)
    await app.controller.getResumePromise()
    taskState.actionBudget = { ...taskState.actionBudget!, recoveryGranted: true, recoveryConsumed: 4, recoveryExhausted: true }
    assert.equal(await post(input), 409)
    assert.equal(app.controller.getSnapshot().runtime.autonomousRecovery?.exhausted, true)
    app.runtime.state.humanRequired = { category: 'PERMISSION_REQUIRED', reason: 'scope approval' }
    assert.equal(await post(input), 409)
    assert.equal(await post({ decision: 'approve everything', taskId: 'T1', generation: 3 }), 409)
    const denied = await fetch(`${app.address.url}/api/session/reject-verification`, { method: 'POST' })
    assert.equal(denied.status, 403)
    await denied.text()
  } finally { await app.server.close() }
})

test('v031: declining verifier approval stays durable, suspended and cannot be silently approved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v031-reject-'))
  const command = 'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head'
  const definition: WorkSessionDefinition = { id: 'reject-verifier', targetRepo: process.cwd(), branch: 'fixture',
    tasks: [{ id: 'T1', goal: 'migration' }], limits: { softMinutes: 20, hardMinutes: 30, maxTasks: 1 } }
  const storageUrl = `file:${join(directory, 'session.db')}`
  let calls = 0
  const taskRunner = { async run() {
    calls++
    return { status: 'HUMAN_REQUIRED' as const,
      humanRequired: { category: 'APPROVAL_REQUIRED', reason: `验证命令需要精确批准：${command}` },
      pendingVerificationCommand: command }
  } }
  let runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner })
  try {
    assert.equal((await runtime.start()).pendingVerificationApproval?.status, 'REQUESTED')
    const rejected = await runtime.rejectPendingVerification()
    assert.equal(rejected.state, 'SUSPENDED')
    assert.equal(rejected.pendingVerificationApproval?.status, 'REJECTED')
    assert.equal(calls, 1)
    await runtime.close()
    runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner })
    assert.equal((await runtime.loadPersistedState())?.pendingVerificationApproval?.status, 'REJECTED')
    assert.equal(runtime.canResumeWithDurableVerificationApproval(), false)
    await assert.rejects(runtime.approvePendingVerificationAndContinue(), /not available/)
    assert.equal(calls, 1)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})
