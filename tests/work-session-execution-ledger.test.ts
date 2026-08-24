import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import {
  ExecutionLedgerStore,
  GuardianWorkSessionTaskRunner,
  GitCheckpointError,
  GitPushError,
  SmtpWorkSessionNotifier,
  WorkSessionRuntime,
  executionLedgerPathFromStorageUrl,
  readExecutionLedger,
  classifyWorkSessionFailure,
  safeFailureMessage,
  type ExecutionLedgerEvent,
  type TaskCompletionEvidence,
  type WorkSessionDefinition,
  type WorkSessionFailedNotification,
  type WorkSessionNotifier,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { createWorkSessionFailedNotification } from '../packages/development-guardian/work-session/notifier.js'
import { renderFailedNotificationText } from '../packages/development-guardian/work-session/smtp-notifier.js'
import { renderHtml } from '../packages/development-guardian/work-session/control-ui/view.js'

const SECRET_INPUT = [
  'git push failed',
  'Authorization: Bearer SECRET_TOKEN',
  'api_key=SECRET_KEY',
  'password=SECRET_PASSWORD',
  'cookie=SECRET_COOKIE',
  '{"provider":"raw","token":"PROVIDER_SECRET"}',
].join('\n')

type PhaseLedgerEvent = Extract<ExecutionLedgerEvent, {
  eventType: 'PHASE_STARTED' | 'PHASE_COMPLETED' | 'PHASE_FAILED'
}>

function definition(id: string, repoPath = process.cwd()): WorkSessionDefinition {
  return {
    id,
    targetRepo: repoPath,
    branch: 'feat/test',
    tasks: [{ id: 'T009', goal: 'complete verified task then push' }],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
  }
}

function completionEvidence(): TaskCompletionEvidence {
  return {
    changedFiles: ['src/t009.ts'],
    verificationResults: [{ name: 'npm test', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['npm test'],
  }
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: repoPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
    })
  })
}

async function setupRepo(root: string): Promise<string> {
  const repoPath = join(root, 'repo')
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await git(repoPath, ['init'])
  await git(repoPath, ['config', 'user.email', 'test@example.com'])
  await git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'README.md'), '# baseline\n')
  await git(repoPath, ['add', 'README.md'])
  await git(repoPath, ['commit', '-m', 'initial'])
  await git(repoPath, ['checkout', '-b', 'feat/test'])
  return repoPath
}

async function withTemp(
  name: string,
  run: (input: { root: string; storageUrl: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), name))
  try {
    await run({ root, storageUrl: pathToFileURL(join(root, 'session.db')).href })
  } finally {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
  }
}

function deleteFailedNotificationLedgerEvents(
  storageUrl: string,
  eventType: 'NOTIFICATION_SENT' | 'NOTIFICATION_FAILED',
): void {
  const database = new DatabaseSync(executionLedgerPathFromStorageUrl(storageUrl))
  try {
    database.prepare(`
      DELETE FROM execution_ledger_events
      WHERE event_type = ? AND notification_kind = 'FAILED'
    `).run(eventType)
  } finally {
    database.close()
  }
}

class FailedNotifier implements WorkSessionNotifier {
  attempts = 0
  failuresRemaining = 0
  readonly notifications: WorkSessionFailedNotification[] = []

  async notifyHumanRequired(): Promise<void> {}

  async notifyFailed(notification: WorkSessionFailedNotification): Promise<void> {
    this.attempts++
    this.notifications.push(notification)
    if (this.failuresRemaining-- > 0) throw new Error('SMTP password=SMTP_SECRET')
  }
}

await test('failure classification prefers structured Git types and stable phase categories', () => {
  assert.deepEqual(classifyWorkSessionFailure(new GitPushError('push rejected', 'abc')), {
    failureStage: 'GIT_PUSH', failureCategory: 'GIT_PUSH_FAILED', safeMessage: 'push rejected',
  })
  assert.deepEqual(classifyWorkSessionFailure(new GitCheckpointError('commit rejected')), {
    failureStage: 'GIT_COMMIT', failureCategory: 'GIT_COMMIT_FAILED', safeMessage: 'commit rejected',
  })
  assert.equal(classifyWorkSessionFailure('deterministic verification failed').failureCategory, 'VERIFICATION_FAILED')
  assert.equal(classifyWorkSessionFailure('REPO_DRIFT: HEAD changed').failureCategory, 'REPO_DRIFT')
  assert.equal(classifyWorkSessionFailure('Reviewer protocol malformed').failureStage, 'REVIEWER')
  assert.equal(classifyWorkSessionFailure('Reviewer protocol malformed').failureCategory, 'PROTOCOL')
})

