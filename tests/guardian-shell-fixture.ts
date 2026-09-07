import {
  guardianShellCommand,
  type GuardianShellCommand,
} from '../packages/development-guardian/shell-contract.js'
import type { GuardianCommandRequest } from '../packages/development-guardian/claude-code-executor.js'

/**
 * Test seam for commands issued by ClaudeCodeExecutor.
 *
 * Deriving the expected executable from the production contract keeps Windows
 * fixtures independent of a particular Git for Windows installation path while
 * retaining the legacy non-Windows `bash -lc` behavior.
 */
export function guardianShellTestCommand(command: string): GuardianShellCommand {
  return guardianShellCommand(command)
}

export function isGuardianShellRequest(
  request: GuardianCommandRequest,
): boolean {
  const expected = guardianShellTestCommand('')
  return request.executable === expected.executable
    && request.args[0] === '-lc'
    && typeof request.args[1] === 'string'
    && (process.platform !== 'win32' || request.nativeGitBash === true)
}

export function guardianShellPayload(
  request: GuardianCommandRequest,
): string | undefined {
  return isGuardianShellRequest(request) ? request.args[1] : undefined
}

export function isClaudeShellRequest(request: GuardianCommandRequest): boolean {
  return guardianShellPayload(request)?.includes('claude') ?? false
}
