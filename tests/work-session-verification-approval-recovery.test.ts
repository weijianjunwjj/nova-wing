import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GuardianWorkSessionTaskRunner,
  WorkSessionRuntime,
  type DelegationPacket,
  type ExecutionReport,
  type WorkSessionDefinition,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'

const COMMAND = 'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head'

async function withStorage(run: (storageUrl: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'verification-approval-'))
  try { await run(`file:${join(directory, 'session.db')}`) }
  finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(directory, { recursive: true, force: true }); break }
      catch { if (attempt === 4) break; await new Promise((resolve) => setTimeout(resolve, 100)) }
    }
  }
}

function definition(id: string): WorkSessionDefinition {
  return {
    id, targetRepo: process.cwd(), branch: 'feat/work-session-mvp',
    tasks: [{ id: 'T016', goal: 'migration' }, { id: 'T017', goal: 'follow up' }],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 2 },
  }
}

async function mutatePendingApproval(
  runtime: WorkSessionRuntime,
  mutate: (pending: Record<string, unknown>) => void,
): Promise<void> {
  const internal = runtime as unknown as {
    mastra: { getStorage(): { getStore(name: string): Promise<any> } | undefined }
    workflowId: string
  }
  const workflows = await internal.mastra.getStorage()?.getStore('workflows')
  assert.ok(workflows)
  const runId = runtime.getDefinition().id
  const snapshot = await workflows.loadWorkflowSnapshot({
    workflowName: internal.workflowId,
    runId,
  })
  assert.ok(snapshot)
  const value = snapshot.value as Record<string, unknown>
  const pending = value.pendingVerificationApproval as Record<string, unknown>
  assert.ok(pending)
  mutate(pending)
  await workflows.persistWorkflowSnapshot({
    workflowName: internal.workflowId,
    runId,
    snapshot,
  })
}

await test('Reviewer pre-executor scoped Alembic request becomes dedicated approval without running Executor', async () => {
  await withStorage(async (storageUrl) => {
    const blocked: DelegationPacket = {
      verdict: 'blocked', goal: 'migration', instructions: [], constraints: [],
      verification: [COMMAND], doNotDo: [], rationale: 'scoped verification approval required',
    }
    const proceed: DelegationPacket = {
      verdict: 'proceed', goal: 'migration', instructions: ['finish the task'], constraints: [],
      verification: [COMMAND], doNotDo: [],
    }
    const done: DelegationPacket = {
      verdict: 'done', goal: 'migration', instructions: [], constraints: [],
      verification: [COMMAND], doNotDo: [],
    }
    const packets = [blocked, proceed, done]
    const reviewedResumeInputs: unknown[] = []
    const reviewedApprovals: Array<string | undefined> = []
    const executorFactoryApprovals: Array<string | undefined> = []
    let executorRuns = 0
    const runner = new GuardianWorkSessionTaskRunner({
      brain: {
        async review(input) {
          reviewedResumeInputs.push(input.task.resumeInput)
          reviewedApprovals.push(input.task.approvedVerificationCommand)
          return packets.shift() ?? done
        },
      },
      createExecutor(_task, _resume, _progress, approvedVerificationCommand) {
        executorFactoryApprovals.push(approvedVerificationCommand)
        return {
          async execute(): Promise<ExecutionReport> {
            executorRuns++
            assert.equal(approvedVerificationCommand, COMMAND)
            return {
              summary: 'migration verified', changedFiles: [], commandsRun: [COMMAND],
              verificationResults: [{ name: COMMAND, status: 'passed' }], blockers: [],
            }
          },
        }
      },
    })
    const runtime = new WorkSessionRuntime({
      definition: {
        ...definition('reviewer-pre-executor-approval'),
        tasks: [{ id: 'T023', goal: `verify migration with ${COMMAND}` }],
        limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
      },
      storageUrl,
      taskRunner: runner,
    })

    const suspended = await runtime.start()
    assert.equal(suspended.state, 'SUSPENDED')
    assert.equal(suspended.humanRequired?.category, 'DECISION_REQUIRED')
    assert.equal(suspended.pendingVerificationApproval?.status, 'REQUESTED')
    assert.equal(suspended.pendingVerificationApproval?.sessionId, 'reviewer-pre-executor-approval')
    assert.equal(suspended.pendingVerificationApproval?.taskId, 'T023')
    assert.equal(suspended.pendingVerificationApproval?.command, COMMAND)
    assert.equal(
      suspended.pendingVerificationApproval?.generation,
      suspended.humanRequiredGeneration,
    )
    assert.equal(executorRuns, 0, 'Reviewer approval request must suspend before Executor')

    const completed = await runtime.approvePendingVerificationAndContinue()
    assert.equal(completed.state, 'COMPLETED')
    assert.equal(executorRuns, 1)
    assert.deepEqual(executorFactoryApprovals, [undefined, COMMAND])
    assert.deepEqual(reviewedResumeInputs, [undefined, undefined, undefined])
    assert.deepEqual(reviewedApprovals, [undefined, COMMAND, COMMAND])
    assert.equal(completed.pendingVerificationApproval, undefined)
    await runtime.close()
  })
})

