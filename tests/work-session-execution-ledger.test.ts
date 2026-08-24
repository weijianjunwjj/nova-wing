import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ExecutionLedgerStore,
  GitCheckpointError,
  GitPushError,
  SmtpWorkSessionNotifier,
  WorkSessionRuntime,
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
    if (phaseStarted?.eventType === 'PHASE_STARTED') assert.equal(phaseStarted.iteration, 0)
    assert.doesNotMatch(JSON.stringify(events), /SECRET_TOKEN|PROVIDER_SECRET/u)
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
