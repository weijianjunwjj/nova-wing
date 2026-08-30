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
  type GuardianTaskRecoveryCheckpoint,
  type WorkSessionDefinition,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'

const COMMAND = 'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head'

function recoveryCheckpoint(
  taskId: string,
  verificationResults: ExecutionReport['verificationResults'] = [],
): GuardianTaskRecoveryCheckpoint {
  return {
    version: 1,
    task: {
      id: taskId,
      goal: 'migration',
      constraints: [],
      state: 'HUMAN_REQUIRED',
      iteration: 1,
      maxIterations: 3,
      lastPacket: {
        verdict: 'blocked', goal: 'migration', instructions: [], constraints: [],
        verification: [COMMAND], doNotDo: [], rationale: 'verification required',
      },
      ...(verificationResults.length === 0
        ? {}
        : {
            lastReport: {
              summary: 'verification completed', changedFiles: [], commandsRun: [COMMAND],
              verificationResults, blockers: [],
            },
          }),
    },
    provider: {},
    repo: {
      repoPath: process.cwd(), branch: 'feat/work-session-mvp',
      headSha: 'a'.repeat(40), changedFiles: [], worktreeFingerprint: 'b'.repeat(64),
    },
    capturedAt: '2026-08-30T00:00:00.000Z',
  }
}

const BRAIN_FAILURE = {
  stage: 'FINAL_REVIEW' as const,
  failureType: 'BRAIN_TRANSPORT_FAILED' as const,
  safeMessage: 'Brain transport unavailable',
  category: 'TRANSPORT' as const,
  rootCause: 'review timed out',
  adapter: 'ask-bridge/chatgpt',
  retryable: true,
  degraded: false,
  fingerprint: 'brain-transport:timeout',
}

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

async function removePendingApproval(runtime: WorkSessionRuntime): Promise<void> {
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
  delete (snapshot.value as Record<string, unknown>).pendingVerificationApproval
  await workflows.persistWorkflowSnapshot({
    workflowName: internal.workflowId,
    runId,
    snapshot,
  })
}

async function replaceCheckpointVerificationCommand(
  runtime: WorkSessionRuntime,
  command: string,
): Promise<void> {
  const internal = runtime as unknown as {
    mastra: { getStorage(): { getStore(name: string): Promise<any> } | undefined }
    workflowId: string
  }
  const workflows = await internal.mastra.getStorage()?.getStore('workflows')
  assert.ok(workflows)
  const runId = runtime.getDefinition().id
  const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: internal.workflowId, runId })
  assert.ok(snapshot)
  const checkpoint = (snapshot.value as Record<string, any>).currentTaskCheckpoint
  checkpoint.task.lastPacket.verification = [command]
  await workflows.persistWorkflowSnapshot({ workflowName: internal.workflowId, runId, snapshot })
}

