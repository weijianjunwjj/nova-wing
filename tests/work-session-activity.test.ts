import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { observeWorkSessionActivity, type WorkSessionActivityEvent, type WorkSessionActivityObserver } from '../packages/development-guardian/work-session/activity.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { createProductionWorkSessionUi, type ProductionWorkSessionUi, type TrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { createNovaWingLaunchpad, type NovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { TaskEtaService, type TaskEtaEstimate } from '../packages/development-guardian/work-session/control-ui/task-eta.js'
import { FakeRuntime, makeDefinition, makeState } from './work-session-w005-a-helpers.js'

function recorder() {
  const events: WorkSessionActivityEvent[] = []
  const active = new Set<string>()
  const counts: number[] = []
  const observe: WorkSessionActivityObserver = (event) => {
    events.push(event)
    if (event.phase === 'started') active.add(event.activityId)
    else assert.equal(active.delete(event.activityId), true, 'release must match one live lease')
    counts.push(active.size)
  }
  return { events, active, counts, observe }
}

function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]
}

await test('activity leases span overlapping Sessions and release once in operation settlement order', async () => {
  const activity = recorder()
  const controllers = ['session-a', 'session-b'].map((id) => {
    const runtime = new FakeRuntime(makeDefinition({ id }))
    runtime.deferStart()
    const controller = new WorkSessionControlController({ createRuntime: () => runtime,
      activityObserver: activity.observe, shutdownMode: 'strict' })
    assert.equal(controller.start().started, true)
    assert.equal(controller.start().started, false)
    return { controller, runtime }
  })
  assert.deepEqual(activity.counts, [1, 2])
  assert.deepEqual(activity.events.map((event) => event.sessionId), ['session-a', 'session-b'])
  assert.equal(new Set(activity.events.map((event) => event.activityId)).size, 2)
  for (const { runtime, controller } of controllers) {
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await controller.getStartPromise()
    await controller.close()
    await controller.close()
  }
  assert.deepEqual(activity.counts, [1, 2, 1, 0])
  assert.ok(activity.events.every((event) => event.operation === 'execution'))
})

await test('durable RUNNING, future schedule, status and subscribed UI never create activity', async () => {
  for (const state of ['RUNNING', 'SCHEDULED', 'SUSPENDED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    const activity = recorder()
    const runtime = new FakeRuntime(makeDefinition({ scheduledStartAt: '2099-01-01T00:00:00.000Z' }))
    runtime.state = makeState({ state, scheduledStartAt: '2099-01-01T00:00:00.000Z',
      ...(state === 'SUSPENDED' ? { suspensionReason: 'USER_PAUSED' as const } : {}) })
    const controller = new WorkSessionControlController({ createRuntime: () => runtime,
      activityObserver: activity.observe, shutdownMode: 'strict' })
    await controller.loadPersistedState()
    controller.getSnapshot()
    const unsubscribe = controller.subscribe({ onEvent() {}, onSnapshot() {} })
    if (state === 'SCHEDULED') {
      assert.equal(controller.start().started, true)
      await controller.getStartPromise()
    }
    unsubscribe()
    await controller.close()
    assert.deepEqual(activity.events, [], state)
  }
})

await test('due scheduled execution acquires before preflight and remains active throughout strict drain', async () => {
  const activity = recorder()
  const preflight = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const dispatched = Promise.withResolvers<void>()
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({ state: 'SCHEDULED', scheduledStartAt: '2026-01-01T00:00:00.000Z' })
  runtime.deferStart()
  const start = runtime.start.bind(runtime)
  runtime.start = () => { dispatched.resolve(); return start() }
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    activityObserver: activity.observe, beforeResume: async () => { entered.resolve(); await preflight.promise } })
  controller.start()
  await entered.promise
  assert.equal(activity.active.size, 1)
  const closing = controller.close()
  let closed = false
  void closing.then(() => { closed = true })
  preflight.resolve()
  await dispatched.promise
  assert.equal(closed, false)
  assert.equal(activity.active.size, 1)
  runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
  await closing
  assert.deepEqual(activity.counts, [1, 0])
  assert.deepEqual(activity.events.map((event) => event.operation), ['scheduled-execution', 'scheduled-execution'])
})

