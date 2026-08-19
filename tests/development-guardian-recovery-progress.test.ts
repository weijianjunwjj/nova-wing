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

test('executor triggers onRecovery callback on max_turns bounded recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成所有任务。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])

  const recoveries: Array<{ reason: string; sessionId: string; bounded: boolean }> = []

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-recovery',
      goal: 'test recovery callback',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test recovery callback',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(report.blockers.length, 0)
  assert.equal(recoveries.length, 1, 'must trigger recovery callback once')
  assert.equal(recoveries[0]?.reason, 'max_turns')
  assert.equal(recoveries[0]?.sessionId, 'session-123')
  assert.equal(recoveries[0]?.bounded, true)

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'must call Claude twice')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call must use --resume')
})

test('executor does not trigger onRecovery when recovery is not needed', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ result: '一次完成。' })),
    result(' M src/a.ts\n'),
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
      id: 'task-no-recovery',
      goal: 'test no recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test no recovery',
      instructions: ['simple task'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(report.blockers.length, 0)
  assert.equal(recoveries.length, 0, 'must not trigger recovery callback')

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 1, 'must call Claude only once')
})