function appendLegacyPrematureConsumption(runtime: WorkSessionRuntime, generation: number): void {
  const internal = runtime as unknown as {
    ledger?: { append(input: Record<string, unknown>, dedupeKey: string): unknown }
  }
  assert.ok(internal.ledger)
  const sessionId = runtime.getDefinition().id
  const approved = runtime.readExecutionLedger().find(
    (event) => event.eventType === 'VERIFICATION_APPROVED',
  )
  const fingerprint = approved !== undefined && 'commandFingerprint' in approved
    ? approved.commandFingerprint
    : undefined
  assert.ok(fingerprint)
  internal.ledger.append({
    eventType: 'VERIFICATION_APPROVAL_CONSUMED', sessionId, taskId: 'T023',
    timestamp: '2026-08-30T00:01:00.000Z', status: 'CONSUMED',
    commandFingerprint: fingerprint, approvalGeneration: generation,
  }, `verification-consumed:T023:${generation}:${fingerprint}`)
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

await test('approved exact command survives Brain transport, restart, and budget pause until execution', async () => {
  await withStorage(async (storageUrl) => {
    const approvals: Array<string | undefined> = []
    let calls = 0
    const runner = {
      async run(_task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        calls += 1
        approvals.push(context?.approvedVerificationCommand)
        if (calls === 1) return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
          pendingVerificationCommand: COMMAND,
          checkpoint: recoveryCheckpoint('T023'),
        }
        if (calls === 2) return {
          status: 'BRAIN_INFRASTRUCTURE_FAILED', brainFailure: BRAIN_FAILURE,
          checkpoint: recoveryCheckpoint('T023'),
        }
        return { status: 'PAUSED', checkpoint: recoveryCheckpoint('T023') }
      },
    }
    const sessionDefinition = {
      ...definition('approval-survives-recovery'), tasks: [{ id: 'T023', goal: 'migration' }],
    }
    const first = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    await first.start()
    const transportSuspended = await first.approvePendingVerificationAndContinue()
    assert.equal(transportSuspended.suspensionReason, 'BRAIN_INFRASTRUCTURE_FAILED')
    assert.equal(transportSuspended.pendingVerificationApproval?.status, 'APPROVED')
    assert.equal(transportSuspended.pendingVerificationApproval?.command, COMMAND)
    assert.equal(first.readExecutionLedger().some(
      (event) => event.eventType === 'VERIFICATION_APPROVAL_CONSUMED',
    ), false)
    await first.close()

    const restarted = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    const hydrated = await restarted.loadPersistedState()
    assert.equal(hydrated?.pendingVerificationApproval?.status, 'APPROVED')
    const paused = await restarted.resume({})
    assert.equal(paused.suspensionReason, 'USER_PAUSED')
    assert.equal(paused.pendingVerificationApproval?.status, 'APPROVED')
    assert.deepEqual(approvals, [undefined, COMMAND, COMMAND])
    const approvalEvents = restarted.readExecutionLedger().filter(
      (event) => event.eventType === 'VERIFICATION_APPROVAL_REQUESTED',
    )
    assert.equal(approvalEvents.length, 1, 'recovery must not request the same approval again')
    await restarted.close()
  })
})

await test('legacy premature CONSUMED is restored only from matching durable approval and checkpoint', async () => {
  await withStorage(async (storageUrl) => {
    const approvals: Array<string | undefined> = []
    let calls = 0
    const runner = {
      async run(_task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        calls += 1
        approvals.push(context?.approvedVerificationCommand)
        if (calls === 1) return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
          pendingVerificationCommand: COMMAND,
          checkpoint: recoveryCheckpoint('T023'),
        }
        if (calls === 2) return {
          status: 'BRAIN_INFRASTRUCTURE_FAILED', brainFailure: BRAIN_FAILURE,
          checkpoint: recoveryCheckpoint('T023'),
        }
        return { status: 'PAUSED', checkpoint: recoveryCheckpoint('T023') }
      },
    }
    const sessionDefinition = {
      ...definition('legacy-consumed-recovery'), tasks: [{ id: 'T023', goal: 'migration' }],
    }
    const first = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    await first.start()
    const suspended = await first.approvePendingVerificationAndContinue()
    const generation = suspended.pendingVerificationApproval?.generation
    assert.ok(generation)
    appendLegacyPrematureConsumption(first, generation)
    await removePendingApproval(first)
    await first.close()

    const restarted = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    assert.equal((await restarted.loadPersistedState())?.pendingVerificationApproval, undefined)
    const recovered = await restarted.resume({})
    assert.equal(recovered.pendingVerificationApproval?.status, 'APPROVED')
    assert.equal(recovered.pendingVerificationApproval?.generation, generation)
    assert.equal(recovered.pendingVerificationApproval?.command, COMMAND)
    assert.deepEqual(approvals, [undefined, COMMAND, COMMAND])
    assert.equal(restarted.readExecutionLedger().filter(
      (event) => event.eventType === 'VERIFICATION_APPROVAL_REQUESTED',
    ).length, 1)
    await restarted.close()
  })
})