await test('Execution Ledger is append-only, ordered, restart durable and dedupes stable facts', async () => {
  await withTemp('ledger-order-', async ({ storageUrl }) => {
    const ledger = new ExecutionLedgerStore(storageUrl)
    const first = ledger.append({
      eventType: 'SESSION_STARTED', sessionId: 'S1', taskId: null,
      timestamp: '2026-08-24T00:00:00.000Z', status: 'RUNNING',
    }, 'session-started')
    const duplicate = ledger.append({
      eventType: 'SESSION_STARTED', sessionId: 'S1', taskId: null,
      timestamp: '2026-08-24T00:00:01.000Z', status: 'RUNNING',
    }, 'session-started')
    const second = ledger.append({
      eventType: 'TASK_STARTED', sessionId: 'S1', taskId: 'T1',
      timestamp: '2026-08-24T00:00:02.000Z', status: 'RUNNING',
    }, 'task-started:T1')
    assert.equal(duplicate.eventId, first.eventId)
    assert.ok(second.eventId > first.eventId)
    assert.deepEqual(ledger.read('S1').map((event) => event.eventId), [first.eventId, second.eventId])
    ledger.close()

    const afterRestart = readExecutionLedger(storageUrl, 'S1')
    assert.deepEqual(afterRestart.map((event) => event.eventType), ['SESSION_STARTED', 'TASK_STARTED'])
    assert.deepEqual(afterRestart.map((event) => event.eventId), [first.eventId, second.eventId])
  })
})

await test('Execution Ledger v1 migration reclassifies phase duration as cumulative elapsed', async () => {
  await withTemp('ledger-v1-migration-', async ({ storageUrl }) => {
    const databasePath = executionLedgerPathFromStorageUrl(storageUrl)
    const v1 = new DatabaseSync(databasePath)
    v1.exec(`
      CREATE TABLE execution_ledger_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        task_id TEXT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT,
        phase TEXT,
        iteration INTEGER,
        duration_ms INTEGER,
        active_elapsed_ms INTEGER,
        commit_sha TEXT,
        push_sha TEXT,
        completion_reason TEXT,
        failure_stage TEXT,
        failure_category TEXT,
        safe_message TEXT,
        notification_kind TEXT,
        notification_id TEXT,
        UNIQUE(session_id, dedupe_key)
      ) STRICT;
      CREATE INDEX execution_ledger_session_order
      ON execution_ledger_events(session_id, event_id);
      INSERT INTO execution_ledger_events (
        event_id, schema_version, session_id, dedupe_key, task_id, timestamp,
        event_type, status
      ) VALUES (
        7, 1, 'v1-migration', 'session-started', NULL,
        '2026-08-24T00:00:00.000Z', 'SESSION_STARTED', 'RUNNING'
      );
      INSERT INTO execution_ledger_events (
        event_id, schema_version, session_id, dedupe_key, task_id, timestamp,
        event_type, status, phase, iteration, duration_ms, active_elapsed_ms
      ) VALUES (
        11, 1, 'v1-migration', 'phase-completed', 'T009',
        '2026-08-24T00:00:48.233Z', 'PHASE_COMPLETED', 'completed',
        'VERIFYING', 2, 48233, 48000
      )
    `)
    v1.close()

    const ledger = new ExecutionLedgerStore(storageUrl)
    const migrated = ledger.read('v1-migration')
    assert.deepEqual(migrated.map((event) => event.eventId), [7, 11])
    assert.deepEqual(migrated.map((event) => event.schemaVersion), [2, 2])
    const phase = migrated[1]
    assert.equal(phase?.eventType, 'PHASE_COMPLETED')
    if (phase?.eventType === 'PHASE_COMPLETED') {
      assert.equal(phase.cumulativeElapsedMs, 48_233)
      assert.equal(phase.durationMs, undefined)
      assert.equal(phase.activeElapsedMs, 48_000)
      assert.equal(phase.verificationCommand, undefined)
      assert.equal(phase.verificationStatus, undefined)
      assert.equal(phase.verificationIndex, undefined)
      assert.equal(phase.recoveryReason, undefined)
      assert.equal(phase.recoveryBounded, undefined)
    }
    ledger.close()

    const afterRestart = readExecutionLedger(storageUrl, 'v1-migration')
    assert.deepEqual(afterRestart, migrated)
  })
})

