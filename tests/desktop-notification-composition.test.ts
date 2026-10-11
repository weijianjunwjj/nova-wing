import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import {
  createProductionWorkSessionUi,
  executionLedgerPathFromStorageUrl,
  validateTrustedWorkSessionConfig,
  WorkSessionRuntime,
  type ProductionWorkSessionUi,
  type RuntimeRepairNotification,
  type RuntimeRepairNotifier,
  type SmtpMailOptions,
  type WorkSessionNotificationKind,
  type WorkSessionNotificationPayload,
  type WorkSessionNotifier,
  type WorkSessionRuntimeConfig,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'

const SMTP_ENV: NodeJS.ProcessEnv = {
  NOVAWING_SMTP_HOST: 'smtp.example.test', NOVAWING_SMTP_PORT: '465',
  NOVAWING_SMTP_SECURE: 'true', NOVAWING_SMTP_USER: 'test-user',
  NOVAWING_SMTP_PASS: 'test-pass', NOVAWING_NOTIFY_FROM: 'nova@example.test',
  NOVAWING_NOTIFY_TO: 'owner@example.test',
}

function recorder(fail = false) {
  const attempts: { kind: WorkSessionNotificationKind; payload: WorkSessionNotificationPayload }[] = []
  const send = async (kind: WorkSessionNotificationKind, payload: WorkSessionNotificationPayload) => {
    attempts.push({ kind, payload })
    if (fail) throw new Error('native delivery failed token=PRIVATE_TRANSPORT_DATA')
  }
  const notifier: WorkSessionNotifier = {
    notificationChannel: 'DESKTOP',
    notificationKinds: ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'],
    notifyCompleted: (value) => send('COMPLETED', value),
    notifyFailed: (value) => send('FAILED', value),
    notifyHumanRequired: (value) => send('HUMAN_REQUIRED', value),
  }
  return { notifier, attempts }
}

interface CompositionOptions {
  desktopNotifier?: WorkSessionNotifier | null
  email?: boolean
  emailCompleted?: boolean
  emailFails?: boolean
  result?: WorkSessionTaskResult
  scheduledStartAt?: string
  controlPlane?: 'v1' | 'v2'
  softMinutes?: number
  maxTasks?: number
  taskCount?: number
  repairNotifier?: RuntimeRepairNotifier
}

async function withComposition(
  run: (create: (options: CompositionOptions) => Promise<{
    app: ProductionWorkSessionUi
    runtime: WorkSessionRuntime
    runtimeConfig: WorkSessionRuntimeConfig
    mails: SmtpMailOptions[]
    executions: () => number
  }>, storageUrl: string) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'nova-native-composition-'))
  const storageUrl = pathToFileURL(join(temp, 'session.db')).href
  const apps: ProductionWorkSessionUi[] = []
  try {
    await run(async (options) => {
      const config = await validateTrustedWorkSessionConfig({
        session: {
          id: 'native-composition', targetRepo: process.cwd(), branch: 'feat/work-session-mvp',
          controlPlane: options.controlPlane ?? 'v1',
          limits: { softMinutes: options.softMinutes ?? 45, hardMinutes: 60, maxTasks: options.maxTasks ?? 5 },
          ...(options.scheduledStartAt === undefined ? {} : { scheduledStartAt: options.scheduledStartAt }),
        },
        tasks: Array.from({ length: options.taskCount ?? 1 }, (_, index) => ({
          id: `T${index + 1}`, goal: 'safe fake workload',
          guardian: { constraints: [], acceptanceCriteria: [], doNotDo: [], allowedPaths: ['packages/**'], forbiddenPaths: [] },
        })),
        gitCheckpoint: { autoCommit: false, autoPush: false },
        executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
        notification: { email: { enabled: options.email ?? false, notifyOnCompleted: options.emailCompleted ?? false } },
        storageUrl,
      })
      let runtime!: WorkSessionRuntime
      let runtimeConfig!: WorkSessionRuntimeConfig
      let executions = 0
      const mails: SmtpMailOptions[] = []
      const app = await createProductionWorkSessionUi(config, {
        env: SMTP_ENV, serverPort: 0, shutdownMode: 'strict', notificationRetryDelayMs: 0,
        ...(options.desktopNotifier === undefined ? {} : { desktopNotifier: options.desktopNotifier }),
        ...(options.repairNotifier === undefined ? {} : { runtimeRepair: { notifier: options.repairNotifier } }),
        createExecutor: () => ({ async execute() { throw new Error('fake workload never calls a model') } }),
        createSmtpTransport: () => ({ async sendMail(mail) {
          mails.push(mail)
          if (options.emailFails === true) throw new Error('smtp test failure')
        } }),
        createRuntime(input) {
          runtimeConfig = input
          runtime = new WorkSessionRuntime({
            ...input, notificationRetryDelayMs: 0,
            taskRunner: { async run() { executions += 1; return options.result ?? { status: 'COMPLETED' } } },
          })
          return runtime
        },
      })
      apps.push(app)
      return { app, runtime, runtimeConfig, mails, executions: () => executions }
    }, storageUrl)
  } finally {
    for (const app of apps.toReversed()) await app.close()
    // Match the existing Work Session fixtures: Windows libSQL may release a
    // WAL handle just after close. Bound retries outside recursive rm, whose
    // nested retries can otherwise multiply into minutes per test directory.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(temp, { recursive: true, force: true })
        break
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) ||
            !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(String(error.code))) throw error
        if (attempt === 9) {
          console.warn(`Desktop notification fixture cleanup deferred: ${temp} (${String(error.code)})`)
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
  }
}