await test('historical approval cannot authorize a changed command fingerprint', async () => {
  await withStorage(async (storageUrl) => {
    const changedCommand = 'cd apps/api/subdir && ../../../.venv/Scripts/python.exe -m alembic upgrade head'
    let calls = 0
    const approvals: Array<string | undefined> = []
    const runner = {
      async run(_task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        calls += 1
        approvals.push(context?.approvedVerificationCommand)
        if (calls === 1) return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
          pendingVerificationCommand: COMMAND,
          checkpoint: recoveryCheckpoint('T023'),
        }
        if (calls === 2) return {
          status: 'BRAIN_INFRASTRUCTURE_FAILED', brainFailure: BRAIN_FAILURE,
          checkpoint: recoveryCheckpoint('T023'),
        }
        return { status: 'PAUSED', checkpoint: recoveryCheckpoint('T023') }
      },
    }
    const sessionDefinition = {
      ...definition('historical-fingerprint-mismatch'), tasks: [{ id: 'T023', goal: 'migration' }],
    }
    const first = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    await first.start()
    await first.approvePendingVerificationAndContinue()
    await removePendingApproval(first)
    await replaceCheckpointVerificationCommand(first, changedCommand)
    await first.close()

    const restarted = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    const state = await restarted.resume({})
    assert.equal(state.pendingVerificationApproval, undefined)
    assert.deepEqual(approvals, [undefined, COMMAND, undefined])
    await restarted.close()
  })
})

await test('failed verifier result supersedes approval and remains durable without reapproval', async () => {
  await withStorage(async (storageUrl) => {
    let calls = 0
    const failedVerification = {
      name: COMMAND, status: 'failed' as const, exitCode: 1,
      details: 'migration verification failed',
    }
    const runner = {
      async run(_task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        calls += 1
        if (calls === 1) return {
          status: 'HUMAN_REQUIRED',
          humanRequired: { category: 'DECISION_REQUIRED', reason: `verification command requires human approval: ${COMMAND}` },
          pendingVerificationCommand: COMMAND,
          checkpoint: recoveryCheckpoint('T023'),
        }
        if (calls === 2) {
          assert.equal(context?.approvedVerificationCommand, COMMAND)
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: 'verification environment failed' },
            verificationFailure: failedVerification,
            checkpoint: recoveryCheckpoint('T023', [failedVerification]),
          }
        }
        assert.equal(context?.approvedVerificationCommand, undefined)
        return { status: 'PAUSED', checkpoint: recoveryCheckpoint('T023') }
      },
    }
    const sessionDefinition = {
      ...definition('failed-verification-evidence'), tasks: [{ id: 'T023', goal: 'migration' }],
    }
    const runtime = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    await runtime.start()
    const failed = await runtime.approvePendingVerificationAndContinue()
    assert.equal(failed.pendingVerificationApproval, undefined)
    assert.deepEqual(failed.verificationFailure, failedVerification)
    assert.deepEqual(failed.verificationResults, [failedVerification])
    assert.equal(runtime.readExecutionLedger().filter(
      (event) => event.eventType === 'VERIFICATION_APPROVAL_CONSUMED',
    ).length, 1)
    assert.equal(runtime.readExecutionLedger().filter(
      (event) => event.eventType === 'VERIFICATION_APPROVAL_REQUESTED',
    ).length, 1)
    await runtime.close()

    const restarted = new WorkSessionRuntime({ definition: sessionDefinition, storageUrl, taskRunner: runner })
    const hydrated = await restarted.loadPersistedState()
    assert.equal(hydrated?.pendingVerificationApproval, undefined)
    assert.deepEqual(hydrated?.verificationFailure, failedVerification)
    assert.deepEqual(hydrated?.verificationResults, [failedVerification])
    const resumed = await restarted.resume({})
    assert.equal(resumed.pendingVerificationApproval, undefined)
    await restarted.close()
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
        if (context?.approvedVerificationCommand === COMMAND) return {
          status: 'COMPLETED',
          completionEvidence: {
            changedFiles: [], blockers: [], finalReviewerVerdict: 'done',
            requiredVerification: [COMMAND],
            verificationResults: [{ name: COMMAND, status: 'passed' }],
          },
        }
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
