import { commandEnvironment } from '../platform/environment.js'
/**
 * NovaWing v0.2.4 — Reviewer Runtime adapters.
 *
 * 每个 adapter 只服务一个 provider，且全部只读。它们共享同一 prompt / verdict 解析，
 * 因此新增 provider 只需新增一个 adapter 并注册，不需要改 TaskController 语义。
 */

import { spawn } from 'node:child_process'

import { hasDeepSeekRoute, resolveClaudeProviderEnvironment } from '../deepseek-executor.js'
import { guardianShellCommand, type GuardianShellContractOptions } from '../shell-contract.js'
import { CODING_EXECUTOR_DEFAULTS } from '../coding-executor-config.js'
import type { GuardianCommandRequest, GuardianCommandResult, GuardianCommandRunner } from '../claude-code-executor.js'
import {
  createCodexRepairModelRunner,
  REPAIR_DEFAULT_REASONING_EFFORT,
  type RepairModelRunner,
} from './launchpad/repair-model.js'
import type { ReviewerOutcome, ReviewerReviewInput, ReviewerRuntime, ReviewerTaskContext } from './reviewer-runtime.js'
import { acceptanceAssertionIds, type AssertionReviewVerdict } from './risk-evidence.js'

/** A real repository review is slower than a contract repair turn. */
export const REVIEW_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
/** DeepSeek is reached through the existing Claude CLI provider route. */
export const REVIEW_DEFAULT_MODEL = 'sonnet'
/**
 * A reviewer must read the diff, the changed files and the verification evidence
 * before deciding, so the turn budget is deliberately generous: a review that runs
 * out of turns produces no verdict and is reported as a reviewer runtime failure.
 */
export const REVIEW_DEFAULT_MAX_TURNS = 40

/**
 * Reviewer 只被授予只读工具。任何写操作（Edit / Write / NotebookEdit / 任意写 shell）
 * 都不在 allowlist 中，且不启用 acceptEdits，因此在非交互模式下会被 provider 拒绝。
 */
export const REVIEWER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
] as const

export const REVIEWER_SYSTEM_PROMPT = [
  'You are the NovaWing independent Reviewer.',
  'A coding agent implemented a Task. You must judge ONLY whether the implementation satisfies the Task Contract.',
  '',
  'Hard rules:',
  '- You are READ-ONLY. You must not modify, create, or delete any file.',
  '- You must not commit, reset, restore, push, or merge.',
  '- You must not change the goal, acceptance criteria, allowed paths, forbidden paths, or risk.',
  '- You must not approve anything and you must not mark the task complete.',
  '- Inspect the repository and the deterministic verification evidence before deciding.',
  '- Judge only what the evidence proves. Do not assume unverified claims are true.',
  '',
  'Work efficiently: start with `git diff` and the changed files listed below, read only',
  'what you need, and answer as soon as you have enough evidence. Do not survey the',
  'whole repository.',
  '',
  'Answer with ONE JSON object and nothing else:',
  '{"verdict":"PASS"|"FAIL","findings":["..."],"blockingFindings":["..."],"summary":"<one or two sentences>"}',
  'When the Task contains AcceptanceAssertion IDs, also include "assertionVerdicts": [{"assertionId":"ID","verdict":"PASS"|"FAIL","evidence":"specific observed evidence"}] for every ID. Missing or unproved IDs cannot PASS.',
  'For a CapabilityContract assertion, each PASS verdict also needs capabilityEvidence with family, providerId, providerVersion, collector, evidenceIds (actual passed verification stepIds), and verificationResult="OBSERVED". A command or HTTP status alone does not prove the expected business outcome.',
  'A FAIL with at least one blockingFinding means the implementation must be revised.',
  'No prose, no markdown fences, no comments.',
].join('\n')

export interface ReviewVerdict {
  passed: boolean
  findings: readonly string[]
  blockingFindings: readonly string[]
  summary: string
  assertionVerdicts?: readonly AssertionReviewVerdict[]
}

