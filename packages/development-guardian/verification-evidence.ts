import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  GuardianCommandResult,
} from './claude-code-executor.js'
import type {
  VerificationFailureClassification,
  VerificationFailurePhase,
  VerificationFirstFailure,
  VerificationResult,
} from './model.js'
import { redactSensitiveText } from './work-session/failure-classification.js'

const FIRST_FAILURE_LIMIT = 8_000
const DETAILS_LIMIT = 4_000

function combinedOutput(result: GuardianCommandResult): string {
  const sections: string[] = []
  if (result.stdout.length > 0) sections.push(`[stdout]\n${result.stdout}`)
  if (result.stderr.length > 0) sections.push(`[stderr]\n${result.stderr}`)
  return sections.join('\n')
}

function exceptionTypeFrom(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:^|\n)(?:E\s+)?([A-Za-z_][\w.]*(?:Error|Exception))(?::|\s|$)/gmu)]
  return matches.at(-1)?.[1]
}

function failurePhase(text: string): VerificationFailurePhase {
  if (/ImportError while importing|ModuleNotFoundError|\bimport error\b/iu.test(text)) return 'import'
  if (/errors? during collection|\bcollect(?:ion|ing)\b/iu.test(text)) return 'collection'
  if (/alembic|migration|upgrade head|database bootstrap/iu.test(text) &&
      /ERROR at setup|fixture|setup failed|bootstrap/iu.test(text)) return 'migration/bootstrap'
  if (/scope\s*=\s*["']session["']|session[- ]scoped|session fixture|pytest_sessionstart/iu.test(text)) {
    return 'setup/session fixture'
  }
  if (/scope\s*=\s*["']module["']|module[- ]scoped|module fixture/iu.test(text)) {
    return 'setup/module fixture'
  }
  if (/ERROR at setup|fixture[^\n]*(?:setup|failed)|setup failed/iu.test(text)) return 'setup/fixture'
  if (/FAILED|AssertionError|\btest_[A-Za-z0-9_]+\b/iu.test(text)) return 'test'
  return 'unknown'
}

function firstFailureSnippet(text: string): string {
  const markers = [
    /_{2,}\s+ERROR at setup of[^\n]*_{2,}/iu,
    /_{2,}\s+ERROR collecting[^\n]*_{2,}/iu,
    /Traceback \(most recent call last\):/iu,
    /(?:^|\n)(?:E\s+)?[A-Za-z_][\w.]*(?:Error|Exception)(?::|\s|$)/mu,
    /(?:^|\n)E\s+.+/mu,
  ]
  let start = 0
  for (const marker of markers) {
    const match = marker.exec(text)
    if (match !== null) {
      start = Math.max(0, match.index - 240)
      break
    }
  }
  return text.slice(start, start + FIRST_FAILURE_LIMIT).trim()
}

function failureTitle(snippet: string, exceptionType: string | undefined): string {
  const exceptionLine = snippet
    .split(/\r?\n/u)
    .map((line) => line.replace(/^E\s+/u, '').trim())
    .find((line) =>
      line.length > 0 &&
      (exceptionType === undefined ? /(?:Error|Exception)(?::|\s|$)/u.test(line) : line.includes(exceptionType)),
    )
  if (exceptionLine !== undefined) return exceptionLine.slice(0, 500)
  const heading = snippet.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)
  return (heading ?? 'Verification command failed').slice(0, 500)
}

function finalSummary(text: string, exitCode: number | null): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const pytest = [...lines].reverse().find((line) =>
    /(?:=+\s*)?(?:\d+\s+(?:failed|errors?|passed|skipped))(?:[,\s]|$)/iu.test(line),
  )
  return (pytest ?? `verification exited with code ${String(exitCode)}`).slice(0, 1_000)
}