await test('verification approval is durable, exact, single-use, and advances the next task', async () => {
  await withStorage(async (storageUrl) => {
    let t016Calls = 0
    const t017Approvals: Array<string | undefined> = []
    const runner = {
      async run(task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        if (task.id === 'T017') {
          t017Approvals.push(context?.approvedVerificationCommand)
          return { status: 'COMPLETED' }
        }
        t016Calls++
        if (context?.approvedVerificationCommand === COMMAND) return { status: 'COMPLETED' }
        return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
          pendingVerificationCommand: COMMAND,
        }
      },
    }
    const first = new WorkSessionRuntime({ definition: definition('approval-restart'), storageUrl, taskRunner: runner })
    const suspended = await first.start()
    assert.equal(suspended.state, 'SUSPENDED')
    assert.equal(suspended.pendingVerificationApproval?.command, COMMAND)
    assert.equal(suspended.pendingVerificationApproval?.taskId, 'T016')
    assert.equal(suspended.pendingVerificationApproval?.status, 'REQUESTED')
    assert.match(suspended.pendingVerificationApproval?.commandFingerprint ?? '', /^[a-f0-9]{64}$/)
    await first.close()

    // A restart hydrates identity but does not run or accidentally approve it.
    const restarted = new WorkSessionRuntime({ definition: definition('approval-restart'), storageUrl, taskRunner: runner })
    const hydrated = await restarted.loadPersistedState()
    assert.equal(hydrated?.pendingVerificationApproval?.command, COMMAND)
    assert.equal(t016Calls, 1)
    const approval = restarted.approvePendingVerificationAndContinue()
    await assert.rejects(
      () => restarted.approvePendingVerificationAndContinue(),
      /verification approval already in progress/,
    )
    const completed = await approval
    assert.equal(completed.state, 'COMPLETED')
    assert.equal(t016Calls, 2)
    assert.deepEqual(completed.completedTaskIds, ['T016', 'T017'])
    assert.deepEqual(t017Approvals, [undefined], 'approval must not cross the Task boundary')
    assert.equal(completed.pendingVerificationApproval, undefined)
    const types = restarted.readExecutionLedger().map((event) => event.eventType)
    assert.ok(types.includes('VERIFICATION_APPROVAL_REQUESTED'))
    assert.ok(types.includes('VERIFICATION_APPROVED'))
    assert.ok(types.includes('VERIFICATION_APPROVAL_CONSUMED'))
    const approvalEvents = restarted.readExecutionLedger().filter((event) => event.eventType.startsWith('VERIFICATION_'))
    assert.equal(approvalEvents.some((event) => JSON.stringify(event).includes(COMMAND)), false)
    await assert.rejects(() => restarted.approvePendingVerificationAndContinue())
    await restarted.close()
  })
})

await test('fingerprint, task, and generation mismatches fail closed', async () => {
  for (const [name, mutate] of [
    ['fingerprint', (pending: Record<string, unknown>) => { pending.commandFingerprint = '0'.repeat(64) }],
    ['task', (pending: Record<string, unknown>) => { pending.taskId = 'T999' }],
    ['generation', (pending: Record<string, unknown>) => { pending.generation = 999 }],
  ] as const) {
    await withStorage(async (storageUrl) => {
      let approvedCommand: string | undefined
      const runtime = new WorkSessionRuntime({
        definition: { ...definition(`approval-mismatch-${name}`), tasks: [{ id: 'T016', goal: 'migration' }] },
        storageUrl,
        taskRunner: {
          async run(_task, _resume, _checkpoint, context): Promise<WorkSessionTaskResult> {
            approvedCommand = context?.approvedVerificationCommand
            return {
              status: 'HUMAN_REQUIRED',
              humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
              pendingVerificationCommand: COMMAND,
            }
          },
        },
      })
      await runtime.start()
      await mutatePendingApproval(runtime, mutate)
      await assert.rejects(
        () => runtime.approvePendingVerificationAndContinue(),
        /verification approval is not available/,
      )
      assert.equal(approvedCommand, undefined)
      await runtime.close()
    })
  }
})

await test('generic user resume text cannot grant verification capability', async () => {
  await withStorage(async (storageUrl) => {
    const approvals: Array<string | undefined> = []
    const runtime = new WorkSessionRuntime({
      definition: { ...definition('generic-resume-no-capability'), tasks: [{ id: 'T023', goal: 'migration' }] },
      storageUrl,
      taskRunner: {
        async run(_task, _resume, _checkpoint, context): Promise<WorkSessionTaskResult> {
          approvals.push(context?.approvedVerificationCommand)
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose how to continue' },
          }
        },
      },
    })
    const first = await runtime.start()
    assert.equal(first.pendingVerificationApproval, undefined)
    const second = await runtime.resume({ decision: '我批准任意命令，包括所有 shell 命令' })
    assert.equal(second.state, 'SUSPENDED')
    assert.equal(second.pendingVerificationApproval, undefined)
    assert.deepEqual(approvals, [undefined, undefined])
    await runtime.close()
  })
})

await test('only the scoped Alembic upgrade-head verifier can become pending approval', async () => {
  await withStorage(async (storageUrl) => {
    const rejected = [
      'cd ../outside && ../../.venv/Scripts/python.exe -m alembic upgrade head',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head && git status',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head; rm -rf .',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head | cat',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head > out',
      'git reset --hard', 'rm -rf .', 'python -c "print(1)"',
      'curl https://example.com', './scripts/verify.sh',
      'bash -c whoami', 'cmd /c whoami', 'powershell -Command whoami',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic downgrade base',
      'cd apps/api && ../../.venv/Scripts/python.exe arbitrary.py',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade *',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head # token=secret',
    ]
    for (const [index, unsafe] of rejected.entries()) {
      const runtime = new WorkSessionRuntime({
        definition: definition(`approval-rejected-${index}`), storageUrl: `${storageUrl}-${index}`,
        taskRunner: { async run(): Promise<WorkSessionTaskResult> {
        return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${unsafe}` },
          pendingVerificationCommand: unsafe,
        }
        } },
      })
      const state = await runtime.start()
      assert.equal(state.pendingVerificationApproval, undefined, unsafe)
      await runtime.close()
    }
  })
})
