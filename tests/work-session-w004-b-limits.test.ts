/**
 * W004-B Session Limits — maxTasks / soft / active-time 测试
 *
 * CASE Y   maxTasks
 * CASE Z   soft stop
 * CASE AA  suspend time excluded from activeElapsed
 * CASE AE  hard between tasks
 * CASE AF  limit precedence（hard > maxTasks > soft）
 * 另含：config validation fail-fast
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WorkSessionRuntime,
  FakeTaskRunner,
  type WorkSessionDefinition,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'

const MIN = 60_000

function makeDefinition(
  id: string,
  tasks: WorkSessionDefinition['tasks'],
  limits: WorkSessionDefinition['limits'],
): WorkSessionDefinition {
  return {
    id,
    targetRepo: '/tmp/repo',
    branch: 'feat/test',
    tasks,
    limits,
  }
}

async function cleanupTemp(tempBase: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
  let retries = 3
  while (retries > 0) {
    try {
      await rm(tempBase, { recursive: true, force: true })
      break
    } catch {
      retries--
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

// ============ CASE Y: maxTasks ============

await test('W004-B CASE Y: maxTasks=2 stops claiming T3', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-y-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        return { status: 'COMPLETED', summary: `${task.id} done` }
      },
    }

    const definition = makeDefinition(
      'w004b-y',
      [{ id: 'T1', goal: '1' }, { id: 'T2', goal: '2' }, { id: 'T3', goal: '3' }],
      { softMinutes: 45, hardMinutes: 60, maxTasks: 2 },
    )

    const runtime = new WorkSessionRuntime({ definition, taskRunner, storageUrl })
    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED')
    assert.deepEqual(state.completedTaskIds, ['T1', 'T2'])
    assert.equal(state.completionReason, 'MAX_TASKS')
    assert.equal(executionCounts.get('T3') ?? 0, 0, 'T3 must not execute')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE Z: soft stop ============

await test('W004-B CASE Z: soft stop — T1 completes past soft, T2 not claimed', async () => {
  let now = 0
  const clock = { now: () => now }
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-z-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        now += 11 * MIN // T1 完成时超过 soft(10min) 且低于 hard(60min)
        return { status: 'COMPLETED', summary: `${task.id} done` }
      },
    }

    const definition = makeDefinition(
      'w004b-z',
      [{ id: 'T1', goal: '1' }, { id: 'T2', goal: '2' }],
      { softMinutes: 10, hardMinutes: 60, maxTasks: 5 },
    )

    const runtime = new WorkSessionRuntime({ definition, taskRunner, storageUrl, clock })
    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(state.completionReason, 'SOFT_LIMIT')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute after soft stop')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE AA: suspend time excluded ============

await test('W004-B CASE AA: suspend time excluded from activeElapsed', async () => {
  let now = 0
  const clock = { now: () => now }
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-aa-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    let t1Mode: 'HUMAN_REQUIRED' | 'COMPLETED' = 'HUMAN_REQUIRED'
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        now += 8 * MIN
        if (t1Mode === 'HUMAN_REQUIRED') {
          return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose db mode' } }
        }
        return { status: 'COMPLETED', summary: 'T1 done' }
      },
    }

    const definition = makeDefinition(
      'w004b-aa',
      [{ id: 'T1', goal: '1' }],
      { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    )

    // 第一段：T1 HUMAN_REQUIRED → suspend（active 8min）
    const runtime1 = new WorkSessionRuntime({ definition, taskRunner, storageUrl, clock })
    const state1 = await runtime1.start()
    assert.equal(state1.state, 'SUSPENDED')
    assert.ok(state1.activeElapsedMs !== undefined, 'activeElapsedMs must be present on suspend')
    assert.ok(
      Math.abs((state1.activeElapsedMs ?? 0) - 8 * MIN) < 1000,
      'activeElapsedMs must be ~8min on suspend',
    )
    await runtime1.close()

    // 3 小时现实墙钟时间过去（模拟用户几小时后才 resume）
    now += 3 * 60 * MIN

    // 第二段：resume → T1 完成
    t1Mode = 'COMPLETED'
    const runtime2 = new WorkSessionRuntime({ definition, taskRunner, storageUrl, clock })
    const state2 = await runtime2.resume({ decision: 'docker' })
    await runtime2.close()

    assert.equal(state2.state, 'COMPLETED')
    assert.deepEqual(state2.completedTaskIds, ['T1'])
    // activeElapsed ≈ 8min(第一段) + 8min(resume 段) = 16min，绝不含 3h 暂停
    const elapsed = state2.activeElapsedMs ?? 0
    assert.ok(Math.abs(elapsed - 16 * MIN) < 2000, `activeElapsed must be ~16min, got ${elapsed}`)
    assert.ok(elapsed < 20 * MIN, 'activeElapsed must NOT include 3h suspension')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE AE: hard between tasks ============

await test('W004-B CASE AE: hard between tasks — T1 completes, T2 not claimed, HARD_LIMIT', async () => {
  let now = 0
  const clock = { now: () => now }
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-ae-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        now += 61 * MIN // 超过 hard(60min)
        return { status: 'COMPLETED', summary: `${task.id} done` }
      },
    }

    const definition = makeDefinition(
      'w004b-ae',
      [{ id: 'T1', goal: '1' }, { id: 'T2', goal: '2' }],
      { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    )

    const runtime = new WorkSessionRuntime({ definition, taskRunner, storageUrl, clock })
    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(state.completionReason, 'HARD_LIMIT')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE AF: precedence ============

await test('W004-B CASE AF: precedence — hard wins over maxTasks and soft', async () => {
  let now = 0
  const clock = { now: () => now }
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-af-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const taskRunner = {
      async run(): Promise<WorkSessionTaskResult> {
        now += 61 * MIN // 超过 hard
        return { status: 'COMPLETED', summary: 'done' }
      },
    }

    // maxTasks=1 + soft=1min 同时满足；hard=60min 也满足 → 应报 HARD_LIMIT
    const definition = makeDefinition(
      'w004b-af',
      [{ id: 'T1', goal: '1' }, { id: 'T2', goal: '2' }],
      { softMinutes: 1, hardMinutes: 60, maxTasks: 1 },
    )

    const runtime = new WorkSessionRuntime({ definition, taskRunner, storageUrl, clock })
    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(state.completionReason, 'HARD_LIMIT', 'hard limit must take precedence')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ Config validation ============

await test('W004-B validation: invalid limits fail fast before any work', async () => {
  const badLimits: WorkSessionDefinition['limits'][] = [
    { softMinutes: 10, hardMinutes: 20, maxTasks: 0 }, // maxTasks < 1
    { softMinutes: -1, hardMinutes: 20, maxTasks: 2 }, // soft < 0
    { softMinutes: 10, hardMinutes: 0, maxTasks: 2 }, // hard <= 0
    { softMinutes: 30, hardMinutes: 20, maxTasks: 2 }, // hard < soft
  ]
  for (const limits of badLimits) {
    assert.throws(
      () =>
        new WorkSessionRuntime({
          definition: {
            id: 'bad-limits',
            targetRepo: '/tmp/repo',
            branch: 'feat/test',
            tasks: [{ id: 'T1', goal: 'g' }],
            limits,
          },
          taskRunner: new FakeTaskRunner({}),
          storageUrl: 'file:/tmp/unused.db',
        }),
      'invalid limits must fail fast',
    )
  }
})

await test('W004-B validation: valid limits accepted', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-valid-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const runtime = new WorkSessionRuntime({
      definition: makeDefinition('w004b-valid', [{ id: 'T1', goal: 'g' }], {
        softMinutes: 1,
        hardMinutes: 2,
        maxTasks: 1,
      }),
      taskRunner: new FakeTaskRunner({ T1: { type: 'COMPLETED' } }),
      storageUrl,
    })
    const state = await runtime.start()
    await runtime.close()
    assert.equal(state.state, 'COMPLETED')
    assert.deepEqual(state.completedTaskIds, ['T1'])
    assert.equal(state.completionReason, 'ALL_TASKS_COMPLETED')
  } finally {
    await cleanupTemp(tempBase)
  }
})