/** Fail-closed verdict parser. Any shape deviation is a reviewer protocol failure. */
export function parseReviewVerdict(text: string): { ok: true; verdict: ReviewVerdict } | { ok: false; reason: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'reviewer returned an empty response' }
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  const candidates = [fenced?.[1]?.trim() ?? trimmed]
  // Real providers sometimes wrap the object in prose. Extract the first balanced
  // object as a fallback; the verdict is still fully validated below.
  if (!candidates[0]!.startsWith('{')) {
    const extracted = extractBalancedObject(trimmed)
    if (extracted !== undefined) candidates.push(extracted)
  }
  let parsed: unknown
  let found = false
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate) as unknown
      found = true
      break
    } catch {
      // try the next candidate
    }
  }
  if (!found) return { ok: false, reason: 'reviewer response is not valid JSON' }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'reviewer response is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.verdict !== 'PASS' && record.verdict !== 'FAIL') {
    return { ok: false, reason: 'reviewer verdict must be PASS or FAIL' }
  }
  const boundedStrings = (value: unknown): string[] | undefined =>
    value === undefined
      ? []
      : Array.isArray(value) && value.length <= 100 &&
          value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 2_000)
        ? (value as string[])
        : undefined
  const findings = boundedStrings(record.findings)
  const blockingFindings = boundedStrings(record.blockingFindings)
  if (findings === undefined || blockingFindings === undefined) {
    return { ok: false, reason: 'reviewer findings must be bounded string arrays' }
  }
  if (typeof record.summary !== 'string' || record.summary.length === 0) {
    return { ok: false, reason: 'reviewer summary must be a non-empty string' }
  }
  let assertionVerdicts: AssertionReviewVerdict[] | undefined
  if (record.assertionVerdicts !== undefined) {
    const validAssertionVerdict = (item: unknown): boolean => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
      const row = item as Record<string, unknown>
      return typeof row.assertionId === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(row.assertionId) &&
        (row.verdict === 'PASS' || row.verdict === 'FAIL') &&
        typeof row.evidence === 'string' && row.evidence.trim().length > 0 && row.evidence.length <= 2_000 &&
        (row.capabilityEvidence === undefined || (() => {
          if (row.capabilityEvidence === null || typeof row.capabilityEvidence !== 'object' || Array.isArray(row.capabilityEvidence)) return false
          const trace = row.capabilityEvidence as Record<string, unknown>
          return ['family', 'providerId', 'providerVersion', 'collector'].every((key) =>
            typeof trace[key] === 'string' && /^[A-Za-z0-9_.-]{1,120}$/u.test(trace[key] as string)) &&
            (trace.verificationResult === 'OBSERVED' || trace.verificationResult === 'FAILED') &&
            Array.isArray(trace.evidenceIds) && trace.evidenceIds.length > 0 && trace.evidenceIds.length <= 20 &&
            trace.evidenceIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(id))
        })())
    }
    if (!Array.isArray(record.assertionVerdicts) || record.assertionVerdicts.length > 100 ||
      !record.assertionVerdicts.every(validAssertionVerdict)) {
      return { ok: false, reason: 'reviewer assertion verdicts are invalid' }
    }
    assertionVerdicts = record.assertionVerdicts as AssertionReviewVerdict[]
    if (new Set(assertionVerdicts.map((item) => item.assertionId)).size !== assertionVerdicts.length) {
      return { ok: false, reason: 'reviewer assertion verdicts are duplicated' }
    }
  }
  const passed = record.verdict === 'PASS'
  // A PASS cannot carry blocking findings, and a FAIL must say what blocks completion.
  if (passed && blockingFindings.length > 0) {
    return { ok: false, reason: 'reviewer PASS carries blocking findings' }
  }
  if (!passed && blockingFindings.length === 0) {
    return { ok: false, reason: 'reviewer FAIL carries no blocking finding' }
  }
  return { ok: true, verdict: { passed, findings, blockingFindings, summary: record.summary.slice(0, 2_000),
    ...(assertionVerdicts === undefined ? {} : { assertionVerdicts }) } }
}