for (const scenario of [
  { name: 'SMTP off', email: false, emailCompleted: false, desktop: true, emails: 0 },
  { name: 'SMTP on, completion email off', email: true, emailCompleted: false, desktop: true, emails: 0 },
  { name: 'both completion channels on', email: true, emailCompleted: true, desktop: true, emails: 1 },
  { name: 'Desktop unsupported, email on', email: true, emailCompleted: true, desktop: false, emails: 1 },
  { name: 'Desktop unsupported, email off', email: false, emailCompleted: false, desktop: false, emails: 0 },
]) {
  test(`Desktop completion composition: ${scenario.name}`, async () => {
    await withComposition(async (create) => {
      const desktop = recorder()
      const { runtime, runtimeConfig, mails, executions } = await create({
        ...scenario, desktopNotifier: scenario.desktop ? desktop.notifier : null,
      })
      assert.equal(runtimeConfig.notifyOnCompleted === true, scenario.emailCompleted, 'Desktop must never force email opt-in')
      assert.equal(runtimeConfig.notificationChannels?.some((entry) => entry.channel === 'DESKTOP') ?? false, scenario.desktop)
      assert.equal((await runtime.start()).completionReason, 'ALL_TASKS_COMPLETED')
      await runtime.getNotificationPromise()
      assert.equal(executions(), 1)
      assert.equal(mails.length, scenario.emails)
      assert.equal(desktop.attempts.length, Number(scenario.desktop))
      if (scenario.desktop) {
        assert.equal(desktop.attempts[0]?.kind, 'COMPLETED')
        assert.equal(desktop.attempts[0]?.payload.notificationId, 'native-composition:completed')
      }
      const channels = runtime.getLastNotificationDelivery()?.channels ?? []
      assert.ok(channels.every((channel) => channel.status === 'SENT'))
      assert.equal(channels.length, Number(scenario.desktop) + scenario.emails)
      if (channels.length === 0) assert.equal(runtime.getLastNotificationDelivery(), undefined, 'unsupported must not fabricate SENT')
    })
  })
}

