import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GuardianWorkSessionTaskRunner,
  ClaudeCodeExecutor,
  type GuardianBrain,
  type GuardianExecutor,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type ExecutionReport,
} from 'nova-wing/development-guardian'
import type { WorkSessionTask } from 'nova-wing/development-guardian'

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

class TaskBindingExecutor implements GuardianExecutor {
  private boundTaskId: string | null = null
  public executeCallCount = 0

  constructor(private readonly runner: QueueRunner) {}

  async execute(input: { task: any; packet: DelegationPacket }): Promise<ExecutionReport> {
    if (this.boundTaskId === null) {
      this.boundTaskId = input.task.id
    } else if (this.boundTaskId !== input.task.id) {
      throw new Error(`executor already bound to task ${this.boundTaskId}, cannot execute ${input.task.id}`)
    }

    this.executeCallCount += 1

    // 模拟简单成功
    await this.runner.run({
      executable: 'git',
      args: ['status', '--porcelain'],
      cwd: 'D:/repo',
      timeoutMs: 30000,
    })

    const claudeResult = await this.runner.run({
      executable: 'claude',
      args: ['code', input.packet.goal],
      cwd: 'D:/repo',
      timeoutMs: 120000,
    })

    const changes = await this.runner.run({
      executable: 'git',
      args: ['status', '--porcelain', '--untracked-files'],
      cwd: 'D:/repo',
      timeoutMs: 30000,
    })

    await this.runner.run({
      executable: 'git',
      args: ['diff', '--check'],
      cwd: 'D:/repo',
      timeoutMs: 30000,
    })

    return {
      summary: 'task executed',
      changedFiles: changes.stdout.trim() === '' ? [] : changes.stdout.trim().split('\n').map(line => line.slice(3)),
      commandsRun: ['git status', 'claude code', 'git diff --check'],
      verificationResults: [{ name: 'mock-verification', status: 'passed' as const }],
      blockers: [],
      ...(claudeResult.stdout.includes('permission_denials')
        ? {
            permissionDenials: JSON.parse(claudeResult.stdout).permission_denials?.map((d: any) => ({
              tool: d.tool,
              operation: d.operation,
              summary: d.summary,
            })),
            executorCapabilities: ['git', 'npm'] as readonly string[],
            incompleteReason: '执行达到 max_turns 且遇到权限拒绝',
          }
        : {}),
    }
  }
}

test('TEST A: different tasks use different executor instances', async () => {
  const runner = new QueueRunner([
    // T1 execution
    commandResult(''),
    commandResult(claudeJson({ result: 'T1 完成' })),
    commandResult(' M src/a.ts\n'),
    commandResult(''),
    // Brain done for T1
    // T2 execution
    commandResult(''),
    commandResult(claudeJson({ result: 'T2 完成' })),
    commandResult(' M src/b.ts\n'),
    commandResult(''),
    // Brain done for T2
  ])

  const createExecutorCalls: string[] = []

  let brainCallCount = 0

  const adapter = new GuardianWorkSessionTaskRunner({
    brain: {
      async review({ report }) {
        brainCallCount += 1
        if (report === undefined) {
          return {
            verdict: 'proceed',
            goal: 'complete',
            instructions: ['implement'],
            constraints: [],
            verification: [],
            doNotDo: [],
          }
        }
        return {
          verdict: 'done',
          goal: 'complete',
          instructions: [],
          constraints: [],
          verification: [],
          doNotDo: [],
        }
      },
    },
    createExecutor: (task: WorkSessionTask) => {
      createExecutorCalls.push(task.id)
      return new TaskBindingExecutor(runner)
    },
  })

  const t1: WorkSessionTask = {
    id: 'task-1',
    goal: 'implement feature A',
  }

  const t2: WorkSessionTask = {
    id: 'task-2',
    goal: 'implement feature B',
  }

  const result1 = await adapter.run(t1)
  const result2 = await adapter.run(t2)

  assert.equal(result1.status, 'COMPLETED', 'T1 must complete')
  assert.equal(result2.status, 'COMPLETED', 'T2 must complete')
  assert.equal(createExecutorCalls.length, 2, 'createExecutor must be called twice')
  assert.equal(createExecutorCalls[0], 'task-1', 'first call for task-1')
  assert.equal(createExecutorCalls[1], 'task-2', 'second call for task-2')
})