await test('real scheduled claim crossing its due time acquires exactly when execution starts and covers finalization', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-activity-schedule-'))
  const activity = recorder()
  let now = Date.parse('2026-09-21T00:00:00Z')
  const definition = makeDefinition({ id: 'activity-scheduled', targetRepo: process.cwd(), tasks: [{ id: 'T1', goal: 'isolated scheduled task' }],
    scheduledStartAt: '2026-09-21T01:00:00Z', scheduleSource: 'custom' })
  const snapshotEntered = Promise.withResolvers<void>()
  const snapshotGate = Promise.withResolvers<void>()
  const taskEntered = Promise.withResolvers<void>()
  const taskGate = Promise.withResolvers<void>()
  const finalizeEntered = Promise.withResolvers<void>()
  const finalizeGate = Promise.withResolvers<void>()
  let executions = 0
  const runtime = new WorkSessionRuntime({ definition, storageUrl: pathToFileURL(join(directory, 'session.db')).href,
    clock: { now: () => now }, taskRunner: { async run() {
      executions++
      taskEntered.resolve()
      await taskGate.promise
      return { status: 'COMPLETED', completionEvidence: { changedFiles: ['src/example.ts'],
        verificationResults: [{ name: 'isolated-check', status: 'passed' }], blockers: [],
        finalReviewerVerdict: 'done', requiredVerification: ['isolated-check'] } }
    } }, gitCheckpoint: { policy: { autoCommit: true, autoPush: false }, finalizer: async () => {
      finalizeEntered.resolve()
      await finalizeGate.promise
      return { commitSha: 'a'.repeat(40), committedFiles: ['src/example.ts'] }
    } } })
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    clock: { now: () => now }, activityObserver: activity.observe })
  try {
    await controller.loadPersistedState()
    controller.start()
    await controller.getStartPromise()
    assert.equal(activity.events.length, 0, 'real waiting Runtime has no activity')
    // Force the clock across due-time during the real awaited snapshot read,
    // after Controller admission and before the schedule store's atomic claim.
    const internals = runtime as unknown as { readPersistedWorkflowSnapshot(): Promise<unknown> }
    const readSnapshot = internals.readPersistedWorkflowSnapshot.bind(runtime)
    let firstRead = true
    internals.readPersistedWorkflowSnapshot = async () => {
      if (firstRead) { firstRead = false; snapshotEntered.resolve(); await snapshotGate.promise }
      return readSnapshot()
    }
    controller.start()
    await snapshotEntered.promise
    assert.equal(activity.active.size, 0)
    now = Date.parse(definition.scheduledStartAt!)
    snapshotGate.resolve()
    await taskEntered.promise
    assert.equal(activity.active.size, 1)
    const closing = controller.close()
    let closed = false
    void closing.then(() => { closed = true })
    taskGate.resolve()
    await finalizeEntered.promise
    assert.equal(activity.active.size, 1, 'checkpoint/finalization remains part of execution')
    assert.equal(closed, false)
    finalizeGate.resolve()
    await closing
    assert.equal(executions, 1)
    assert.equal(runtime.getDurableState()?.state, 'COMPLETED')
    assert.deepEqual(activity.counts, [1, 0])
    assert.equal(activity.events[0]!.operation, 'scheduled-execution')
  } finally {
    snapshotGate.resolve(); taskGate.resolve(); finalizeGate.resolve()
    await controller.close()
    await runtime.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

await test('real Runtime publishes shared start before synchronous activity observer reentry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-activity-reentry-'))
  const activity = recorder()
  let executions = 0
  let nested: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  const runtime = new WorkSessionRuntime({ definition: makeDefinition({ id: 'activity-reentry' }),
    storageUrl: pathToFileURL(join(directory, 'session.db')).href,
    taskRunner: { async run() { executions++; return { status: 'COMPLETED' } } } })
  try {
    const starting = runtime.startWithActivityObserver((event) => {
      activity.observe(event)
      if (event.phase === 'started') {
        nested = runtime.start()
        closing = runtime.close()
      }
    })
    const results = await Promise.allSettled([starting, nested, closing])
    assert.equal(results[0]!.status, 'rejected', 'existing pre-dispatch close cancellation is preserved')
    assert.equal(results[1]!.status, 'rejected')
    assert.equal(results[2]!.status, 'fulfilled')
    if (results[0]!.status === 'rejected' && results[1]!.status === 'rejected') {
      assert.equal(results[0]!.reason, results[1]!.reason)
    }
    assert.equal(executions, 0)
    assert.deepEqual(activity.counts, [1, 0])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

await test('actual ETA model runner retains activity after presentation timeout until strict drain finishes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const activity = recorder()
  const gate = Promise.withResolvers<{ text: string }>()
  const entered = Promise.withResolvers<void>()
  const values = new Map<string, TaskEtaEstimate>()
  const service = new TaskEtaService({ activityObserver: activity.observe, timeoutMs: 10,
    cache: { read: (key) => values.get(key), update: (key, value) => { values.set(key, value) },
      claim: (key, value) => { if (values.has(key)) return false; values.set(key, value); return true } },
    runner: () => { entered.resolve(); return gate.promise } })
  const definition = makeDefinition()
  const state = makeState({ state: 'RUNNING', currentTaskId: 'T1', taskEventLogs: { T1: [{ eventId: '1',
    sessionId: definition.id, taskId: 'T1', timestamp: new Date(0).toISOString(), type: 'VERIFICATION_PLANNED' }] } })
  service.project({ definition, state })
  await entered.promise
  assert.equal(activity.active.size, 1)
  context.mock.timers.tick(10)
  await service.settled()
  state.state = 'COMPLETED'
  service.project({ definition, state })
  assert.equal(activity.active.size, 1, 'UI timeout/terminal projection cannot release a running model')
  let drained = false
  const closing = service.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  gate.reject(new Error('late provider failure'))
  await closing
  assert.deepEqual(activity.counts, [1, 0])
  assert.equal(activity.events[0]!.operation, 'model-runner')
})

