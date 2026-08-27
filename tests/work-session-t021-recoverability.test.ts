/**
 * T021 Work Session 中断检测与安全恢复 — 确定性测试
 *
 * 覆盖：
 * - deriveDisplayState 派生状态单一来源（持久化 state 与 runtime liveness 分离）
 * - deriveRecoverySummary 恢复信息（仅来自真实持久化事实）
 * - 真实 restart 语义：RUNNING 崩溃遗留 → RECOVERABLE；fresh → READY；终态不可恢复
 * - 显式 resumeInterrupted：使用原 Session identity，只执行下一未完成 Task，不重复已完成 Task
 * - repeated resume 幂等（不创建两个活动 Runner）
 * - controller 层 displayState / recoverableSummary / resumeRecoverable 分派
 * - Launchpad 状态读取与控制器一致
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkSessionRuntime,
  deriveDisplayState,
  deriveRecoverySummary,
  type WorkSessionDefinition,
  type WorkSessionDurableState,
  type WorkSessionTaskResult,
  type WorkSessionTaskRunner,
} from 'nova-wing/development-guardian'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { createNovaWingLaunchpad } from 'nova-wing/development-guardian'

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

/** 永不 resolve 的 promise，模拟进程在 RUNNING 中异常退出。 */
const NEVER = new Promise<never>(() => undefined)

function completedRunner(sideEffects: Map<string, number>): WorkSessionTaskRunner {
  return {
    async run(task): Promise<WorkSessionTaskResult> {
      sideEffects.set(task.id, (sideEffects.get(task.id) ?? 0) + 1)
      return { status: 'COMPLETED' }
    },
  }
}

function sampleDurableState(overrides: Partial<WorkSessionDurableState> = {}): WorkSessionDurableState {
  return {
    sessionId: 's1',
    state: 'RUNNING',
    currentTaskIndex: 1,
    currentTaskId: 'T2',
    completedTaskIds: ['T1'],
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    updatedAt: new Date('2026-08-27T00:10:00.000Z'),
    ...overrides,
  }
}

// ============ deriveDisplayState 单一来源 ============

await test('T021 deriveDisplayState 分离持久化状态与 runtime liveness', () => {
  assert.equal(deriveDisplayState(undefined, false), 'READY')
  assert.equal(deriveDisplayState(undefined, true), 'READY')

  // 终态：绝不可 recoverable
  for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    assert.equal(deriveDisplayState(sampleDurableState({ state: terminal }), false), terminal)
    assert.equal(deriveDisplayState(sampleDurableState({ state: terminal }), true), terminal)
  }

  // 有活动 Runner：保持原状态
  assert.equal(deriveDisplayState(sampleDurableState({ state: 'RUNNING' }), true), 'RUNNING')
  assert.equal(deriveDisplayState(sampleDurableState({ state: 'SUSPENDED' }), true), 'SUSPENDED')

  // 无活动 Runner（进程重启/异常退出）：RECOVERABLE
  assert.equal(deriveDisplayState(sampleDurableState({ state: 'RUNNING' }), false), 'RECOVERABLE')
  assert.equal(deriveDisplayState(sampleDurableState({ state: 'SUSPENDED' }), false), 'RECOVERABLE')
})

// ============ deriveRecoverySummary 恢复信息 ============

await test('T021 deriveRecoverySummary 仅从持久化事实推导恢复信息', () => {
  const def = definition('s1', 3)
  const state = sampleDurableState({
    checkpointCommits: { T1: 'a'.repeat(40) },
    currentTaskCheckpoint: {
      version: 1,
      task: {
        id: 'T2', goal: 'task 2', state: 'HUMAN_REQUIRED',
        iteration: 3, maxIterations: 10,
      },
      provider: {},
      repo: {
        repoPath: REPO, branch: BRANCH, headSha: 'b'.repeat(40),
        changedFiles: [], worktreeFingerprint: 'c'.repeat(64),
      },
      capturedAt: '2026-08-27T00:09:00.000Z',
    },
  })

  const summary = deriveRecoverySummary(def, state, [])
  assert.equal(summary.lastCompletedTaskId, 'T1')
  assert.equal(summary.currentTaskId, 'T2')
  assert.equal(summary.lastReliableCheckpoint, 'Guardian checkpoint（Task T2，iteration 3）')
  assert.ok(summary.nextResumableAction.includes('T2'))
  assert.equal(summary.lastActivityAt, '2026-08-27T00:10:00.000Z')

  // 无任何可靠 checkpoint 时不伪造
  const bare = deriveRecoverySummary(def, sampleDurableState(), [])
  assert.equal(bare.lastReliableCheckpoint, undefined)

  // Task completed boundary：currentTaskId 为空时指向下一未完成 Task
  const boundary = deriveRecoverySummary(def, sampleDurableState({
    currentTaskId: null,
    currentTaskIndex: 2,
    completedTaskIds: ['T1', 'T2'],
  }), [])
  assert.equal(boundary.lastCompletedTaskId, 'T2')
  assert.equal(boundary.currentTaskId, null)
  assert.ok(boundary.nextResumableAction.includes('T3'))
})

