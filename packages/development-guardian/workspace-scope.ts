import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GuardianTask } from './model.js'
import { normalizePath } from './work-session/worktree-fingerprint.js'

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

/** `.` covers the whole workspace; a trailing `/**` covers a subtree. */
function matchesPathRule(path: string, rule: string): boolean {
  const normalizedPath = normalizeScopePath(path)
  const normalizedRule = normalizeScopePath(rule)
  if (normalizedRule === '.') return normalizedPath !== '..' && !normalizedPath.startsWith('../') && !normalizedPath.startsWith('/')
  if (normalizedRule.endsWith('/**')) {
    const prefix = normalizedRule.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`)
}

function normalizeScopePath(value: string): string {
  return normalizePath(value).replace(/\/$/u, '')
}

/**
 * Pure scope verdict for an already workspace-relative path set.  Callers that
 * only have a canonical root use this; `scopeBlockers` adds the
 * configured-rule normalization used by the executor boundary.
 *
 * Every path that reaches this point is a tracked, meaningful change, so it is
 * checked individually and never blanket-ignored by directory name.
 */
export function scopeViolations(input: {
  changedFiles: readonly string[]
  allowedPaths?: readonly string[] | undefined
  forbiddenPaths?: readonly string[] | undefined
}): string[] {
  const blockers: string[] = []
  const { changedFiles, allowedPaths, forbiddenPaths } = input
  if (allowedPaths !== undefined && allowedPaths.length > 0) {
    for (const path of changedFiles) {
      if (!allowedPaths.some((rule) => matchesPathRule(path, rule))) {
        blockers.push(`changed file is outside allowed scope: ${path}`)
      }
    }
  }
  if (forbiddenPaths !== undefined) {
    for (const path of changedFiles) {
      if (forbiddenPaths.some((rule) => matchesPathRule(path, rule))) {
        blockers.push(`changed file is inside forbidden scope: ${path}`)
      }
    }
  }
  return blockers
}