await test('all execution and recovery dispatches release on failure, human wait and terminal settlement', async (context) => {
  for (const kind of ['resume', 'interrupted', 'durable-approval', 'approve', 'runtime-repair', 'checkpoint'] as const) {
    await context.test(kind, async () => {
      const activity = recorder()
      const gate = Promise.withResolvers<ReturnType<typeof makeState>>()
      const run = () => gate.promise
      const runtime = Object.assign(new FakeRuntime(makeDefinition()), {
        resume: run, resumeInterrupted: run, resumeWithDurableVerificationApproval: run,
        approvePendingVerificationAndContinue: run, repairRuntimeAndResume: run,
        recoverFailedGitCheckpoint: run,
      })
      runtime.state = makeState({ state: 'SUSPENDED', currentTaskId: 'T1', suspensionReason: 'USER_PAUSED' })
      if (kind === 'interrupted') runtime.state.state = 'RUNNING'
      if (kind === 'durable-approval') runtime.durableVerificationRecoveryAvailable = true
      if (kind === 'approve') {
        runtime.state.humanRequired = { category: 'DECISION_REQUIRED', reason: 'approve verification' }
        runtime.state.pendingVerificationApproval = { sessionId: runtime.state.sessionId, taskId: 'T1', command: 'npm test',
          commandFingerprint: 'test-command', generation: 1, status: 'REQUESTED' }
      }
      if (kind === 'runtime-repair') runtime.state.humanRequired = { category: 'ENVIRONMENT_REQUIRED', reason: 'PROVIDER_UNAVAILABLE' }
      if (kind === 'checkpoint') runtime.state = makeState({ state: 'FAILED', currentTaskId: 'T1', failureStage: 'GIT_PUSH',
        failureCategory: 'GIT_PUSH_FAILED', checkpointCommits: { T1: 'abcdef' } })
      const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
        activityObserver: activity.observe })
      const result = kind === 'resume' ? controller.resume({})
        : kind === 'interrupted' || kind === 'durable-approval' ? controller.resumeRecoverable({})
          : kind === 'approve' ? controller.approvePendingVerificationAndContinue()
            : kind === 'runtime-repair' ? controller.repairRuntimeAndResume() : controller.recoverFailedCheckpoint()
      assert.equal(result.accepted, true)
      assert.equal(activity.active.size, 1)
      const closing = controller.close()
      const failure = new Error(`${kind} failed`)
      const failed = kind === 'runtime-repair' || kind === 'checkpoint'
      const completion = failed ? assert.rejects(closing, (error) => leaves(error).includes(failure)) : closing
      if (failed) gate.reject(failure)
      else gate.resolve(makeState({ state: kind === 'resume' ? 'SUSPENDED' : 'COMPLETED',
        ...(kind === 'resume' ? { humanRequired: { category: 'DECISION_REQUIRED', reason: 'wait for operator' } } : {}) }))
      await completion
      const expected = kind === 'runtime-repair' ? 'runtime-repair' : kind === 'checkpoint' ? 'checkpoint-recovery'
        : kind === 'approve' || kind === 'durable-approval' ? 'verification' : 'resume'
      assert.deepEqual(activity.events.map((event) => event.operation), [expected, expected])
      assert.deepEqual(activity.counts, [1, 0])
    })
  }
})

await test('sync throws, async rejection and observer failures preserve result/error identity and release', async (context) => {
  for (const observerKind of ['throw', 'reject'] as const) {
    for (const outcome of ['success', 'throw', 'reject'] as const) {
      await context.test(`${observerKind}/${outcome}`, async () => {
        const activity = recorder()
        const failure = new Error('business failure')
        const value = { business: 'result' }
        const observer: WorkSessionActivityObserver = (event) => {
          activity.observe(event)
          if (observerKind === 'throw') throw new Error('observer failure')
          return Promise.reject(new Error('observer failure'))
        }
        const operation = observeWorkSessionActivity(observer, { operation: 'execution' }, () => {
          if (outcome === 'throw') throw failure
          if (outcome === 'reject') return Promise.reject(failure)
          return value
        })
        if (outcome === 'success') assert.equal(await operation, value)
        else await assert.rejects(operation, (error) => error === failure)
        assert.deepEqual(activity.counts, [1, 0])
        assert.equal(activity.events[0]!.activityId, activity.events[1]!.activityId)
      })
    }
  }
})

