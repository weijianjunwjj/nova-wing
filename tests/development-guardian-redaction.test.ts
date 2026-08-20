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

test('reason with secret must be redacted', async () => {
  const stdoutWithSecret = JSON.stringify({
    type: 'success',
    subtype: 'error_max_turns',
    is_error: false,
    result: '部分完成',
    session_id: 'session-123',
    num_turns: 12,
    permission_denials: [
      {
        tool: 'Bash',
        operation: 'curl https://api.example.com',
        reason: 'Authorization: Bearer super-secret-token',
      },
    ],
  })

  const runner = new QueueRunner([
    result(''),
    result(stdoutWithSecret, 0),
    result(' M src/a.ts\n'),
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: {
      id: 'task-secret-redaction',
      goal: 'test secret redaction',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test',
      instructions: ['implement'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.notEqual(report.permissionDenials, undefined, 'must have permission denials')
  assert.equal(report.permissionDenials!.length, 1, 'must have 1 denial')

  const denial = report.permissionDenials![0]
  assert.ok(denial !== undefined, 'denial must exist')
  assert.ok(
    !denial.summary?.includes('super-secret-token'),
    'summary must NOT contain secret token',
  )
  assert.ok(
    denial.summary !== 'Authorization: Bearer super-secret-token',
    'summary must be redacted',
  )
})

test('operation with API key must be redacted', async () => {
  const stdoutWithApiKey = JSON.stringify({
    type: 'success',
    subtype: 'error_max_turns',
    is_error: false,
    result: '部分完成',
    session_id: 'session-456',
    num_turns: 12,
    permission_denials: [
      {
        tool: 'Bash',
        operation: 'export API_KEY=sk-1234567890abcdef',
        reason: 'User blocked environment variable',
      },
    ],
  })

  const runner = new QueueRunner([
    result(''),
    result(stdoutWithApiKey, 0),
    result(' M src/config.ts\n'),
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: {
      id: 'task-apikey-redaction',
      goal: 'test API key redaction',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test',
      instructions: ['implement'],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  })

  assert.notEqual(report.permissionDenials, undefined, 'must have permission denials')
  const denial = report.permissionDenials![0]
  assert.ok(denial !== undefined, 'denial must exist')
  assert.equal(
    denial.operation,
    '[operation contains sensitive data]',
    'operation with api_key must be redacted',
  )
})
