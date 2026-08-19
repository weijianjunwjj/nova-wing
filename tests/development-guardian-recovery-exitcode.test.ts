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

test('error_max_turns with exitCode=1 blocks recovery and shows no diagnostic', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' }), 1),
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
      id: 'task-exitcode-1',
      goal: 'test exitCode=1 blocks recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test exitCode=1',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must not trigger recovery when exitCode != 0')
  assert.equal(report.blockers.length, 1, 'must have only exitCode blocker')
  const exitCodeBlocker = report.blockers.find((b) => b.includes('Claude Code failed'))
  assert.ok(exitCodeBlocker, 'must report Claude Code failure')
  assert.ok(
    exitCodeBlocker?.includes('error_max_turns'),
    'blocker must contain stdout (JSON with error_max_turns)',
  )
})

test('error_max_turns with exitCode=0 and otherBlockers shows diagnostic', async () => {
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

  await executor.execute({
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
  const claudeRequests = runner.requests.filter((req) => req.args.some((a) => a.includes('claude')))
  assert.equal(claudeRequests.length, 2, 'must call Claude twice')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call must use --resume')
})
