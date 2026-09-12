import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  buildVerificationResult,
  classifyWorkSessionFailure,
  ExecutionLedgerStore,
  persistVerificationOutput,
  runGuardianTask,
  WorkSessionRuntime,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianTask,
  type GuardianTaskRecoveryCheckpoint,
  type VerificationResult,
  type WorkSessionDefinition,
} from 'nova-wing/development-guardian'

async function removeEventually(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 7) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

const SHARED_SETUP_OUTPUT = `
________________ ERROR at setup of test_database_000 _________________

@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    command.upgrade(config, "head")

Traceback (most recent call last):
  File "sqlalchemy/engine/base.py", line 146, in __init__
    self._dbapi_connection = engine.raw_connection()
E   psycopg2.OperationalError: connection to server at "127.0.0.1", port 5432 failed: Connection refused
E       Is the server running on that host and accepting TCP/IP connections?

=========================== short test summary info ===========================
ERROR tests/test_database.py::test_database_000
============================== 227 errors in 3.91s ==============================
`

function failedResult(output: string, rawOutputRef?: string): VerificationResult {
  return buildVerificationResult({
    command: '.venv/Scripts/python.exe -m pytest',
    result: { exitCode: 1, signal: null, stdout: output, stderr: '' },
    durationMs: 3_910,
    ...(rawOutputRef === undefined ? {} : { rawOutputRef }),
  })
}

test('CASE A/D: shared pytest setup fan-out collapses to one environment root cause', () => {
  const result = failedResult(SHARED_SETUP_OUTPUT, 'D:/safe/session/raw.log')
  assert.equal(result.classification, 'ENVIRONMENT_FAILURE')
  assert.equal(result.affectedTests, 227)
  assert.equal(result.rootCauseCount, 1)
  assert.equal(result.firstFailure?.exceptionType, 'psycopg2.OperationalError')
  assert.equal(result.firstFailure?.phase, 'setup/session fixture')
  assert.match(result.firstFailure?.tracebackSnippet ?? '', /127\.0\.0\.1/u)
  assert.match(result.firstFailure?.tracebackSnippet ?? '', /Connection refused/iu)
  assert.equal(result.rawOutputRef, 'D:/safe/session/raw.log')
  assert.match(result.finalSummary ?? '', /227 errors/iu)
})

test('CASE B/C: assertions and migration code defects remain code verification failures', () => {
  const assertion = failedResult(`
_________________________ test_total _________________________
E   AssertionError: expected 2, got 1
============================== 1 failed in 0.12s ==============================
`)
  assert.equal(assertion.classification, 'CODE_FAILURE')
  assert.equal(assertion.firstFailure?.phase, 'test')

  const migrationNameError = failedResult(`
________________ ERROR at setup of test_database _________________
  File "migrations/versions/bad_revision.py", line 21, in upgrade
    missing_identifier()
E   NameError: name 'missing_identifier' is not defined
============================== 1 error in 0.20s ==============================
`)
  assert.equal(migrationNameError.classification, 'CODE_FAILURE')

  const sqlCodeError = failedResult(`
________________ ERROR at setup of test_database _________________
  File "alembic/runtime/migration.py", line 627, in run_migrations
E   sqlalchemy.exc.OperationalError: syntax error at or near "BROKEN"
============================== 1 error in 0.20s ==============================
`)
  assert.equal(sqlCodeError.classification, 'CODE_FAILURE')

  const missingVenvOnly = failedResult(
    'bash: .venv/Scripts/python.exe: No such file or directory',
  )
  assert.equal(missingVenvOnly.classification, 'VERIFIER_CONFIGURATION_FAILURE')
})

test('raw verification output is durable, complete and redacted outside the repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-verification-artifact-'))
  try {
    const rawOutputRef = await persistVerificationOutput({
      directory,
      taskId: 'T-env',
      iteration: 1,
      index: 0,
      command: '.venv/Scripts/python.exe -m pytest',
      result: {
        exitCode: 1,
        signal: null,
        stdout: `${SHARED_SETUP_OUTPUT}\npassword=hunter2\ncookie: session-cookie`,
        stderr: 'Authorization: Bearer abc.def.ghi',
      },
    })
    assert.ok(rawOutputRef)
    const stored = await readFile(rawOutputRef, 'utf8')
    assert.match(stored, /227 errors/iu)
    assert.match(stored, /password=\[REDACTED\]/iu)
    assert.match(stored, /cookie=\[REDACTED\]/iu)
    assert.doesNotMatch(stored, /hunter2|session-cookie|abc\.def\.ghi/u)
  } finally {
    await removeEventually(directory)
  }
})

