import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runGuardianTask,
  RetryableGuardianBrainError,
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

test('guardian retries one typed transient Brain timeout without adding an executor iteration', async () => {
  let reviews = 0
  let executions = 0
  const brain: GuardianBrain = {
    async review() {
      reviews += 1
      if (reviews === 1) {
        throw new RetryableGuardianBrainError('ChatGPT review timed out after 600000ms')
      }
      return reviews === 2 ? packet('proceed') : packet('done')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      executions += 1
      return report()
    },
  }

  const result = await runGuardianTask({
    task: baseTask(), brain, executor, maxBrainReviewRetries: 1,
  })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(reviews, 3)
  assert.equal(executions, 1)
  assert.equal(result.task.iteration, 1)
})

test('guardian retries one malformed Reviewer protocol response in the same session then completes', async () => {
  let reviews = 0
  let executions = 0
  const protocolRepairFlags: Array<boolean | undefined> = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain: {
      async review(input) {
        reviews += 1
        protocolRepairFlags.push(input.protocolRepair)
        if (reviews === 1) throw new RetryableGuardianBrainError('reviewer returned malformed Guardian JSON', 'protocol')
        return reviews === 2 ? packet('proceed') : packet('done')
      },
    },
    executor: { async execute() { executions += 1; return report() } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(reviews, 3)
  assert.equal(executions, 1)
  assert.deepEqual(protocolRepairFlags, [undefined, true, undefined])
})

test('guardian rotates after a second malformed Reviewer protocol response and completes fresh review', async () => {
  let reviews = 0
  let rotations = 0
  const protocolRepairFlags: Array<boolean | undefined> = []
  const result = await runGuardianTask({
    task: baseTask(),
    brain: {
      async review(input) {
        reviews += 1
        protocolRepairFlags.push(input.protocolRepair)
        if (reviews <= 2) throw new RetryableGuardianBrainError('reviewer returned malformed Guardian JSON', 'protocol')
        return reviews === 3 ? packet('proceed') : packet('done')
      },
      resetTaskReviewSession() { rotations += 1 },
    },
    executor: { async execute() { return report() } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(reviews, 4)
  assert.equal(rotations, 1)
  assert.deepEqual(protocolRepairFlags, [undefined, true, true, undefined])
})

test('guardian stops after consecutive retryable Brain timeouts', async () => {
  let reviews = 0
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
  })
  assert.equal(reviews, 2)
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.equal(result.task.brainFailure?.fingerprint, 'brain-transport:timeout')
  assert.equal(result.task.brainFailure?.failureType, 'BRAIN_TRANSPORT_FAILED')
  assert.equal(result.task.brainFailure?.stage, 'BRAIN_REVIEW')
  assert.equal(result.task.brainFailure?.attempt, 2)
  assert.equal(result.task.brainFailure?.nextResumableAction, 'REVIEWING')
  assert.match(result.task.brainFailure?.timestamp ?? '', /^\d{4}-\d{2}-\d{2}T/u)
  assert.doesNotMatch(result.task.brainFailure?.safeMessage ?? '', /timeout/u)
})

test('guardian does not retry ordinary Brain errors', async () => {
  let reviews = 0
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; throw new Error('protocol failure') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
  })
  assert.equal(reviews, 1)
  assert.match(result.task.stopReason ?? '', /protocol failure/)
})

test('guardian checks hard limit again before retrying a transient Brain timeout', async () => {
  let reviews = 0
  let hardLimit = false
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; hardLimit = true; throw new RetryableGuardianBrainError('timeout') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    shouldStopAutonomousWork: () => hardLimit,
  })
  assert.equal(reviews, 1)
  assert.equal(result.task.stopReason, 'WORK_SESSION_HARD_LIMIT_REACHED')
})

test('guardian checks pause again before retrying a transient Brain timeout', async () => {
  let reviews = 0
  let paused = false
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; paused = true; throw new RetryableGuardianBrainError('timeout') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    shouldPauseAutonomousWork: () => paused,
  })
  assert.equal(reviews, 1)
  assert.equal(result.task.stopReason, 'WORK_SESSION_USER_PAUSE_REQUESTED')
})

test('guardian checks hard limit and pause before retrying malformed Reviewer protocol responses', async () => {
  for (const boundary of ['hard-limit', 'pause'] as const) {
    let reviews = 0
    let blocked = false
    const result = await runGuardianTask({
      task: baseTask(),
      brain: {
        async review() {
          reviews += 1
          blocked = true
          throw new RetryableGuardianBrainError('reviewer returned malformed Guardian JSON', 'protocol')
        },
      },
      executor: { async execute() { throw new Error('must not execute') } },
      maxBrainReviewRetries: 1,
      ...(boundary === 'hard-limit'
        ? { shouldStopAutonomousWork: () => blocked }
        : { shouldPauseAutonomousWork: () => blocked }),
    })
    assert.equal(reviews, 1)
    assert.equal(
      result.task.stopReason,
      boundary === 'hard-limit' ? 'WORK_SESSION_HARD_LIMIT_REACHED' : 'WORK_SESSION_USER_PAUSE_REQUESTED',
    )
  }
})

