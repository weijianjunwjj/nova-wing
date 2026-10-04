import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
  type WorkSessionDurableState,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'

const REPO = process.cwd()
const BRANCH = 'feat/work-session-mvp'

function definition(id: string, taskCount = 1): WorkSessionDefinition {
  return {
    id,
    targetRepo: REPO,
    branch: BRANCH,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `T${index + 1}`,
      goal: `task ${index + 1}`,
    })),
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: () => resolvePromise?.() }
}

async function withStorage(
  prefix: string,
  run: (storageUrl: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(`file:${join(directory, 'session.db')}`)
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(directory, { recursive: true, force: true })
        break
      } catch {
        if (attempt === 4) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}

async function startHydratedServer(runtime: WorkSessionRuntime): Promise<{
  controller: WorkSessionControlController
  server: WorkSessionControlServer
  address: { url: string }
  token: string
  hydrated: WorkSessionDurableState | undefined
}> {
  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    pollIntervalMs: 10,
  })
  const hydrated = await controller.loadPersistedState()
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  return {
    controller,
    server,
    address,
    token: await mintSession(server),
    hydrated,
  }
}

async function postResume(
  server: { address: { url: string }; token: string },
  input: Record<string, unknown>,
): Promise<number> {
  const response = await sessionFetch(`${server.address.url}/api/session/resume`, {
    method: 'POST',
    headers: {
      Origin: server.address.url,
      'Content-Type': 'application/json',
      'Cookie': server.token,
    },
    body: JSON.stringify(input),
  })
  await response.text()
  return response.status
}

await test('W005-B RESTART-1: HUMAN_REQUIRED hydrates without provider calls and resumes through HTTP', async () => {
  await withStorage('w005b-restart-human-', async (storageUrl) => {
    const session = definition('restart-human')
    let emptyProviderCalls = 0
    const emptyRuntime = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          emptyProviderCalls++
          return { status: 'COMPLETED' }
        },
      },
    })
    assert.equal(await emptyRuntime.loadPersistedState(), undefined)
    assert.equal(emptyProviderCalls, 0)
    assert.equal(emptyRuntime.getDurableState(), undefined)
    await emptyRuntime.close()

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: {
              category: 'DECISION_REQUIRED',
              reason: 'choose database mode',
            },
          }
        },
      },
    })
    const suspended = await runtime1.start()
    assert.equal(suspended.state, 'SUSPENDED')
    await runtime1.close()

    let providerCalls = 0
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          providerCalls++
          return { status: 'COMPLETED' }
        },
      },
    })
    const app = await startHydratedServer(runtime2)
    try {
      assert.equal(providerCalls, 0, 'hydrate must not invoke Brain/Executor/task runner')
      assert.equal(app.hydrated?.state, 'SUSPENDED')
      assert.equal(app.hydrated?.currentTaskId, 'T1')
      assert.deepEqual(app.hydrated?.completedTaskIds, [])
      assert.deepEqual(app.hydrated?.humanRequired, {
        category: 'DECISION_REQUIRED',
        reason: 'choose database mode',
      })
      assert.equal(app.controller.getSnapshot().runtime.started, true)
      assert.equal(app.controller.start().started, false)

      assert.equal(await postResume(app, { decision: 'sqlite' }), 202)
      await app.controller.getResumePromise()
      assert.equal(providerCalls, 1)
      assert.equal(runtime2.getDurableState()?.state, 'COMPLETED')
    } finally {
      await app.server.close()
      await runtime2.close()
    }
  })
})

