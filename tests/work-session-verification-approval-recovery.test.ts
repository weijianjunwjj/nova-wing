import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WorkSessionRuntime,
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

await test('verification approval is durable, exact, single-use, and advances the next task', async () => {
  await withStorage(async (storageUrl) => {
    let t016Calls = 0
    const runner = {
      async run(task: { id: string }, _resume?: unknown, _checkpoint?: unknown, context?: { approvedVerificationCommand?: string }): Promise<WorkSessionTaskResult> {
        if (task.id === 'T017') return { status: 'COMPLETED' }
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
    const completed = await restarted.approvePendingVerificationAndContinue()
    assert.equal(completed.state, 'COMPLETED')
    assert.equal(t016Calls, 2)
    assert.deepEqual(completed.completedTaskIds, ['T016', 'T017'])
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

await test('only the scoped Alembic upgrade-head verifier can become pending approval', async () => {
  await withStorage(async (storageUrl) => {
    const rejected = [
      'cd ../outside && ../../.venv/Scripts/python.exe -m alembic upgrade head',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head && git status',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head; rm -rf .',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head | cat',
      'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head > out',
      'git reset --hard', 'rm -rf .', 'python -c "print(1)"',
      'bash -c whoami', 'cmd /c whoami', 'powershell -Command whoami',
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