await test('controller publishes drain ownership before synchronous observer close and preserves business errors', async () => {
  const activity = recorder()
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  let closing: Promise<void> | undefined
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, shutdownMode: 'strict',
    activityObserver: (event) => {
      activity.observe(event)
      if (event.phase === 'started') closing = controller.close()
      throw new Error('observer cannot interfere')
    } })
  controller.start()
  assert.ok(closing)
  const failure = new Error('execution rejected')
  const rejected = assert.rejects(closing, (error) => leaves(error).includes(failure))
  assert.equal(activity.active.size, 1)
  runtime.startDeferred!.reject(failure)
  await rejected
  assert.equal(activity.active.size, 0)
})

function config(storageUrl: string): TrustedWorkSessionConfig {
  return {
    session: { id: 'observed-session', targetRepo: process.cwd(), branch: 'feat/v0.4-desktop',
      limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'isolated observer wiring', guardian: { constraints: [], acceptanceCriteria: [],
      doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false }, storageUrl,
  }
}

function post(launchpad: NovaWingLaunchpad, action: string, body: unknown): Promise<Response> {
  const url = launchpad.getAddress()!.url
  return fetch(`${url}/api/session/${action}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(), Origin: url } })
}

await test('Launchpad forwards observer through production into the existing controller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-activity-wiring-'))
  const activity = recorder()
  const runtime = new FakeRuntime(makeDefinition())
  runtime.deferStart()
  let app: ProductionWorkSessionUi | undefined
  await writeFile(join(directory, 'observed.json'), JSON.stringify(config(pathToFileURL(join(directory, 'session.db')).href)))
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, shutdownMode: 'strict', dependencies: {
    activityObserver: activity.observe, readSessionStatus: async () => 'READY',
    readCodexAvailability: () => ({ state: 'available' }), resolveEnvironment: async () => ({ NOVAWING_DATA_DIR: directory }),
    createWorkSession: async (trusted, options) => {
      assert.equal(options.activityObserver, activity.observe)
      return app = await createProductionWorkSessionUi(trusted, { ...options, createRuntime: (input) => {
        runtime.definition = input.definition
        return runtime
      } })
    },
  } })
  try {
    await launchpad.start()
    assert.equal(activity.events.length, 0)
    const response = await post(launchpad, 'start', { configId: launchpad.getConfigs()[0]!.configId })
    assert.equal(response.status, 202, await response.text())
    assert.equal(activity.active.size, 1)
    assert.equal(activity.events[0]!.sessionId, 'observed-session')
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await app!.controller.getStartPromise()
    await launchpad.close()
    assert.deepEqual(activity.counts, [1, 0])
  } finally {
    runtime.startDeferred!.resolve(makeState({ state: 'COMPLETED' }))
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('manual and automatic contract model repair own a lease only during real model work', { timeout: 15_000 }, async (context) => {
  for (const action of ['create', 'repair'] as const) {
    await context.test(action, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'novawing-activity-repair-'))
      const repo = join(directory, 'repo')
      await mkdir(repo)
      await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      const activity = recorder()
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const launchpad = await createNovaWingLaunchpad({ configDirectory: join(directory, 'configs'), shutdownMode: 'strict', dependencies: {
        activityObserver: activity.observe,
        analyticsPath: join(directory, 'analytics.db'),
        readCodexAvailability: () => ({ state: 'available' }),
        gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
        repairAudit: { async record() {} }, repairNotifier: { async notify() {} },
        repairLlmAgent: { id: 'isolated-model', async repair() {
          entered.resolve()
          await gate.promise
          throw new Error('isolated model failure')
        } },
        createWorkSession: async () => { throw new Error('failed repair must not launch work') },
      } })
      let request: Promise<Response> | undefined
      try {
        await launchpad.start()
        assert.equal(activity.events.length, 0)
        request = post(launchpad, action, { requestId: `activity-${action}-repair-1`, targetRepo: repo,
          tasks: [{ id: 'T1', goal: 'Fix a focused helper.' }], autoCommit: false,
          guardian: { allowedPaths: ['src/**'], acceptanceCriteria: ['AC1 label formatting matches every specified example'] } })
        await entered.promise
        assert.equal(activity.active.size, 1)
        assert.equal(activity.events[0]!.operation, 'model-repair')
        assert.equal(activity.events[0]!.sessionId, undefined)
        const closing = launchpad.close()
        gate.resolve()
        const response = await request
        assert.equal(response.status, 400, await response.text())
        await closing
        assert.deepEqual(activity.counts, [1, 0])
      } finally {
        gate.resolve()
        await request
        await launchpad.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})
