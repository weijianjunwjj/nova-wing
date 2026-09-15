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
import { createExecutorTestWorkspace } from './executor-workspace-fixture.js'

function task(iteration = 0, overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-npm-install',
    goal: '初始化新项目依赖',
    state: 'EXECUTING',
    iteration,
    maxIterations: 3,
    ...overrides,
  }
}

function packet(verification: readonly string[] = ['npm test']): DelegationPacket {
  return {
    verdict: 'proceed',
    goal: '初始化新项目依赖',
    instructions: ['安装 Vue 3 和 TypeScript'],
    constraints: ['只修改 package.json'],
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
    result: '已安装依赖。',
    session_id: 'session-npm-test',
    num_turns: 2,
    ...overrides,
  })
}

test('executor does not include npm install permission by default', async (t) => {
  const cwd = await createExecutorTestWorkspace(t, 'npm-install-default')
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M package.json\n M package-lock.json\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd,
    commandRunner: runner.run,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
  assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

  const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
  assert.ok(!tools.includes('Bash(npm install:*)'), 'should not include npm install permission by default')
  assert.ok(tools.includes('Read'), 'should include Read permission')
  assert.ok(tools.includes('Write'), 'should include Write permission')
})

test('executor includes npm install permission when allowNpmInstall is true', async (t) => {
  const cwd = await createExecutorTestWorkspace(t, 'npm-install-enabled')
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M package.json\n M package-lock.json\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd,
    commandRunner: runner.run,
    allowNpmInstall: true,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
  assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

  const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
  assert.ok(tools.includes('Bash(npm install:*)'), 'should include npm install permission when enabled')
  assert.ok(tools.includes('Read'), 'should include Read permission')
  assert.ok(tools.includes('Write'), 'should include Write permission')
  assert.ok(!tools.includes('Bash'), 'should not include generic Bash permission')
})

test('executor preserves npm install permission through recovery', async (t) => {
  const cwd = await createExecutorTestWorkspace(t, 'npm-install-recovery')
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M package.json\n'),
    result(claudeJson({ result: '已完成所有依赖安装。' })),
    result(' M package.json\n M package-lock.json\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd,
    commandRunner: runner.run,
    allowNpmInstall: true,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'should call Claude twice: initial + recovery')

  for (const claudeRequest of claudeRequests) {
    const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
    assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

    const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
    assert.ok(
      tools.includes('Bash(npm install:*)'),
      'npm install permission should be preserved through recovery',
    )
  }
})
