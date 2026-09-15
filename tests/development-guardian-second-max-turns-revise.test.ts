import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  runGuardianTask,
  ClaudeCodeExecutor,
  type DelegationPacket,
  type GuardianBrain,
  type GuardianCommandRequest,
  type GuardianCommandResult,
} from 'nova-wing/development-guardian'

class QueueRunner {
  public readonly requests: GuardianCommandRequest[] = []
  private queue: GuardianCommandResult[]

  constructor(queue: GuardianCommandResult[]) {
    this.queue = [...queue]
  }

  run = async (request: GuardianCommandRequest): Promise<GuardianCommandResult> => {
    this.requests.push(request)
    const result = this.queue.shift()
    if (result === undefined) {
      throw new Error('test runner queue is empty')
    }
    return result
  }
}

function commandResult(stdout: string, exitCode = 0): GuardianCommandResult {
  return { exitCode, signal: null, stdout, stderr: '' }
}

function claudeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'success',
    subtype: 'success',
    is_error: false,
    result: 'task completed',
    session_id: 'session-123',
    num_turns: 8,
    ...overrides,
  })
}

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: '完成开发任务',
    instructions: verdict === 'proceed' || verdict === 'revise' ? ['实现功能'] : [],
    constraints: ['保持类型安全'],
    verification: ['npm test'],
    doNotDo: ['不要修改数据库'],
  }
}

test('second max_turns with safe boundaries allows Brain to revise', async (t) => {
  const createdWorkspace = await mkdtemp(join(tmpdir(), 'novawing-second-max-turns-'))
  const workspace = await realpath(createdWorkspace)
  t.after(async () => { await rm(createdWorkspace, { recursive: true, force: true }) })
  // Scenario: 第一次 12 turns 达到 max_turns → recovery +6 turns → 第二次仍达到 max_turns
  // 但安全边界正常（无 scope violation、permission denial）
  // Guardian 应该重新请求 Brain review，Brain 可以返回 revise
  // Executor 继续使用同一 session
  const runner = new QueueRunner([
    // iteration 1: 第一次执行
    commandResult(''), // git status --porcelain (clean)
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 12, result: '部分完成，需要更多轮次。' }), 1),
    commandResult(' M src/feature.ts\n'), // git status after first attempt
    // recovery
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 6, result: '继续完成，但仍需更多轮次。' }), 1),
    commandResult(' M src/feature.ts\n M src/feature.test.ts\n'), // git status after recovery
    // 第二次 max_turns 后不运行 verification

    // iteration 2: Brain 返回 revise，继续执行
    commandResult(claudeJson({ result: '已完成所有功能。' })), // 第三次执行完成
    commandResult(' M src/feature.ts\n M src/feature.test.ts\n M README.md\n'), // git status
    commandResult('diff clean'), // git diff --check
    commandResult('tests passed'), // npm test
  ])

  const brainReviewCalls: Array<{ hasReport: boolean; iteration: number }> = []
  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review({ task, report }) {
      brainCallCount += 1
      brainReviewCalls.push({ hasReport: report !== undefined, iteration: task.iteration })

      if (brainCallCount === 1) {
        // 第一次 review：返回 proceed
        return packet('proceed')
      } else if (brainCallCount === 2) {
        // 第二次 review：第一次执行结束，返回 revise
        // 此时 report 应该有 incompleteReason，没有 blockers
        assert.notEqual(report, undefined, 'second review must have report')
        assert.equal(report?.blockers.length, 0, 'second review report must have no blockers')
        assert.notEqual(
          report?.incompleteReason,
          undefined,
          'second review report must have incompleteReason',
        )
        return packet('revise')
      } else {
        // 第三次 review：第二次执行结束，返回 done
        return packet('done')
      }
    },
  }

  const executor = new ClaudeCodeExecutor({
    cwd: workspace,
    commandRunner: runner.run,
  })

  const result = await runGuardianTask({
    task: {
      id: 'task-second-max-turns-revise',
      goal: '完成复杂功能',
      state: 'READY',
      iteration: 0,
      maxIterations: 3,
    },
    brain,
    executor,
  })

  assert.equal(result.task.state, 'COMPLETED', 'task must complete')
  assert.equal(result.task.iteration, 2, 'must have 2 iterations')
  assert.equal(result.reports.length, 2, 'must have 2 execution reports')
  assert.equal(brainCallCount, 3, 'Brain must be called 3 times')

  // 验证第一个 report 有 incompleteReason
  assert.notEqual(result.reports[0]?.incompleteReason, undefined, 'first report must have incompleteReason')
  assert.equal(result.reports[0]?.blockers.length, 0, 'first report must have no blockers')

  // 验证第二个 report 正常完成
  assert.equal(result.reports[1]?.incompleteReason, undefined, 'second report must not have incompleteReason')
  assert.equal(result.reports[1]?.blockers.length, 0, 'second report must have no blockers')

  // 验证 Claude 使用同一 session
  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 3, 'must call Claude 3 times total')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call (recovery) must use --resume')
  assert.ok(claudeRequests[2]?.args.includes('--resume'), 'third call (iteration 2) must use --resume')
})

