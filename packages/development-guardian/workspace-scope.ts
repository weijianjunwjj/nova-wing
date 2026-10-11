import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GuardianTask } from './model.js'

/** Launchpad's existing protected paths, shared with exact recovery-policy validation. */
export const DEFAULT_WORKSPACE_FORBIDDEN_PATHS = ['.env', '**/.env', '**/*secret*', '**/*credential*'] as const

/**
 * Executor boundary: every scope rule inside the workspace is workspace-relative;
 * `.` means the whole repository. Legacy canonical absolute configuration is
 * converted here, never matched directly against a relative tool path.
 * Tool operation paths remain strictly relative (this adapter is NOT for them).
 */
export async function taskWorkspaceScope(root: string, task: GuardianTask): Promise<GuardianTask> {
  return relativeTaskWorkspaceScope(await realpath(root), task, resolve(root))
}

/** Pure guard adapter when Repository Inspector already supplied a canonical root. */
export function relativeTaskWorkspaceScope(canonicalRoot: string, task: GuardianTask, configuredRoot = canonicalRoot): GuardianTask {
  const normalize = (rule: string): string => {
    const slash = rule.replaceAll('\\', '/').replace(/\/$/u, '')
    if (!slash || slash.includes('\0') || slash.split('/').includes('..')) throw new Error('Invalid workspace scope rule')
    let result = slash
    if (isAbsolute(rule)) {
      // Also accept the configured root's spelling (e.g. macOS /var -> /private/var).
      const candidates = [canonicalRoot, configuredRoot].map(base => relative(base, rule).replaceAll('\\', '/'))
      const inside = candidates.find(path => !isAbsolute(path) && path !== '..' && !path.startsWith('../'))
      if (inside === undefined) throw new Error('Absolute scope is outside the workspace')
      result = inside || '.'
    } else if (slash.includes(':') || slash.startsWith('/')) {
      throw new Error('Invalid workspace scope coordinates')
    }
    result = result.replace(/^\.\//u, '').replace(/\/$/u, '')
    if (result !== '.' && result.split('/').some(part => !part || part === '.')) throw new Error('Invalid workspace scope rule')
    return result
  }
  return { ...task,
    ...(task.allowedPaths === undefined ? {} : { allowedPaths: task.allowedPaths.map(normalize) }),
    ...(task.forbiddenPaths === undefined ? {} : { forbiddenPaths: task.forbiddenPaths.map(normalize) }) }
}