test('guardian does not retry a valid blocked Reviewer packet', async () => {
  let reviews = 0
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; return packet('blocked') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(reviews, 1)
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
})

test('guardian rotates one stuck Brain session and completes with preserved task evidence', async () => {
  let reviews = 0
  let rotations = 0
  let executions = 0
  const seenTasks: GuardianTask[] = []
  const brain: GuardianBrain = {
    async review(input) {
      reviews += 1
      seenTasks.push(input.task)
      if (reviews <= 2) throw new RetryableGuardianBrainError('timeout')
      return reviews === 3 ? packet('proceed') : packet('done')
    },
    resetTaskReviewSession(taskId) {
      assert.equal(taskId, 'task-1')
      rotations += 1
    },
  }
  const result = await runGuardianTask({
    task: baseTask({
      constraints: ['constraint'],
      acceptanceCriteria: ['acceptance'],
      doNotDo: ['forbidden action'],
      allowedPaths: ['src/**'],
      forbiddenPaths: ['secrets/**'],
      recoveryContinuation: true,
      resumeInput: { decision: 'continue' },
    }),
    brain,
    executor: { async execute() { executions += 1; return report() } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(reviews, 4, 'three initial-review calls plus a separate final review')
  assert.equal(rotations, 1)
  assert.equal(executions, 1)
  assert.equal(result.task.iteration, 1)
  assert.deepEqual(seenTasks[2]?.constraints, ['constraint'])
  assert.deepEqual(seenTasks[2]?.acceptanceCriteria, ['acceptance'])
  assert.deepEqual(seenTasks[2]?.resumeInput, { decision: 'continue' })
})

test('guardian permits no fourth call after a rotated session also times out', async () => {
  let reviews = 0
  let rotations = 0
  const brain: GuardianBrain = {
    async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
    resetTaskReviewSession() { rotations += 1 },
  }
  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(reviews, 3)
  assert.equal(rotations, 1)
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
})

test('guardian preserves two-attempt behavior when Brain cannot rotate sessions', async () => {
  let reviews = 0
  const result = await runGuardianTask({
    task: baseTask(),
    brain: { async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') } },
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(reviews, 2)
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
})

test('guardian checks hard limit before rotating a stuck Brain session', async () => {
  let reviews = 0
  let rotations = 0
  const brain: GuardianBrain = {
    async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
    resetTaskReviewSession() { rotations += 1 },
  }
  const result = await runGuardianTask({
    task: baseTask(), brain,
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
    shouldStopAutonomousWork: () => reviews >= 2,
  })
  assert.equal(reviews, 2)
  assert.equal(rotations, 0)
  assert.equal(result.task.stopReason, 'WORK_SESSION_HARD_LIMIT_REACHED')
})

test('guardian checks pause before rotating a stuck Brain session', async () => {
  let reviews = 0
  let rotations = 0
  const brain: GuardianBrain = {
    async review() { reviews += 1; throw new RetryableGuardianBrainError('timeout') },
    resetTaskReviewSession() { rotations += 1 },
  }
  const result = await runGuardianTask({
    task: baseTask(), brain,
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
    shouldPauseAutonomousWork: () => reviews >= 2,
  })
  assert.equal(reviews, 2)
  assert.equal(rotations, 0)
  assert.equal(result.task.stopReason, 'WORK_SESSION_USER_PAUSE_REQUESTED')
})

test('guardian never rotates on an ordinary Brain protocol error', async () => {
  let reviews = 0
  let rotations = 0
  const brain: GuardianBrain = {
    async review() {
      reviews += 1
      if (reviews === 1) throw new RetryableGuardianBrainError('timeout')
      throw new Error('protocol failure')
    },
    resetTaskReviewSession() { rotations += 1 },
  }
  const result = await runGuardianTask({
    task: baseTask(), brain,
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })
  assert.equal(reviews, 2)
  assert.equal(rotations, 0)
  assert.match(result.task.stopReason ?? '', /protocol failure/)
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

test('brain failure becomes infrastructure failure instead of a human decision', async () => {
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
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.match(result.task.stopReason ?? '', /ChatGPT Web bridge unavailable/)
  assert.equal(result.task.iteration, 0)
})