test('second max_turns with scope violation requires human', async () => {
  // Scenario: 第二次 max_turns 但存在 scope violation
  // 必须直接进入 HUMAN_REQUIRED，不允许 Brain revise
  const runner = new QueueRunner([
    commandResult(''), // git status --porcelain (clean)
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 12, result: '部分完成。' }), 1),
    commandResult(' M src/allowed.ts\n'), // git status after first
    // recovery
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 6, result: '继续完成。' }), 1),
    commandResult(' M src/allowed.ts\n M src/forbidden.ts\n'), // git status after recovery - 包含 forbidden 文件
  ])

  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review() {
      brainCallCount += 1
      if (brainCallCount === 1) {
        return packet('proceed')
      }
      throw new Error('Brain should not be called again after scope violation')
    },
  }

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const result = await runGuardianTask({
    task: {
      id: 'task-second-max-turns-scope-violation',
      goal: '完成功能',
      state: 'READY',
      iteration: 0,
      maxIterations: 3,
      forbiddenPaths: ['src/forbidden.ts'],
    },
    brain,
    executor,
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED', 'must require human intervention')
  assert.ok(result.task.stopReason?.includes('forbidden'), 'stopReason must mention forbidden path')
  assert.equal(result.task.iteration, 1, 'must have 1 iteration')
  assert.equal(result.reports.length, 1, 'must have 1 execution report')
  assert.equal(brainCallCount, 1, 'Brain must be called only once')
})

test('second max_turns with permission denial enters recovery loop until maxIterations', async () => {
  // W002: 第二次 max_turns 有 permission_denials 但无其他 blocker
  // Guardian 会重新进入 REVIEWING，但最终会因 maxIterations 停止
  const runner = new QueueRunner([
    commandResult(''), // git status --porcelain (clean)
    commandResult(
      claudeJson({ subtype: 'error_max_turns', num_turns: 12, permission_denials: [], result: '部分完成。' }),
      1,
    ),
    commandResult(' M src/feature.ts\n'),
    // recovery
    commandResult(
      claudeJson({
        subtype: 'error_max_turns',
        num_turns: 6,
        permission_denials: [{ tool: 'Bash', command: 'mkdir new_folder' }],
        result: '尝试创建目录但被拒绝。',
      }),
      1,
    ),
    commandResult(' M src/feature.ts\n'),
    // 不运行 verification，因为 permission denial + incomplete
  ])

  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review(input) {
      brainCallCount += 1
      if (brainCallCount === 1) {
        return packet('proceed')
      }
      // 第二次 Brain 应该收到 permission denials
      const report = input.report
      assert.ok(report !== undefined, 'second review must have report')
      assert.ok(report!.permissionDenials !== undefined, 'must have permission denials')
      assert.ok(report!.executorCapabilities !== undefined, 'must have executor capabilities')
      assert.ok(report!.incompleteReason !== undefined, 'must have incomplete reason')
      assert.equal(report!.blockers.length, 0, 'must not have blockers for permission denial only')

      // Reviewer 判断无法使用已有能力完成，需要新权限
      return {
        verdict: 'blocked',
        goal: '完成功能',
        instructions: [],
        constraints: ['保持类型安全'],
        verification: ['npm test'],
        doNotDo: ['不要修改数据库'],
        rationale: 'task requires file system capability not in executor_capabilities',
      }
    },
  }

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const result = await runGuardianTask({
    task: {
      id: 'task-second-max-turns-permission-denial-blocked',
      goal: '完成功能',
      state: 'READY',
      iteration: 0,
      maxIterations: 3,
    },
    brain,
    executor,
  })

  // W002: permission denial 让 Guardian 重新进入 REVIEWING
  // Brain 判断 blocked，最终进入 HUMAN_REQUIRED
  assert.equal(result.task.state, 'HUMAN_REQUIRED', 'must require human for new capability')
  assert.equal(result.task.iteration, 1, 'must have 1 iteration')
  assert.equal(result.reports.length, 1, 'must have 1 execution report')
  assert.equal(brainCallCount, 2, 'Brain must be called twice (proceed + blocked)')

  const firstReport = result.reports[0]
  if (firstReport === undefined) {
    throw new Error('first report must exist')
  }
  assert.equal(firstReport.blockers.length, 0, 'report must not have blockers')
  assert.ok(firstReport.permissionDenials !== undefined, 'must have permission denials')
  assert.ok(firstReport.incompleteReason !== undefined, 'must have incomplete reason')

  // 确认 stopReason 来自 Brain blocked verdict
  assert.ok(
    result.task.stopReason?.includes('capability') || result.task.stopReason?.includes('blocked'),
    'stopReason must reflect Brain blocked for new capability',
  )
})

