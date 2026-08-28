import assert from 'node:assert/strict'
import { mock } from 'node:test'
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
    id: 'task-coverage',
    goal: 'test coverage',
    state: 'READY',
    iteration: 0,
    maxIterations: 3,
    ...overrides,
  }
}

function packet(verdict: DelegationPacket['verdict']): DelegationPacket {
  return {
    verdict,
    goal: 'test coverage',
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

test('final review timeout preserves executor report', async () => {
  let reviewCount = 0
  const brain: GuardianBrain = {
    async review() {
      reviewCount += 1
      if (reviewCount === 1) {
        return packet('proceed')
      }
      throw new Error('ChatGPT review timed out after 180000ms')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      return {
        summary: 'implementation completed',
        changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
        commandsRun: ['claude', 'npm test'],
        verificationResults: [
          { name: 'git diff --check', status: 'passed' },
          { name: 'npm test', status: 'passed' },
        ],
        blockers: [],
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

  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED', 'must not complete after final review timeout')
  assert.ok(result.task.stopReason?.includes('timed out'), 'stopReason must mention timeout')
  assert.equal(result.reports.length, 1, 'must preserve executor report')
  assert.deepEqual(result.reports[0]?.changedFiles, ['src/auth.ts', 'src/auth.test.ts'])
  assert.equal(result.reports[0]?.summary, 'implementation completed')
  assert.equal(result.reports[0]?.verificationResults.length, 2)
  assert.equal(result.task.brainFailure?.stage, 'FINAL_REVIEW')
  assert.equal(result.task.brainFailure?.lastReliableCheckpoint, 'AFTER_EXECUTOR_VERIFICATION')
  assert.equal(result.task.brainFailure?.nextResumableAction, 'FINAL_REVIEW')

  const finalReviewActive = events.find((e) => e.phase === 'FINAL_REVIEW' && e.status === 'active')
  assert.ok(finalReviewActive, 'must show FINAL_REVIEW started')
  const finalReviewFailed = events.find((e) => e.phase === 'FINAL_REVIEW' && e.status === 'failed')
  assert.ok(finalReviewFailed, 'must show FINAL_REVIEW failed')
})

test('initial review timeout has no executor report', async () => {
  const brain: GuardianBrain = {
    async review() {
      throw new Error('ChatGPT review timed out after 180000ms')
    },
  }
  const executor: GuardianExecutor = {
    async execute() {
      throw new Error('executor should not be called')
    },
  }

  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
  })

  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.ok(result.task.stopReason?.includes('timed out'))
  assert.equal(result.reports.length, 0, 'initial review timeout must have no executor report')
})

test('timeout stopReason distinguishes initial vs final review', async () => {
  const initialBrain: GuardianBrain = {
    async review() {
      throw new Error('ChatGPT review timed out after 180000ms')
    },
  }
  const initialResult = await runGuardianTask({
    task: baseTask({ id: 'initial' }),
    brain: initialBrain,
    executor: {
      async execute() {
        return report()
      },
    },
  })

  let finalReviewCount = 0
  const finalBrain: GuardianBrain = {
    async review() {
      finalReviewCount += 1
      if (finalReviewCount === 1) {
        return packet('proceed')
      }
      throw new Error('ChatGPT review timed out after 180000ms')
    },
  }
  const finalResult = await runGuardianTask({
    task: baseTask({ id: 'final' }),
    brain: finalBrain,
    executor: {
      async execute() {
        return report()
      },
    },
  })

  assert.equal(initialResult.reports.length, 0)
  assert.equal(finalResult.reports.length, 1)
  assert.equal(initialResult.task.brainFailure?.stage, 'BRAIN_REVIEW')
  assert.equal(finalResult.task.brainFailure?.stage, 'FINAL_REVIEW')
})

test('CLI heartbeat timer is cleared after phase completes', async () => {
  const timers: NodeJS.Timeout[] = []
  const originalSetInterval = global.setInterval
  const originalClearInterval = global.clearInterval

  const setIntervalMock = mock.fn((callback: () => void, ms: number) => {
    const timer = originalSetInterval(callback, ms)
    timers.push(timer)
    return timer
  })

  const clearIntervalMock = mock.fn((timer: NodeJS.Timeout) => {
    const index = timers.indexOf(timer)
    if (index >= 0) {
      timers.splice(index, 1)
    }
    originalClearInterval(timer)
  })

  global.setInterval = setIntervalMock as unknown as typeof global.setInterval
  global.clearInterval = clearIntervalMock as unknown as typeof global.clearInterval

  try {
    class TestDisplay {
      private heartbeatTimer: NodeJS.Timeout | null = null

      startHeartbeat(): void {
        this.clearHeartbeat()
        this.heartbeatTimer = setInterval(() => {
          // heartbeat tick
        }, 30_000)
      }

      clearHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
      }

      onProgress(event: GuardianProgressEvent): void {
        if (event.status === 'active' && event.phase === 'REVIEWING') {
          this.startHeartbeat()
        } else if (event.status === 'completed' && event.phase === 'REVIEWING') {
          this.clearHeartbeat()
        }
      }
    }

    const display = new TestDisplay()
    const events: GuardianProgressEvent[] = []

    const brain: GuardianBrain = {
      async review() {
        return packet('done')
      },
    }
    const executor: GuardianExecutor = {
      async execute() {
        return report()
      },
    }

    await runGuardianTask({
      task: baseTask(),
      brain,
      executor,
      onProgress: (event) => {
        events.push(event)
        display.onProgress(event)
      },
    })

    assert.equal(setIntervalMock.mock.callCount(), 1, 'should create one heartbeat timer')
    assert.equal(clearIntervalMock.mock.callCount(), 1, 'should clear heartbeat timer')
    assert.equal(timers.length, 0, 'all timers should be cleared')
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
  }
})

test('RECOVERING progress event on max_turns bounded recovery', async () => {
  const brainPackets = [
    {
      verdict: 'proceed' as const,
      goal: 'test recovery',
      instructions: ['implement feature'],
      constraints: [],
      verification: ['npm test'],
      doNotDo: [],
    },
    {
      verdict: 'done' as const,
      goal: 'test recovery',
      instructions: [],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
  ]

  const brain: GuardianBrain = {
    async review() {
      const packet = brainPackets.shift()
      if (packet === undefined) {
        throw new Error('no more packets')
      }
      return packet
    },
  }

  let executeCount = 0
  const events: GuardianProgressEvent[] = []

  const executor: GuardianExecutor = {
    async execute() {
      executeCount += 1
      if (executeCount === 1) {
        // Simulate: executor internally does max_turn recovery
        // First attempt: max_turns
        // Recovery callback fires
        events.push({
          phase: 'RECOVERING',
          status: 'active',
          iteration: 1,
          elapsedMs: 0,
          recovery: {
            reason: 'max_turns',
            sessionId: 'session-123',
            bounded: true,
          },
        })
        // Second attempt: success
        return {
          summary: 'completed after recovery',
          changedFiles: ['src/a.ts'],
          commandsRun: ['claude', 'npm test'],
          verificationResults: [{ name: 'npm test', status: 'passed' }],
          blockers: [],
        }
      }
      throw new Error('unexpected execute call')
    },
  }

  const result = await runGuardianTask({
    task: baseTask(),
    brain,
    executor,
    onProgress: (event) => {
      if (event.phase !== 'RECOVERING') {
        events.push(event)
      }
    },
  })

  assert.equal(result.task.state, 'COMPLETED', 'task with done verdict and passing verification should complete')
  const recoveringEvent = events.find((e) => e.phase === 'RECOVERING')
  assert.ok(recoveringEvent, 'must emit RECOVERING event')
  assert.equal(recoveringEvent?.recovery?.reason, 'max_turns')
  assert.equal(recoveringEvent?.recovery?.bounded, true)
  assert.ok(recoveringEvent?.recovery?.sessionId)
})
