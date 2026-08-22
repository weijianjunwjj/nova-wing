import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createProductionWorkSessionUi,
  createSmtpWorkSessionNotifierFromEnv,
  validateTrustedWorkSessionConfig,
  type HumanRequiredNotification,
  type SmtpMailOptions,
  type SmtpTransportConfig,
  type TrustedWorkSessionConfig,
  type WorkSessionRuntimeConfig,
} from 'nova-wing/development-guardian'
import {
  renderNotificationSubject,
  renderNotificationText,
} from '../packages/development-guardian/work-session/smtp-notifier.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'

const SMTP_ENV: NodeJS.ProcessEnv = {
  NOVAWING_SMTP_HOST: 'smtp.example.test',
  NOVAWING_SMTP_PORT: '465',
  NOVAWING_SMTP_SECURE: 'true',
  NOVAWING_SMTP_USER: 'smtp-user',
  NOVAWING_SMTP_PASS: 'smtp-pass',
  NOVAWING_NOTIFY_FROM: 'novawing@example.test',
  NOVAWING_NOTIFY_TO: 'owner@example.test',
}

function notification(): HumanRequiredNotification {
  return {
    notificationId: 'session-1:T2:3',
    session: {
      id: 'session-1',
      targetRepo: 'D:/VSCode/nova-wing',
      branch: 'feat/work-session-mvp',
    },
    progress: {
      completedTaskIds: ['T1'],
      currentTaskId: 'T2',
    },
    humanRequired: {
      category: 'DECISION_REQUIRED',
      reason: 'choose database mode',
    },
    recommendation:
      'Review the decision in the NovaWing control panel and choose the intended option.',
    control: {
      localUrl: 'http://127.0.0.1:4317',
      instruction: 'Open the local NovaWing control panel and resolve this item.',
    },
  }
}