await test('Execution Ledger preserves fractional cumulative elapsed and real duration across restart', async () => {
  await withTemp('ledger-fractional-', async ({ storageUrl }) => {
    const ledger = new ExecutionLedgerStore(storageUrl)
    ledger.append({
      eventType: 'PHASE_COMPLETED', sessionId: 'fractional', taskId: 'T009',
      timestamp: '2026-08-24T00:00:00.000Z', phase: 'VERIFYING',
      status: 'completed', iteration: 1, cumulativeElapsedMs: 48_233.37,
      durationMs: 0.44, activeElapsedMs: 48_233.37,
      verificationCommand: 'npm test', verificationStatus: 'passed', verificationIndex: 0,
    }, 'verification:T009:1:0:passed')
    ledger.close()

    const [event] = readExecutionLedger(storageUrl, 'fractional')
    assert.equal(event?.eventType, 'PHASE_COMPLETED')
    if (event?.eventType === 'PHASE_COMPLETED') {
      assert.equal(event.cumulativeElapsedMs, 48_233.37)
      assert.equal(event.durationMs, 0.44)
      assert.equal(event.activeElapsedMs, 48_233.37)
    }
  })
})

await test('runtime records session, task, Guardian phase and completion facts', async () => {
  await withTemp('ledger-runtime-', async ({ storageUrl }) => {
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-runtime'),
      storageUrl,
      taskRunner: {
        async run(_task, _resume, _checkpoint, context): Promise<WorkSessionTaskResult> {
          context?.onProgress?.({
            phase: 'REVIEWING', status: 'active', iteration: 0, elapsedMs: 10,
            detail: SECRET_INPUT,
          })
          context?.onProgress?.({
            phase: 'REVIEWING', status: 'completed', iteration: 0, elapsedMs: 25,
            detail: SECRET_INPUT,
          })
          return { status: 'COMPLETED' }
        },
      },
    })
    assert.equal((await runtime.start()).state, 'COMPLETED')
    const events = runtime.readExecutionLedger()
    assert.deepEqual(events.map((event) => event.eventType), [
      'SESSION_STARTED', 'TASK_STARTED', 'PHASE_STARTED', 'PHASE_COMPLETED',
      'TASK_COMPLETED', 'SESSION_COMPLETED',
    ])
    const phaseStarted = events.find((event) => event.eventType === 'PHASE_STARTED')
    assert.equal(phaseStarted?.eventType, 'PHASE_STARTED')
    if (phaseStarted?.eventType === 'PHASE_STARTED') {
      assert.equal(phaseStarted.iteration, 0)
      assert.equal(phaseStarted.cumulativeElapsedMs, 10)
      assert.equal(phaseStarted.durationMs, undefined)
    }
    const phaseCompleted = events.find((event) => event.eventType === 'PHASE_COMPLETED')
    assert.equal(phaseCompleted?.eventType, 'PHASE_COMPLETED')
    if (phaseCompleted?.eventType === 'PHASE_COMPLETED') {
      assert.equal(phaseCompleted.cumulativeElapsedMs, 25)
      assert.equal(phaseCompleted.durationMs, undefined)
    }
    assert.doesNotMatch(JSON.stringify(events), /SECRET_TOKEN|PROVIDER_SECRET/u)
    await runtime.close()
  })
})

