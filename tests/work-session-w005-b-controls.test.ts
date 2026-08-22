import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GuardianWorkSessionTaskRunner,
  RetryableGuardianBrainError,
  WorkSessionRuntime,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianBrain,
  type GuardianTask,
  type GuardianTaskRecoveryCheckpoint,
  type TaskCompletionEvidence,
  type WorkSessionDefinition,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'
import type { GuardianRecoverableExecutor } from '../packages/development-guardian/ports.js'
import { computeWorktreeFingerprint } from '../packages/development-guardian/work-session/worktree-fingerprint.js'

const REPO = process.cwd()
const BRANCH = 'feat/work-session-mvp'
const HEAD = '6b6c392893d7b3dce17538262d1fb658fa94e773'

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: 'goal',
    instructions: verdict === 'proceed' || verdict === 'revise' ? ['implement'] : [],
    constraints: [],
    verification: ['npm test'],
    doNotDo: [],
    ...(verdict === 'blocked' ? { rationale: 'choose an approach' } : {}),
  }
}

function report(): ExecutionReport {
  return {
    summary: 'executor returned normally',
    changedFiles: [],
    commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
  }
}

class RecordingExecutor implements GuardianRecoverableExecutor {
  calls = 0
  returned = false
  onExecute?: () => void
  claudeSessionId?: string

  async execute(): Promise<ExecutionReport> {
    this.calls++
    this.onExecute?.()
    this.returned = true
    return report()
  }

  captureProviderState(): { claudeSessionId?: string } {
    return this.claudeSessionId === undefined ? {} : { claudeSessionId: this.claudeSessionId }
  }

  restoreProviderState(state: { claudeSessionId?: string }): void {
    if (state.claudeSessionId === undefined) {
      delete this.claudeSessionId
    } else {
      this.claudeSessionId = state.claudeSessionId
    }
  }
}

function gitRunner(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = command.includes('branch --show-current')
    ? `${BRANCH}\n`
    : command.includes('rev-parse HEAD')
      ? `${HEAD}\n`
      : ''
  return Promise.resolve({ exitCode: 0, stdout, stderr: '' })
}

function adapter(options: {
  brain: GuardianBrain
  executor: RecordingExecutor
  createGuardianTask?: () => GuardianTask
}): GuardianWorkSessionTaskRunner {
  return new GuardianWorkSessionTaskRunner({
    brain: options.brain,
    createExecutor: () => options.executor,
    ...(options.createGuardianTask === undefined
      ? {}
      : { createGuardianTask: options.createGuardianTask }),
    repoPath: REPO,
    gitRunner,
  })
}

await test('W005-B PAUSE-A: pause before Reviewer starts returns PAUSED with checkpoint', async () => {
  let reviews = 0
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: { async review() { reviews++; return packet('proceed') } },
    executor,
  })

  const result = await runner.run(
    { id: 'T1', goal: 'one' },
    undefined,
    undefined,
    { shouldPauseAutonomousWork: () => true },
  )

  assert.equal(result.status, 'PAUSED')
  assert.equal(reviews, 0)
  assert.equal(executor.calls, 0)
  assert.equal(result.checkpoint?.task.stopReason, 'WORK_SESSION_USER_PAUSE_REQUESTED')
})

await test('reviewer timeout is retried once by the Work Session adapter default', async () => {
  let reviews = 0
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        reviews += 1
        if (reviews === 1) {
          throw new RetryableGuardianBrainError('ChatGPT review timed out after 600000ms')
        }
        return reviews === 2 ? packet('proceed') : packet('done')
      },
    },
    executor,
  })

  const result = await runner.run({ id: 'T1', goal: 'one' })
  assert.equal(result.status, 'COMPLETED')
  assert.equal(reviews, 3)
  assert.equal(executor.calls, 1)
})

await test('exhausted reviewer timeout retry remains HUMAN_REQUIRED and STALLED', async () => {
  let reviews = 0
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        reviews += 1
        throw new RetryableGuardianBrainError('ChatGPT review timed out after 600000ms')
      },
    },
    executor,
  })

  const result = await runner.run({ id: 'T1', goal: 'one' })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'STALLED')
  assert.equal(reviews, 2)
  assert.equal(executor.calls, 0)
})

