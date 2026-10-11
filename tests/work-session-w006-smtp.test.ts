import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createProductionWorkSessionUi, createSmtpWorkSessionNotifierFromEnv, validateTrustedWorkSessionConfig, type HumanRequiredNotification, type WorkSessionCompletedNotification, type SmtpMailOptions, type SmtpTransportConfig, type TrustedWorkSessionConfig, type WorkSessionRuntimeConfig } from 'nova-wing/development-guardian'
import { renderNotificationSubject, renderNotificationText, renderCompletedNotificationSubject, renderCompletedNotificationText } from '../packages/development-guardian/work-session/smtp-notifier.js'
import { safeNotificationReason } from '../packages/development-guardian/work-session/notifier.js'
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
    recommendation: '打开本地 NovaWing Work Session 控制台查看决策，并选择预期选项。',
    control: {
      localUrl: 'http://127.0.0.1:4317',
      instruction: '打开本地 NovaWing Work Session 控制台查看详情，并在确认后恢复任务。',
    },
  }
}

function completedNotification(): WorkSessionCompletedNotification {
  return {
    notificationId: 'session-1:completed',
    session: { id: 'session-1', targetRepo: 'D:/VSCode/nova-wing', branch: 'feat/work-session-mvp' },
    completedTaskIds: ['T1', 'T2'],
    completionReason: 'ALL_TASKS_COMPLETED',
    activeElapsedMs: 64_000,
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
    subject: '[NovaWing] 需要人工处理：T2',
    text: renderNotificationText(notification()),
  }])
  assert.equal(renderNotificationSubject(notification()), sent[0]?.subject)
  assert.match(sent[0]?.text ?? '', /项目：nova-wing/u)
  assert.match(sent[0]?.text ?? '', /已完成 Task：T1/u)
  assert.match(sent[0]?.text ?? '', /当前 Task：T2/u)
  assert.match(sent[0]?.text ?? '', /类别：需要人工决策/u)
  assert.match(sent[0]?.text ?? '', /http:\/\/127\.0\.0\.1:4317/u)
})

await test('completion SMTP uses the completed-only subject and safe plain text', async () => {
  const sent: SmtpMailOptions[] = []
  const notifier = createSmtpWorkSessionNotifierFromEnv({
    env: SMTP_ENV,
    createTransport: () => ({ async sendMail(options) { sent.push(options) } }),
  })
  await notifier.notifyCompleted(completedNotification())
  assert.equal(sent[0]?.subject, '[NovaWing] Work Session 已完成')
  assert.equal(sent[0]?.text, renderCompletedNotificationText(completedNotification()))
  assert.equal(renderCompletedNotificationSubject(completedNotification()), sent[0]?.subject)
  assert.match(sent[0]?.text ?? '', /状态：已完成/u)
  assert.doesNotMatch(JSON.stringify(sent[0]), /Bearer|token=|password=|DATABASE_URL|resumeInput|fingerprint|provider URL/u)
})

await test('notification reasons are localized, bounded, and redact credential-like values', () => {
  assert.equal(
    safeNotificationReason('403 insufficient balance'),
    'Executor Provider 账户余额不足，无法继续调用模型。',
  )
  assert.equal(
    safeNotificationReason('DATABASE_URL missing; pytest failed'),
    'PostgreSQL DATABASE_URL 未配置，pytest 无法完成验证。',
  )
  assert.equal(
    safeNotificationReason('AskBridge tab identification failure'),
    'Reviewer 浏览器会话打开失败。',
  )
  assert.equal(
    safeNotificationReason(
      'brain review failed: ask-bridge failed: Error opening ChatGPT session: Could not identify the newly opened tab; existing tabs were preserved',
    ),
    'Reviewer 浏览器会话打开失败。',
  )
  assert.doesNotMatch(
    safeNotificationReason('provider error token=SUPER_SECRET cookie=SESSION_SECRET'),
    /SUPER_SECRET|SESSION_SECRET/u,
  )
  for (const reason of [
    'ANTHROPIC_AUTH_TOKEN=SUPER_SECRET',
    'NOVAWING_SMTP_PASS=SUPER_SECRET',
    'POSTGRES_PASSWORD=SUPER_SECRET',
    'MY_API_KEY=SUPER_SECRET',
    'SOME_COOKIE=SUPER_SECRET',
    'SOME_COOKIE:SUPER_SECRET',
    'AUTHORIZATION=BearerSecret',
  ]) {
    assert.doesNotMatch(safeNotificationReason(reason), /SUPER_SECRET|BearerSecret/u)
  }
  assert.equal(
    safeNotificationReason('{"token":"SUPER_SECRET","usage":{"raw":true}}'),
    '发生未知错误。请在本地控制台查看安全诊断信息。',
  )
})

await test('W006 production config: enabled fails fast without SMTP env; disabled needs none', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w006-production-'))
  try {
    const enabled = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'enabled.db')).href, true),
    )
    let providerCalls = 0
    await assert.rejects(
      createProductionWorkSessionUi(enabled, {
        env: {},
        createCodexExecutor() {
          providerCalls++
          throw new Error('must not run')
        },
      }),
      /NOVAWING_SMTP_HOST is required/u,
    )
    assert.equal(providerCalls, 0, 'SMTP validation must precede provider/session startup')

    const disabled = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'disabled.db')).href, false),
    )
    let disabledRuntimeConfig: WorkSessionRuntimeConfig | undefined
    const app = await createProductionWorkSessionUi(disabled, {
      env: {},
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

await test('completion notification config is opt-in and rejects enabled=false', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w006-completed-config-'))
  try {
    const enabled = rawConfig(pathToFileURL(join(temp, 'enabled.db')).href, true) as {
      notification: { email: { enabled: boolean; notifyOnCompleted?: boolean } }
    }
    enabled.notification.email.notifyOnCompleted = true
    assert.equal((await validateTrustedWorkSessionConfig(enabled)).notification?.email.notifyOnCompleted, true)

    const invalid = rawConfig(pathToFileURL(join(temp, 'invalid.db')).href, false) as typeof enabled
    invalid.notification.email.notifyOnCompleted = true
    await assert.rejects(validateTrustedWorkSessionConfig(invalid), /notifyOnCompleted requires/u)
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