await test('same-iteration verification commands and recovery remain independent durable facts', async () => {
  await withTemp('ledger-verification-facts-', async ({ storageUrl }) => {
    const commands = ['npm run typecheck', 'npm test', 'npm run build'] as const
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-verification-facts'),
      storageUrl,
      taskRunner: {
        async run(_task, _resume, _checkpoint, context): Promise<WorkSessionTaskResult> {
          const statuses = ['passed', 'failed', 'passed'] as const
          commands.forEach((command, index) => context?.onProgress?.({
            phase: 'VERIFYING',
            status: statuses[index] === 'failed' ? 'failed' : 'completed',
            iteration: 1,
            elapsedMs: 48_233.37,
            verification: {
              command,
              status: statuses[index]!,
              index,
              durationMs: 0.44 + index,
            },
          }))
          context?.onProgress?.({
            phase: 'RECOVERING', status: 'active', iteration: 1, elapsedMs: 48_233.37,
            recovery: { reason: 'max_turns', sessionId: 'provider-session', bounded: true },
          })
          return {
            status: 'FAILED', error: 'verification command failed',
            failureStage: 'VERIFICATION', failureCategory: 'VERIFICATION_FAILED',
          }
        },
      },
    })

    await assert.rejects(runtime.start(), /verification command failed/u)
    const verificationEvents = runtime.readExecutionLedger().filter((event): event is PhaseLedgerEvent =>
      (event.eventType === 'PHASE_COMPLETED' || event.eventType === 'PHASE_FAILED') &&
      event.phase === 'VERIFYING',
    )
    assert.equal(verificationEvents.length, 3)
    assert.deepEqual(verificationEvents.map((event) => ({
      command: event.verificationCommand,
      status: event.verificationStatus,
      durationMs: event.durationMs,
      index: event.verificationIndex,
    })), [
      { command: commands[0], status: 'passed', durationMs: 0.44, index: 0 },
      { command: commands[1], status: 'failed', durationMs: 1.44, index: 1 },
      { command: commands[2], status: 'passed', durationMs: 2.44, index: 2 },
    ])
    assert.equal(verificationEvents.filter((event) => event.verificationStatus === 'failed').length, 1)
    const recovery = runtime.readExecutionLedger().find((event) =>
      event.eventType === 'PHASE_STARTED' && event.phase === 'RECOVERING')
    assert.equal(recovery?.eventType, 'PHASE_STARTED')
    if (recovery?.eventType === 'PHASE_STARTED') {
      assert.equal(recovery.recoveryReason, 'max_turns')
      assert.equal(recovery.recoveryBounded, true)
    }
    await runtime.close()

    assert.equal(readExecutionLedger(storageUrl, 'ledger-verification-facts').filter((event) =>
      (event.eventType === 'PHASE_COMPLETED' || event.eventType === 'PHASE_FAILED') &&
      event.phase === 'VERIFYING').length, 3)
  })
})

await test('generic executor errors retain the structured EXECUTOR failure boundary', async () => {
  await withTemp('ledger-executor-stage-', async ({ storageUrl }) => {
    const runner = new GuardianWorkSessionTaskRunner({
      brain: {
        async review({ task }) {
          return {
            verdict: 'proceed', goal: task.goal, instructions: ['execute'],
            constraints: [], verification: [], doNotDo: [],
          }
        },
      },
      createExecutor() {
        return { async execute() { throw new Error('spawn EACCES') } }
      },
    })
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-executor-stage'), storageUrl, taskRunner: runner,
    })
    await assert.rejects(runtime.start(), /spawn EACCES/u)
    assert.equal(runtime.getDurableState()?.failureStage, 'EXECUTOR')
    const failed = runtime.readExecutionLedger().find((event) => event.eventType === 'SESSION_FAILED')
    assert.equal(failed?.failureStage, 'EXECUTOR')
    await runtime.close()
  })
})

await test('successful Git finalization records real commit and push facts', async () => {
  await withTemp('ledger-git-success-', async ({ root, storageUrl }) => {
    const repoPath = await setupRepo(root)
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-git-success', repoPath),
      storageUrl,
      taskRunner: { async run() { return { status: 'COMPLETED' as const, completionEvidence: completionEvidence() } } },
      gitCheckpoint: {
        policy: {
          autoCommit: true,
          autoPush: true,
          pushRemote: { name: 'origin', expectedUrl: 'https://example.invalid/repo.git' },
        },
        async finalizer() {
          return { commitSha: 'commit-sha-009', pushSha: 'push-sha-009', committedFiles: ['src/t009.ts'] }
        },
      },
    })
    assert.equal((await runtime.start()).state, 'COMPLETED')
    const events = runtime.readExecutionLedger()
    assert.equal(events.find((event) => event.eventType === 'GIT_COMMIT_COMPLETED')?.commitSha, 'commit-sha-009')
    assert.equal(events.find((event) => event.eventType === 'GIT_PUSH_COMPLETED')?.pushSha, 'push-sha-009')
    await runtime.close()
  })
})

