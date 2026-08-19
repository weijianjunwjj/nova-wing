import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  type ClaudeCodeTimingEvent,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianCommandRunner,
  type GuardianTask,
} from 'nova-wing/development-guardian'

function task(iteration = 0, overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-1',
    goal: '完成最小修改',
    state: 'EXECUTING',
    iteration,
    maxIterations: 4,
    ...overrides,
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
    duration_ms: 1200,
    duration_api_ms: 900,
    ...overrides,
  })
}

test('executor runs Claude Code then deterministic verification', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const timings: ClaudeCodeTimingEvent[] = []
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onTiming: (event) => timings.push(event),
  })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts'])
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])
  assert.deepEqual(report.blockers, [])
  assert.equal(runner.requests[0]?.args.join(' '), '-lc git status --porcelain')
  assert.match(runner.requests[1]?.args.join(' ') ?? '', /claude/)
  assert.equal(runner.requests[3]?.args.join(' '), '-lc git diff --check')
  assert.equal(runner.requests[4]?.args.join(' '), '-lc npm test')
  assert.deepEqual(
    timings.map((event) => event.phase),
    ['clean-start', 'inspect-changes', 'claude-code', 'verification', 'verification', 'executor-total'],
  )
  const claudeTiming = timings.find((event) => event.phase === 'claude-code')
  assert.equal(claudeTiming?.numTurns, 3)
  assert.equal(claudeTiming?.totalCostUsd, 0.1)
  assert.equal(claudeTiming?.reportedDurationMs, 1200)
  assert.equal(claudeTiming?.apiDurationMs, 900)
  assert.ok(timings.every((event) => event.durationMs >= 0))
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
    result('diff clean'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(),
    packet: packet(['rm -rf dist']),
  })

  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    {
      name: 'rm -rf dist',
      status: 'skipped',
      details: 'verification command is not in the MVP allowlist',
    },
  ])
  assert.match(report.blockers[0] ?? '', /human approval/)
  assert.equal(runner.requests.length, 4)
})

test('executor stops before verification when changed files leave allowed scope', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n M package.json\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['src/**'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['src/a.ts', 'package.json'])
  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /outside allowed scope: package.json/)
  assert.equal(runner.requests.length, 3)
})

test('executor stops when changed files enter forbidden scope', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n M migrations/001.sql\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { forbiddenPaths: ['migrations/**'] }),
    packet: packet(),
  })

  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /inside forbidden scope: migrations\/001.sql/)
  assert.equal(runner.requests.length, 3)
})

test('executor resumes same Claude Code session on revise round', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
    result(claudeJson({ result: '已修复。' })),
    result(' M src/a.ts\n'),
    result('diff clean'),
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

test('executor prompt includes hard boundaries and excludes internal fields', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  await executor.execute({
    task: task(3, {
      id: 'task-boundary-test',
      allowedPaths: ['src/**'],
      forbiddenPaths: ['test/**', 'package.json'],
    }),
    packet: {
      verdict: 'proceed',
      goal: '实现用户认证功能',
      instructions: ['在 src/auth.ts 中添加登录方法'],
      constraints: ['必须使用现有 hash 函数'],
      verification: ['npm test'],
      doNotDo: ['不要修改公开 API'],
    },
  })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const promptArgIndex = claudeRequest.args.findIndex((entry) => entry === '-p')
  assert.ok(promptArgIndex >= 0, 'should have -p flag')
  const prompt = claudeRequest.args[promptArgIndex + 1] ?? ''

  assert.match(prompt, /实现用户认证功能/, 'prompt must include goal')
  assert.match(prompt, /在 src\/auth\.ts 中添加登录方法/, 'prompt must include instructions')
  assert.match(prompt, /必须使用现有 hash 函数/, 'prompt must include constraints')
  assert.match(prompt, /src\/\*\*/, 'prompt must include allowedPaths')
  assert.match(prompt, /test\/\*\*/, 'prompt must include forbiddenPaths')
  assert.match(prompt, /package\.json/, 'prompt must include forbiddenPaths')
  assert.match(prompt, /不要修改公开 API/, 'prompt must include doNotDo')

  assert.doesNotMatch(prompt, /task-boundary-test/, 'prompt must not include task.id')
  assert.doesNotMatch(prompt, /iteration.*3/, 'prompt must not include task.iteration')
  assert.doesNotMatch(prompt, /npm test/, 'prompt must not include verification command')
})