await test('exhausted malformed Reviewer protocol recovery is HUMAN_REQUIRED but never DECISION_REQUIRED', async () => {
  let reviews = 0
  let rotations = 0
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        reviews += 1
        throw new RetryableGuardianBrainError('reviewer returned malformed Guardian JSON', 'protocol')
      },
      resetTaskReviewSession() { rotations += 1 },
    },
    executor,
  })

  const result = await runner.run({ id: 'T1', goal: 'one' })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'REVIEWER_PROTOCOL_FAILURE')
  assert.notEqual(result.humanRequired?.category, 'DECISION_REQUIRED')
  assert.equal(reviews, 3)
  assert.equal(rotations, 1)
  assert.equal(executor.calls, 0)
})

await test('W003 rotation replaces only the restored Brain URL and preserves checkpoint truth', async () => {
  const oldUrl = 'https://chatgpt.com/c/old-task-session'
  const newUrl = 'https://chatgpt.com/c/new-task-session'
  let reviews = 0
  let rotations = 0
  let conversationUrl: string | undefined
  let reviewed = false
  const brain: GuardianBrain & {
    captureProviderState(): { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] }
    restoreProviderState(state: { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] }): void
  } = {
    restoreProviderState(state) {
      conversationUrl = state.taskConversationUrls['T1']
      reviewed = state.reviewedTaskIds.includes('T1')
    },
    captureProviderState() {
      return {
        taskConversationUrls: conversationUrl === undefined ? {} : { T1: conversationUrl },
        reviewedTaskIds: reviewed ? ['T1'] : [],
      }
    },
    resetTaskReviewSession(taskId) {
      assert.equal(taskId, 'T1')
      conversationUrl = undefined
      reviewed = false
      rotations += 1
    },
    async review(input) {
      reviews += 1
      assert.equal(input.task.lastReport?.summary, 'executor returned normally')
      assert.equal(input.task.recoveryContinuation, true)
      if (reviews <= 2) throw new RetryableGuardianBrainError('timeout')
      assert.equal(conversationUrl, undefined)
      conversationUrl = newUrl
      reviewed = true
      return packet('blocked')
    },
  }
  const executor = new RecordingExecutor()
  const repo = {
    repoPath: REPO,
    branch: BRANCH,
    headSha: HEAD,
    changedFiles: [] as readonly string[],
    worktreeFingerprint: await computeWorktreeFingerprint(REPO, []),
  }
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: {
      id: 'T1', goal: 'one', state: 'HUMAN_REQUIRED', iteration: 1, maxIterations: 10,
      lastReport: report(),
    },
    provider: { chatgptConversationUrl: oldUrl, claudeSessionId: 'claude-session' },
    repo,
    capturedAt: new Date().toISOString(),
  }
  const runner = adapter({ brain, executor })

  const result = await runner.run({ id: 'T1', goal: 'one' }, undefined, checkpoint)

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(reviews, 3)
  assert.equal(rotations, 1)
  assert.equal(result.checkpoint?.provider.chatgptConversationUrl, newUrl)
  assert.equal(result.checkpoint?.provider.claudeSessionId, 'claude-session')
  assert.deepEqual(result.checkpoint?.repo, repo)
})

