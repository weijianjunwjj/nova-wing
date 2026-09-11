import nodemailer from 'nodemailer'

import {
  presentHumanRequiredCategory,
  projectNameFromNotification,
  type WorkSessionCompletedNotification,
  type WorkSessionFailedNotification,
  type WorkSessionRecoveryRequiredNotification,
  type HumanRequiredNotification,
  type WorkSessionNotifier,
} from './notifier.js'

export interface SmtpTransportConfig {
  host: string
  port: number
  secure: boolean
  auth: {
    user: string
    pass: string
  }
}

export interface SmtpMailOptions {
  from: string
  to: string
  subject: string
  text: string
}

export interface SmtpMailTransport {
  sendMail(options: SmtpMailOptions): Promise<unknown>
}

export interface SmtpWorkSessionNotifierOptions {
  transport: SmtpMailTransport
  from: string
  to: string
}

export interface SmtpNotifierEnvironmentOptions {
  env?: NodeJS.ProcessEnv
  createTransport?: (config: SmtpTransportConfig) => SmtpMailTransport
}

export class SmtpWorkSessionNotifier implements WorkSessionNotifier {
  /**
   * `sendMail` resolves only once the SMTP server accepted the message, so a
   * resolved send is a real SENT for this channel and a later, unrelated
   * channel failure must never rewrite it.
   */
  readonly notificationChannel = 'EMAIL' as const
  readonly notificationKinds = ['HUMAN_REQUIRED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'] as const
  private readonly transport: SmtpMailTransport
  private readonly from: string
  private readonly to: string

  constructor(options: SmtpWorkSessionNotifierOptions) {
    this.transport = options.transport
    this.from = options.from
    this.to = options.to
  }

  async notifyHumanRequired(notification: HumanRequiredNotification): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject: renderNotificationSubject(notification),
      text: renderNotificationText(notification),
    })
  }

  async notifyCompleted(notification: WorkSessionCompletedNotification): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject: renderCompletedNotificationSubject(notification),
      text: renderCompletedNotificationText(notification),
    })
  }

  async notifyFailed(notification: WorkSessionFailedNotification): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject: renderFailedNotificationSubject(notification),
      text: renderFailedNotificationText(notification),
    })
  }

  async notifyRecoveryRequired(notification: WorkSessionRecoveryRequiredNotification): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: this.to,
      subject: renderRecoveryRequiredNotificationSubject(notification),
      text: renderRecoveryRequiredNotificationText(notification),
    })
  }
}

export function createSmtpWorkSessionNotifierFromEnv(
  options: SmtpNotifierEnvironmentOptions = {},
): SmtpWorkSessionNotifier {
  const env = options.env ?? process.env
  const host = requireEnv(env, 'NOVAWING_SMTP_HOST')
  const port = parsePort(requireEnv(env, 'NOVAWING_SMTP_PORT'))
  const secure = parseSecure(requireEnv(env, 'NOVAWING_SMTP_SECURE'))
  const user = requireEnv(env, 'NOVAWING_SMTP_USER')
  const pass = requireEnv(env, 'NOVAWING_SMTP_PASS')
  const from = requireSingleLineEnv(env, 'NOVAWING_NOTIFY_FROM')
  const to = requireSingleLineEnv(env, 'NOVAWING_NOTIFY_TO')
  const config: SmtpTransportConfig = {
    host,
    port,
    secure,
    auth: { user, pass },
  }
  const transport = options.createTransport?.(config) ?? nodemailer.createTransport(config)
  return new SmtpWorkSessionNotifier({ transport, from, to })
}

export function renderNotificationSubject(notification: HumanRequiredNotification): string {
  const task = notification.progress.currentTaskId ?? '未知 Task'
  return `[NovaWing] 需要人工处理：${singleLine(task)}`
}