await test('T009 commit success + push failure stays FAILED, notifies with one retry, and restart dedupes', async () => {
  await withTemp('ledger-t009-', async ({ root, storageUrl }) => {
    const repoPath = await setupRepo(root)
    const notifier = new FailedNotifier()
    notifier.failuresRemaining = 1
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-t009', repoPath),
      storageUrl,
      notifier,
      notificationRetryDelayMs: 0,
      localControlUrl: () => 'http://127.0.0.1:43123',
      taskRunner: { async run() { return { status: 'COMPLETED' as const, completionEvidence: completionEvidence() } } },
      gitCheckpoint: {
        policy: {
          autoCommit: true,
          autoPush: true,
          pushRemote: { name: 'origin', expectedUrl: 'https://example.invalid/repo.git' },
        },
        async finalizer() {
          throw new GitPushError(SECRET_INPUT, 'local-commit-sha-009')
        },
      },
    })

    await assert.rejects(runtime.start(), /Git checkpoint failed/u)
    await runtime.getNotificationPromise()
    const state = runtime.getDurableState()
    assert.equal(state?.state, 'FAILED')
    assert.equal(state?.checkpointCommits?.T009, 'local-commit-sha-009')
    assert.equal(state?.checkpointPushes?.T009, undefined)
    assert.equal(state?.failureStage, 'GIT_PUSH')
    assert.equal(state?.failureCategory, 'GIT_PUSH_FAILED')
    assert.equal(state?.failureNotificationAttempted, true)
    assert.equal(state?.failureNotified, true)
    assert.equal(notifier.attempts, 2)

    const events = runtime.readExecutionLedger()
    assert.ok(events.some((event) => event.eventType === 'GIT_COMMIT_COMPLETED'))
    assert.ok(!events.some((event) => event.eventType === 'GIT_PUSH_COMPLETED'))
    const failed = events.find((event) => event.eventType === 'SESSION_FAILED')
    assert.equal(failed?.failureStage, 'GIT_PUSH')
    assert.equal(failed?.failureCategory, 'GIT_PUSH_FAILED')
    assert.equal(failed?.commitSha, 'local-commit-sha-009')
    assert.match(failed?.safeMessage ?? '', /git push failed/u)
    assert.ok(events.some((event) =>
      event.eventType === 'NOTIFICATION_SENT' && event.notificationKind === 'FAILED'))
    assert.doesNotMatch(JSON.stringify(events), /SECRET_TOKEN|SECRET_KEY|SECRET_PASSWORD|SECRET_COOKIE|PROVIDER_SECRET/u)
    assert.doesNotMatch(JSON.stringify(notifier.notifications), /SECRET_TOKEN|SECRET_KEY|SECRET_PASSWORD|SECRET_COOKIE|PROVIDER_SECRET/u)
    await runtime.close()

    const restarted = new WorkSessionRuntime({
      definition: definition('ledger-t009', repoPath), storageUrl, notifier,
      notificationRetryDelayMs: 0,
      taskRunner: { async run() { throw new Error('must not run') } },
    })
    assert.equal((await restarted.loadPersistedState())?.state, 'FAILED')
    assert.equal(notifier.attempts, 2, 'hydrate must not send a third FAILED email')
    assert.deepEqual(
      restarted.readExecutionLedger().map((event) => event.eventId),
      events.map((event) => event.eventId),
    )
    await restarted.close()
  })
})

await test('two FAILED notification delivery failures do not mutate terminal state and are ledger-visible', async () => {
  await withTemp('ledger-notify-failed-', async ({ storageUrl }) => {
    const notifier = new FailedNotifier()
    notifier.failuresRemaining = 2
    const runtime = new WorkSessionRuntime({
      definition: definition('ledger-notify-failed'), storageUrl, notifier,
      notificationRetryDelayMs: 0,
      taskRunner: {
        async run() {
          return {
            status: 'FAILED' as const,
            error: SECRET_INPUT,
            failureStage: 'EXECUTOR' as const,
            failureCategory: 'PROVIDER_ERROR' as const,
          }
        },
      },
    })
    await assert.rejects(runtime.start(), /Task T009 failed/u)
    await runtime.getNotificationPromise()
    assert.equal(notifier.attempts, 2)
    assert.equal(runtime.getDurableState()?.state, 'FAILED')
    assert.equal(runtime.getDurableState()?.failureNotificationAttempted, true)
    assert.notEqual(runtime.getDurableState()?.failureNotified, true)
    assert.ok(runtime.readExecutionLedger().some((event) =>
      event.eventType === 'NOTIFICATION_FAILED' && event.notificationKind === 'FAILED'))
    await runtime.close()
  })
})

