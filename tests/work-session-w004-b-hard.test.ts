/**
 * W004-B Hard Boundary — Guardian optional hook + BUDGET_EXHAUSTED 映射
 *
 * CASE AB  hard before Reviewer（review=0, executor=0）
 * CASE AC  hard after Reviewer（review=1, executor=0）
 * CASE AD  hard after Executor（review=1, executor=1, 下一 Reviewer 不启动）
 * 另含：runtime 级集成（context.hardDeadlineAtMs → SUSPENDED BUDGET_EXHAUSTED）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GuardianWorkSessionTaskRunner,
  WorkSessionRuntime,
  type GuardianBrain,
  type GuardianExecutor,
  type DelegationPacket,
  type ExecutionReport,
  type WorkSessionDefinition,
} from 'nova-wing/development-guardian'

function proceedPacket(): DelegationPacket {
  return {
    verdict: 'proceed',
    goal: '实现 feature',
    instructions: ['实现 src/a.ts'],
    constraints: [],
    verification: ['git diff --check'],
    doNotDo: [],
  }
}

function donePacket(): DelegationPacket {
  return {
    verdict: 'done',
    goal: '实现 feature',
    instructions: [],
    constraints: [],
    verification: ['git diff --check'],
    doNotDo: [],
  }
}

function passedReport(): ExecutionReport {
  return {
    summary: 'done',
    changedFiles: ['src/a.ts'],
    commandsRun: ['git diff --check'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }],
    blockers: [],
  }
}

async function cleanupTemp(tempBase: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
  let retries = 3
  while (retries > 0) {
    try {
      await rm(tempBase, { recursive: true, force: true })
      break
    } catch {
      retries--
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

// ============ CASE AB: hard before Reviewer ============

await test('W004-B CASE AB: hard before Reviewer → review=0, executor=0, BUDGET_EXHAUSTED', async () => {
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      return proceedPacket()
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    clock: { now: () => 10_000 },
  })

  const result = await adapter.run(
    { id: 'T1', goal: '实现 feature' },
    undefined,
    undefined,
    { hardDeadlineAtMs: 5_000 },
  )

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'BUDGET_EXHAUSTED')
  assert.equal(result.humanRequired?.reason, 'work session hard time boundary reached')
  assert.equal(reviewCalls, 0, 'reviewer must not be called')
  assert.equal(executeCalls, 0, 'executor must not be called')
})

// ============ CASE AC: hard after Reviewer ============

await test('W004-B CASE AC: hard after Reviewer → review=1, executor=0, BUDGET_EXHAUSTED', async () => {
  let now = 0
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      now = 20_000 // 在 review 期间越过 hard deadline
      return proceedPacket()
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    clock: { now: () => now },
  })

  const result = await adapter.run(
    { id: 'T1', goal: '实现 feature' },
    undefined,
    undefined,
    { hardDeadlineAtMs: 10_000 },
  )

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'BUDGET_EXHAUSTED')
  assert.equal(reviewCalls, 1, 'reviewer called once')
  assert.equal(executeCalls, 0, 'executor must not be called')
})

// ============ CASE AD: hard after Executor ============

await test('W004-B CASE AD: hard after Executor → review=1, executor=1, next review not started', async () => {
  let now = 0
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      if (reviewCalls === 1) {
        return proceedPacket()
      }
      return donePacket()
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      now = 20_000 // 在 execute 期间越过 hard deadline；绝不中途 kill
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    clock: { now: () => now },
  })

  const result = await adapter.run(
    { id: 'T1', goal: '实现 feature' },
    undefined,
    undefined,
    { hardDeadlineAtMs: 10_000 },
  )

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'BUDGET_EXHAUSTED')
  assert.equal(reviewCalls, 1, 'reviewer called once (next review not started)')
  assert.equal(executeCalls, 1, 'executor completed the in-flight execute')
})

// ============ CASE AC2: hard after Reviewer done → terminal verdict 优先 ============

await test('W004-B CASE AC2: hard after Reviewer done → normal COMPLETED (not BUDGET_EXHAUSTED)', async () => {
  let now = 0
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      if (reviewCalls === 1) {
        return proceedPacket()
      }
      now = 20_000 // 在 done review 期间越过 hard deadline
      return donePacket()
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    clock: { now: () => now },
  })

  const result = await adapter.run(
    { id: 'T1', goal: '实现 feature' },
    undefined,
    undefined,
    { hardDeadlineAtMs: 10_000 },
  )

  assert.equal(result.status, 'COMPLETED', 'terminal done verdict must win over hard limit')
  assert.equal(reviewCalls, 2, 'proceed then done')
  assert.equal(executeCalls, 1, 'one executor call')
})

// ============ CASE AC3: hard after Reviewer blocked → terminal verdict 优先 ============

await test('W004-B CASE AC3: hard after Reviewer blocked → normal HUMAN_REQUIRED (not BUDGET_EXHAUSTED)', async () => {
  let now = 0
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      now = 20_000 // 越过 hard deadline
      return {
        verdict: 'blocked',
        goal: '实现 feature',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
        rationale: '需要人工授权',
      }
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
    clock: { now: () => now },
  })

  const result = await adapter.run(
    { id: 'T1', goal: '实现 feature' },
    undefined,
    undefined,
    { hardDeadlineAtMs: 10_000 },
  )

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.notEqual(result.humanRequired?.category, 'BUDGET_EXHAUSTED', 'blocked must NOT map to BUDGET_EXHAUSTED')
  assert.equal(result.humanRequired?.category, 'DECISION_REQUIRED', 'blocked rationale maps to DECISION_REQUIRED')
  assert.equal(reviewCalls, 1)
  assert.equal(executeCalls, 0, 'blocked verdict stops before executor')
})

// ============ 无 deadline 时 hook 不注入（backward compat） ============

await test('W004-B hard: no hardDeadline → no stop hook, Guardian behavior unchanged', async () => {
  let reviewCalls = 0
  let executeCalls = 0

  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      if (reviewCalls === 1) {
        return proceedPacket()
      }
      return donePacket()
    },
  }
  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      executeCalls += 1
      return passedReport()
    },
  }

  const adapter = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
  })

  const result = await adapter.run({ id: 'T1', goal: '实现 feature' })

  assert.equal(result.status, 'COMPLETED', 'no deadline → normal completion')
  assert.equal(reviewCalls, 2, 'proceed then done')
  assert.equal(executeCalls, 1, 'one executor call')
})

// ============ runtime 级集成：hard boundary 期间 task → SUSPENDED BUDGET_EXHAUSTED ============

await test('W004-B hard runtime: hard boundary during task → SUSPENDED BUDGET_EXHAUSTED', async () => {
  let now = 0
  const clock = { now: () => now }
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-hard-rt-'))
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const brain: GuardianBrain = {
      async review() {
        now = 70_000 // 越过 hard(1min) 的 deadline
        return proceedPacket()
      },
    }
    const executor: GuardianExecutor = {
      async execute(): Promise<ExecutionReport> {
        return passedReport()
      },
    }

    const adapter = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      clock,
    })

    const definition: WorkSessionDefinition = {
      id: 'w004b-hard-rt',
      targetRepo: '/tmp/repo',
      branch: 'feat/test',
      tasks: [{ id: 'T1', goal: '实现 feature' }],
      limits: { softMinutes: 1, hardMinutes: 1, maxTasks: 5 },
    }

    const runtime = new WorkSessionRuntime({ definition, taskRunner: adapter, storageUrl, clock })
    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'SUSPENDED', 'session must suspend on hard boundary')
    assert.equal(state.humanRequired?.category, 'BUDGET_EXHAUSTED')
    assert.equal(state.humanRequired?.reason, 'work session hard time boundary reached')
    assert.deepEqual(state.completedTaskIds, [], 'no task completed')
  } finally {
    await cleanupTemp(tempBase)
  }
})