function affectedTestsFrom(text: string): number | undefined {
  const counts = [...text.matchAll(/\b(\d+)\s+(?:errors?|failed)(?:\s|,|=|$)/giu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
  if (counts.length > 0) return Math.max(...counts)
  const setupHeadings = text.match(/ERROR at setup of/giu)?.length ?? 0
  return setupHeadings > 0 ? setupHeadings : undefined
}

function rootCauseSignatures(text: string): string[] {
  const lines = text
    .split(/\r?\n/u)
  const terminalLines = lines.filter((line) => /^E\s+/u.test(line))
  const signatures = (terminalLines.length > 0 ? terminalLines : lines)
    .map((line) => line.replace(/^E\s+/u, '').trim())
    .filter((line) => /[A-Za-z_][\w.]*(?:Error|Exception)(?::|\s|$)/u.test(line))
    .map((line) => line.replace(/\s+/gu, ' ').slice(0, 1_000))
  return [...new Set(signatures)]
}

function rootCauseCount(
  text: string,
  phase: VerificationFailurePhase,
  affectedTests: number | undefined,
): number {
  const signatures = rootCauseSignatures(text)
  if (signatures.length > 0) return signatures.length
  if (affectedTests !== undefined && affectedTests > 1 && phase !== 'test' && phase !== 'unknown') return 1
  return 1
}

function classifyFailure(
  text: string,
  exceptionType: string | undefined,
): VerificationFailureClassification {
  const unreachableSignal =
    /\bECONNREFUSED\b|connection (?:was )?refused|actively refused|could not connect to server|unable to connect to (?:the )?server|failed to establish a new connection|is the server running[^\n]*accepting connections/iu.test(text)
  const serviceContext =
    /OperationalError|ConnectionRefusedError|OSError|psycopg|sqlalchemy|database|server|socket|connect/iu.test(
      `${exceptionType ?? ''}\n${text}`,
    )
  if (unreachableSignal && serviceContext) return 'ENVIRONMENT_REQUIRED'

  if (/docker daemon/iu.test(text) && /not running|unavailable|cannot connect|failed to connect/iu.test(text)) {
    return 'ENVIRONMENT_REQUIRED'
  }
  const venvTargetMissing =
    /\.venv[/\\]Scripts[/\\]python\.exe/iu.test(text) &&
    /no such file or directory|\bENOENT\b|the system cannot find the file specified/iu.test(text)
  const hostPythonUnavailable =
    /['"]?python['"]?(?:\.exe)? is not recognized|python(?:\.exe)?: command not found|no module named ['"]?venv['"]?|ensurepip[^\n]*(?:not available|unavailable|error)/iu.test(text)
  // A missing repository-local venv is a recoverable bootstrap prerequisite
  // when the host Python runtime itself remains available.
  if (venvTargetMissing && !hostPythonUnavailable) return 'CODE_VERIFICATION_FAILED'
  if (
    /(?:command not found|is not recognized|no such file or directory|\bENOENT\b|the system cannot find the file specified)/iu.test(text) &&
    /(?:executable|interpreter|python(?:\.exe)?|node(?:\.exe)?|docker(?:\.exe)?|runtime)/iu.test(text)
  ) {
    return 'ENVIRONMENT_REQUIRED'
  }
  return 'CODE_VERIFICATION_FAILED'
}

function boundedDetails(firstFailure: VerificationFirstFailure, summary: string): string {
  return `${firstFailure.title}\n${firstFailure.tracebackSnippet}\n${summary}`.slice(0, DETAILS_LIMIT)
}

export interface VerificationEvidenceInput {
  command: string
  result: GuardianCommandResult
  durationMs: number
  rawOutputRef?: string
}

export function buildVerificationResult(input: VerificationEvidenceInput): VerificationResult {
  if (input.result.exitCode === 0) {
    return {
      name: input.command,
      status: 'passed',
    }
  }

  const redacted = redactSensitiveText(combinedOutput(input.result))
  const snippet = firstFailureSnippet(redacted)
  const exceptionType = exceptionTypeFrom(snippet)
  const phase = failurePhase(redacted)
  const firstFailure: VerificationFirstFailure = {
    title: failureTitle(snippet, exceptionType),
    ...(exceptionType === undefined ? {} : { exceptionType }),
    tracebackSnippet: snippet,
    phase,
  }
  const summary = finalSummary(redacted, input.result.exitCode)
  const affectedTests = affectedTestsFrom(redacted)
  return {
    name: input.command,
    status: 'failed',
    exitCode: input.result.exitCode,
    durationMs: input.durationMs,
    details: boundedDetails(firstFailure, summary),
    firstFailure,
    classification: classifyFailure(redacted, exceptionType),
    ...(input.rawOutputRef === undefined ? {} : { rawOutputRef: input.rawOutputRef }),
    finalSummary: summary,
    rootCauseCount: rootCauseCount(redacted, phase, affectedTests),
    ...(affectedTests === undefined ? {} : { affectedTests }),
  }
}

function safeArtifactStem(taskId: string, iteration: number, index: number, command: string): string {
  const safeTask = taskId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'task'
  const digest = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 12)
  return `${safeTask}-i${iteration}-v${index}-${digest}-${randomUUID()}`
}

/** Persist complete redacted stdout/stderr outside the target worktree. */
export async function persistVerificationOutput(options: {
  directory?: string
  taskId: string
  iteration: number
  index: number
  command: string
  result: GuardianCommandResult
}): Promise<string | undefined> {
  if (options.directory === undefined) return undefined
  await mkdir(options.directory, { recursive: true })
  const stem = safeArtifactStem(options.taskId, options.iteration, options.index, options.command)
  const finalPath = join(options.directory, `${stem}.log`)
  const temporaryPath = join(options.directory, `${stem}.tmp`)
  const content = redactSensitiveText([
    `command: ${options.command}`,
    `exitCode: ${String(options.result.exitCode)}`,
    `signal: ${String(options.result.signal)}`,
    combinedOutput(options.result),
  ].join('\n'))
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporaryPath, finalPath)
  return finalPath
}

export function environmentVerificationFailure(
  results: readonly VerificationResult[],
): VerificationResult | undefined {
  return results.find(
    (result) => result.status === 'failed' && result.classification === 'ENVIRONMENT_REQUIRED',
  )
}
