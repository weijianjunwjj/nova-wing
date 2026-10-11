import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorkSessionRuntime, type TaskCompletionEvidence, type WorkSessionDefinition, type WorkSessionTaskResult } from 'nova-wing/development-guardian'

const REPO = process.cwd()
const BRANCH = 'feat/work-session-mvp'

function definition(id: string, taskCount = 2): WorkSessionDefinition {
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

function completionEvidence(): TaskCompletionEvidence {
  return {
    changedFiles: ['src/example.ts'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['npm test'],
  }
}

async function withStorage<T>(prefix: string, fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await fn(`file:${join(dir, 'session.db')}`)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200))
    for (let attempts = 0; attempts < 4; attempts++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch {
        if (attempts === 3) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: () => resolvePromise?.() }
}

await test('W005-B PAUSE-F: suspended wall clock is excluded and resume continues', async () => {
  await withStorage('w005b-pause-f-', async (storageUrl) => {
    let now = 0
    let calls = 0
    const entered = deferred()
    const release = deferred()
    const taskRunner = {
      async run(_task: unknown, _resume: unknown, checkpoint: unknown, context: { shouldPauseAutonomousWork?: () => boolean }): Promise<WorkSessionTaskResult> {
        calls++
        now += 1_000
        if (calls === 1) {
          entered.resolve()
          await release.promise
          assert.equal(context.shouldPauseAutonomousWork?.(), true)
          return { status: 'PAUSED', checkpoint: checkpoint as never }
        }
        return { status: 'COMPLETED' }
      },
    }
    const runtime = new WorkSessionRuntime({
      definition: definition('pause-f', 1),
      taskRunner,
      storageUrl,
      clock: { now: () => now },
    })
    const startPromise = runtime.start()
    await entered.promise
    assert.deepEqual(runtime.requestPause(), { accepted: true })
    release.resolve()
    const paused = await startPromise
    assert.equal(paused.state, 'SUSPENDED')
    assert.equal(paused.suspensionReason, 'USER_PAUSED')
    assert.equal(paused.humanRequired, undefined)
    assert.equal(paused.activeSegmentStartedAt, undefined)
    const pausedElapsed = paused.activeElapsedMs

    now += 3 * 60 * 60_000
    const completed = await runtime.resume({})
    assert.equal(completed.state, 'COMPLETED')
    assert.equal(completed.activeElapsedMs, (pausedElapsed ?? 0) + 1_000)
    await runtime.close()
  })
})

await test('W005-B STOP-A: completes checkpoint then cancels before T2', async () => {
  await withStorage('w005b-stop-a-', async (storageUrl) => {
    const entered = deferred()
    const release = deferred()
    const counts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string }): Promise<WorkSessionTaskResult> {
        counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          entered.resolve()
          await release.promise
        }
        return { status: 'COMPLETED', completionEvidence: completionEvidence() }
      },
    }
    let finalizerCalls = 0
    const runtime = new WorkSessionRuntime({
      definition: definition('stop-a'),
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: {
          autoCommit: true,
          autoPush: true,
          pushRemote: { name: 'origin', expectedUrl: 'https://example.test/repo.git' },
        },
        finalizer: async () => {
          finalizerCalls++
          return { commitSha: 'commit-t1', committedFiles: ['src/example.ts'], pushSha: 'commit-t1' }
        },
      },
    })
    const startPromise = runtime.start()
    await entered.promise
    assert.deepEqual(runtime.requestStopAfterTask(), { accepted: true })
    release.resolve()
    const state = await startPromise

    assert.equal(state.state, 'CANCELLED')
    assert.equal(state.cancellationReason, 'STOP_AFTER_TASK')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(state.checkpointCommits?.T1, 'commit-t1')
    assert.equal(state.checkpointPushes?.T1, 'commit-t1')
    assert.equal(finalizerCalls, 1)
    assert.equal(counts.get('T2') ?? 0, 0)
    await runtime.close()
  })
})

await test('W005-B STOP-B: intent survives HUMAN_REQUIRED and cancels after resumed Task', async () => {
  await withStorage('w005b-stop-b-', async (storageUrl) => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const counts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string }): Promise<WorkSessionTaskResult> {
        counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
        calls++
        if (calls === 1) {
          entered.resolve()
          await release.promise
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose' },
          }
        }
        return { status: 'COMPLETED' }
      },
    }
    const runtime = new WorkSessionRuntime({
      definition: definition('stop-b'),
      taskRunner,
      storageUrl,
    })
    const startPromise = runtime.start()
    await entered.promise
    assert.deepEqual(runtime.requestStopAfterTask(), { accepted: true })
    release.resolve()
    assert.equal((await startPromise).state, 'SUSPENDED')
    const state = await runtime.resume({ decision: 'continue' })
    assert.equal(state.state, 'CANCELLED')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(counts.get('T2') ?? 0, 0)
    await runtime.close()
  })
})

await test('W005-B STOP-C: all tasks completed wins over stop-after-task', async () => {
  await withStorage('w005b-stop-c-', async (storageUrl) => {
    const entered = deferred()
    const release = deferred()
    const taskRunner = {
      async run(): Promise<WorkSessionTaskResult> {
        entered.resolve()
        await release.promise
        return { status: 'COMPLETED' }
      },
    }
    const runtime = new WorkSessionRuntime({
      definition: definition('stop-c', 1),
      taskRunner,
      storageUrl,
    })
    const startPromise = runtime.start()
    await entered.promise
    assert.deepEqual(runtime.requestStopAfterTask(), { accepted: true })
    release.resolve()
    const state = await startPromise
    assert.equal(state.state, 'COMPLETED')
    assert.equal(state.completionReason, 'ALL_TASKS_COMPLETED')
    assert.equal(state.cancellationReason, undefined)
    await runtime.close()
  })
})
