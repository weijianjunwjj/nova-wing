import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { TrustedWorkSessionConfig } from './production.js'

export const SMTP_SECRET_KEYS = [
  'NOVAWING_SMTP_HOST',
  'NOVAWING_SMTP_PORT',
  'NOVAWING_SMTP_SECURE',
  'NOVAWING_SMTP_USER',
  'NOVAWING_SMTP_PASS',
  'NOVAWING_NOTIFY_FROM',
  'NOVAWING_NOTIFY_TO',
] as const

export type SmtpSecretKey = (typeof SMTP_SECRET_KEYS)[number]
export type SmtpSecretEnvironment = Record<SmtpSecretKey, string>

const execFileAsync = promisify(execFile)

export function defaultLocalSmtpSecretPath(
  localAppData = process.env.LOCALAPPDATA,
): string {
  if (process.platform !== 'win32') {
    throw new Error('local SMTP secret persistence is supported only on Windows')
  }
  if (localAppData === undefined || localAppData.trim().length === 0) {
    throw new Error('LOCALAPPDATA is required for local SMTP secret persistence')
  }
  return join(localAppData, 'NovaWing', 'secrets', 'smtp.json')
}

export function smtpEnvironmentFrom(source: NodeJS.ProcessEnv): SmtpSecretEnvironment | undefined {
  const values = SMTP_SECRET_KEYS.map((key) => source[key]?.trim())
  const present = SMTP_SECRET_KEYS.filter((key) => source[key] !== undefined).length
  if (present === 0) return undefined
  if (present !== SMTP_SECRET_KEYS.length) {
    throw new Error('SMTP environment must provide all 7 notification values or none')
  }
  return validateSmtpSecrets(Object.fromEntries(
    SMTP_SECRET_KEYS.map((key, index) => [key, values[index]]),
  ))
}

export function validateSmtpSecrets(value: unknown): SmtpSecretEnvironment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local SMTP secrets must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== SMTP_SECRET_KEYS.length || keys.some((key) => !SMTP_SECRET_KEYS.includes(key as SmtpSecretKey))) {
    throw new Error('local SMTP secrets contain unsupported or missing keys')
  }
  const result = {} as SmtpSecretEnvironment
  for (const key of SMTP_SECRET_KEYS) {
    const raw = record[key]
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(`local SMTP secret ${key} must be non-empty`)
    }
    result[key] = raw.trim()
  }
  const port = Number(result.NOVAWING_SMTP_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('local SMTP secret port is invalid')
  }
  if (result.NOVAWING_SMTP_SECURE !== 'true' && result.NOVAWING_SMTP_SECURE !== 'false') {
    throw new Error('local SMTP secret secure value is invalid')
  }
  for (const key of ['NOVAWING_SMTP_USER', 'NOVAWING_NOTIFY_FROM', 'NOVAWING_NOTIFY_TO'] as const) {
    if (/\r|\n/u.test(result[key])) throw new Error(`local SMTP secret ${key} must be single-line`)
  }
  return result
}

export async function loadLocalSmtpSecrets(path = defaultLocalSmtpSecretPath()): Promise<SmtpSecretEnvironment> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('SMTP notification is enabled but local secrets are not configured. Run: npm run guardian:notification:setup')
    }
    throw new Error('local SMTP secrets could not be read safely')
  }
  return validateSmtpSecrets(parsed)
}

export async function restrictWindowsSecretFileAcl(path: string, username = process.env.USERNAME): Promise<void> {
  if (process.platform !== 'win32') throw new Error('local SMTP secret persistence is supported only on Windows')
  if (username === undefined || username.trim().length === 0) throw new Error('USERNAME is required to secure local SMTP secrets')
  try {
    await execFileAsync('icacls', [
      path,
      '/inheritance:r',
      '/grant:r', `${username}:(R,W)`,
      '/grant:r', 'SYSTEM:(F)',
    ], { shell: false, windowsHide: true })
  } catch {
    throw new Error('failed to secure local SMTP secrets with Windows ACL')
  }
}

export async function saveLocalSmtpSecrets(
  input: unknown,
  options: {
    path?: string
    restrictAcl?: (path: string) => Promise<void>
  } = {},
): Promise<string> {
  const secrets = validateSmtpSecrets(input)
  const path = options.path ?? defaultLocalSmtpSecretPath()
  const temporaryPath = join(dirname(path), `.smtp-${randomUUID()}.tmp`)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(secrets)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await (options.restrictAcl ?? restrictWindowsSecretFileAcl)(temporaryPath)
    await rename(temporaryPath, path)
    return path
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error instanceof Error ? error : new Error('local SMTP secrets could not be saved safely')
  }
}

export async function resolveProductionSmtpEnvironment(
  config: TrustedWorkSessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): Promise<NodeJS.ProcessEnv> {
  if (config.notification?.email.enabled !== true) return { ...env }
  const explicit = smtpEnvironmentFrom(env)
  if (explicit !== undefined) return { ...env, ...explicit }
  return { ...env, ...(await loadLocalSmtpSecrets(path ?? defaultLocalSmtpSecretPath())) }
}