test('TEST B: same Guardian Task revise reuses same executor', async () => {
  const runner = new QueueRunner([
    // Brain #1 → proceed, Executor call #1 → permission denial
    commandResult(''),
    commandResult(
      claudeJson({
        subtype: 'error_max_turns',
        result: '部分完成，遇到权限拒绝',
        num_turns: 12,
        permission_denials: [{ tool: 'Bash', operation: 'mkdir new_folder' }],
      }),
      0,
    ),
    commandResult(' M src/feature.ts\n'),
    // Brain #2 → revise, Executor call #2 → success
    commandResult(''),
    commandResult(claudeJson({ result: '已完成所有任务' })),
    commandResult(' M src/feature.ts\n M src/feature.test.ts\n'),
    commandResult(''),
    commandResult('tests passed'),
    // Brain #3 → done
  ])

  let brainCallCount = 0
  const brain: GuardianBrain = {
    async review({ report }) {
      brainCallCount += 1
      if (brainCallCount === 1) {
        return {
          verdict: 'proceed',
          goal: 'implement feature',
          instructions: ['add feature'],
          constraints: [],
          verification: [],
          doNotDo: [],
        }
      } else if (brainCallCount === 2) {
        // 第一次执行完成，permission denial，revise
        assert.notEqual(report, undefined, 'second review must have report')
        assert.notEqual(report?.permissionDenials, undefined, 'must have permission denials')
        return {
          verdict: 'revise',
          goal: 'implement feature with alternative approach',
          instructions: ['use alternative approach without mkdir'],
          constraints: [],
          verification: ['npm test'],
          doNotDo: [],
        }
      }
      // Brain #3 检查第二次执行结果
      assert.notEqual(report, undefined, 'third review must have report')
      assert.ok(
        report?.verificationResults !== undefined && report.verificationResults.length > 0,
        'third review must have verification results',
      )
      return {
        verdict: 'done',
        goal: 'complete',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
      }
    },
  }

  let createExecutorCallCount = 0
  let sharedExecutor: TaskBindingExecutor | null = null

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: (_task: WorkSessionTask) => {
      createExecutorCallCount += 1
      sharedExecutor = new TaskBindingExecutor(runner)
      return sharedExecutor
    },
  })

  const task: WorkSessionTask = {
    id: 'task-revise-test',
    goal: 'implement complex feature',
  }

  const result = await adapter.run(task)

  assert.equal(result.status, 'COMPLETED', 'task must complete after revise')
  assert.equal(createExecutorCallCount, 1, 'createExecutor must be called only once')
  assert.notEqual(sharedExecutor, null, 'sharedExecutor must be assigned')
  assert.equal(sharedExecutor!.executeCallCount, 2, 'executor.execute must be called twice')
})

test('resumeData reaches createGuardianTask callback', async () => {
  const runner = new QueueRunner([
    commandResult(''),
    commandResult(claudeJson({ result: '完成' })),
    commandResult(' M src/docker.ts\n'),
    commandResult(''),
  ])

  let receivedResumeData: unknown = null

  const adapter = new GuardianWorkSessionTaskRunner({
    brain: {
      async review() {
        return {
          verdict: 'done',
          goal: 'complete',
          instructions: [],
          constraints: [],
          verification: [],
          doNotDo: [],
        }
      },
    },
    createExecutor: () => new TaskBindingExecutor(runner),
    createGuardianTask: (task, resumeData) => {
      receivedResumeData = resumeData
      return {
        id: task.id,
        goal: task.goal,
        state: 'READY',
        iteration: 0,
        maxIterations: 10,
      }
    },
  })

  const task: WorkSessionTask = {
    id: 'task-resume',
    goal: 'implement with docker',
  }

  await adapter.run(task, { decision: 'docker' })

  assert.deepEqual(receivedResumeData, { decision: 'docker' }, 'resumeData must reach callback')
})

test('Chinese rationale maps to PERMISSION_REQUIRED', async () => {
  const runner = new QueueRunner([
    commandResult(''),
    commandResult(
      claudeJson({
        subtype: 'error_max_turns',
        result: '遇到权限限制',
        num_turns: 12,
        permission_denials: [{ tool: 'Bash', operation: 'npm install' }],
      }),
      0,
    ),
    commandResult(' M src/deps.ts\n'),
  ])

  const brain: GuardianBrain = {
    async review({ report }) {
      if (report === undefined) {
        return {
          verdict: 'proceed',
          goal: 'install deps',
          instructions: ['npm install'],
          constraints: [],
          verification: [],
          doNotDo: [],
        }
      }

      // 第二次 review，有 permission denial
      assert.notEqual(report.permissionDenials, undefined, 'must have permission denials')
      return {
        verdict: 'blocked',
        goal: 'install deps',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
        rationale: '完成任务必须新增 Bash 权限，现有授权能力不足',
      }
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => new ClaudeCodeExecutor({
      cwd: 'D:/repo',
      commandRunner: runner.run,
    }),
  })

  const task: WorkSessionTask = {
    id: 'task-chinese-rationale',
    goal: 'install dependencies',
  }

  const result = await adapter.run(task)

  assert.equal(result.status, 'HUMAN_REQUIRED', 'must require human')
  assert.equal(result.humanRequired?.category, 'PERMISSION_REQUIRED', 'must be PERMISSION_REQUIRED')
})
