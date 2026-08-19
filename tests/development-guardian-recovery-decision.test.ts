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

test('recovery decision diagnostic captures exitCode != 0 blocker', async () => {
  const runner = new QueueRunner([
    result(''),
    result(
      claudeJson({ subtype: 'error_max_turns', result: '部分完成。' }),
      1, // exitCode = 1 模拟真实 Claude CLI 行为
    ),
    result(' M src/a.ts\n'),
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: {
      id: 'task-exitcode-diagnostic',
      goal: 'test exitCode blocker',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test exitCode blocker',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  // exitCode != 0 时，executeClaudeOnce 会提前返回并输出诊断
  assert.equal(report.blockers.length, 2, 'must have exitCode blocker and diagnostic')
  const exitCodeBlocker = report.blockers.find((b) => b.includes('Claude Code failed'))
  assert.ok(exitCodeBlocker, 'must report Claude Code failure with exit code 1')

  const diagnostic = report.blockers.find((b) => b.includes('[MAX_TURN_RECOVERY_DECISION]'))
  assert.ok(diagnostic, 'must include recovery decision diagnostic')
  assert.ok(diagnostic?.includes('eligible=false'), 'decision must be ineligible')
  assert.ok(diagnostic?.includes('reason=nonzero_exit_code'), 'must show nonzero exit code reason')
  assert.ok(diagnostic?.includes('exitCode=1'), 'must show exit code 1')
})

test('recovery decision diagnostic captures scopeBlockers', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M forbidden/secret.ts\n'),
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: {
      id: 'task-scope-diagnostic',
      goal: 'test scope blocker',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
      allowedPaths: ['src/**'],
    },
    packet: {
      verdict: 'proceed',
      goal: 'test scope blocker',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  const diagnostic = report.blockers.find((b) => b.includes('[MAX_TURN_RECOVERY_DECISION]'))
  assert.ok(diagnostic, 'must include recovery decision diagnostic')
  assert.ok(diagnostic?.includes('eligible=false'), 'decision must be ineligible')
  assert.ok(diagnostic?.includes('scopeBlockers=1'), 'must show scopeBlockers present')
  assert.ok(diagnostic?.includes('otherBlockers=0'), 'must show no otherBlockers')
})

test('recovery decision shows eligible when all conditions met', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
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
      id: 'task-eligible',
      goal: 'test eligible recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test eligible recovery',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(report.blockers.length, 0, 'must have no blockers when recovery succeeds')
  assert.equal(recoveries.length, 1, 'must trigger recovery')

  const diagnostic = report.blockers.find((b) => b.includes('Recovery decision'))
  assert.equal(diagnostic, undefined, 'must not include diagnostic when recovery succeeds')
})
