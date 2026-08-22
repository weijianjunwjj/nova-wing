import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GuardianWorkSessionTaskRunner,
  buildGuardianBrainPrompt,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianBrain,
  type GuardianTask,
} from 'nova-wing/development-guardian'
import type { GuardianRecoverableExecutor } from '../packages/development-guardian/ports.js'

const REPO = process.cwd()
const BRANCH = 'feat/work-session-mvp'
const HEAD = '6b6c392893d7b3dce17538262d1fb658fa94e773'

function donePacket(): DelegationPacket {
  return {
    verdict: 'done',
    goal: 'preserved goal',
    instructions: [],
    constraints: [],
    verification: ['npm test'],
    doNotDo: [],
  }
}

function previousReport(): ExecutionReport {
  return {
    summary: 'partial chain already executed',
    changedFiles: ['src/existing.ts'],
    commandsRun: ['npm test'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
  }
}

class NoExecute implements GuardianRecoverableExecutor {
  calls = 0
  async execute(): Promise<ExecutionReport> {
    this.calls++
    throw new Error('Executor must not run for terminal recovered review')
  }
}

function gitRunner(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = command.includes('branch --show-current')
    ? `${BRANCH}\n`
    : command.includes('rev-parse HEAD')
      ? `${HEAD}\n`
      : ''
  return Promise.resolve({ exitCode: 0, stdout, stderr: '' })
}

await test('W005-B RESUME-A: recovered Reviewer receives trusted resume input after repo gate', async () => {
  const originalTask: GuardianTask = {
    id: 'T1',
    goal: 'preserved goal',
    state: 'READY',
    iteration: 1,
    maxIterations: 10,
    constraints: ['keep constraint'],
    acceptanceCriteria: ['tests pass'],
    doNotDo: ['no redesign'],
    allowedPaths: ['src/**'],
    forbiddenPaths: ['secrets/**'],
    lastReport: previousReport(),
  }

  const firstExecutor = new NoExecute()
  const first = new GuardianWorkSessionTaskRunner({
    brain: {
      async review() {
        return { ...donePacket(), verdict: 'blocked', rationale: 'choose database mode' }
      },
    },
    createExecutor: () => firstExecutor,
    createGuardianTask: () => originalTask,
    repoPath: REPO,
    gitRunner,
  })
  const suspended = await first.run({ id: 'T1', goal: 'preserved goal' })
  assert.equal(suspended.status, 'HUMAN_REQUIRED')
  assert.ok(suspended.checkpoint)

  let recoveredTask: GuardianTask | undefined
  let prompt = ''
  const recoveredBrain: GuardianBrain = {
    async review(input) {
      recoveredTask = input.task
      prompt = buildGuardianBrainPrompt(input)
      return donePacket()
    },
  }
  const recoveredExecutor = new NoExecute()
  const recovered = new GuardianWorkSessionTaskRunner({
    brain: recoveredBrain,
    createExecutor: () => recoveredExecutor,
    repoPath: REPO,
    gitRunner,
  })

  const result = await recovered.run(
    { id: 'T1', goal: 'preserved goal' },
    { decision: '  docker  ', token: 'must-not-propagate' },
    suspended.checkpoint,
  )

  assert.equal(result.status, 'COMPLETED')
  assert.equal(recoveredExecutor.calls, 0)
  assert.equal(recoveredTask?.recoveryContinuation, true)
  assert.deepEqual(recoveredTask?.resumeInput, { decision: 'docker' })
  assert.equal(recoveredTask?.iteration, 1, 'execution chain must not restart from zero')
  assert.equal(recoveredTask?.lastReport?.summary, 'partial chain already executed')
  assert.equal(recoveredTask?.goal, originalTask.goal)
  assert.deepEqual(recoveredTask?.constraints, originalTask.constraints)
  assert.deepEqual(recoveredTask?.acceptanceCriteria, originalTask.acceptanceCriteria)
  assert.deepEqual(recoveredTask?.doNotDo, originalTask.doNotDo)
  assert.deepEqual(recoveredTask?.allowedPaths, originalTask.allowedPaths)
  assert.deepEqual(recoveredTask?.forbiddenPaths, originalTask.forbiddenPaths)
  assert.match(prompt, /user_resume_input/)
  assert.match(prompt, /"decision":"docker"/)
  assert.match(prompt, /不自动扩大 tool capability/)
  assert.doesNotMatch(prompt, /must-not-propagate/)
})

await test('W005-B RESUME-E: repo drift blocks resume before Reviewer/provider calls', async () => {
  let providerCalls = 0
  const executor = new NoExecute()
  const checkpoint = {
    version: 1 as const,
    task: {
      id: 'T1',
      goal: 'goal',
      state: 'HUMAN_REQUIRED' as const,
      iteration: 1,
      maxIterations: 10,
      stopReason: 'choose',
    },
    provider: {},
    repo: {
      repoPath: REPO,
      branch: 'wrong-branch',
      headSha: HEAD,
      changedFiles: [],
      worktreeFingerprint: 'irrelevant',
    },
    capturedAt: new Date().toISOString(),
  }
  const runner = new GuardianWorkSessionTaskRunner({
    brain: { async review() { providerCalls++; return donePacket() } },
    createExecutor: () => executor,
    repoPath: REPO,
    gitRunner,
  })
  const result = await runner.run(
    { id: 'T1', goal: 'goal' },
    { decision: 'docker' },
    checkpoint,
  )
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(providerCalls, 0)
  assert.equal(executor.calls, 0)
})