// ============ 真实 restart 语义：RUNNING 崩溃 → RECOVERABLE ============

await test('T021 restart: RUNNING 崩溃遗留的 unfinished Session 被识别为 RECOVERABLE', async () => {
  await withStorage('t021-restart-running-', async (storageUrl) => {
    const session = definition('t021-restart-running', 2)
    let t2Entered: (() => void) | undefined
    const t2EnteredPromise = new Promise<void>((resolve) => { t2Entered = resolve })

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          if (task.id === 'T1') return { status: 'COMPLETED' }
          t2Entered?.()
          await NEVER
          return { status: 'COMPLETED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await t2EnteredPromise

    // 进程内 domain state 已持久化为 RUNNING + currentTaskId=T2
    assert.equal(runtime1.getDurableState()?.state, 'RUNNING')
    assert.deepEqual(runtime1.getDurableState()?.completedTaskIds, ['T1'])
    assert.equal(runtime1.getDurableState()?.currentTaskId, 'T2')
    await runtime1.close()
    void startPromise

    // 模拟进程重启：新 Runtime 只 hydrate，不执行
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: completedRunner(new Map()),
    })
    const hydrated = await runtime2.loadPersistedState()
    assert.equal(hydrated?.state, 'RUNNING', '持久化 domain state 保持 RUNNING')
    assert.equal(runtime2.hasActiveExecution(), false, '新实例无活动 Runner')
    assert.equal(
      deriveDisplayState(hydrated, runtime2.hasActiveExecution()),
      'RECOVERABLE',
      '派生展示状态必须是 RECOVERABLE，而不是 READY/RUNNING',
    )
    await runtime2.close()
  })
})

// ============ 显式 resumeInterrupted：原 identity + 不重复已完成 Task ============

await test('T021 CASE A: resumeInterrupted 使用原 Session，只执行下一 Task，不重复已完成 Task', async () => {
  await withStorage('t021-case-a-', async (storageUrl) => {
    const session = definition('t021-case-a', 3)
    const sideEffects = new Map<string, number>()
    let t2Entered: (() => void) | undefined
    const t2EnteredPromise = new Promise<void>((resolve) => { t2Entered = resolve })

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          sideEffects.set(task.id, (sideEffects.get(task.id) ?? 0) + 1)
          if (task.id === 'T1') return { status: 'COMPLETED' }
          t2Entered?.()
          await NEVER
          return { status: 'COMPLETED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await t2EnteredPromise
    assert.deepEqual(runtime1.getDurableState()?.completedTaskIds, ['T1'])
    await runtime1.close()
    void startPromise

    // 重启后显式恢复
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: completedRunner(sideEffects),
    })
    const hydrated = await runtime2.loadPersistedState()
    assert.equal(deriveDisplayState(hydrated, false), 'RECOVERABLE')

    const resumed = await runtime2.resumeInterrupted()
    assert.equal(resumed.state, 'COMPLETED')
    assert.deepEqual(resumed.completedTaskIds, ['T1', 'T2', 'T3'])

    // T1 已完成不重复（runtime2 中 T1 执行 0 次）；T2 从边界恢复执行 1 次；T3 执行 1 次
    assert.equal(sideEffects.get('T1'), 1, 'T1 不得重复执行')
    assert.equal(sideEffects.get('T2'), 2, 'T2 在 P1 挂起 + P2 恢复各一次')
    assert.equal(sideEffects.get('T3'), 1, 'T3 只执行一次')
    await runtime2.close()
  })
})

