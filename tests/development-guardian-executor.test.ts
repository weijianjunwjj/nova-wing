import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianCommandRunner,
  type GuardianTask,
} from 'nova-wing/development-guardian'

function task(iteration = 0): GuardianTask {
  return {
    id: 'task-1',
    goal: '完成最小修改',
    state: 'EXECUTING',
    iteration,
    maxIterations: 4,
  }
}

function packet(verification: readonly string[] = ['npm test']): DelegationPacket {
  return {
    verdict: 'proceed',
    goal: '完成最小修改',
    instructions: ['修改 src/a.ts'],
    constraints: ['只改目标文件'],
    verification,
    doNotDo: ['不要提交 git'],
  }
}

function result(stdout = '', stderr = '', exitCode = 0): GuardianCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
  }
}

class QueueRunner {
  readonly requests: GuardianCommandRequest[] = []
  readonly queue: GuardianCommandResult[]

  constructor(queue: GuardianCommandResult[]) {
    this.queue = [...queue]
  }

  run: GuardianCommandRunner = async (request) => {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error('fake runner exhausted')
    }
    return next
  }
}

function claudeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '已修改目标文件。',
    session_id: 'session-123',
    num_turns: 3,
    total_cost_usd: 0.1,
    ...overrides,
  })
}

test('executor runs Claude Code then deterministic verification', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts'])
  assert.deepEqual(report.verificationResults, [{ name: 'npm test', status: 'passed' }])
  assert.deepEqual(report.blockers, [])
  assert.equal(runner.requests[0]?.args.join(' '), '-lc git status --porcelain')
  assert.match(runner.requests[1]?.args.join(' ') ?? '', /claude/)
  assert.equal(runner.requests[3]?.args.join(' '), '-lc npm test')
})

test('executor refuses autonomous start on dirty worktree', async () => {
  const runner = new QueueRunner([result(' M src/existing.ts\n')])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.equal(report.changedFiles.length, 0)
  assert.match(report.blockers[0] ?? '', /clean worktree/)
  assert.equal(runner.requests.length, 1)
})

test('executor blocks verification command outside MVP allowlist', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(),
    packet: packet(['rm -rf dist']),
  })

  assert.equal(report.verificationResults[0]?.status, 'skipped')
  assert.match(report.blockers[0] ?? '', /human approval/)
  assert.equal(runner.requests.length, 3)
})

test('executor resumes same Claude Code session on revise round', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('tests passed'),
    result(claudeJson({ result: '已修复。' })),
    result(' M src/a.ts\n'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  await executor.execute({ task: task(0), packet: packet() })
  await executor.execute({ task: task(1), packet: { ...packet(), verdict: 'revise' } })

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2)
  assert.ok(claudeRequests[1]?.args.includes('--resume'))
  assert.ok(claudeRequests[1]?.args.includes('session-123'))
})
