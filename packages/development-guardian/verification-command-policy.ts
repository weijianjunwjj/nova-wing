import { VENV_PYTEST_COMMANDS } from './platform/executables.js'
import { createHash } from 'node:crypto'

export type VerificationAdmission = 'ALLOWED' | 'APPROVAL_REQUIRED' | 'UNSUPPORTED'

export interface VerificationCommandAdmission {
  status: VerificationAdmission
  reason: string
}

export interface NormalizedNpmTestScript {
  originalCommand: string
  command: string
  sourceFingerprint: string
  reason: string
}

const EXACT_ALLOWED = new Set([
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm run check',
  'git diff --check',
  ...VENV_PYTEST_COMMANDS,
])

export function deterministicVerificationCapabilities(): string[] {
  return [...EXACT_ALLOWED]
}

function unquoteSingleArgument(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1)
    return /["\\$`]/u.test(inner) ? undefined : inner
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1)
    return inner.includes("'") ? undefined : inner
  }
  return /\s/u.test(trimmed) ? undefined : trimmed
}

export function scopedNodeTestPath(command: string): string | undefined {
  const match = /^node(?:\.exe)?\s+--test\s+(.+)$/iu.exec(command.trim())
  if (match === null) return undefined
  const path = unquoteSingleArgument(match[1]!)?.replaceAll('\\', '/')
  if (path === undefined || path.length === 0 || path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.includes('//')) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*\.(?:cjs|mjs|js|ts)$/u.test(path)) return undefined
  if (path.split('/').some((part) => part === '..' || part === '.')) return undefined
  return path
}

export function canonicalScopedNodeTest(path: string): string {
  return `node --test ${path.includes(' ') ? JSON.stringify(path) : path}`
}

/** Shared admission policy used by planning and the guarded verifier. */
export function assessVerificationCommand(command: string): VerificationCommandAdmission {
  const trimmed = command.trim()
  if (EXACT_ALLOWED.has(trimmed) || scopedNodeTestPath(trimmed) !== undefined) {
    return { status: 'ALLOWED', reason: 'command matches the deterministic verifier allowlist' }
  }
  if (/^(?:npm|pnpm|yarn)(?:\s+run)?\s+[^\s]+$/iu.test(trimmed)) {
    return { status: 'APPROVAL_REQUIRED', reason: 'package script is not an automatically allowed verifier command' }
  }
  if (/^(?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest|\.venv[\\/])/iu.test(trimmed)) {
    return { status: 'APPROVAL_REQUIRED', reason: 'command requires exact runtime approval' }
  }
  return { status: 'UNSUPPORTED', reason: 'command is outside the supported deterministic verifier forms' }
}

export function npmScriptFingerprint(scripts: Readonly<Record<string, string>>, scriptName: string): string {
  return createHash('sha256').update(JSON.stringify({
    script: scripts[scriptName] ?? null,
    pre: scripts[`pre${scriptName}`] ?? null,
    post: scripts[`post${scriptName}`] ?? null,
  })).digest('hex')
}

/**
 * Normalize only a provably single node --test invocation. Lifecycle hooks,
 * missing targets and shell syntax keep the original npm command unapproved.
 */
export function normalizeNamedNpmTestScript(input: {
  scriptName: string
  scripts: Readonly<Record<string, string>>
  packageFiles: readonly string[]
}): NormalizedNpmTestScript | undefined {
  const script = input.scripts[input.scriptName]
  if (script === undefined || input.scripts[`pre${input.scriptName}`] !== undefined || input.scripts[`post${input.scriptName}`] !== undefined) return undefined
  const path = scopedNodeTestPath(script)
  if (path === undefined || !input.packageFiles.includes(path)) return undefined
  const command = canonicalScopedNodeTest(path)
  if (assessVerificationCommand(command).status !== 'ALLOWED') return undefined
  return {
    originalCommand: `npm run ${input.scriptName}`,
    command,
    sourceFingerprint: npmScriptFingerprint(input.scripts, input.scriptName),
    reason: `Safely normalized ${input.scriptName} to one existing scoped node --test file with no lifecycle hooks.`,
  }
}