await test('W003 fresh-session timeout checkpoint never restores the discarded URL', async () => {
  let reviews = 0
  let conversationUrl: string | undefined
  const brain: GuardianBrain & {
    captureProviderState(): { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] }
    restoreProviderState(state: { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] }): void
  } = {
    restoreProviderState(state) { conversationUrl = state.taskConversationUrls['T1'] },
    captureProviderState() {
      return { taskConversationUrls: conversationUrl === undefined ? {} : { T1: conversationUrl }, reviewedTaskIds: [] }
    },
    resetTaskReviewSession() { conversationUrl = undefined },
    async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
  }
  const executor = new RecordingExecutor()
  const repo = {
    repoPath: REPO, branch: BRANCH, headSha: HEAD, changedFiles: [] as readonly string[],
    worktreeFingerprint: await computeWorktreeFingerprint(REPO, []),
  }
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: { id: 'T1', goal: 'one', state: 'HUMAN_REQUIRED', iteration: 1, maxIterations: 10, lastReport: report() },
    provider: { chatgptConversationUrl: 'https://chatgpt.com/c/old-task-session', claudeSessionId: 'claude-session' },
    repo,
    capturedAt: new Date().toISOString(),
  }
  const runner = adapter({ brain, executor })

  const result = await runner.run({ id: 'T1', goal: 'one' }, undefined, checkpoint)

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'STALLED')
  assert.equal(reviews, 3)
  assert.equal(result.checkpoint?.provider.chatgptConversationUrl, undefined)
  assert.equal(result.checkpoint?.provider.claudeSessionId, 'claude-session')
  assert.deepEqual(result.checkpoint?.repo, repo)
})

await test('Work Session adapter allows session rotation to be disabled for tests', async () => {
  let reviews = 0
  let rotations = 0
  const executor = new RecordingExecutor()
  const runner = new GuardianWorkSessionTaskRunner({
    brain: {
      async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
      resetTaskReviewSession() { rotations += 1 },
    },
    createExecutor: () => executor,
    maxBrainReviewSessionRotations: 0,
  })

  const result = await runner.run({ id: 'T1', goal: 'one' })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(reviews, 2)
  assert.equal(rotations, 0)
})

await test('W005-B PAUSE-B: pause requested during Reviewer prevents Executor', async () => {
  let pause = false
  let reviews = 0
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        reviews++
        pause = true
        return packet('proceed')
      },
    },
    executor,
  })

  const result = await runner.run(
    { id: 'T1', goal: 'one' },
    undefined,
    undefined,
    { shouldPauseAutonomousWork: () => pause },
  )

  assert.equal(result.status, 'PAUSED')
  assert.equal(reviews, 1)
  assert.equal(executor.calls, 0)
})

await test('W005-B PAUSE-C: in-flight Executor returns normally before pause', async () => {
  let pause = false
  let reviews = 0
  const executor = new RecordingExecutor()
  executor.onExecute = () => { pause = true }
  const runner = adapter({
    brain: { async review() { reviews++; return packet('proceed') } },
    executor,
  })

  const result = await runner.run(
    { id: 'T1', goal: 'one' },
    undefined,
    undefined,
    { shouldPauseAutonomousWork: () => pause },
  )

  assert.equal(result.status, 'PAUSED')
  assert.equal(reviews, 1, 'next Reviewer must not start')
  assert.equal(executor.calls, 1)
  assert.equal(executor.returned, true, 'Executor must not be killed')
  assert.equal(result.checkpoint?.task.lastReport?.summary, 'executor returned normally')
})

await test('W005-B PAUSE-D: terminal done verdict wins over simultaneous pause', async () => {
  let pause = false
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        pause = true
        return packet('done')
      },
    },
    executor,
    createGuardianTask: () => ({
      id: 'T1',
      goal: 'one',
      state: 'READY',
      iteration: 1,
      maxIterations: 10,
      lastReport: report(),
    }),
  })

  const result = await runner.run(
    { id: 'T1', goal: 'one' },
    undefined,
    undefined,
    { shouldPauseAutonomousWork: () => pause },
  )
  assert.equal(result.status, 'COMPLETED')
})

await test('W005-B PAUSE-E: terminal blocked verdict remains HUMAN_REQUIRED', async () => {
  let pause = false
  const executor = new RecordingExecutor()
  const runner = adapter({
    brain: {
      async review() {
        pause = true
        return packet('blocked')
      },
    },
    executor,
  })

  const result = await runner.run(
    { id: 'T1', goal: 'one' },
    undefined,
    undefined,
    { shouldPauseAutonomousWork: () => pause },
  )
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'DECISION_REQUIRED')
})

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
