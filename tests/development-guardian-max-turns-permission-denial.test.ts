import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  type GuardianCommandRequest,
  type GuardianCommandResult,
} from 'nova-wing/development-guardian'
import { createExecutorTestWorkspace } from './executor-workspace-fixture.js'

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

test('CASE 1: max_turns without permission denial preserves bounded recovery', async (t) => {
  const cwd = await createExecutorTestWorkspace(t, 'max-turns-permission')
  const runner = new QueueRunner([
    result(''),  // git status --porcelain (clean start)
    result(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成',
        session_id: 'session-abc',
      }),
      0,
    ),  // claude first attempt
    result(' M src/a.ts\n'),  // git status after first attempt
    result(claudeJson({ result: '完成所有任务' })),  // claude recovery
    result(' M src/a.ts\n M src/b.ts\n'),  // git status after recovery
    result('diff clean'),  // verification: diff
    result('tests passed'),  // verification: test
  ])

  const recoveries: unknown[] = []

  const executor = new ClaudeCodeExecutor({
    cwd,
    commandRunner: runner.run,
    onRecovery: (recovery) => {
      recoveries.push(recovery)
    },
  })

  const report = await executor.execute({
    task: {
      id: 'task-case1',
      goal: 'test bounded recovery',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test',
      instructions: ['implement'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 1, 'must trigger recovery once')
  assert.equal(report.blockers.length, 0, 'no blockers when recovery succeeds')
  assert.equal(report.incompleteReason, undefined, 'no incompleteReason when task completes')

  const claudeCalls = runner.requests.filter((req) =>
    req.args.join(' ').includes('claude'),
  )
  assert.equal(claudeCalls.length, 2, 'must call Claude twice (first + recovery)')
})

test('CASE 2: max_turns + permission denial prevents recovery, returns incompleteReason', async () => {
  const stdoutWithPermissionDenial = JSON.stringify({
    type: 'success',
    subtype: 'error_max_turns',
    is_error: false,
    result: '部分完成，但遇到权限拒绝',
    session_id: 'session-xyz',
    num_turns: 12,
    permission_denials: [
      {
        tool: 'Bash',
        operation: 'npm install lodash',
        summary: 'User denied Bash permission for: npm install lodash',
      },
    ],
  })

  const runner = new QueueRunner([
    result(''),  // git status --porcelain (clean start)
    result(stdoutWithPermissionDenial, 0),  // claude attempt
    result(' M src/config.ts\n'),  // git status after attempt
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
      id: 'task-case2',
      goal: 'test max_turns + permission denial',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
    },
    packet: {
      verdict: 'proceed',
      goal: 'test',
      instructions: ['implement'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.equal(recoveries.length, 0, 'must NOT trigger recovery')
  assert.equal(report.blockers.length, 0, 'no blockers')
  assert.notEqual(report.incompleteReason, undefined, 'must have incompleteReason')
  assert.match(
    report.incompleteReason ?? '',
    /执行达到 max_turns 且遇到权限拒绝/,
    'incompleteReason mentions max_turns and permission denial',
  )
  assert.notEqual(report.permissionDenials, undefined, 'must include permission denials')
  assert.equal(report.permissionDenials?.length, 1, 'must have 1 permission denial')
  assert.notEqual(report.executorCapabilities, undefined, 'must include executor capabilities')

  const claudeCalls = runner.requests.filter((req) =>
    req.args.join(' ').includes('claude'),
  )
  assert.equal(claudeCalls.length, 1, 'must call Claude only once (no recovery)')
})

test('CASE 3: max_turns + permission denial + scope violation fails closed', async () => {
  const stdoutWithBoth = JSON.stringify({
    type: 'success',
    subtype: 'error_max_turns',
    is_error: false,
    result: '部分完成，违反 scope',
    session_id: 'session-bad',
    num_turns: 12,
    permission_denials: [
      {
        tool: 'Bash',
        operation: 'rm -rf node_modules',
        summary: 'User denied dangerous operation',
      },
    ],
  })

  const runner = new QueueRunner([
    result(''),  // git status --porcelain (clean start)
    result(stdoutWithBoth, 0),  // claude attempt
    result(' M ../other-project/file.ts\n'),  // git status showing scope violation
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: {
      id: 'task-case3',
      goal: 'test scope violation + permission denial',
      state: 'EXECUTING',
      iteration: 1,
      maxIterations: 3,
      allowedPaths: ['src/**', 'tests/**'],  // 限制只能修改这些目录
    },
    packet: {
      verdict: 'proceed',
      goal: 'test',
      instructions: ['implement'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
  })

  assert.ok(report.blockers.length > 0, 'must have blockers when scope violation present')
  assert.ok(
    report.blockers.some((b) => b.includes('scope') || b.includes('other-project')),
    'blocker must mention scope violation',
  )
  assert.notEqual(report.permissionDenials, undefined, 'must include permission denials')
})
