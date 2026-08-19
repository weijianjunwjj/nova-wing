import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runGuardianTask,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianBrain,
  type GuardianExecutor,
  type GuardianProgressEvent,
  type GuardianTask,
} from 'nova-wing/development-guardian'

function baseTask(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-progress',
    goal: 'test progress',
    state: 'READY',
    iteration: 0,
    maxIterations: 3,
    ...overrides,
  }
}

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: 'test progress',
    instructions: verdict === 'proceed' || verdict === 'revise' ? ['do work'] : [],
    constraints: [],
    verification: ['npm test'],
    doNotDo: [],
  }
}

function report(): ExecutionReport {
  return {
    summary: 'done',
    changedFiles: ['src/a.ts'],
    commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
  }
}

test('CASE A: progress events follow correct sequence for successful completion', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  const events: GuardianProgressEvent[] = []
  await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  const phases = events.map((e) => `${e.phase}:${e.status}`)
  assert.deepEqual(phases, [
    'PREPARING:completed',
    'REVIEWING:active',
    'REVIEWING:completed',
    'EXECUTING:active',
    'EXECUTING:completed',
    'FINAL_REVIEW:active',
    'FINAL_REVIEW:completed',
    'COMPLETED:completed',
  ])
})

test('CASE B: progress observer is optional', async () => {
  const brainPackets = [packet('proceed'), packet('done')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
  })

  assert.equal(result.task.state, 'COMPLETED')
})

test('CASE C: brain review failure triggers HUMAN_REQUIRED', async () => {
  const brain: GuardianBrain = {
    async review() {
      throw new Error('ChatGPT review timed out after 180000ms')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  const events: GuardianProgressEvent[] = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.ok(result.task.stopReason?.includes('brain review failed'))
  assert.ok(result.task.stopReason?.includes('timed out'))

  const finalEvent = events.find((e) => e.phase === 'HUMAN_REQUIRED')
  assert.ok(finalEvent)
  assert.equal(finalEvent.status, 'completed')
})

test('CASE D: executor failure before any report triggers FAILED', async () => {
  const brain: GuardianBrain = {
    async review() {
      return packet('proceed')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      throw new Error('executor startup failed')
    },
  }

  const events: GuardianProgressEvent[] = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  assert.equal(result.task.state, 'FAILED')
  assert.ok(result.task.stopReason?.includes('executor startup failed'))

  const failedPhases = events.filter((e) => e.status === 'failed')
  assert.ok(failedPhases.some((e) => e.phase === 'EXECUTING'))
})

test('CASE E: max iterations triggers HUMAN_REQUIRED', async () => {
  const brain: GuardianBrain = {
    async review() {
      return packet('proceed')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  const events: GuardianProgressEvent[] = []
  const result = await runGuardianTask({
    task: baseTask({ maxIterations: 2 }),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.ok(result.task.stopReason?.includes('max iterations'))
  assert.equal(result.task.iteration, 2)

  const humanRequiredEvent = events.find((e) => e.phase === 'HUMAN_REQUIRED')
  assert.ok(humanRequiredEvent)
})

test('CASE F: brain blocked verdict triggers HUMAN_REQUIRED', async () => {
  const brain: GuardianBrain = {
    async review() {
      return {
        ...packet('blocked'),
        rationale: 'detected security risk',
      }
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return report()
    },
  }

  const events: GuardianProgressEvent[] = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.ok(result.task.stopReason?.includes('security risk'))
  assert.equal(result.reports.length, 0)
})

test('CASE G: executor blocker triggers HUMAN_REQUIRED', async () => {
  const brainPackets = [packet('proceed')]
  const brain: GuardianBrain = {
    async review() {
      return brainPackets.shift() ?? packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return {
        ...report(),
        blockers: ['changed file is outside allowed scope: src/forbidden.ts'],
      }
    },
  }

  const events: GuardianProgressEvent[] = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => events.push(event),
  })

  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.ok(result.task.stopReason?.includes('forbidden'))
  assert.equal(result.reports.length, 1)
})
