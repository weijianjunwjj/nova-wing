import nodemailer from 'nodemailer'

import {
  projectNameFromNotification,
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
  const project = singleLine(projectNameFromNotification(notification))
  const category = singleLine(notification.humanRequired.category)
  return `[NovaWing] 需要你处理：${project} / ${category}`
}

export function renderNotificationText(notification: HumanRequiredNotification): string {
  const completed = notification.progress.completedTaskIds.length === 0
    ? 'None'
    : notification.progress.completedTaskIds.join(', ')
  const currentTask = notification.progress.currentTaskId ?? 'None'
  const resumeLocation = notification.control.localUrl === undefined
    ? 'Open the NovaWing local control panel on this machine.'
    : notification.control.localUrl
  return [
    'NovaWing paused because human input is required.',
    '',
    `Project: ${projectNameFromNotification(notification)}`,
    `Branch: ${notification.session.branch}`,
    `Session: ${notification.session.id}`,
    `Completed: ${completed}`,
    `Current task: ${currentTask}`,
    `Category: ${notification.humanRequired.category}`,
    `Reason: ${notification.humanRequired.reason}`,
    '',
    'Recommended action:',
    notification.recommendation ?? 'Review the current blocker in the NovaWing control panel.',
    '',
    'Resume:',
    resumeLocation,
    notification.control.instruction,
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
