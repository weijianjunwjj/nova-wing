/**
 * NovaWing v0.2 automated certification — scripted provider (V2ActionDispatcher).
 *
 * The NovaWing control plane stays real: V2ControllerTaskRunner + TaskController
 * + reconciliation + event log + provider health all run unmodified. This module
 * only replaces the model/executor response with a deterministic per-scenario
 * script, mirroring the production `createV2Dispatcher` seam.
 */
import { spawn } from 'node:child_process'
import type { VerificationResult } from '../../../packages/development-guardian/model.js'
import type {
  AgentCapabilityProfile,
  V2ActionDispatcher,
  V2StructuredHandoff,
} from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { TaskAction } from '../../../packages/development-guardian/work-session/task-controller.js'
import type { TaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import type { ApprovalEvidence, ReviewEvidence } from '../../../packages/development-guardian/work-session/risk-evidence.js'
import type { ProviderHealthObservation } from '../../../packages/development-guardian/work-session/task-observability.js'
import { inspectRepo } from './util.js'

export interface DispatchRecord {
  action: TaskAction
  agent: string
  provider: string
  decidedAction: TaskAction
  headShaBefore: string | undefined
  headShaAfter: string | undefined
}

export interface DispatchCtx {
  action: TaskAction
  agent: AgentCapabilityProfile
  task: TaskStateV2
  repo: string
  handoff?: V2StructuredHandoff
  approvedVerificationCommand?: string
  record: DispatchRecord
}

export type ProviderStatus = 'SUCCESS' | 'FAILED' | 'BLOCKED'

export interface ProviderDispatchResult {
  status: ProviderStatus
  summary?: string
  changedFiles?: readonly string[]
  verificationResults?: readonly VerificationResult[]
  blockers?: readonly string[]
  review?: ReviewEvidence
  approval?: ApprovalEvidence
  providerHistory?: readonly string[]
  providerHealth?: readonly ProviderHealthObservation[]
}

export type ScenarioProvider = (ctx: DispatchCtx) => Promise<ProviderDispatchResult>

export interface ScriptedDispatcherOptions {
  repo: string
  provider: ScenarioProvider
  onDispatch?: (record: DispatchRecord) => void
}

function identityOf(agent: AgentCapabilityProfile): { agent: string; provider: string; runtimeIdentity: string } {
  return agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
}

/** Build the identity the V2 runner trusts for this selected agent. */
export function agentIdentityOf(agent: AgentCapabilityProfile): { agent: string; provider: string; runtimeIdentity: string } {
  return identityOf(agent)
}

export function reviewEvidence(input: {
  reviewer: AgentCapabilityProfile
  implementer: TaskStateV2['implementer']
  passed: boolean
  findings: readonly string[]
  blockingFindings: readonly string[]
  files: readonly string[]
  task: TaskStateV2
}): ReviewEvidence {
  const identity = identityOf(input.reviewer)
  return {
    passed: input.passed,
    findings: [...input.findings],
    severity: input.passed ? 'LOW' : 'HIGH',
    blockingFindings: [...input.blockingFindings],
    reviewer: identity,
    implementer: input.implementer ?? { agent: 'unknown', provider: 'unknown', runtimeIdentity: 'unknown' },
    ...(input.task.gitState.repositoryIdentity === undefined ? {} : { reviewedRepository: input.task.gitState.repositoryIdentity }),
    ...(input.task.gitState.branch === undefined ? {} : { reviewedBranch: input.task.gitState.branch }),
    ...(input.task.gitState.headSha === undefined ? {} : { reviewedCommit: input.task.gitState.headSha }),
    ...(input.task.gitState.worktreeFingerprint === undefined ? {} : { reviewedWorkspace: input.task.gitState.worktreeFingerprint }),
    reviewedFiles: [...input.files],
    timestamp: new Date().toISOString(),
  }
}

export function approvalEvidence(input: {
  approved: boolean
  task: TaskStateV2
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  context: string
}): ApprovalEvidence {
  return {
    approved: input.approved,
    ...(input.task.gitState.repositoryIdentity === undefined ? {} : { repositoryIdentity: input.task.gitState.repositoryIdentity }),
    ...(input.task.gitState.branch === undefined ? {} : { branch: input.task.gitState.branch }),
    workspaceIdentity: input.task.gitState.worktreeFingerprint ?? '',
    ...(input.task.gitState.headSha === undefined ? {} : { reviewedCommit: input.task.gitState.headSha }),
    risk: input.risk,
    riskContext: input.context,
    timestamp: new Date().toISOString(),
  }
}

export function providerHealth(provider: string, status: ProviderHealthObservation['status'], reason?: string): ProviderHealthObservation {
  return {
    provider,
    status,
    ...(reason === undefined ? {} : { reason }),
    observedAt: new Date().toISOString(),
    source: 'runtime',
  }
}

/** All evidence names the completion gate demands for this task. */
export function requiredEvidenceOf(task: TaskStateV2): string[] {
  return [...new Set(task.completion.bindings.flatMap((binding) => binding.requiredEvidence))]
}

export function uniqueRequiredEvidence(task: TaskStateV2): string[] {
  return requiredEvidenceOf(task)
}

export interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function runProcess(executable: string, args: readonly string[], cwd: string, timeoutMs = 30_000): Promise<SpawnResult> {
  return new Promise((resolveSpawn) => {
    const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      resolveSpawn({ exitCode: 1, stdout, stderr: `${stderr}\nverifier timed out`.trim() })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveSpawn({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveSpawn({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Quote-aware tokenizer for a verifier command line. This is deliberately NOT a
 * shell: quote characters only group tokens, backslash only escapes a quote, and
 * no variable/glob/subshell/redirection semantics exist. Dangerous metacharacters
 * that cannot be expressed as literal data fail closed with a clear message.
 */
export function tokenizeCommand(command: string): { tokens: readonly string[]; error?: string } {
  if (command.length === 0 || command.length > 2_000) return { tokens: [], error: 'invalid verifier command length' }
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasCurrent = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      } else if (character === '\\' && quote === '"' && command[index + 1] === '"') {
        current += '"'
        index++
      } else {
        current += character
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      hasCurrent = true
      continue
    }
    if (character === '\\') {
      const next = command[index + 1]
      if (next === '"' || next === "'" || next === '\\') {
        current += next
        index++
        hasCurrent = true
        continue
      }
      return { tokens: [], error: `unsupported escape before '${next ?? 'end'}' in verifier command` }
    }
    if (character === ' ') {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      continue
    }
    if ('$`;&|<>'.includes(character) || character === '\n' || character === '\r' || character === '\t') {
      return { tokens: [], error: `unsafe unquoted metacharacter '${character}' in verifier command` }
    }
    current += character
    hasCurrent = true
  }
  if (quote !== undefined) return { tokens: [], error: 'unterminated quote in verifier command' }
  if (hasCurrent) tokens.push(current)
  if (tokens.length === 0) return { tokens: [], error: 'empty verifier command' }
  return { tokens }
}

export async function runVerifierCommand(command: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  const { tokens, error } = tokenizeCommand(command)
  if (error !== undefined) return { ok: false, error }
  const [first, ...rest] = tokens
  if (first === undefined) return { ok: false, error: 'empty verifier command' }
  const executable = first === 'node' ? process.execPath : first
  if (first !== 'node' && !first.includes('/') && !first.includes('\\')) {
    return { ok: false, error: `unsupported verifier executable '${first}' (only node is allowed)` }
  }
  const result = await runProcess(executable, rest, cwd)
  if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}` }
  return { ok: true }
}

/** Default VERIFY policy: run every bound evidence command as a real node verifier. */
export async function verifyByCommand(task: TaskStateV2, repo: string): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const command of uniqueRequiredEvidence(task)) {
    const outcome = await runVerifierCommand(command, repo)
    results.push(outcome.ok
      ? { name: command, status: 'passed' }
      : { name: command, status: 'failed', ...(outcome.error === undefined ? {} : { details: outcome.error }) })
  }
  return results
}

export function makeDispatcher(options: ScriptedDispatcherOptions): V2ActionDispatcher {
  const { repo } = options
  return {
    inspectRepository: () => inspectRepo(repo),
    dispatch: async (input) => {
      const headBefore = (await inspectRepo(repo)).headSha
      const record: DispatchRecord = {
        action: input.action,
        agent: input.agent.id,
        provider: input.agent.identity?.provider ?? input.agent.id,
        decidedAction: input.action,
        headShaBefore: headBefore,
        headShaAfter: headBefore,
      }
      const outcome = await options.provider({
        action: input.action,
        agent: input.agent,
        task: input.task,
        repo,
        record,
        ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
        ...(input.approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand: input.approvedVerificationCommand }),
      })
      const headAfter = (await inspectRepo(repo)).headSha
      record.headShaAfter = headAfter
      options.onDispatch?.(record)
      return outcome
    },
  }
}

/** Convenience for building a well-formed passing EXECUTE. */
export function successResult(overrides: Partial<ProviderDispatchResult> = {}): ProviderDispatchResult {
  return { status: 'SUCCESS', ...overrides }
}

export function blockedResult(blockers: readonly string[], overrides: Partial<ProviderDispatchResult> = {}): ProviderDispatchResult {
  return { status: 'BLOCKED', blockers: [...blockers], ...overrides }
}

export function agentProfile(input: {
  id: string
  provider: string
  runtimeIdentity: string
  capabilities: Partial<Record<'coding' | 'reasoning' | 'review' | 'repoNavigation' | 'debugging' | 'verification', boolean>>
  available?: boolean
  quotaExhausted?: boolean
  degraded?: boolean
}): AgentCapabilityProfile {
  return {
    id: input.id,
    identity: { agent: input.id, provider: input.provider, runtimeIdentity: input.runtimeIdentity },
    capabilities: {
      coding: input.capabilities.coding ?? false,
      reasoning: input.capabilities.reasoning ?? false,
      review: input.capabilities.review ?? false,
      repoNavigation: input.capabilities.repoNavigation ?? false,
      debugging: input.capabilities.debugging ?? false,
      verification: input.capabilities.verification ?? false,
    },
    available: input.available ?? true,
    quotaExhausted: input.quotaExhausted ?? false,
    degraded: input.degraded ?? false,
  }
}
