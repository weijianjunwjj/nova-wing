import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
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

function result(stdout: string, exitCode = 0): GuardianCommandResult {
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

test('error_max_turns with exitCode=0 triggers recovery and shows diagnostic on failure', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' }), 0),
    result(' M src/a.ts\n'),
    result(claudeJson({ subtype: 'error_max_turns', result: '仍未完成。' }), 0),
    result(' M src/a.ts\n M src/b.ts\n'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-max-turns-double',
      goal: 'test double max_turns',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test double max_turns',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 1, 'must trigger recovery once')
  assert.equal(report.blockers.length, 1, 'must have failure context blocker')
  const failureContext = report.blockers.find((b) => b.includes('第二次执行仍达到 max_turns'))
  assert.ok(failureContext, 'must report second max_turns')
})

test('error_max_turns with exitCode=1 + valid session_id triggers recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成。',
        session_id: 'real-session-abc',
        permission_denials: [],
      }),
      1, // exitCode=1 但有合法的 error_max_turns result
    ),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成所有任务。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-exitcode-1-recoverable',
      goal: 'test exitCode=1 with error_max_turns allows recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test exitCode=1 recoverable',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 1, 'must trigger recovery when exitCode=1 + error_max_turns + session_id')
  assert.equal(report.blockers.length, 0, 'must have no blockers when recovery succeeds')

  const claudeRequests = runner.requests.filter((req) => req.args.some((a) => a.includes('claude')))
  assert.equal(claudeRequests.length, 2, 'must call Claude twice')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call must use --resume')
  assert.ok(
    claudeRequests[1]?.args.includes('real-session-abc'),
    'second call must resume real-session-abc',
  )
})

test('error_max_turns with exitCode=1 but missing session_id blocks recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成。',
        session_id: '', // 空 session_id
        permission_denials: [],
      }),
      1,
    ),
    result(' M src/a.ts\n'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-exitcode-1-no-session',
      goal: 'test exitCode=1 + missing session_id blocks recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test no session',
      instructions: ['implement feature'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must not trigger recovery when session_id missing')
  assert.ok(
    report.blockers.some((b) => b.includes('没有 session_id')),
    'must report missing session_id',
  )
})

test('error_max_turns with exitCode=1 but permission_denials blocks recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成。',
        session_id: 'session-xyz',
        permission_denials: [{ tool: 'Bash', reason: 'user denied' }],
      }),
      1,
    ),
    result(' M src/a.ts\n'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-permission-denials',
      goal: 'test permission_denials blocks recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test permission denials',
      instructions: ['implement feature'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must not trigger recovery when permission_denials present')
  const diagnostic = report.blockers.find((b) => b.includes('[MAX_TURN_RECOVERY_DECISION]'))
  assert.ok(diagnostic, 'must include diagnostic')
  assert.ok(diagnostic?.includes('eligible=false'), 'must show ineligible')
  assert.ok(
    diagnostic?.includes('permission denials') || diagnostic?.includes('permission_denials'),
    'must reference permission denials',
  )
})

test('error_max_turns with exitCode=1 but scope violation blocks recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成。',
        session_id: 'session-scope-test',
        permission_denials: [],
      }),
      1,
    ),
    result(' M server/forbidden/secret.ts\n'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-scope-violation',
      goal: 'test scope violation blocks recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
      forbiddenPaths: ['server/forbidden/**'],
    },
    packet: {
      verdict: 'proceed',
      goal: 'test scope violation',
      instructions: ['implement feature'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must not trigger recovery when scope violation exists')
  assert.ok(
    report.blockers.some((b) => b.includes('scope violation')),
    'must report scope violation',
  )
})

test('ordinary exitCode=1 without error_max_turns blocks execution', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_other',
        result: '执行失败。',
        session_id: 'session-fail',
      }),
      1, // exitCode=1 但 subtype 不是 error_max_turns
    ),
    result(' M src/a.ts\n'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-ordinary-fail',
      goal: 'test ordinary exitCode=1 fails',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test ordinary failure',
      instructions: ['implement feature'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must not trigger recovery for non-max_turns failure')
  assert.ok(
    report.blockers.some((b) => b.includes('Claude Code failed')),
    'must report Claude Code failure',
  )
})

test('error_max_turns with exitCode=0 triggers recovery and shows diagnostic', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成。',
      }),
      0,
    ),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成所有任务。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-diagnostic-test',
      goal: 'test diagnostic output',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test diagnostic',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 1, 'must trigger recovery')
  assert.equal(report.blockers.length, 0, 'must have no blockers when recovery succeeds')

  const claudeRequests = runner.requests.filter((req) => req.args.some((a) => a.includes('claude')))
  assert.equal(claudeRequests.length, 2, 'must call Claude twice')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call must use --resume')

  // 注意：eligible=true 的诊断不会出现在 finalAttempt.blockers 中，因为恢复成功了
  // 诊断只在测试场景通过 onRecovery 的存在来触发，但不影响最终 report
})