await test('durable FAILED notification success remains authoritative when its Ledger write is lost', async () => {
  await withTemp('ledger-notify-durable-sent-', async ({ storageUrl }) => {
    const firstNotifier = new FailedNotifier()
    const firstProcess = new WorkSessionRuntime({
      definition: definition('ledger-notify-durable-sent'), storageUrl,
      notifier: firstNotifier,
      notificationRetryDelayMs: 0,
      taskRunner: {
        async run() {
          return {
            status: 'FAILED' as const,
            error: 'executor failed',
            failureStage: 'EXECUTOR' as const,
            failureCategory: 'PROVIDER_ERROR' as const,
          }
        },
      },
    })
    await assert.rejects(firstProcess.start(), /Task T009 failed/u)
    await firstProcess.getNotificationPromise()
    assert.equal(firstNotifier.attempts, 1)
    assert.equal(firstProcess.getDurableState()?.failureNotified, true)
    await firstProcess.close()

    deleteFailedNotificationLedgerEvents(storageUrl, 'NOTIFICATION_SENT')
    assert.ok(!readExecutionLedger(storageUrl, 'ledger-notify-durable-sent').some((event) =>
      event.eventType === 'NOTIFICATION_SENT' && event.notificationKind === 'FAILED'))

    const restartNotifier = new FailedNotifier()
    const restarted = new WorkSessionRuntime({
      definition: definition('ledger-notify-durable-sent'), storageUrl,
      notifier: restartNotifier,
      notificationRetryDelayMs: 0,
      taskRunner: { async run() { throw new Error('persisted FAILED must not execute task') } },
    })
    assert.equal((await restarted.loadPersistedState())?.failureNotified, true)
    await restarted.getNotificationPromise()
    assert.equal(restartNotifier.attempts, 0)
    await restarted.close()
  })
})

await test('attempted-only FAILED state without a Ledger delivery fact retries once after restart', async () => {
  await withTemp('ledger-notify-old-preclaim-', async ({ storageUrl }) => {
    const failedNotifier = new FailedNotifier()
    failedNotifier.failuresRemaining = 2
    const firstProcess = new WorkSessionRuntime({
      definition: definition('ledger-notify-old-preclaim'), storageUrl,
      notifier: failedNotifier,
      notificationRetryDelayMs: 0,
      taskRunner: {
        async run() {
          return {
            status: 'FAILED' as const,
            error: 'executor failed',
            failureStage: 'EXECUTOR' as const,
            failureCategory: 'PROVIDER_ERROR' as const,
          }
        },
      },
    })
    await assert.rejects(firstProcess.start(), /Task T009 failed/u)
    await firstProcess.getNotificationPromise()
    assert.equal(firstProcess.getDurableState()?.failureNotificationAttempted, true)
    assert.notEqual(firstProcess.getDurableState()?.failureNotified, true)
    await firstProcess.close()

    deleteFailedNotificationLedgerEvents(storageUrl, 'NOTIFICATION_FAILED')
    const restartNotifier = new FailedNotifier()
    const restarted = new WorkSessionRuntime({
      definition: definition('ledger-notify-old-preclaim'), storageUrl,
      notifier: restartNotifier,
      notificationRetryDelayMs: 0,
      taskRunner: { async run() { throw new Error('persisted FAILED must not execute task') } },
    })
    assert.equal((await restarted.loadPersistedState())?.state, 'FAILED')
    await restarted.getNotificationPromise()
    assert.equal(restartNotifier.attempts, 1)
    assert.equal(restarted.getDurableState()?.failureNotified, true)
    await restarted.close()
  })
})

