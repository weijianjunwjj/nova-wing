import { homedir } from 'node:os'
import { posix, win32, resolve } from 'node:path'

export interface PlatformPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  userHome?: string
}

/** All local state roots live here. Overrides are explicit, independent of host OS. */
export function platformPaths(options: PlatformPathOptions = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.userHome ?? homedir()
  const path = platform === 'win32' ? win32 : posix
  const absolute = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed && path.isAbsolute(trimmed) ? trimmed : undefined
  }
  const base = platform === 'win32'
    ? path.join(absolute(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local'), 'NovaWing')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'NovaWing')
      : path.join(absolute(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share'), 'NovaWing')
  const data = absolute(env.NOVAWING_DATA_DIR) ?? base
  const config = platform === 'linux'
    ? path.join(absolute(env.XDG_CONFIG_HOME) ?? path.join(home, '.config'), 'NovaWing') : base
  return {
    data, config,
    trustedConfig: absolute(env.NOVAWING_CONFIG_DIR) ?? path.join(config, 'canary-configs'),
    secrets: path.join(config, 'secrets'),
    smtpSecret: path.join(config, 'secrets', 'smtp.json'),
    sessions: path.join(data, 'work-sessions'),
    codingExecution: path.join(data, 'coding-executors.sqlite'),
    analytics: path.join(data, 'work-sessions', 'task-run-analytics.db'),
    runtimeRepairAudit: path.join(data, 'runtime-repair-audit.log'),
    repairAudit: path.join(data, 'repair-audit.log'),
    decisionShadowRecords: path.join(data, 'decision-shadow.jsonl'),
    eta: path.join(data, 'runtime-ui', 'eta'),
  }
}

export function resolveHostArgumentPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const match = /^\/([a-z])\/(.*)$/iu.exec(value)
    if (match) return win32.resolve(`${match[1]}:/`, match[2]!)
  }
  return resolve(value)
}

/** Windows paths compare case-insensitively; POSIX paths preserve their identity. */
export function workspacePathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? value.toLowerCase() : value
}