test('verification evidence is durable in the Execution Ledger without the traceback body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-verification-ledger-'))
  const storageUrl = pathToFileURL(join(directory, 'session.db')).href
  try {
    const ledger = new ExecutionLedgerStore(storageUrl)
    ledger.append({
      eventType: 'PHASE_FAILED', sessionId: 'S-env', taskId: 'T-env',
      timestamp: '2026-08-28T00:00:00.000Z', phase: 'VERIFYING', status: 'failed',
      iteration: 1, verificationCommand: '.venv/Scripts/python.exe -m pytest',
      verificationStatus: 'failed', verificationIndex: 1,
      verificationClassification: 'ENVIRONMENT_REQUIRED',
      rawOutputRef: join(directory, 'raw.log'),
      firstFailureTitle: 'psycopg2.OperationalError: Connection refused',
      exceptionType: 'psycopg2.OperationalError', failurePhase: 'setup/session fixture',
      finalSummary: '227 errors in 3.91s', rootCauseCount: 1, affectedTests: 227,
    }, 'verification:T-env:1:1:failed')
    ledger.close()

    const reopened = new ExecutionLedgerStore(storageUrl)
    const event = reopened.read('S-env')[0]
    reopened.close()
    assert.equal(event?.eventType, 'PHASE_FAILED')
    if (event?.eventType !== 'PHASE_FAILED') throw new Error('missing verification failure event')
    assert.equal(event.verificationClassification, 'ENVIRONMENT_REQUIRED')
    assert.equal(event.rawOutputRef, join(directory, 'raw.log'))
    assert.equal(event.rootCauseCount, 1)
    assert.equal(event.affectedTests, 227)
    assert.equal('tracebackSnippet' in (event ?? {}), false)
  } finally {
    await removeEventually(directory)
  }
})

function packet(verdict: 'proceed' | 'done'): DelegationPacket {
  return {
    verdict,
    goal: 'verify database-backed code',
    instructions: verdict === 'proceed' ? ['implement the requested change'] : [],
    constraints: [],
    verification: ['.venv/Scripts/python.exe -m pytest'],
    doNotDo: [],
  }
}

function report(verificationResult: VerificationResult): ExecutionReport {
  return {
    summary: 'Executor completed the code change.',
    changedFiles: ['src/example.py'],
    commandsRun: ['claude -p --output-format json', verificationResult.name],
    verificationResults: [verificationResult],
    blockers: [],
    ...(verificationResult.rawOutputRef === undefined
      ? {}
      : { rawOutputRef: verificationResult.rawOutputRef }),
  }
}

test('CASE A/G: environment failure bypasses Reviewer revise and resume invokes verification only', async () => {
  let initialBrainCalls = 0
  let initialExecutorCalls = 0
  const first = await runGuardianTask({
    task: { id: 'T-env', goal: 'verify', state: 'READY', iteration: 0, maxIterations: 3 },
    brain: { async review() { initialBrainCalls++; return packet('proceed') } },
    executor: {
      async execute() {
        initialExecutorCalls++
        return report(failedResult(SHARED_SETUP_OUTPUT, 'D:/safe/session/raw.log'))
      },
    },
  })
  assert.equal(first.task.state, 'HUMAN_REQUIRED')
  assert.equal(initialBrainCalls, 1, 'Reviewer must not be asked to revise an environment failure')
  assert.equal(initialExecutorCalls, 1)

  let finalReviewCalls = 0
  let resumedExecutorCalls = 0
  let verificationRetryCalls = 0
  const resumedTask: GuardianTask = {
    ...first.task,
    recoveryContinuation: true,
    resumeInput: { approval: true },
  }
  const resumed = await runGuardianTask({
    task: resumedTask,
    brain: { async review() { finalReviewCalls++; return packet('done') } },
    executor: {
      async execute() {
        resumedExecutorCalls++
        throw new Error('Executor must not run during environment recovery')
      },
      async retryVerification({ report: previous }) {
        verificationRetryCalls++
        return {
          ...previous,
          verificationResults: previous.verificationResults.map((item) => ({
            name: item.name,
            status: 'passed' as const,
            exitCode: 0,
            durationMs: 100,
            finalSummary: '1 passed in 0.10s',
          })),
        }
      },
    },
  })
  assert.equal(resumed.task.state, 'COMPLETED')
  assert.equal(verificationRetryCalls, 1)
  assert.equal(resumedExecutorCalls, 0)
  assert.equal(finalReviewCalls, 1, 'successful retry proceeds directly to final review')
})