await test('FAILED Ledger delivery failure prevents unbounded notification retries on restart', async () => {
  await withTemp('ledger-notify-failed-restart-', async ({ storageUrl }) => {
    const failedNotifier = new FailedNotifier()
    failedNotifier.failuresRemaining = 2
    const firstProcess = new WorkSessionRuntime({
      definition: definition('ledger-notify-failed-restart'), storageUrl,
      notifier: failedNotifier,
      notificationRetryDelayMs: 0,
      taskRunner: {
        async run() {
          return {
            status: 'FAILED' as const,
            error: 'executor failed',
            failureStage: 'EXECUTOR' as const,
            failureCategory: 'PROVIDER_ERROR' as const,
          }
        },
      },
    })
    await assert.rejects(firstProcess.start(), /Task T009 failed/u)
    await firstProcess.getNotificationPromise()
    assert.equal(failedNotifier.attempts, 2)
    await firstProcess.close()

    const restartNotifier = new FailedNotifier()
    for (let restart = 0; restart < 2; restart++) {
      const restarted = new WorkSessionRuntime({
        definition: definition('ledger-notify-failed-restart'), storageUrl,
        notifier: restartNotifier,
        notificationRetryDelayMs: 0,
        taskRunner: { async run() { throw new Error('persisted FAILED must not execute task') } },
      })
      const hydrated = await restarted.loadPersistedState()
      assert.equal(hydrated?.failureNotificationAttempted, true)
      assert.notEqual(hydrated?.failureNotified, true)
      await restarted.getNotificationPromise()
      await restarted.close()
    }
    assert.equal(restartNotifier.attempts, 0)
  })
})

await test('restart delivers a persisted FAILED state that crashed before its first SMTP attempt', async () => {
  await withTemp('ledger-failed-before-smtp-', async ({ storageUrl }) => {
    const firstProcess = new WorkSessionRuntime({
      definition: definition('ledger-failed-before-smtp'), storageUrl,
      taskRunner: {
        async run() {
          return {
            status: 'FAILED' as const,
            error: 'spawn EACCES',
            failureStage: 'EXECUTOR' as const,
            failureCategory: 'PROVIDER_ERROR' as const,
          }
        },
      },
    })
    await assert.rejects(firstProcess.start(), /spawn EACCES/u)
    assert.equal(firstProcess.getDurableState()?.failureNotificationAttempted, undefined)
    await firstProcess.close()

    const notifier = new FailedNotifier()
    const restarted = new WorkSessionRuntime({
      definition: definition('ledger-failed-before-smtp'), storageUrl, notifier,
      notificationRetryDelayMs: 0,
      taskRunner: { async run() { throw new Error('persisted FAILED must not execute task') } },
    })
    assert.equal((await restarted.loadPersistedState())?.state, 'FAILED')
    await restarted.getNotificationPromise()
    assert.equal(notifier.attempts, 1)
    assert.equal(restarted.getDurableState()?.failureNotificationAttempted, true)
    assert.equal(restarted.getDurableState()?.failureNotified, true)
    assert.ok(restarted.readExecutionLedger().some((event) =>
      event.eventType === 'NOTIFICATION_SENT' && event.notificationKind === 'FAILED'))
    await restarted.close()
  })
})

await test('FAILED SMTP payload contains structured safe fields and excludes raw secrets', async () => {
  const state = {
    sessionId: 'smtp-failed', state: 'FAILED' as const, currentTaskIndex: 0,
    currentTaskId: 'T009', completedTaskIds: [], failureReason: SECRET_INPUT,
    failureStage: 'GIT_PUSH' as const, failureCategory: 'GIT_PUSH_FAILED' as const,
    safeFailureMessage: safeFailureMessage(SECRET_INPUT), activeElapsedMs: 64_000,
    createdAt: new Date(), updatedAt: new Date(),
  }
  const notification = createWorkSessionFailedNotification({
    definition: definition('smtp-failed'), state, localControlUrl: 'http://127.0.0.1:43123',
  })
  const text = renderFailedNotificationText(notification)
  assert.match(text, /NovaWing Work Session/u)
  assert.match(text, /GIT_PUSH/u)
  assert.match(text, /GIT_PUSH_FAILED/u)
  assert.match(text, /T009/u)
  assert.match(text, /http:\/\/127\.0\.0\.1:43123/u)
  assert.doesNotMatch(text, /SECRET_TOKEN|SECRET_KEY|SECRET_PASSWORD|SECRET_COOKIE|PROVIDER_SECRET/u)

  const sent: { subject: string; text: string }[] = []
  const smtp = new SmtpWorkSessionNotifier({
    from: 'nova@example.com', to: 'owner@example.com',
    transport: { async sendMail(mail) { sent.push({ subject: mail.subject, text: mail.text }) } },
  })
  await smtp.notifyFailed(notification)
  assert.equal(sent.length, 1)
  assert.doesNotMatch(JSON.stringify(sent), /SECRET_TOKEN|SECRET_KEY|SECRET_PASSWORD|SECRET_COOKIE|PROVIDER_SECRET/u)
})