test('the V2 production branch also receives the independent Desktop capability', async () => {
  await withComposition(async (create) => {
    const desktop = recorder()
    const { runtimeConfig } = await create({ desktopNotifier: desktop.notifier, email: true, controlPlane: 'v2' })
    assert.equal(runtimeConfig.terminalNotifier, desktop.notifier)
    assert.equal(runtimeConfig.notifyOnCompleted, undefined)
    assert.deepEqual(runtimeConfig.notificationChannels?.map((entry) => ({
      channel: entry.channel, kinds: entry.notifier.notificationKinds,
    })), [
      { channel: 'EMAIL', kinds: ['HUMAN_REQUIRED', 'FAILED', 'RECOVERY_REQUIRED'] },
      { channel: 'DESKTOP', kinds: ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'] },
    ])
  })
})

test('omitting the injection retains existing SMTP completion opt-in', async () => {
  await withComposition(async (create) => {
    const { runtime, runtimeConfig, mails } = await create({ email: true })
    assert.equal(runtimeConfig.terminalNotifier, undefined)
    assert.equal(runtimeConfig.notificationChannels?.length, 1, 'the existing injected-runtime seam still suppresses the legacy Windows adapter')
    await runtime.start()
    await runtime.getNotificationPromise()
    assert.equal(mails.length, 0)
    assert.equal(runtime.getLastNotificationDelivery(), undefined)
  })
})

test('explicit Desktop composition reserves task completion for the durable pipeline and retains repair outcomes', async () => {
  for (const desktopNotifier of [undefined, null, recorder().notifier]) {
    await withComposition(async (create) => {
      const repairs: RuntimeRepairNotification[] = []
      const { runtimeConfig } = await create({
        ...(desktopNotifier === undefined ? {} : { desktopNotifier }),
        controlPlane: 'v2', repairNotifier: { async notify(notification) { repairs.push(notification) } },
      })
      for (const kind of ['SUCCESS', 'FAILURE', 'COMPLETED'] as const) {
        await runtimeConfig.runtimeRepair?.notifier?.notify({ kind, sessionId: 'native-composition', summary: 'safe fixture repair result' })
      }
      assert.deepEqual(repairs.map((notification) => notification.kind),
        desktopNotifier === undefined ? ['SUCCESS', 'FAILURE', 'COMPLETED'] : ['SUCCESS', 'FAILURE'])
    })
  }
})

for (const failure of ['DESKTOP', 'EMAIL'] as const) {
  test(`production channel retries isolate ${failure} failure and preserve COMPLETED`, async () => {
    await withComposition(async (create) => {
      const desktop = recorder(failure === 'DESKTOP')
      const { runtime, mails } = await create({
        desktopNotifier: desktop.notifier, email: true, emailCompleted: true, emailFails: failure === 'EMAIL',
      })
      await runtime.start()
      await runtime.getNotificationPromise()
      assert.equal(runtime.getDurableState()?.state, 'COMPLETED')
      assert.equal(mails.length, failure === 'EMAIL' ? 2 : 1)
      assert.equal(desktop.attempts.length, failure === 'DESKTOP' ? 2 : 1)
      assert.equal(new Set(desktop.attempts.map((attempt) => attempt.payload.notificationId)).size, 1)
      assert.equal(runtime.getLastNotificationDelivery()?.overallStatus, 'PARTIAL_SUCCESS')
      assert.equal(runtime.getLastNotificationDelivery()?.channels?.find((channel) => channel.channel === failure)?.status, 'FAILED')
      assert.doesNotMatch(JSON.stringify(runtime.readExecutionLedger()), /PRIVATE_TRANSPORT_DATA/u)
    })
  })
}

const failedResult: WorkSessionTaskResult = {
  status: 'FAILED', error: 'safe fixture execution failure', failureStage: 'EXECUTOR', failureCategory: 'PROVIDER_ERROR',
}
const humanResult: WorkSessionTaskResult = {
  status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose a safe option' },
}

for (const failDelivery of [false, true]) {
  for (const kind of ['FAILED', 'HUMAN_REQUIRED', 'COMPLETED'] as const) {
    test(`${kind} keeps its business identity when Desktop delivery ${failDelivery ? 'fails' : 'succeeds'}`, async () => {
      await withComposition(async (create) => {
        const desktop = recorder(failDelivery)
        const { runtime } = await create({ desktopNotifier: desktop.notifier,
          result: kind === 'FAILED' ? failedResult : kind === 'HUMAN_REQUIRED' ? humanResult : { status: 'COMPLETED' },
        })
        if (kind === 'FAILED') await assert.rejects(runtime.start(), /safe fixture execution failure/u)
        else await runtime.start()
        await runtime.getNotificationPromise()
        const state = runtime.getDurableState()
        assert.equal(state?.state, kind === 'HUMAN_REQUIRED' ? 'SUSPENDED' : kind)
        if (kind === 'FAILED') {
          assert.equal(state?.failureStage, 'EXECUTOR')
          assert.equal(state?.failureCategory, 'PROVIDER_ERROR')
          assert.match(state?.failureReason ?? '', /safe fixture execution failure/u)
        }
        if (kind === 'HUMAN_REQUIRED') {
          assert.equal(state?.humanRequired?.category, 'DECISION_REQUIRED')
          assert.equal(state?.humanRequiredGeneration, 1)
          assert.equal(desktop.attempts[0]?.payload.notificationId, 'native-composition:T1:1')
        }
        assert.equal(desktop.attempts.length, failDelivery ? 2 : 1)
        assert.ok(desktop.attempts.every((attempt) => attempt.kind === kind))
        assert.equal(runtime.getLastNotificationDelivery()?.channels?.[0]?.status, failDelivery ? 'FAILED' : 'SENT')
        await runtime.close()
        assert.equal(desktop.attempts.length, failDelivery ? 2 : 1, 'close drains the existing bounded attempts only')
      })
    })
  }
}

for (const scenario of ['USER_PAUSED', 'IDLE', 'SCHEDULED', 'SOFT_LIMIT', 'MAX_TASKS'] as const) {
  test(`${scenario} does not generate a native target notification`, async () => {
    await withComposition(async (create) => {
      const desktop = recorder()
      const { runtime, executions } = await create({
        desktopNotifier: desktop.notifier,
        ...(scenario === 'USER_PAUSED' ? { result: { status: 'PAUSED' as const } } : {}),
        ...(scenario === 'SCHEDULED' ? { scheduledStartAt: new Date(Date.now() + 86_400_000).toISOString() } : {}),
        ...(scenario === 'SOFT_LIMIT' ? { softMinutes: 0 } : {}),
        ...(scenario === 'MAX_TASKS' ? { maxTasks: 1, taskCount: 2 } : {}),
      })
      const state = scenario === 'IDLE' ? await runtime.loadPersistedState() : await runtime.start()
      await runtime.getNotificationPromise()
      if (scenario === 'USER_PAUSED') assert.equal(state?.suspensionReason, 'USER_PAUSED')
      if (scenario === 'SCHEDULED') assert.equal(state?.state, 'SCHEDULED')
      if (scenario === 'SOFT_LIMIT' || scenario === 'MAX_TASKS') assert.equal(state?.completionReason, scenario)
      if (scenario === 'IDLE' || scenario === 'SCHEDULED') assert.equal(executions(), 0)
      assert.equal(desktop.attempts.length, 0)
      assert.equal(runtime.getLastNotificationDelivery(), undefined)
    })
  })
}

for (const kind of ['COMPLETED', 'FAILED', 'HUMAN_REQUIRED'] as const) {
  test(`existing ${kind} is not backfilled when Desktop is enabled`, async () => {
    await withComposition(async (create) => {
      const first = await create({ desktopNotifier: null,
        result: kind === 'FAILED' ? failedResult : kind === 'HUMAN_REQUIRED' ? humanResult : { status: 'COMPLETED' },
      })
      if (kind === 'FAILED') await assert.rejects(first.runtime.start())
      else await first.runtime.start()
      await first.app.close()
      const desktop = recorder()
      const restarted = await create({ desktopNotifier: desktop.notifier })
      await restarted.runtime.getNotificationPromise()
      await restarted.runtime.loadPersistedState()
      restarted.app.controller.getSnapshot()
      restarted.runtime.getDurableState()
      await restarted.runtime.getNotificationPromise()
      assert.equal(desktop.attempts.length, 0)
      assert.equal(restarted.executions(), 0)
      assert.equal(restarted.runtime.getLastNotificationDelivery(), undefined)
    })
  })
}

test('historical FAILED keeps legacy SMTP restoration while excluding new Desktop delivery', async () => {
  await withComposition(async (create) => {
    const first = await create({ desktopNotifier: null, result: failedResult })
    await assert.rejects(first.runtime.start())
    await first.app.close()
    const desktop = recorder()
    const restarted = await create({ desktopNotifier: desktop.notifier, email: true })
    await restarted.runtime.getNotificationPromise()
    assert.equal(restarted.mails.length, 1)
    assert.equal(desktop.attempts.length, 0)
    assert.deepEqual(restarted.runtime.getLastNotificationDelivery()?.channels, [{ channel: 'EMAIL', status: 'SENT' }])
  })
})

test('a durable FAILED attempt without a ledger delivery fact retains the existing recovery rule', async () => {
  await withComposition(async (create, storageUrl) => {
    const first = await create({ desktopNotifier: recorder(true).notifier, result: failedResult })
    await assert.rejects(first.runtime.start())
    await first.runtime.getNotificationPromise()
    assert.equal(first.runtime.getDurableState()?.failureNotificationAttempted, true)
    await first.app.close()
    const ledger = new DatabaseSync(executionLedgerPathFromStorageUrl(storageUrl))
    try {
      ledger.prepare("DELETE FROM execution_ledger_events WHERE event_type = 'NOTIFICATION_FAILED' AND notification_kind = 'FAILED'").run()
    } finally { ledger.close() }
    const desktop = recorder()
    const restarted = await create({ desktopNotifier: desktop.notifier })
    await restarted.runtime.getNotificationPromise()
    assert.equal(desktop.attempts.length, 1)
    assert.equal(desktop.attempts[0]?.payload.notificationId, 'native-composition:failed')
    assert.equal(restarted.runtime.getDurableState()?.failureNotified, true)
    assert.equal(restarted.executions(), 0)
  })
})

test('delivered and exhausted native generations remain deduplicated across hydration and UI reads', async () => {
  for (const failure of [false, true]) {
    for (const result of [{ status: 'COMPLETED' } as WorkSessionTaskResult, failedResult, humanResult]) {
      await withComposition(async (create) => {
        const desktop = recorder(failure)
        const first = await create({ desktopNotifier: desktop.notifier, result })
        if (result.status === 'FAILED') await assert.rejects(first.runtime.start())
        else await first.runtime.start()
        await first.runtime.getNotificationPromise()
        const attempts = desktop.attempts.length
        await first.app.close()
        const restarted = await create({ desktopNotifier: desktop.notifier })
        for (let read = 0; read < 3; read++) {
          await restarted.runtime.loadPersistedState()
          restarted.app.controller.getSnapshot()
          restarted.runtime.getDurableState()
        }
        await restarted.runtime.getNotificationPromise()
        assert.equal(desktop.attempts.length, attempts)
        assert.equal(restarted.executions(), 0)
      })
    }
  }
})
