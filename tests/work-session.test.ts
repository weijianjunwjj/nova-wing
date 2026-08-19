/**
 * Work Session W001 Integration Test
 * 验证持久化、suspend 和 resume 核心能力
 */

import assert from 'node:assert'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WorkSessionRuntime,
  FakeTaskRunner,
  type WorkSessionDefinition,
  type WorkSessionRuntimeConfig,
} from '../packages/development-guardian/work-session/index.js'

describe('Work Session W001 - Durable Skeleton', () => {
  let tempDir: string
  let storageUrl: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'work-session-test-'))
    storageUrl = `file:${join(tempDir, 'test.db')}`
  })

  afterEach(async () => {
    if (tempDir) {
      // 等待一段时间确保数据库文件被释放
      await new Promise((resolve) => setTimeout(resolve, 200))

      // 重试删除，处理 Windows 文件锁定问题
      let retries = 3
      while (retries > 0) {
        try {
          await rm(tempDir, { recursive: true, force: true })
          break
        } catch (error) {
          if (retries === 1) {
            // 最后一次重试失败，记录错误但不抛出
            console.warn(`Failed to cleanup ${tempDir}:`, error)
          }
          retries--
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    }
  })

  it('Case A: T1 COMPLETED → T2 HUMAN_REQUIRED → process restart → resume → T2,T3 COMPLETED', async () => {
    // 定义 Work Session
    const definition: WorkSessionDefinition = {
      id: 'test-session-a',
      targetRepo: '/test/repo',
      branch: 'main',
      tasks: [
        { id: 'T1', goal: 'Complete task 1' },
        { id: 'T2', goal: 'Complete task 2' },
        { id: 'T3', goal: 'Complete task 3' },
      ],
      limits: {
        softMinutes: 45,
        hardMinutes: 60,
        maxTasks: 5,
      },
    }

    // 创建 FakeTaskRunner
    const taskRunner = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: {
        type: 'HUMAN_REQUIRED',
        category: 'DECISION_REQUIRED',
        reason: 'choose database mode',
      },
      T3: { type: 'COMPLETED' },
    })

    const config: WorkSessionRuntimeConfig = {
      definition,
      taskRunner,
      storageUrl,
    }

    // ===== 第一次执行 =====
    const runtime1 = new WorkSessionRuntime(config)
    const state1 = await runtime1.start()

    // 验证第一次执行后的状态
    assert.strictEqual(state1.state, 'SUSPENDED', 'Session should be SUSPENDED')
    assert.deepStrictEqual(
      state1.completedTaskIds,
      ['T1'],
      'Only T1 should be completed',
    )
    assert.strictEqual(state1.currentTaskId, 'T2', 'Current task should be T2')
    assert.strictEqual(
      taskRunner.getExecutionCount('T1'),
      1,
      'T1 should execute exactly once',
    )
    assert.strictEqual(
      taskRunner.getExecutionCount('T2'),
      1,
      'T2 should execute once',
    )
    assert.strictEqual(
      taskRunner.getExecutionCount('T3'),
      0,
      'T3 should not execute yet',
    )
    assert.strictEqual(
      state1.humanRequired?.category,
      'DECISION_REQUIRED',
      'Should require human decision',
    )
    assert.strictEqual(
      state1.humanRequired?.reason,
      'choose database mode',
      'Should have correct reason',
    )

    // ===== 模拟进程重启 =====
    // 完全销毁第一套 runtime
    await runtime1.close()

    // 在 resume 前，将 T2 的行为修改为 COMPLETED（模拟用户提供决策后任务可以完成）
    taskRunner.setBehavior('T2', { type: 'COMPLETED' })

    // ===== 创建新的 runtime，使用相同的 storage 和 definition =====
    const runtime2 = new WorkSessionRuntime(config)

    // Resume with decision
    const state2 = await runtime2.resume({ decision: 'docker' })

    // 验证 resume 后的状态
    assert.strictEqual(state2.state, 'COMPLETED', 'Session should be COMPLETED')
    assert.deepStrictEqual(
      state2.completedTaskIds,
      ['T1', 'T2', 'T3'],
      'All tasks should be completed',
    )
    assert.strictEqual(state2.currentTaskId, null, 'No current task')

    // 核心验证：T1 总执行次数仍然是 1
    assert.strictEqual(
      taskRunner.getExecutionCount('T1'),
      1,
      'T1 should still execute exactly once (not rerun)',
    )
    assert.strictEqual(
      taskRunner.getExecutionCount('T2'),
      2,
      'T2 should execute twice (initial + resume)',
    )
    assert.strictEqual(
      taskRunner.getExecutionCount('T3'),
      1,
      'T3 should execute once after T2 resumed',
    )

    await runtime2.close()
  })

  it('Case B: T1 COMPLETED → T2 FAILED → session FAILED', async () => {
    const definition: WorkSessionDefinition = {
      id: 'test-session-b',
      targetRepo: '/test/repo',
      branch: 'main',
      tasks: [
        { id: 'T1', goal: 'Complete task 1' },
        { id: 'T2', goal: 'Fail task 2' },
        { id: 'T3', goal: 'Complete task 3' },
      ],
      limits: {
        softMinutes: 45,
        hardMinutes: 60,
        maxTasks: 5,
      },
    }

    const taskRunner = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: { type: 'FAILED', error: 'simulated failure' },
      T3: { type: 'COMPLETED' },
    })

    const config: WorkSessionRuntimeConfig = {
      definition,
      taskRunner,
      storageUrl,
    }

    const runtime = new WorkSessionRuntime(config)

    try {
      await runtime.start()
      assert.fail('Should have thrown error for FAILED task')
    } catch (error) {
      // Expected failure
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('failed'))
    } finally {
      await runtime.close()
    }

    // 验证状态
    assert.deepStrictEqual(
      taskRunner.getExecutionCount('T1'),
      1,
      'T1 should execute once',
    )
    assert.deepStrictEqual(
      taskRunner.getExecutionCount('T2'),
      1,
      'T2 should execute once',
    )
    assert.deepStrictEqual(
      taskRunner.getExecutionCount('T3'),
      0,
      'T3 should not execute',
    )
  })

  it('Case C: T1 HUMAN_REQUIRED → process restart → resume → T1 COMPLETED', async () => {
    const definition: WorkSessionDefinition = {
      id: 'test-session-c',
      targetRepo: '/test/repo',
      branch: 'main',
      tasks: [
        { id: 'T1', goal: 'Task requiring human input' },
        { id: 'T2', goal: 'Complete task 2' },
        { id: 'T3', goal: 'Complete task 3' },
      ],
      limits: {
        softMinutes: 45,
        hardMinutes: 60,
        maxTasks: 5,
      },
    }

    // T1 initially requires human, then completes on resume
    const taskRunner = new FakeTaskRunner({
      T1: { type: 'HUMAN_REQUIRED', category: 'PERMISSION_REQUIRED', reason: 'need approval' },
      T2: { type: 'COMPLETED' },
      T3: { type: 'COMPLETED' },
    })

    const config: WorkSessionRuntimeConfig = {
      definition,
      taskRunner,
      storageUrl,
    }

    // 第一次执行
    const runtime1 = new WorkSessionRuntime(config)
    const state1 = await runtime1.start()

    assert.strictEqual(state1.state, 'SUSPENDED')
    assert.deepStrictEqual(state1.completedTaskIds, [])
    assert.strictEqual(state1.currentTaskId, 'T1')
    assert.strictEqual(taskRunner.getExecutionCount('T1'), 1)
    assert.strictEqual(taskRunner.getExecutionCount('T2'), 0)

    // 关闭第一个 runtime
    await runtime1.close()

    // 模拟进程重启，修改 T1 behavior 为 COMPLETED
    taskRunner.setBehavior('T1', { type: 'COMPLETED' })

    const runtime2 = new WorkSessionRuntime(config)
    const state2 = await runtime2.resume({ approval: true })

    // 验证 T1 继续执行，不是直接跳到 T2
    assert.strictEqual(state2.state, 'COMPLETED')
    assert.deepStrictEqual(state2.completedTaskIds, ['T1', 'T2', 'T3'])
    assert.strictEqual(taskRunner.getExecutionCount('T1'), 2)
    assert.strictEqual(taskRunner.getExecutionCount('T2'), 1)
    assert.strictEqual(taskRunner.getExecutionCount('T3'), 1)

    await runtime2.close()
  })
})