await test('W005-B RESTART-2: USER_PAUSED hydrates and resumes with an empty payload', async () => {
  await withStorage('w005b-restart-paused-', async (storageUrl) => {
    const session = definition('restart-paused')
    const entered = deferred()
    const release = deferred()
    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          entered.resolve()
          await release.promise
          return { status: 'PAUSED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await entered.promise
    assert.deepEqual(runtime1.requestPause(), { accepted: true })
    release.resolve()
    assert.equal((await startPromise).suspensionReason, 'USER_PAUSED')
    await runtime1.close()

    let providerCalls = 0
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          providerCalls++
          return { status: 'COMPLETED' }
        },
      },
    })
    const app = await startHydratedServer(runtime2)
    try {
      assert.equal(providerCalls, 0)
      assert.equal(app.hydrated?.state, 'SUSPENDED')
      assert.equal(app.hydrated?.suspensionReason, 'USER_PAUSED')
      assert.equal(app.controller.getSnapshot().runtime.started, true)

      assert.equal(await postResume(app, {}), 202)
      await app.controller.getResumePromise()
      assert.equal(providerCalls, 1)
      assert.equal(runtime2.getDurableState()?.state, 'COMPLETED')
    } finally {
      await app.server.close()
      await runtime2.close()
    }
  })
})

await test('W005-B RESTART-3: stop-after-task survives HUMAN_REQUIRED restart and prevents T2', async () => {
  await withStorage('w005b-restart-stop-', async (storageUrl) => {
    const session = definition('restart-stop', 2)
    const entered = deferred()
    const release = deferred()
    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          entered.resolve()
          await release.promise
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'confirm T1' },
          }
        },
      },
    })
    const startPromise = runtime1.start()
    await entered.promise
    assert.deepEqual(runtime1.requestStopAfterTask(), { accepted: true })
    release.resolve()
    const suspended = await startPromise
    assert.equal(suspended.stopAfterTaskRequested, true)
    await runtime1.close()

    const calls = new Map<string, number>()
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          calls.set(task.id, (calls.get(task.id) ?? 0) + 1)
          return { status: 'COMPLETED' }
        },
      },
    })
    const app = await startHydratedServer(runtime2)
    try {
      assert.equal(app.hydrated?.stopAfterTaskRequested, true)
      assert.equal(app.controller.getSnapshot().controls.stopAfterTaskRequested, true)
      assert.equal(await postResume(app, { decision: 'continue' }), 202)
      await app.controller.getResumePromise()

      const finalState = runtime2.getDurableState()
      assert.equal(finalState?.state, 'CANCELLED')
      assert.equal(finalState?.cancellationReason, 'STOP_AFTER_TASK')
      assert.equal(finalState?.stopAfterTaskRequested, undefined)
      assert.deepEqual(finalState?.completedTaskIds, ['T1'])
      assert.equal(calls.get('T1'), 1)
      assert.equal(calls.get('T2') ?? 0, 0)
    } finally {
      await app.server.close()
      await runtime2.close()
    }
  })
})

await test('W005-B RESTART-4: last task completion wins over restored stop intent', async () => {
  await withStorage('w005b-restart-last-', async (storageUrl) => {
    const session = definition('restart-last')
    const entered = deferred()
    const release = deferred()
    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          entered.resolve()
          await release.promise
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'confirm final task' },
          }
        },
      },
    })
    const startPromise = runtime1.start()
    await entered.promise
    assert.deepEqual(runtime1.requestStopAfterTask(), { accepted: true })
    release.resolve()
    assert.equal((await startPromise).stopAfterTaskRequested, true)
    await runtime1.close()

    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
    })
    const hydrated = await runtime2.loadPersistedState()
    assert.equal(hydrated?.stopAfterTaskRequested, true)
    const finalState = await runtime2.resume({ decision: 'continue' })
    assert.equal(finalState.state, 'COMPLETED')
    assert.equal(finalState.completionReason, 'ALL_TASKS_COMPLETED')
    assert.equal(finalState.cancellationReason, undefined)
    assert.equal(finalState.stopAfterTaskRequested, undefined)
    await runtime2.close()

    let terminalProviderCalls = 0
    const runtime3 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run() {
          terminalProviderCalls++
          return { status: 'COMPLETED' as const }
        },
      },
    })
    const controller = new WorkSessionControlController({ createRuntime: () => runtime3 })
    const terminalState = await controller.loadPersistedState()
    assert.equal(terminalState?.state, 'COMPLETED')
    assert.equal(terminalProviderCalls, 0)
    assert.equal(controller.getSnapshot().runtime.started, true)
    assert.equal(controller.start().started, false)
    controller.close()
    await runtime3.close()
  })
})