// ============ repeated resume 幂等 ============

await test('T021 repeated resumeInterrupted 不创建两个活动 Runner', async () => {
  await withStorage('t021-idempotent-', async (storageUrl) => {
    const session = definition('t021-idempotent', 2)
    let t2Entered: (() => void) | undefined
    const t2EnteredPromise = new Promise<void>((resolve) => { t2Entered = resolve })

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          if (task.id === 'T1') return { status: 'COMPLETED' }
          t2Entered?.()
          await NEVER
          return { status: 'COMPLETED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await t2EnteredPromise
    await runtime1.close()
    void startPromise

    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: completedRunner(new Map()),
    })
    await runtime2.loadPersistedState()

    const first = runtime2.resumeInterrupted()
    await assert.rejects(runtime2.resumeInterrupted(), /already in progress/)
    const resumed = await first
    assert.equal(resumed.state, 'COMPLETED')
    await runtime2.close()
  })
})

// ============ 终态不可恢复 + fresh READY ============

await test('T021 终态 Session 不可 resumeInterrupted，fresh Session 保持 READY', async () => {
  await withStorage('t021-terminal-', async (storageUrl) => {
    // COMPLETED
    const completedSession = definition('t021-terminal-completed')
    const runtimeA = new WorkSessionRuntime({
      definition: completedSession,
      storageUrl: `${storageUrl}-completed`,
      taskRunner: completedRunner(new Map()),
    })
    assert.equal((await runtimeA.start()).state, 'COMPLETED')
    await runtimeA.close()

    const runtimeA2 = new WorkSessionRuntime({
      definition: completedSession,
      storageUrl: `${storageUrl}-completed`,
      taskRunner: completedRunner(new Map()),
    })
    const completedHydrated = await runtimeA2.loadPersistedState()
    assert.equal(deriveDisplayState(completedHydrated, false), 'COMPLETED')
    await assert.rejects(runtimeA2.resumeInterrupted(), /cannot be recovered/)
    await runtimeA2.close()

    // FAILED
    const failedSession = definition('t021-terminal-failed')
    const runtimeB = new WorkSessionRuntime({
      definition: failedSession,
      storageUrl: `${storageUrl}-failed`,
      taskRunner: {
        async run(): Promise<WorkSessionTaskResult> {
          return { status: 'FAILED', error: 'simulated failure' }
        },
      },
    })
    await assert.rejects(runtimeB.start(), /failed/)
    await runtimeB.close()

    const runtimeB2 = new WorkSessionRuntime({
      definition: failedSession,
      storageUrl: `${storageUrl}-failed`,
      taskRunner: completedRunner(new Map()),
    })
    const failedHydrated = await runtimeB2.loadPersistedState()
    assert.equal(deriveDisplayState(failedHydrated, false), 'FAILED')
    await assert.rejects(runtimeB2.resumeInterrupted(), /cannot be recovered/)
    await runtimeB2.close()

    // fresh（从未启动）
    const freshSession = definition('t021-terminal-fresh')
    const runtimeC = new WorkSessionRuntime({
      definition: freshSession,
      storageUrl: `${storageUrl}-fresh`,
      taskRunner: completedRunner(new Map()),
    })
    const freshHydrated = await runtimeC.loadPersistedState()
    assert.equal(freshHydrated, undefined)
    assert.equal(deriveDisplayState(freshHydrated, false), 'READY')
    await runtimeC.close()
  })
})

// ============ controller：displayState / recoverableSummary / resumeRecoverable ============

