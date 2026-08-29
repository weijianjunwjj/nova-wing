import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

export const VERIFICATION_APPROVAL_BLOCKER =
  'verification command requires human approval: '

export function verificationCommandFingerprint(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

/** Strictly a display-safe deterministic command, never a shell-language grant. */
function isSafeApprovalCommand(command: string): boolean {
  return command.length > 0 && command.length <= 500 &&
    !/[\r\n\0]/.test(command) &&
    !['*', '?', '[', ']', '`', '$'].some((character) => command.includes(character)) &&
    !/(?:token|secret|password|credential|authorization|cookie|api[_-]?key)/i.test(command)
}

/**
 * The only non-global verification command eligible for user approval. This is
 * deliberately a parser for one known deterministic verifier, not a shell
 * policy: `cd <repo-relative-dir> && <repo .venv python> -m alembic upgrade head`.
 */
export function isEligibleScopedVerificationCommand(
  command: string,
  targetRepo: string,
): boolean {
  if (!isSafeApprovalCommand(command)) return false
  const match = /^cd ([A-Za-z0-9._/-]+) && ([A-Za-z0-9._/-]+) -m alembic upgrade head$/.exec(command)
  if (match === null) return false
  const [, cwdText, executableText] = match
  if (cwdText === undefined || executableText === undefined || isAbsolute(cwdText) || isAbsolute(executableText)) {
    return false
  }
  const repo = resolve(targetRepo)
  const cwd = resolve(repo, cwdText)
  const cwdRelation = relative(repo, cwd)
  if (cwdRelation === '..' || cwdRelation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(cwdRelation)) {
    return false
  }
  return resolve(cwd, executableText) === resolve(repo, '.venv', 'Scripts', 'python.exe')
}