function rawConfig(storageUrl: string, emailEnabled: boolean): unknown {
  return {
    session: {
      id: 'w006-production',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    tasks: [{
      id: 'T1',
      goal: 'task one',
      guardian: {
        constraints: [],
        acceptanceCriteria: [],
        doNotDo: [],
        allowedPaths: ['packages/**'],
        forbiddenPaths: [],
      },
    }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: {
      model: 'sonnet',
      maxTurns: 10,
      allowNpmInstall: false,
      allowPythonBootstrap: false,
    },
    notification: { email: { enabled: emailEnabled } },
    storageUrl,
  }
}

await test('W006 SMTP: environment maps to transport and plain-text email content', async () => {
  let transportConfig: SmtpTransportConfig | undefined
  const sent: SmtpMailOptions[] = []
  const notifier = createSmtpWorkSessionNotifierFromEnv({
    env: SMTP_ENV,
    createTransport(config) {
      transportConfig = config
      return {
        async sendMail(options) {
          sent.push(options)
        },
      }
    },
  })
  await notifier.notifyHumanRequired(notification())
  assert.deepEqual(transportConfig, {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    auth: { user: 'smtp-user', pass: 'smtp-pass' },
  })
  assert.deepEqual(sent, [{
    from: 'novawing@example.test',
    to: 'owner@example.test',
    subject: '[NovaWing] 需要你处理：nova-wing / DECISION_REQUIRED',
    text: renderNotificationText(notification()),
  }])
  assert.equal(renderNotificationSubject(notification()), sent[0]?.subject)
  assert.match(sent[0]?.text ?? '', /Project: nova-wing/u)
  assert.match(sent[0]?.text ?? '', /Completed: T1/u)
  assert.match(sent[0]?.text ?? '', /Current task: T2/u)
  assert.match(sent[0]?.text ?? '', /http:\/\/127\.0\.0\.1:4317/u)
})

await test('W006 production config: enabled fails fast without SMTP env; disabled needs none', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w006-production-'))
  try {
    const enabled = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'enabled.db')).href, true),
    )
    let brainCalls = 0
    await assert.rejects(
      createProductionWorkSessionUi(enabled, {
        env: {},
        createBrain() {
          brainCalls++
          return { async review() { throw new Error('must not run') } }
        },
      }),
      /NOVAWING_SMTP_HOST is required/u,
    )
    assert.equal(brainCalls, 0, 'SMTP validation must precede provider/session startup')

    const disabled = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'disabled.db')).href, false),
    )
    let disabledRuntimeConfig: WorkSessionRuntimeConfig | undefined
    const app = await createProductionWorkSessionUi(disabled, {
      env: {},
      createBrain: () => ({ async review() { throw new Error('must not run') } }),
      createExecutor: () => ({ async execute() { throw new Error('must not run') } }),
      createRuntime(config) {
        disabledRuntimeConfig = config
        return new FakeRuntime(config.definition)
      },
      serverPort: 0,
    })
    const address = await app.start()
    const response = await fetch(`${address.url}/api/session/start`, {
      method: 'POST',
      headers: {
        'X-NovaWing-Control-Token': app.server.getTokenForTest(),
        Origin: address.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notification: { email: { enabled: true } } }),
    })
    assert.equal(response.status, 202)
    assert.equal(disabledRuntimeConfig?.notifier, undefined,
      'browser input cannot enable notification outside trusted config')
    await app.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W006 production wiring: enabled SMTP notifier receives safe local URL', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w006-enabled-wiring-'))
  try {
    const config = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'session.db')).href, true),
    )
    let runtimeConfig: WorkSessionRuntimeConfig | undefined
    const sent: SmtpMailOptions[] = []
    const app = await createProductionWorkSessionUi(config, {
      env: SMTP_ENV,
      serverPort: 0,
      createSmtpTransport: () => ({
        async sendMail(options) { sent.push(options) },
      }),
      createBrain: () => ({ async review() { throw new Error('must not run') } }),
      createExecutor: () => ({ async execute() { throw new Error('must not run') } }),
      createRuntime(input) {
        runtimeConfig = input
        return new FakeRuntime(input.definition)
      },
    })
    const address = await app.start()
    assert.ok(runtimeConfig?.notifier)
    assert.equal(runtimeConfig?.localControlUrl?.(), address.url)
    await runtimeConfig?.notifier?.notifyHumanRequired(notification())
    assert.equal(sent.length, 1)
    await app.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W006 config secrecy: credential-like notification keys remain forbidden', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w006-config-secret-'))
  try {
    const input = rawConfig(pathToFileURL(join(temp, 'session.db')).href, true) as {
      notification: { email: Record<string, unknown> }
    }
    input.notification.email.password = 'x'
    await assert.rejects(
      validateTrustedWorkSessionConfig(input),
      /credential-like config key is forbidden/u,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W006 Web safety: notification event and SSE omit raw SMTP diagnostics', async () => {
  let notify: ((result: {
    status: 'FAILED'
    notificationId: string
    taskId: string | null
    category: string
  }) => void) | undefined
  const controller = new WorkSessionControlController({
    createRuntime(_guardianSink, notificationSink) {
      notify = notificationSink
      return new FakeRuntime({
        id: 'w006-web',
        targetRepo: process.cwd(),
        branch: 'feat/work-session-mvp',
        tasks: [{ id: 'T1', goal: 'one' }],
        limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
      })
    },
  })
  const unsafeResult = {
    status: 'FAILED' as const,
    notificationId: 'w006-web:T1:1',
    taskId: 'T1',
    category: 'CREDENTIAL_REQUIRED',
    rawError: '535 auth failed password=SUPER_SECRET',
  }
  notify?.(unsafeResult)
  const serialized = JSON.stringify(controller.getSnapshot())
  assert.match(serialized, /NOTIFICATION_FAILED/u)
  assert.doesNotMatch(serialized, /SUPER_SECRET|535 auth failed password|rawError/u)
  assert.deepEqual(controller.getRecentEvents()[0]?.data, {
    notificationId: 'w006-web:T1:1',
    taskId: 'T1',
    category: 'CREDENTIAL_REQUIRED',
  })

  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await server.start()
  const response = await fetch(`${address.url}/api/events`)
  const reader = response.body?.getReader()
  assert.ok(reader)
  const chunk = await reader.read()
  const sse = new TextDecoder().decode(chunk.value)
  assert.match(sse, /NOTIFICATION_FAILED/u)
  assert.doesNotMatch(sse, /SUPER_SECRET|535 auth failed password|rawError/u)
  await reader.cancel()
  await server.close()
})

// Compile-time guard: validated configs expose only the non-secret enabled flag.
const _trustedConfigShape: TrustedWorkSessionConfig['notification'] = {
  email: { enabled: true },
}
void _trustedConfigShape