await test('T021 controller 暴露 displayState、恢复信息，并显式分派 resumeRecoverable', async () => {
  await withStorage('t021-controller-', async (storageUrl) => {
    const session = definition('t021-controller', 2)
    let t2Entered: (() => void) | undefined
    const t2EnteredPromise = new Promise<void>((resolve) => { t2Entered = resolve })

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          if (task.id === 'T1') return { status: 'COMPLETED' }
          t2Entered?.()
          await NEVER
          return { status: 'COMPLETED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await t2EnteredPromise
    await runtime1.close()
    void startPromise

    const sideEffects = new Map<string, number>()
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: completedRunner(sideEffects),
    })
    const controller = new WorkSessionControlController({
      createRuntime: () => runtime2,
      pollIntervalMs: 10,
    })
    const hydrated = await controller.loadPersistedState()
    assert.equal(hydrated?.state, 'RUNNING')

    const snapshot = controller.getSnapshot()
    assert.equal(snapshot.runtime.displayState, 'RECOVERABLE', '控制台不得显示 RUNNING')
    assert.equal(snapshot.runtime.hasActiveExecution, false)
    assert.ok(snapshot.runtime.recoverableSummary, 'RECOVERABLE 必须有恢复信息')
    assert.equal(snapshot.runtime.recoverableSummary?.lastCompletedTaskId, 'T1')
    assert.equal(snapshot.runtime.recoverableSummary?.currentTaskId, 'T2')
    // 无活动 Runner：UI 依据 displayState 不显示 pause/stop（displayState !== RUNNING）
    assert.notEqual(snapshot.runtime.displayState, 'RUNNING')

    // 显式恢复分派（RUNNING 崩溃 → resumeInterrupted）
    const accepted = controller.resumeRecoverable({})
    assert.equal(accepted.accepted, true)
    await controller.getResumePromise()
    assert.equal(runtime2.getDurableState()?.state, 'COMPLETED')
    assert.equal(sideEffects.get('T1') ?? 0, 0, 'controller 恢复后 T1 不得重复执行')
    assert.equal(sideEffects.get('T2'), 1)

    controller.close()
    await runtime2.close()
  })
})

// ============ Launchpad 状态读取与控制器一致 ============

await test('T021 Launchpad 读取持久化状态并派生与控制器一致的展示状态', async () => {
  await withStorage('t021-launchpad-', async (storageUrl) => {
    const session = definition('t021-launchpad-session', 2)
    let t2Entered: (() => void) | undefined
    const t2EnteredPromise = new Promise<void>((resolve) => { t2Entered = resolve })

    const runtime1 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: {
        async run(task): Promise<WorkSessionTaskResult> {
          if (task.id === 'T1') return { status: 'COMPLETED' }
          t2Entered?.()
          await NEVER
          return { status: 'COMPLETED' }
        },
      },
    })
    const startPromise = runtime1.start()
    await t2EnteredPromise
    await runtime1.close()
    void startPromise

    // 控制器侧：读同一持久化 storage
    const runtime2 = new WorkSessionRuntime({
      definition: session,
      storageUrl,
      taskRunner: completedRunner(new Map()),
    })
    const controller = new WorkSessionControlController({ createRuntime: () => runtime2 })
    const hydrated = await controller.loadPersistedState()
    const controllerDisplay = deriveDisplayState(hydrated, runtime2.hasActiveExecution())
    assert.equal(controllerDisplay, 'RECOVERABLE')

    // Launchpad 侧：写一个带显式 storageUrl 的 trusted config，让默认 readSessionStatus 读同一 storage
    const configDirectory = await mkdtemp(join(tmpdir(), 't021-launchpad-cfg-'))
    const trustedConfig = {
      session: {
        id: session.id,
        targetRepo: REPO,
        branch: BRANCH,
        limits: session.limits,
      },
      tasks: session.tasks.map((task) => ({
        id: task.id, goal: task.goal,
        guardian: {
          constraints: [], acceptanceCriteria: [], doNotDo: [],
          allowedPaths: ['packages/**'], forbiddenPaths: [],
        },
      })),
      gitCheckpoint: { autoCommit: false, autoPush: false },
      executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      storageUrl,
    }
    await writeFile(join(configDirectory, `${session.id}.json`), JSON.stringify(trustedConfig), 'utf8')

    const launchpad = await createNovaWingLaunchpad({ configDirectory })
    try {
      await launchpad.start()
      const configs = launchpad.getConfigs()
      assert.equal(configs.length, 1)
      assert.equal(configs[0]!.status, 'RECOVERABLE', 'Launchpad 与控制台必须一致')
    } finally {
      await launchpad.close()
      await rm(configDirectory, { recursive: true, force: true })
    }

    controller.close()
    await runtime2.close()
  })
})
