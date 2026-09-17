import { assessVerificationCommand } from '../../verification-command-policy.js'
import type { VerifierCommandCanonicalization } from '../risk-evidence.js'
import { classifyAcceptanceCriterion } from './acceptance-criterion.js'
export type { VerifierCommandCanonicalization } from '../risk-evidence.js'

const RESULT = /^(?:(?:并)?(?:应当|应该|应|必须|需要|需|确保)?(?:通过|成功)|(?:and\s+)?(?:(?:should|must)\s+|ensure\s+)?(?:pass|passes|succeed|succeeds))$/iu
const RESULT_LEAD = /^(?:(?:并)?(?:应当|应该|应|必须|需要|需|确保)?(?:通过|成功)(?=$|\p{Script=Han}|\s|[。.,，;；:：])|(?:and\s+)?(?:(?:should|must)\s+|ensure\s+)?(?:pass|passes|succeed|succeeds)(?=$|\s|[。,，;；:：]|\.(?:\s|$)))/iu
const PUNCTUATION = /^[\s。.,，;；:：]+|[\s。.,，;；:：]+$/gu
const COMMAND_WORD = /(?:^|[^A-Za-z0-9_./\\-])(?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest)(?:\.(?:exe|cmd))?(?=\s|$)|\.venv[\\/]/iu
const ARGUMENT = /"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/gu

/** Whole arguments only; quoted values retain their spelling in the command. */
function argumentsOf(command: string): string[] | undefined {
  const tokens = [...command.matchAll(ARGUMENT)]
  if (tokens.length === 0 || /[\r\n\u0000-\u001f;&|<>$`]/u.test(command)) return undefined
  const values: string[] = []
  let end = 0
  for (const match of tokens) {
    if (match.index !== 0 && !/^\s+$/u.test(command.slice(end, match.index))) return undefined
    const token = match[0]
    end = match.index + token.length
    if (token.startsWith('"') || token.startsWith("'")) {
      if (token.at(-1) !== token[0] || token.length < 2) return undefined
      const value = token.slice(1, -1)
      if (/["']/u.test(value)) return undefined
      values.push(value)
    } else {
      if (/["']/u.test(token)) return undefined
      values.push(token)
    }
  }
  return values
}

function testPath(value: string): boolean {
  const path = value.replaceAll('\\', '/')
  return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*\.(?:[cm]?[jt]sx?|py)$/u.test(path) &&
    !path.split('/').some((part) => part === '..' || part === '.' || part.length === 0)
}

/**
 * This is an extraction grammar, not an execution allowlist. In particular,
 * scoped npm / pytest commands still need the existing policy's exact approval.
 * Unknown flags, free-form selectors and shell expressions require an explicit
 * command field: a prose suffix could otherwise be an argument to that flag.
 */
function completeCommand(command: string): boolean {
  const args = argumentsOf(command)
  if (args === undefined) return false
  if (assessVerificationCommand(normalizeSpacing(command)).status === 'ALLOWED') return true
  if (/^(?:npm|pnpm|yarn)$/u.test(args[0]!)) {
    const scriptIndex = args[1] === 'run' ? 2 : 1
    const script = args[scriptIndex]
    if (script === undefined || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(script)) return false
    // Only npm lifecycle/script syntax, never arbitrary npm subcommands.
    if (scriptIndex === 1 && !['test', 'build', 'lint', 'check', 'typecheck'].includes(script)) return false
    const rest = args.slice(scriptIndex + 1)
    return rest.length === 0 || (rest[0] === '--' && rest.length > 1 && rest.slice(1).every(testPath))
  }
  if (args[0] === 'pytest') return args.slice(1).every(testPath)
  if (/^\.venv[\\/]Scripts[\\/]python\.exe$/u.test(args[0]!) && args[1] === '-m' && args[2] === 'pytest') {
    return args.slice(3).every(testPath)
  }
  return false
}

/** Only boundaries outside quoted arguments are eligible for prose removal. */
function resultBoundaries(text: string, completeResult = true): number[] {
  const boundaries: number[] = []
  let quote: string | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/[\s。.,，;；:：]/u.test(char) && (completeResult ? RESULT : RESULT_LEAD).test(text.slice(index).replace(PUNCTUATION, ''))) boundaries.push(index)
  }
  return boundaries
}

function normalizeSpacing(command: string): string {
  return [...command.matchAll(ARGUMENT)].map((match) => match[0]).join(' ')
}

export function extractAcceptanceVerifier(sourceText: string): { command: string; canonicalization: VerifierCommandCanonicalization } | undefined {
  if (classifyAcceptanceCriterion(sourceText) !== 'COMMAND_BEARING') return undefined
  const text = sourceText.trim()
  if (text.length === 0 || text.length > 500 || /[\r\n\u0000-\u001f]/u.test(text)) return undefined
  // An imperative must be at the start; never search inside conditional prose.
  const body = text.replace(/^(?:(?:运行|执行)\s*|run\s+)/iu, '')
  let command: string | undefined
  if (completeCommand(body)) command = body
  else {
    const candidates = resultBoundaries(body).map((index) => body.slice(0, index).trimEnd()).filter(completeCommand)
    const unique = [...new Set(candidates)]
    if (unique.length === 1) command = unique[0]
  }
  if (command === undefined) return undefined
  if (command !== text) command = normalizeSpacing(command)
  const assessment = assessVerificationCommand(command).status
  if (assessment === 'UNSUPPORTED') return undefined
  return { command, canonicalization: { sourceText, command, grammar: 'acceptance-command-v1', assessment } }
}

/** Reject prose in dedicated command fields before approval classification. */
export function hasUncanonicalizedVerifierText(command: string): boolean {
  const extracted = extractAcceptanceVerifier(command)
  if (extracted !== undefined) return extracted.command !== command.trim()
  if (!COMMAND_WORD.test(command)) return false
  if (/^(?:运行|执行|run\s)/iu.test(command)) return true
  // Inspect result clauses before shell separators as well, without looking
  // inside quoted program text / option values or treating a chain as one command.
  const clauses: string[] = []
  let quote: string | undefined
  let start = 0
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === '"' || char === "'") quote = char
    else if (/[;&|\r\n]/u.test(char)) { clauses.push(command.slice(start, index)); start = index + 1 }
  }
  clauses.push(command.slice(start))
  return clauses.some((clause) => {
    if (completeCommand(clause.trim())) return false
    if (resultBoundaries(clause, false).some((index) => completeCommand(clause.slice(0, index).trim()))) return true
    const index = resultBoundaries(clause)[0]
    if (index === undefined) return false
    const prefix = clause.slice(0, index).trimEnd()
    // A result word can be an option value. Never truncate that argument.
    return !/(?:^|\s)--[A-Za-z][\w-]*$/u.test(prefix)
  })
}
