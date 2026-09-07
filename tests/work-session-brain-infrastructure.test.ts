import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WorkSessionRuntime,
  type GuardianTaskRecoveryCheckpoint,
  type WorkSessionRecoveryRequiredNotification,
  type WorkSessionNotifier,
  type WorkSessionTaskRunner,
} from 'nova-wing/development-guardian'

test('Brain infrastructure suspension preserves checkpoint and resumes the failed review stage', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'novawing-brain-infra-'))
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: {
      id: 'T1',
      goal: 'preserve completed Executor work',
      state: 'BRAIN_INFRASTRUCTURE_FAILED',
      iteration: 1,
      maxIterations: 10,
      lastReport: {
        summary: 'Executor changes already complete',
        changedFiles: ['src/preserved.ts'],
        commandsRun: ['npm test'],
        verificationResults: [{ name: 'npm test', status: 'passed' }],
        blockers: [],
      },
      brainFailure: {
        stage: 'BRAIN_REVIEW',
        category: 'TRANSPORT',
        rootCause: 'ask-bridge unavailable',
        adapter: 'ask-bridge/chatgpt',
        requestedModel: 'GPT-5.6 Sol',
        requestedReasoning: 'high',
        retryable: true,
        degraded: false,
        fingerprint: 'brain-transport:ask-bridge-unavailable',
        attemptTimeline: [{
          attempt: 1,
          operationKind: 'normal',
          startedAt: '2026-08-24T00:00:00.000Z',
          durationMs: 180_000,
          outcome: 'failure',
          failureType: 'BRAIN_TRANSPORT_FAILED',
          fingerprint: 'brain-transport:timeout',
          timeout: true,
        }],
      },
    },
    provider: {
      chatgptConversationUrl: 'https://chatgpt.com/c/preserved-review',
      claudeSessionId: 'preserved-executor-session',
    },
    repo: {
      repoPath: 'D:/repo/example',
      branch: 'feat/test',
      headSha: '0123456789012345678901234567890123456789',
      changedFiles: ['src/preserved.ts'],
      worktreeFingerprint: 'preserved-fingerprint',
    },
    capturedAt: '2026-08-24T00:00:00.000Z',
  }
  let calls = 0
  let notificationAttempts = 0
  const recoveryNotifications: WorkSessionRecoveryRequiredNotification[] = []
  const notifier: WorkSessionNotifier = {
    async notifyHumanRequired() {},
    async notifyRecoveryRequired(notification) {
      notificationAttempts++
      recoveryNotifications.push(notification)
      throw new Error('smtp password=CHECKPOINT_SECRET')
    },
  }
  const seenCheckpoints: Array<GuardianTaskRecoveryCheckpoint | undefined> = []
  const runner: WorkSessionTaskRunner = {
    async run(_task, _resumeData, restoredCheckpoint) {
      calls += 1
      seenCheckpoints.push(restoredCheckpoint)
      if (calls === 1) {
        return {
          status: 'BRAIN_INFRASTRUCTURE_FAILED',
          brainFailure: checkpoint.task.brainFailure!,
          checkpoint,
        }
      }
      return { status: 'COMPLETED', summary: 'Review completed without rerunning Executor' }
    },
  }
  const runtime = new WorkSessionRuntime({
    definition: {
      id: 'brain-infrastructure-recovery',
      targetRepo: 'D:/repo/example',
      branch: 'feat/test',
      tasks: [{ id: 'T1', goal: 'preserve completed Executor work' }],
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    taskRunner: runner,
    notifier,
    notificationRetryDelayMs: 0,
    storageUrl: new URL(`file:///${join(temp, 'session.db').replaceAll('\\', '/')}`).href,
  })
  t.after(async () => {
    await runtime.close()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await rm(temp, { recursive: true, force: true })
        break
      } catch {
        // Windows may release the LibSQL file handle shortly after runtime.close().
      }
    }
  })

  const suspended = await runtime.start()
  assert.equal(suspended.state, 'SUSPENDED')
  assert.equal(suspended.suspensionReason, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.equal(suspended.humanRequired, undefined)
  assert.equal(suspended.brainFailure?.stage, 'BRAIN_REVIEW')
  assert.deepEqual(suspended.brainFailure?.attemptTimeline, checkpoint.task.brainFailure?.attemptTimeline)
  assert.equal(suspended.currentTaskCheckpoint?.task.iteration, 1)
  assert.equal(
    suspended.currentTaskCheckpoint?.task.lastReport?.summary,
    'Executor changes already complete',
  )
  assert.deepEqual(suspended.currentTaskCheckpoint?.repo, checkpoint.repo)
  await runtime.getNotificationPromise()
  assert.equal(notificationAttempts, 2)
  assert.equal(runtime.getDurableState()?.state, 'SUSPENDED')
  assert.deepEqual(runtime.getDurableState()?.currentTaskCheckpoint, checkpoint)
  assert.deepEqual(runtime.getDurableState()?.brainFailure?.attemptTimeline, checkpoint.task.brainFailure?.attemptTimeline)
  assert.equal(recoveryNotifications[0]?.notificationId, 'brain-infrastructure-recovery:T1:recovery:1')
  assert.ok(runtime.readExecutionLedger().some((event) =>
    event.eventType === 'NOTIFICATION_FAILED' && event.notificationKind === 'RECOVERY_REQUIRED'))
  assert.doesNotMatch(JSON.stringify(runtime.readExecutionLedger()), /CHECKPOINT_SECRET|smtp password/u)

  const completed = await runtime.resume({})
  assert.equal(completed.state, 'COMPLETED')
  assert.equal(calls, 2)
  assert.equal(seenCheckpoints[0], undefined)
  assert.equal(seenCheckpoints[1]?.task.iteration, 1, 'must not restart from iteration 0')
  assert.equal(
    seenCheckpoints[1]?.task.lastReport?.summary,
    'Executor changes already complete',
  )
  assert.deepEqual(seenCheckpoints[1]?.repo, checkpoint.repo)
})