function definition(id: string, repo: string): WorkSessionDefinition {
  return {
    id,
    targetRepo: repo,
    branch: 'feat/test',
    tasks: [{ id: 'T-env', goal: 'verify' }],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
  }
}

function checkpoint(repo: string, verificationFailure: VerificationResult): GuardianTaskRecoveryCheckpoint {
  return {
    version: 1,
    task: {
      id: 'T-env', goal: 'verify', state: 'HUMAN_REQUIRED', iteration: 1, maxIterations: 3,
      stopReason: 'VERIFICATION_ENVIRONMENT_REQUIRED',
      lastPacket: packet('proceed'),
      lastReport: report(verificationFailure),
    },
    provider: { claudeSessionId: 'already-completed-executor' },
    repo: {
      repoPath: repo, branch: 'feat/test', headSha: 'a'.repeat(40),
      changedFiles: ['src/example.py'], worktreeFingerprint: 'b'.repeat(64),
    },
    capturedAt: new Date().toISOString(),
  }
}

test('CASE F: environment evidence and raw output reference survive runtime recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-verification-restart-'))
  const storageUrl = pathToFileURL(join(directory, 'session.db')).href
  const verificationFailure = failedResult(SHARED_SETUP_OUTPUT, join(directory, 'raw.log'))
  const savedCheckpoint = checkpoint(directory, verificationFailure)
  const sessionDefinition = definition('verification-restart', directory)
  const runtime1 = new WorkSessionRuntime({
    definition: sessionDefinition,
    storageUrl,
    taskRunner: {
      async run() {
        return {
          status: 'HUMAN_REQUIRED' as const,
          humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: 'database unavailable' },
          verificationFailure,
          checkpoint: savedCheckpoint,
        }
      },
    },
  })
  try {
    const suspended = await runtime1.start()
    assert.equal(suspended.state, 'SUSPENDED')
    await runtime1.close()

    const runtime2 = new WorkSessionRuntime({
      definition: sessionDefinition,
      storageUrl,
      taskRunner: { async run() { throw new Error('hydration must not execute work') } },
    })
    try {
      const restored = await runtime2.loadPersistedState()
      assert.equal(restored?.state, 'SUSPENDED')
      assert.equal(restored?.verificationFailure?.classification, 'ENVIRONMENT_FAILURE')
      assert.equal(restored?.verificationFailure?.rawOutputRef, join(directory, 'raw.log'))
      assert.equal(restored?.currentTaskCheckpoint?.task.lastReport?.verificationResults[0]?.affectedTests, 227)
    } finally {
      await runtime2.close()
    }
  } finally {
    await removeEventually(directory)
  }
})

test('CASE H: direct repeated resume starts only one retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-verification-idempotency-'))
  const runtime = new WorkSessionRuntime({
    definition: definition('verification-idempotency', directory),
    storageUrl: pathToFileURL(join(directory, 'session.db')).href,
    taskRunner: {
      async run(_task, resumeData) {
        if (resumeData?.approval !== true) {
          return {
            status: 'HUMAN_REQUIRED' as const,
            humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: 'database unavailable' },
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { status: 'COMPLETED' as const, summary: 'verified' }
      },
    },
  })
  try {
    await runtime.start()
    const firstResume = runtime.resume({ approval: true })
    await assert.rejects(runtime.resume({ approval: true }), /already in progress/u)
    const completed = await firstResume
    assert.equal(completed.state, 'COMPLETED')
  } finally {
    await runtime.close()
    await removeEventually(directory)
  }
})

test('CASE E: credential/scope words in free text do not create permission or drift categories', () => {
  const noisy = 'AssertionError: docs mention forbidden_paths allowed_paths permission and worktree'
  const classified = classifyWorkSessionFailure(noisy, { failureStage: 'VERIFICATION' })
  assert.equal(classified.failureCategory, 'VERIFICATION_FAILED')
})
