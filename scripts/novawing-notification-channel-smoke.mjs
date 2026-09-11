/* global console, process */
/**
 * NovaWing v0.2.6 — real-machine notification channel smoke.
 *
 * Exercises the production notifiers (real WinRT toast host and, when the local
 * SMTP secrets are configured, a real SMTP send) instead of mocks, and reports
 * each channel's own result. Nothing is fabricated: a channel that cannot be
 * reached locally is reported as SKIPPED with the reason.
 *
 * Usage:
 *   npm run guardian:notification-channel:smoke
 */
import {
  createWindowsTaskRunNotifier,
  createSmtpWorkSessionNotifierFromEnv,
  deliverNotificationToChannels,
  overallNotificationStatus,
  smtpEnvironmentFrom,
  resolveProductionSmtpEnvironment,
} from 'nova-wing/development-guardian'

const completed = {
  notificationId: 'v026-smoke:completed',
  session: { id: 'v026-smoke', targetRepo: process.cwd(), branch: 'feat/v0.2.6' },
  completedTaskIds: ['REAL-001'],
  completionReason: 'ALL_TASKS_COMPLETED',
}

const ZH = {
  ALL_SUCCEEDED: '全部成功',
  PARTIAL_SUCCESS: '部分成功',
  ALL_FAILED: '全部失败',
  SENT: '已发送',
  FAILED: '发送失败',
  SKIPPED: '已跳过（不适用）',
  EMAIL: '邮件',
  DESKTOP: '桌面通知',
}

function describe(channels, overall) {
  const lines = channels.map((channel) => `    ${ZH[channel.channel] ?? channel.channel}：${ZH[channel.status] ?? channel.status}${channel.reason === undefined ? '' : `（${channel.reason}）`}`)
  return [...lines, `    总体：${ZH[overall] ?? overall}`].join('\n')
}

/** The real SMTP channel when the local secrets exist; otherwise an explicitly skipped one. */
async function resolveEmailChannel() {
  try {
    const env = await resolveProductionSmtpEnvironment({ notification: { email: { enabled: true } } })
    const present = smtpEnvironmentFrom(env)
    if (present === undefined) return { status: 'SKIPPED', reason: '本机未配置 SMTP 凭据' }
    return { notifier: createSmtpWorkSessionNotifierFromEnv({ env }) }
  } catch (error) {
    return { status: 'SKIPPED', reason: error instanceof Error ? error.message : '本机 SMTP 不可用' }
  }
}

function failingEmailNotifier() {
  return {
    notificationChannel: 'EMAIL',
    async notifyHumanRequired() {},
    async notifyCompleted() {
      throw new Error('smoke: forced SMTP rejection')
    },
  }
}

function failingDesktopNotifier() {
  return createWindowsTaskRunNotifier({
    platform: 'win32',
    timeoutMs: 5_000,
    spawnToast: async () => {
      throw new Error('smoke: forced toast host failure')
    },
  })
}

const email = await resolveEmailChannel()
const realDesktop = createWindowsTaskRunNotifier()

const cases = []
if (email.notifier === undefined) {
  cases.push({ name: 'A 邮件 + 桌面通知 全部成功', channels: [], overall: undefined, note: `邮件渠道不可用：${email.reason ?? '未知原因'}` })
} else {
  cases.push({ name: 'A 邮件 + 桌面通知 全部成功', channels: [{ channel: 'EMAIL', notifier: email.notifier }, { channel: 'DESKTOP', notifier: realDesktop }] })
}
cases.push({
  name: 'B 邮件成功 + 桌面通知失败（应部分成功）',
  channels: email.notifier === undefined
    ? [{ channel: 'DESKTOP', notifier: failingDesktopNotifier() }]
    : [{ channel: 'EMAIL', notifier: email.notifier }, { channel: 'DESKTOP', notifier: failingDesktopNotifier() }],
})
cases.push({
  name: 'C 邮件失败 + 桌面通知失败（应全部失败）',
  channels: [{ channel: 'EMAIL', notifier: failingEmailNotifier() }, { channel: 'DESKTOP', notifier: failingDesktopNotifier() }],
})
cases.push({
  name: 'D REAL-001 路径：SMTP 已接受时邮件必须保持已发送',
  channels: email.notifier === undefined
    ? [{ channel: 'DESKTOP', notifier: failingDesktopNotifier() }]
    : [{ channel: 'EMAIL', notifier: email.notifier }, { channel: 'DESKTOP', notifier: failingDesktopNotifier() }],
})

let failures = 0
for (const item of cases) {
  console.log(`\n[case] ${item.name}`)
  if (item.note !== undefined) {
    console.log(`    跳过：${item.note}`)
    continue
  }
  const results = []
  for (const entry of item.channels) {
    const channelResults = await deliverNotificationToChannels(entry.notifier, 'COMPLETED', completed)
    results.push(...channelResults)
  }
  const overall = overallNotificationStatus(results)
  console.log(describe(results, overall))

  if (item.name.startsWith('A') && overall !== 'ALL_SUCCEEDED') {
    failures += 1
    console.error('    FAIL: 期望全部成功')
  }
  if (item.name.startsWith('B') || item.name.startsWith('D')) {
    const emailResult = results.find((channel) => channel.channel === 'EMAIL')
    if (overall !== 'PARTIAL_SUCCESS' && email.notifier !== undefined) {
      failures += 1
      console.error('    FAIL: 期望部分成功')
    }
    if (emailResult !== undefined && emailResult.status !== 'SENT') {
      failures += 1
      console.error('    FAIL: SMTP 接受后邮件渠道被误标为失败')
    }
    if (overall === 'ALL_FAILED') {
      failures += 1
      console.error('    FAIL: 邮件已成功却报告全部失败')
    }
  }
  if (item.name.startsWith('C') && overall !== 'ALL_FAILED') {
    failures += 1
    console.error('    FAIL: 期望全部失败')
  }
}

if (process.platform !== 'win32') {
  console.log('\n提示：当前不是 win32，桌面通知渠道会被报告为已跳过。')
}

if (failures > 0) {
  console.error(`\nNotification channel smoke FAILED (${failures} assertion(s)).`)
  process.exitCode = 1
} else {
  console.log('\nNotification channel smoke PASSED.')
}