/** First balanced `{...}` region that parses, ignoring quoted braces. */
function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

export function buildReviewPrompt(context: ReviewerTaskContext): string {
  const list = (values: readonly string[]): string =>
    values.length === 0 ? '  (none)' : values.map((value) => `  - ${value}`).join('\n')
  return [
    `Task id: ${context.taskId}`,
    `Goal:\n${context.goal}`,
    `Constraints:\n${list(context.constraints)}`,
    `Acceptance criteria:\n${list(context.acceptanceCriteria)}`,
    ...(acceptanceAssertionIds(context.acceptanceCriteria).length === 0 ? [] : [
      `Return one assertionVerdict for each of these exact IDs: ${acceptanceAssertionIds(context.acceptanceCriteria).join(', ')}.`,
      'For every PASS, cite specific verification or repository evidence in its evidence field. If any assertion is unproved, return FAIL.',
    ]),
    `Implementer identity: ${context.implementer === undefined ? '(none)' : JSON.stringify(context.implementer)}`,
    `Providers that produced the implementation: ${context.implementerProviders.join(', ') || '(none)'}`,
    `Risk: ${context.risk}`,
    `Repository: ${context.repositoryIdentity ?? '(unknown)'}`,
    `Branch: ${context.branch ?? '(unknown)'}`,
    `HEAD: ${context.headSha ?? '(unknown)'}`,
    `Workspace fingerprint: ${context.workspaceFingerprint ?? '(unknown)'}`,
    `Changed files:\n${list(context.changedFiles)}`,
    `Deterministic verification evidence:\n${list(context.verificationEvidence.map((evidence) => `${evidence.name}: ${evidence.status}`))}`,
    `Acceptance evidence:\n${list(context.evidence.map((entry) => `${entry.type}: ${entry.status}`))}`,
    `Current blockers:\n${list(context.blockers)}`,
    '',
    'Inspect the repository in the working directory, then return your verdict JSON.',
  ].join('\n')
}

function exportShellOptions(options: { gitBashPath?: string | undefined; platform?: NodeJS.Platform | undefined }): GuardianShellContractOptions {
  return {
    ...(options.gitBashPath === undefined ? {} : { gitBashPath: options.gitBashPath }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  }
}

function reviewClaudeArgs(model: string | undefined, prompt: string, maxTurns: number): string[] {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    // Read-only by construction: no acceptEdits, and no write tool in the allowlist.
    '--permission-mode', 'default',
    '--max-turns', String(maxTurns),
  ]
  if (model !== undefined) args.push('--model', model)
  args.push('--allowedTools', ...REVIEWER_ALLOWED_TOOLS)
  return args
}