test('second max_turns with Brain blocked verdict requires human', async () => {
  // Scenario: 第二次 max_turns 后 Brain 判断 blocked
  // 必须进入 HUMAN_REQUIRED
  const runner = new QueueRunner([
    commandResult(''),
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 12, result: '部分完成。' }), 1),
    commandResult(' M src/feature.ts\n'),
    // recovery
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 6, result: '继续完成。' }), 1),
    commandResult(' M src/feature.ts\n'),
    // 第二次 max_turns 后不运行 verification
  ])

  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review({ report }) {
      brainCallCount += 1
      if (brainCallCount === 1) {
        return packet('proceed')
      } else if (brainCallCount === 2) {
        // Brain 判断当前进展不值得继续
        assert.notEqual(report?.incompleteReason, undefined, 'must have incompleteReason')
        return {
          verdict: 'blocked' as const,
          goal: '完成开发任务',
          instructions: [],
          constraints: [],
          verification: [],
          doNotDo: [],
          rationale: 'Brain 判断当前方向不对，需要人工介入重新规划',
        }
      }
      throw new Error('Brain should not be called again after blocked')
    },
  }

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const result = await runGuardianTask({
    task: {
      id: 'task-second-max-turns-brain-blocked',
      goal: '完成功能',
      state: 'READY',
      iteration: 0,
      maxIterations: 3,
    },
    brain,
    executor,
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED', 'must require human intervention')
  assert.ok(result.task.stopReason?.includes('Brain 判断'), 'stopReason must mention Brain rationale')
  assert.equal(result.task.iteration, 1, 'must have 1 iteration')
  assert.equal(result.reports.length, 1, 'must have 1 execution report')
  assert.equal(brainCallCount, 2, 'Brain must be called twice')
})

test('second max_turns reaching maxIterations requires human', async () => {
  // Scenario: 多次 max_turns + revise，最终达到 maxIterations
  const runner = new QueueRunner([
    // iteration 1
    commandResult(''),
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 12, result: '部分完成。' }), 1),
    commandResult(' M src/feature.ts\n'),
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 6, result: '继续完成。' }), 1),
    commandResult(' M src/feature.ts\n'),
    // 第二次 max_turns 后不运行 verification
    // iteration 2
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 12, result: '继续完成。' }), 1),
    commandResult(' M src/feature.ts\n M src/feature.test.ts\n'),
    commandResult(claudeJson({ subtype: 'error_max_turns', num_turns: 6, result: '还需要更多。' }), 1),
    commandResult(' M src/feature.ts\n M src/feature.test.ts\n'),
    // 第二次 max_turns 后不运行 verification
  ])

  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review({ report }) {
      brainCallCount += 1
      if (brainCallCount === 1) {
        return packet('proceed')
      } else if (brainCallCount === 2) {
        // 第二次返回 revise
        assert.notEqual(report?.incompleteReason, undefined, 'must have incompleteReason')
        return packet('revise')
      }
      throw new Error('Brain should not be called after maxIterations')
    },
  }

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const result = await runGuardianTask({
    task: {
      id: 'task-second-max-turns-max-iterations',
      goal: '完成复杂功能',
      state: 'READY',
      iteration: 0,
      maxIterations: 2, // 只允许 2 次 iteration
    },
    brain,
    executor,
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED', 'must require human intervention')
  assert.ok(result.task.stopReason?.includes('max iterations'), 'stopReason must mention max iterations')
  assert.equal(result.task.iteration, 2, 'must reach maxIterations')
  assert.equal(result.reports.length, 2, 'must have 2 execution reports')
  assert.equal(brainCallCount, 2, 'Brain must be called 2 times (once per iteration)')
})


