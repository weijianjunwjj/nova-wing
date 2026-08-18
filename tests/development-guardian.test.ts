import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runGuardianTask,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianBrain,
  type GuardianExecutor,
  type GuardianTask,
} from 'nova-wing/development-guardian'

function baseTask(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-1',
    goal: '完成一个最小开发任务',
    state: 'READY',
    iteration: 0,
    maxIterations: 4,
    ...overrides,
  }
}

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: '完成一个最小开发任务',
    instructions: verdict === 'proceed' || verdict === 'revise' ? ['按当前范围修改'] : [],
    constraints: ['不得越界'],
    verification: ['npm test'],
    doNotDo: ['不要改 schema'],
  }
}

function report(status: 'passed' | 'failed' | 'skipped' = 'passed'): ExecutionReport {
  return {
    summary: '执行完成',
    changedFiles: ['src/a.ts'],
    commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status }],
    blockers: [],
  }
}

test('guardian completes after execute and review done', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report('passed')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(result.task.iteration, 1)
  assert.equal(result.reports.length, 1)
})

test('guardian supports review revise loop', async () => {
  const brainPackets = [packet('proceed'), packet('revise'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  let executions = 0
  const executor: GuardianExecutor = {
    async execute() {
      executions += 1
      return report('passed')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(executions, 2)
  assert.equal(result.task.iteration, 2)
})

test('guardian preserves user task goal and hard constraints for executor', async () => {
  const brainPackets = [
    {
      ...packet('proceed'),
      goal: 'Brain 改写后的目标',
      constraints: ['Brain 约束'],
      doNotDo: [],
    },
    packet('done'),
  ]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  let executedPacket: DelegationPacket | undefined
  const executor: GuardianExecutor = {
    async execute(input) {
      executedPacket = input.packet
      return report('passed')
    },
  }

  await runGuardianTask({
    task: baseTask({
      goal: '用户原始目标',
      constraints: ['用户硬约束'],
      doNotDo: ['禁止改 schema'],
    }),
    brain,
    executor,
  })

  assert.equal(executedPacket?.goal, '用户原始目标')
  assert.deepEqual(executedPacket?.constraints, ['用户硬约束', 'Brain 约束'])
  assert.deepEqual(executedPacket?.doNotDo, ['禁止改 schema'])
})

test('failed deterministic verification prevents completion', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report('failed')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.match(result.task.stopReason ?? '', /non-passing deterministic verification/)
})

test('skipped deterministic verification prevents completion', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report('skipped')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.match(result.task.stopReason ?? '', /non-passing deterministic verification/)
})

test('brain cannot complete before any execution evidence exists', async () => {
  const brain: GuardianBrain = {
    async review() {
      return packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      throw new Error('executor must not run')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.equal(result.task.iteration, 0)
  assert.match(result.task.stopReason ?? '', /before any execution evidence/)
})

test('brain cannot complete without deterministic verification evidence', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return { ...report('passed'), verificationResults: [] }
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.match(result.task.stopReason ?? '', /without deterministic verification evidence/)
})

test('executor blocker moves task to human required', async () => {
  const brain: GuardianBrain = {
    async review() {
      return packet('proceed')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return { ...report('passed'), blockers: ['需要人工选择方案'] }
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.match(result.task.stopReason ?? '', /需要人工选择方案/)
})

test('max iterations stops autonomous loop', async () => {
  const brain: GuardianBrain = {
    async review() {
      return packet('revise')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report('passed')
    },
  }

  const result = await runGuardianTask({
    task: baseTask({ maxIterations: 2 }),
    brain,
    executor,
  })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.equal(result.task.iteration, 2)
  assert.match(result.task.stopReason ?? '', /max iterations reached/)
})

test('brain failure moves task to human required instead of crashing loop', async () => {
  const brain: GuardianBrain = {
    async review() {
      throw new Error('ChatGPT Web bridge unavailable')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report('passed')
    },
  }

  const result = await runGuardianTask({ task: baseTask(), brain, executor })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.match(result.task.stopReason ?? '', /ChatGPT Web bridge unavailable/)
  assert.equal(result.task.iteration, 0)
})
