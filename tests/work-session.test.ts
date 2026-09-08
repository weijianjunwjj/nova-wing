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

    // ===== 第一阶段：第一次执行 =====
    // 创建 runner1，T2 使用 CONDITIONAL 行为
    const runner1 = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: {
        type: 'CONDITIONAL',
        checkResumeData: (resumeData) => {
          // 如果有 decision，表示 resume，返回 COMPLETED
          if (resumeData?.decision) {
            return { type: 'COMPLETED' }
          }
          // 否则第一次执行，返回 HUMAN_REQUIRED
          return {
            type: 'HUMAN_REQUIRED',
            category: 'DECISION_REQUIRED',
            reason: 'choose database mode',
          }
        },
      },
      T3: { type: 'COMPLETED' },
    })

    const config1: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: runner1,
      storageUrl,
    }

    const runtime1 = new WorkSessionRuntime(config1)
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
      runner1.getExecutionCount('T1'),
      1,
      'T1 should execute exactly once',
    )
    assert.strictEqual(
      runner1.getExecutionCount('T2'),
      1,
      'T2 should execute once',
    )
    assert.strictEqual(
      runner1.getExecutionCount('T3'),
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
    assert.strictEqual(state1.taskStatesV2?.T2?.identity.taskId, 'T2')
    assert.strictEqual(state1.taskStatesV2?.T2?.status, 'SUSPENDED')

    const runId1 = runtime1.getRunId()
    assert.ok(runId1, 'Should have runId')

    // ===== 验证 Mastra Snapshot 持久化 =====
    const snapshot = await runtime1.verifySnapshot()
    assert.strictEqual(snapshot.exists, true, 'Mastra snapshot should exist')
    assert.strictEqual(snapshot.status, 'suspended', 'Snapshot should be suspended')
    assert.strictEqual(
      snapshot.hasSuspendedStep,
      true,
      'Snapshot should have suspended step',
    )
    assert.strictEqual(
      snapshot.suspendedStepId,
      'execute-tasks-serially',
      'Suspended step should be the task executor',
    )

    // ===== 模拟进程重启 =====
    // 完全销毁第一套 runtime 和 runner
    await runtime1.close()
    // runner1 不再使用

    // ===== 第二阶段：创建全新的 runtime 和 runner =====
    // 创建 runner2，使用相同的 CONDITIONAL 逻辑
    const runner2 = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: {
        type: 'CONDITIONAL',
        checkResumeData: (resumeData) => {
          if (resumeData?.decision) {
            return { type: 'COMPLETED' }
          }
          return {
            type: 'HUMAN_REQUIRED',
            category: 'DECISION_REQUIRED',
            reason: 'choose database mode',
          }
        },
      },
      T3: { type: 'COMPLETED' },
    })

    const config2: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: runner2,
      storageUrl, // 相同的 storage URL
    }

    const runtime2 = new WorkSessionRuntime(config2)

    // Resume with decision（runId 自动使用 definition.id）
    const state2 = await runtime2.resume({ decision: 'docker' })

    // 验证 resume 后的状态
    assert.strictEqual(state2.state, 'COMPLETED', 'Session should be COMPLETED')
    assert.deepStrictEqual(
      state2.completedTaskIds,
      ['T1', 'T2', 'T3'],
      'All tasks should be completed',
    )
    assert.strictEqual(state2.currentTaskId, null, 'No current task')
    assert.strictEqual(state2.humanRequired, undefined, 'humanRequired should be cleared after completion')
    assert.strictEqual(state2.taskStatesV2?.T2?.identity.sessionId, definition.id)

    // 核心验证：第二套 runner 的执行次数
    // runner2 的 T1 不应该执行（因为已在 completed 列表）
    assert.strictEqual(
      runner2.getExecutionCount('T1'),
      0,
      'runner2: T1 should NOT execute (already completed)',
    )
    // T2 在 resume 时执行一次（带 decision）
    assert.strictEqual(
      runner2.getExecutionCount('T2'),
      1,
      'runner2: T2 should execute once with resumeData',
    )
    // T3 在 T2 完成后执行一次
    assert.strictEqual(
      runner2.getExecutionCount('T3'),
      1,
      'runner2: T3 should execute once after T2 resumed',
    )

    // 验证 runner1 的执行次数未变（因为是不同实例）
    assert.strictEqual(
      runner1.getExecutionCount('T1'),
      1,
      'runner1: T1 count should remain 1',
    )
    assert.strictEqual(
      runner1.getExecutionCount('T2'),
      1,
      'runner1: T2 count should remain 1',
    )
    assert.strictEqual(
      runner1.getExecutionCount('T3'),
      0,
      'runner1: T3 count should remain 0',
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
      // Mastra 可能包装错误，检查消息或 cause
      const message = error.message
      const causeMessage = (error as any).cause?.message || ''
      assert.ok(
        message.includes('failed') || causeMessage.includes('failed'),
        `Error message should contain 'failed', got: ${message}`,
      )
    }

    // 验证 Mastra 持久化的 FAILED state
    const snapshot = await runtime.verifySnapshot()
    assert.strictEqual(snapshot.exists, true, 'Snapshot should exist')
    assert.strictEqual(snapshot.status, 'failed', 'Persisted status should be failed')
    assert.strictEqual(snapshot.hasSuspendedStep, false, 'Should not have suspended step')

    await runtime.close()

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

    // T1 初次需要人工介入，resume 后完成
    const taskRunner1 = new FakeTaskRunner({
      T1: { type: 'HUMAN_REQUIRED', category: 'PERMISSION_REQUIRED', reason: 'need approval' },
      T2: { type: 'COMPLETED' },
      T3: { type: 'COMPLETED' },
    })

    const config1: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner1,
      storageUrl,
    }

    // 第一次执行
    const runtime1 = new WorkSessionRuntime(config1)
    const state1 = await runtime1.start()

    assert.strictEqual(state1.state, 'SUSPENDED')
    assert.deepStrictEqual(state1.completedTaskIds, [])
    assert.strictEqual(state1.currentTaskId, 'T1')
    assert.strictEqual(taskRunner1.getExecutionCount('T1'), 1)
    assert.strictEqual(taskRunner1.getExecutionCount('T2'), 0)

    // 关闭第一个 runtime
    await runtime1.close()

    // 模拟进程重启，使用 fresh runner，T1 使用 CONDITIONAL behavior
    const taskRunner2 = new FakeTaskRunner({
      T1: {
        type: 'CONDITIONAL',
        checkResumeData: resumeData => {
          // resume 时带有 approval 字段，T1 完成
          if (resumeData?.approval === true) {
            return { type: 'COMPLETED' }
          }
          return { type: 'HUMAN_REQUIRED', category: 'PERMISSION_REQUIRED', reason: 'still need approval' }
        },
      },
      T2: { type: 'COMPLETED' },
      T3: { type: 'COMPLETED' },
    })

    const config2: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner2,
      storageUrl,
    }

    const runtime2 = new WorkSessionRuntime(config2)
    const state2 = await runtime2.resume({ approval: true })

    // 验证 T1 继续执行并完成，然后 T2、T3 也执行
    assert.strictEqual(state2.state, 'COMPLETED')
    assert.deepStrictEqual(state2.completedTaskIds, ['T1', 'T2', 'T3'])
    assert.strictEqual(state2.humanRequired, undefined, 'humanRequired should be cleared')

    // taskRunner2 是新实例，T1 执行 1 次，T2 执行 1 次，T3 执行 1 次
    assert.strictEqual(taskRunner2.getExecutionCount('T1'), 1)
    assert.strictEqual(taskRunner2.getExecutionCount('T2'), 1)
    assert.strictEqual(taskRunner2.getExecutionCount('T3'), 1)

    // taskRunner1 计数不变
    assert.strictEqual(taskRunner1.getExecutionCount('T1'), 1)
    assert.strictEqual(taskRunner1.getExecutionCount('T2'), 0)

    await runtime2.close()
  })

  it('Case D: duplicate start() on existing session fails closed', async () => {
    const definition: WorkSessionDefinition = {
      id: 'test-session-d',
      targetRepo: '/test/repo',
      branch: 'main',
      tasks: [
        { id: 'T1', goal: 'Task requiring human input' },
        { id: 'T2', goal: 'Complete task 2' },
      ],
      limits: {
        softMinutes: 45,
        hardMinutes: 60,
        maxTasks: 5,
      },
    }

    const taskRunner1 = new FakeTaskRunner({
      T1: { type: 'HUMAN_REQUIRED', category: 'PERMISSION_REQUIRED', reason: 'need approval' },
      T2: { type: 'COMPLETED' },
    })

    const config1: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner1,
      storageUrl,
    }

    // 第一次 start() 成功
    const runtime1 = new WorkSessionRuntime(config1)
    const state1 = await runtime1.start()

    assert.strictEqual(state1.state, 'SUSPENDED')
    assert.strictEqual(taskRunner1.getExecutionCount('T1'), 1)

    await runtime1.close()

    // 第二次尝试 start() 相同 session，必须失败
    const taskRunner2 = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: { type: 'COMPLETED' },
    })

    const config2: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner2,
      storageUrl,
    }

    const runtime2 = new WorkSessionRuntime(config2)

    await assert.rejects(
      runtime2.start(),
      /already exists|resume/i,
      'Should reject duplicate start() with clear error',
    )

    // 验证 runner2 未执行任何任务
    assert.strictEqual(taskRunner2.getExecutionCount('T1'), 0)
    assert.strictEqual(taskRunner2.getExecutionCount('T2'), 0)

    await runtime2.close()
  })

  it('Case E: resume() on FAILED session fails closed', async () => {
    const definition: WorkSessionDefinition = {
      id: 'test-session-e',
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

    const taskRunner1 = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: { type: 'FAILED', error: 'simulated failure' },
      T3: { type: 'COMPLETED' },
    })

    const config1: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner1,
      storageUrl,
    }

    // 第一次运行：T1 完成，T2 失败
    const runtime1 = new WorkSessionRuntime(config1)

    try {
      await runtime1.start()
      assert.fail('Should have thrown error for FAILED task')
    } catch (error) {
      assert.ok(error instanceof Error)
      assert.ok(
        error.message.includes('failed'),
        `Error message should contain 'failed', got: ${error.message}`,
      )
    }

    // 验证 Mastra persisted status 为 failed
    const snapshot = await runtime1.verifySnapshot()
    assert.strictEqual(snapshot.status, 'failed', 'Persisted status should be failed')

    await runtime1.close()

    // 第二次尝试 resume() FAILED session，必须失败
    const taskRunner2 = new FakeTaskRunner({
      T1: { type: 'COMPLETED' },
      T2: { type: 'COMPLETED' },
      T3: { type: 'COMPLETED' },
    })

    const config2: WorkSessionRuntimeConfig = {
      definition,
      taskRunner: taskRunner2,
      storageUrl,
    }

    const runtime2 = new WorkSessionRuntime(config2)

    await assert.rejects(
      runtime2.resume({}),
      /failed|cannot resume/i,
      'Should reject resume() on FAILED session with clear error',
    )

    // 验证 runner2 未执行任何任务
    assert.strictEqual(taskRunner2.getExecutionCount('T1'), 0)
    assert.strictEqual(taskRunner2.getExecutionCount('T2'), 0)
    assert.strictEqual(taskRunner2.getExecutionCount('T3'), 0)

    await runtime2.close()
  })
})