await test('Control UI exposes only safe persistent Ledger failure data', async () => {
  await withTemp('ledger-ui-', async ({ storageUrl }) => {
    const controller = new WorkSessionControlController({
      pollIntervalMs: 5,
      createRuntime(_progress, notificationObserver) {
        return new WorkSessionRuntime({
          definition: definition('ledger-ui'), storageUrl, notificationObserver,
          taskRunner: {
            async run() {
              return {
                status: 'FAILED' as const, error: SECRET_INPUT,
                failureStage: 'GIT_PUSH' as const,
                failureCategory: 'GIT_PUSH_FAILED' as const,
              }
            },
          },
        })
      },
    })
    controller.start()
    await controller.getStartPromise()
    const snapshot = controller.getSnapshot()
    const serialized = JSON.stringify(snapshot)
    assert.match(serialized, /GIT_PUSH_FAILED/u)
    assert.match(serialized, /git push failed/u)
    assert.doesNotMatch(serialized, /SECRET_TOKEN|SECRET_KEY|SECRET_PASSWORD|SECRET_COOKIE|PROVIDER_SECRET/u)
    assert.doesNotMatch(renderHtml({ controlToken: 'safe-token', serverOrigin: 'http://127.0.0.1' }), /SECRET_TOKEN|PROVIDER_SECRET/u)
    controller.close()
  })
})

await test('Ledger schema supports simple session and failure statistics by reduction', async () => {
  await withTemp('ledger-stats-', async ({ storageUrl }) => {
    const ledger = new ExecutionLedgerStore(storageUrl)
    ledger.append({ eventType: 'SESSION_STARTED', sessionId: 'S1', taskId: null, timestamp: '2026-08-24T00:00:00Z', status: 'RUNNING' }, 'start')
    ledger.append({ eventType: 'SESSION_COMPLETED', sessionId: 'S1', taskId: null, timestamp: '2026-08-24T00:01:00Z', status: 'COMPLETED', completionReason: 'ALL_TASKS_COMPLETED' }, 'terminal')
    ledger.append({ eventType: 'SESSION_STARTED', sessionId: 'S2', taskId: null, timestamp: '2026-08-24T00:02:00Z', status: 'RUNNING' }, 'start')
    ledger.append({ eventType: 'HUMAN_REQUIRED', sessionId: 'S2', taskId: 'T2', timestamp: '2026-08-24T00:03:00Z', status: 'SUSPENDED', safeMessage: '需要人工决策。' }, 'human')
    ledger.append({ eventType: 'SESSION_FAILED', sessionId: 'S2', taskId: 'T2', timestamp: '2026-08-24T00:04:00Z', status: 'FAILED', failureStage: 'VERIFICATION', failureCategory: 'VERIFICATION_FAILED', safeMessage: '验证失败。' }, 'terminal')
    const events: ExecutionLedgerEvent[] = [...ledger.read('S1'), ...ledger.read('S2')]
    const stats = events.reduce((result, event) => {
      if (event.eventType === 'SESSION_STARTED') result.sessions++
      if (event.eventType === 'SESSION_COMPLETED') result.completed++
      if (event.eventType === 'SESSION_FAILED') {
        result.failed++
        result.failureStages[event.failureStage] = (result.failureStages[event.failureStage] ?? 0) + 1
      }
      if (event.eventType === 'HUMAN_REQUIRED') result.humanRequired++
      return result
    }, { sessions: 0, completed: 0, failed: 0, humanRequired: 0, failureStages: {} as Record<string, number> })
    assert.deepEqual(stats, {
      sessions: 2, completed: 1, failed: 1, humanRequired: 1,
      failureStages: { VERIFICATION: 1 },
    })
    ledger.close()
  })
})