export function renderNotificationText(notification: HumanRequiredNotification): string {
  const completed = notification.progress.completedTaskIds.length === 0
    ? '无'
    : notification.progress.completedTaskIds.join(', ')
  const currentTask = notification.progress.currentTaskId ?? '无'
  const resumeLocation = notification.control.localUrl === undefined
    ? '请在此机器上打开本地 NovaWing Work Session 控制台。'
    : notification.control.localUrl
  return [
    'NovaWing Work Session 需要人工处理。',
    '',
    `项目：${projectNameFromNotification(notification)}`,
    `分支：${notification.session.branch}`,
    `Work Session：${notification.session.id}`,
    `已完成 Task：${completed}`,
    `当前 Task：${currentTask}`,
    '状态：已暂停',
    `类别：${presentHumanRequiredCategory(notification.humanRequired.category)}`,
    '',
    '原因：',
    notification.humanRequired.reason,
    '',
    '建议操作：',
    notification.recommendation ?? '请在 NovaWing Work Session 控制台检查当前阻塞原因。',
    '',
    '控制台：',
    resumeLocation,
    notification.control.instruction,
  ].join('\n')
}

export function renderCompletedNotificationSubject(
  notification: WorkSessionCompletedNotification,
): string {
  void notification
  return '[NovaWing] Work Session 已完成'
}

export function renderCompletedNotificationText(
  notification: WorkSessionCompletedNotification,
): string {
  const completed = notification.completedTaskIds.length === 0
    ? '无'
    : notification.completedTaskIds.join(', ')
  return [
    'NovaWing Work Session 已完成。',
    '',
    `项目：${projectNameFromNotification(notification)}`,
    `分支：${notification.session.branch}`,
    `Work Session：${notification.session.id}`,
    `已完成 Task：${completed}`,
    '状态：已完成',
    ...(notification.activeElapsedMs === undefined
      ? []
      : [`已运行时间：${formatDuration(notification.activeElapsedMs)}`]),
  ].join('\n')
}

export function renderFailedNotificationSubject(
  notification: WorkSessionFailedNotification,
): string {
  const task = notification.currentTaskId === null ? '' : `：${singleLine(notification.currentTaskId)}`
  return `[NovaWing] Work Session 失败${task}`
}

export function renderFailedNotificationText(
  notification: WorkSessionFailedNotification,
): string {
  const control = notification.control.localUrl ?? '请在此机器上打开本地 NovaWing Work Session 控制台。'
  return [
    'NovaWing Work Session 执行失败。',
    '',
    `项目：${projectNameFromNotification(notification)}`,
    `分支：${notification.session.branch}`,
    `Work Session：${notification.session.id}`,
    `当前 Task：${notification.currentTaskId ?? '无'}`,
    '状态：FAILED',
    `失败阶段：${notification.failureStage}`,
    `失败类别：${notification.failureCategory}`,
    ...(notification.activeElapsedMs === undefined
      ? []
      : [`已运行时间：${formatDuration(notification.activeElapsedMs)}`]),
    '',
    '安全失败原因：',
    notification.safeReason,
    '',
    '控制台：',
    control,
  ].join('\n')
}

export function renderRecoveryRequiredNotificationSubject(
  notification: WorkSessionRecoveryRequiredNotification,
): string {
  const task = notification.currentTaskId === null ? '' : `：${singleLine(notification.currentTaskId)}`
  return `[NovaWing] 需要恢复基础设施${task}`
}

export function renderRecoveryRequiredNotificationText(
  notification: WorkSessionRecoveryRequiredNotification,
): string {
  const control = notification.control.localUrl ?? '请在此机器上打开本地 NovaWing Work Session 控制台。'
  const stage = notification.stage === 'FINAL_REVIEW' ? 'Final Review' : 'Brain Review'
  return [
    'NovaWing Work Session 因 Brain 基础设施故障暂停。',
    '',
    `项目：${projectNameFromNotification(notification)}`,
    `分支：${notification.session.branch}`,
    `Work Session：${notification.session.id}`,
    `当前 Task：${notification.currentTaskId ?? '无'}`,
    '状态：RECOVERY_REQUIRED',
    `阶段：${stage}`,
    `类别：${notification.category}`,
    '',
    '安全信息：',
    notification.safeMessage,
    '',
    '建议操作：',
    notification.recommendation,
    '',
    '控制台：',
    control,
  ].join('\n')
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when email notification is enabled`)
  }
  return value
}

function requireSingleLineEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name)
  if (/\r|\n/u.test(value)) {
    throw new Error(`${name} must be a single line`)
  }
  return value
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('NOVAWING_SMTP_PORT must be an integer between 1 and 65535')
  }
  return port
}

function parseSecure(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('NOVAWING_SMTP_SECURE must be true or false')
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim()
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds} 秒`
}