function spawnReviewCommand(request: GuardianCommandRequest): Promise<GuardianCommandResult> {
  return new Promise((resolveRun) => {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: commandEnvironment(request.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: GuardianCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(result)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => finish({ exitCode: 1, signal: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', (code, signal) => finish({ exitCode: code, signal, stdout, stderr }))
    const timer = setTimeout(() => {
      child.kill()
      finish({
        exitCode: null, signal: 'SIGTERM', terminationConfirmed: false, stdout,
        stderr: `${stderr}\nreviewer timed out after ${request.timeoutMs}ms`.trim(),
      })
    }, request.timeoutMs)
    timer.unref()
  })
}

function redactReason(value: string): string {
  return value
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\b\s*[:=]\s*\S+/giu, '$1= [redacted]')
    .slice(0, 300)
}

/** Maps a provider error string to a health status; never guesses "available". */
export function classifyReviewerProviderFailure(text: string): 'QUOTA_EXHAUSTED' | 'OFFLINE' | 'TIMEOUT' | 'DEGRADED' {
  if (/quota|usage[ _-]?limit|rate[ _-]?limit|\b402\b|\b429\b/iu.test(text)) return 'QUOTA_EXHAUSTED'
  if (/not logged in|unauthorized|\b401\b|\b403\b|api key|authentication|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/iu.test(text)) return 'OFFLINE'
  if (/timed out|timeout/iu.test(text)) return 'TIMEOUT'
  return 'DEGRADED'
}

export interface DeepSeekReviewerRuntimeOptions {
  cwd: string
  model?: string
  timeoutMs?: number
  maxTurns?: number
  gitBashPath?: string
  platform?: NodeJS.Platform
  commandRunner?: GuardianCommandRunner
  /** Test/ops seam: report whether the DeepSeek route is configured on this host. */
  routeAvailable?: () => Promise<boolean>
}

/**
 * Read-only DeepSeek reviewer. It never writes: the CLI is invoked without write
 * tools, and any attempted write shows up as a permission denial that becomes a
 * blocking finding. If the DeepSeek route is not configured it fails closed
 * instead of silently using another provider.
 */
export function createDeepSeekReviewerRuntime(options: DeepSeekReviewerRuntimeOptions): ReviewerRuntime {
  const timeoutMs = options.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS
  const maxTurns = options.maxTurns ?? REVIEW_DEFAULT_MAX_TURNS
  const runner = options.commandRunner ?? spawnReviewCommand
  const routeAvailable = options.routeAvailable ?? ((): Promise<boolean> => hasDeepSeekRoute(options.cwd))
  return {
    provider: 'deepseek',
    async review(input: ReviewerReviewInput): Promise<ReviewerOutcome> {
      if (!(await routeAvailable())) {
        return {
          kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: 'OFFLINE',
          reason: 'DeepSeek reviewer route is not configured; NovaWing will not silently use another provider',
        }
      }
      const effectiveTimeoutMs = input.timeoutMs ?? timeoutMs
      const prompt = `${REVIEWER_SYSTEM_PROMPT}\n\n${buildReviewPrompt(input.task)}`
      const args = reviewClaudeArgs(options.model ?? REVIEW_DEFAULT_MODEL, prompt, maxTurns)
      const spec = guardianShellCommand('exec claude "$@"', exportShellOptions(options))
      // The provider route needs its credentials on the CLI process environment even
      // when NovaWing itself was launched without them. They stay in memory only.
      const providerEnvironment = await resolveClaudeProviderEnvironment(options.cwd, process.env)
        .catch(() => ({ ...process.env }))
      const env = spec.nativeGitBash === true
        ? {
            ...providerEnvironment,
            BASH: spec.executable,
            NOVAWING_GIT_BASH_PATH: spec.executable,
            SHELL: spec.executable,
            npm_config_script_shell: spec.executable,
          }
        : providerEnvironment
      let result: GuardianCommandResult
      try {
        result = await runner({
          executable: spec.executable,
          args: [...spec.args, '--', ...args],
          cwd: options.cwd,
          timeoutMs: effectiveTimeoutMs,
          ...(env === undefined ? {} : { env }),
          ...(spec.nativeGitBash === true ? { nativeGitBash: true } : {}),
        })
      } catch (error) {
        const detail = redactReason(error instanceof Error ? error.message : String(error))
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: classifyReviewerProviderFailure(detail), reason: `DeepSeek reviewer failed: ${detail}` }
      }
      if (result.exitCode === null && result.signal === 'SIGTERM') {
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: 'TIMEOUT', reason: `DeepSeek reviewer timed out after ${effectiveTimeoutMs}ms` }
      }
      if (result.exitCode !== 0) {
        const detail = redactReason(result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`)
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: classifyReviewerProviderFailure(detail), reason: `DeepSeek reviewer failed: ${detail}` }
      }
      let payload: { result?: unknown; is_error?: unknown; permission_denials?: unknown }
      try {
        payload = JSON.parse(result.stdout.trim()) as typeof payload
      } catch {
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: 'DEGRADED', reason: 'DeepSeek reviewer returned invalid JSON output' }
      }
      if (payload.is_error === true || typeof payload.result !== 'string') {
        const detail = redactReason(typeof payload.result === 'string' ? payload.result : 'reviewer produced no result payload')
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: classifyReviewerProviderFailure(detail), reason: `DeepSeek reviewer failed: ${detail}` }
      }
      const parsed = parseReviewVerdict(payload.result)
      if (!parsed.ok) {
        return { kind: 'RUNTIME_FAILURE', provider: 'deepseek', status: 'DEGRADED', reason: `DeepSeek reviewer protocol failure: ${parsed.reason}` }
      }
      // A denied write attempt is a real safety event and must stay visible.
      const deniedWrites = Array.isArray(payload.permission_denials)
        ? payload.permission_denials.filter((denial) => {
            if (denial === null || typeof denial !== 'object') return false
            const tool = (denial as { tool?: unknown }).tool
            return typeof tool === 'string' && /^(Edit|Write|NotebookEdit|MultiEdit)$/u.test(tool)
          }).length
        : 0
      const blockingFindings = [...parsed.verdict.blockingFindings]
      if (deniedWrites > 0) {
        blockingFindings.push(`reviewer attempted ${deniedWrites} write operation(s) and was denied; a reviewer must stay read-only`)
      }
      return {
        kind: 'VERDICT',
        passed: parsed.verdict.passed && deniedWrites === 0,
        findings: [...parsed.verdict.findings],
        blockingFindings,
        summary: parsed.verdict.summary,
        provider: 'deepseek',
        ...(parsed.verdict.assertionVerdicts === undefined ? {} : { assertionVerdicts: parsed.verdict.assertionVerdicts }),
      }
    },
  }
}

export interface CodexReviewerRuntimeOptions {
  cwd: string
  model?: string
  reasoningEffort?: string
  timeoutMs?: number
  /** Test seam: the installed Codex SDK read-only runner. */
  runner?: RepairModelRunner
}

/**
 * Read-only Codex reviewer. It reuses the read-only Codex runner (no file writes,
 * no network, approval policy never), so a Codex reviewer can independently review
 * work produced by a different provider — the mirror image of the default policy.
 */
export function createCodexReviewerRuntime(options: CodexReviewerRuntimeOptions): ReviewerRuntime {
  const timeoutMs = options.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS
  return {
    provider: 'codex',
    async review(input: ReviewerReviewInput): Promise<ReviewerOutcome> {
      const run = options.runner ?? createCodexRepairModelRunner({ env: process.env })
      let text: string
      try {
        ({ text } = await run({
          system: REVIEWER_SYSTEM_PROMPT,
          user: buildReviewPrompt(input.task),
          targetRepo: options.cwd,
          model: options.model ?? CODING_EXECUTOR_DEFAULTS.codex.model,
          reasoningEffort: options.reasoningEffort ?? REPAIR_DEFAULT_REASONING_EFFORT,
          timeoutMs: input.timeoutMs ?? timeoutMs,
        }))
      } catch (error) {
        const detail = redactReason(error instanceof Error ? error.message : String(error))
        return { kind: 'RUNTIME_FAILURE', provider: 'codex', status: classifyReviewerProviderFailure(detail), reason: `Codex reviewer failed: ${detail}` }
      }
      const parsed = parseReviewVerdict(text)
      if (!parsed.ok) {
        return { kind: 'RUNTIME_FAILURE', provider: 'codex', status: 'DEGRADED', reason: `Codex reviewer protocol failure: ${parsed.reason}` }
      }
      return {
        kind: 'VERDICT',
        passed: parsed.verdict.passed,
        findings: [...parsed.verdict.findings],
        blockingFindings: [...parsed.verdict.blockingFindings],
        summary: parsed.verdict.summary,
        provider: 'codex',
        ...(parsed.verdict.assertionVerdicts === undefined ? {} : { assertionVerdicts: parsed.verdict.assertionVerdicts }),
      }
    },
  }
}
