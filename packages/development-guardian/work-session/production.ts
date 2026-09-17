import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { AskBridgeBrain, type AskBridgeBrainOptions } from '../ask-bridge-brain.js'
import {
  type ClaudeCodeExecutorOptions,
} from '../claude-code-executor.js'
import { DeepSeekExecutor, hasDeepSeekRoute } from '../deepseek-executor.js'
import type { GuardianBrain, GuardianRecoverableExecutor } from '../ports.js'
import type { GuardianTask } from '../model.js'
import { CodexExecutor, type CodexExecutorOptions } from '../codex-executor.js'
import { ExecutorRouter, type RouterCodexExecutor } from '../executor-router.js'
import {
  CODING_EXECUTOR_DEFAULTS,
  isSupportedCodexConfiguration,
  resolvePersistedCodexConfiguration,
} from '../coding-executor-config.js'
import { CodingExecutionStore, defaultCodingExecutionStorePath } from './coding-execution-store.js'
import type { ProviderHealthObservation, ProviderHealthStatus } from './task-observability.js'
import { createGuardianTask, GuardianWorkSessionTaskRunner } from './guardian-task-runner.js'
import { V2ControllerTaskRunner, type AgentCapabilityProfile, type V2ActionDispatcher } from './v2-controller-task-runner.js'
import { GoldenPathTaskRunner } from './golden-path.js'
import { createAutonomousDiagnosisRunner, type AutonomousRecoveryOptions } from './autonomous-diagnosis.js'
import { readAutonomousRecoveryDiff, readAutonomousVerificationOutput } from './autonomous-recovery-evidence.js'
import { createCodexRepairModelRunner } from './launchpad/repair-model.js'
import { computeWorktreeFingerprint, parseGitStatus } from './worktree-fingerprint.js'
import type { WorkSessionDefinition, WorkSessionTask } from './model.js'
import { normalizeScheduledStart } from './schedule-policy.js'
import type { SmtpMailTransport, SmtpTransportConfig } from './smtp-notifier.js'
import { createSmtpWorkSessionNotifierFromEnv } from './smtp-notifier.js'
import { combineWorkSessionNotifiers, createWindowsTaskRunNotifier } from './task-run-notifier.js'
import {
  WorkSessionRuntime,
  type NotificationChannelEntry,
  type PreflightRepairRecord,
  type WorkSessionRuntimeConfig,
  type WorkSessionRuntimeRepairConfig,
} from './runtime.js'
import { createRuntimeRepairEngine } from './runtime-repair-engine.js'
import { createFileRuntimeRepairAuditSink, defaultRuntimeRepairAuditPath, type RuntimeRepairAuditSink } from './runtime-repair-audit.js'
import { createWindowsToastRuntimeRepairNotifier, type RuntimeRepairNotifier } from './runtime-repair-notifier.js'
import type { RuntimeRepairRefresh } from './runtime-repair.js'
import { defaultTaskRunAnalyticsPath, TaskRunAnalyticsProjector, TaskRunAnalyticsStore } from './task-run-analytics.js'
import { createRuntimeTaskEtaService, type TaskEtaService } from './control-ui/task-eta.js'
import { ReviewerRuntimeRegistry } from './reviewer-runtime.js'
import { createReviewDispatcher } from './review-dispatcher.js'
import {
  createCodexReviewerRuntime,
  createDeepSeekReviewerRuntime,
  REVIEW_DEFAULT_MODEL,
} from './reviewer-adapters.js'
import type { WorkSessionControlRuntime } from './control-ui/events.js'
import {
  WorkSessionControlController,
} from './control-ui/controller.js'
import {
  WorkSessionControlServer,
  type WorkSessionControlServerAddress,
} from './control-ui/server.js'
import {
  requireDependencyPreflightReady,
  resolveAskBridgeExecutable,
  runProductionDependencyPreflight,
  type DependencyHealthReport,
} from './dependency-health.js'

const GuardianPolicySchema = z.object({
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  doNotDo: z.array(z.string()),
  allowedPaths: z.array(z.string()).min(1),
  forbiddenPaths: z.array(z.string()),
}).strict()

const AcceptanceEvidenceBindingSchema = z.object({
  criterion: z.string(),
  requiredEvidence: z.array(z.string()),
  requiresApproval: z.boolean().optional(),
}).strict()

const TrustedConfigSchema = z.object({
  session: z.object({
    id: z.string(),
    targetRepo: z.string(),
    branch: z.string(),
    scheduledStartAt: z.string().nullable().optional(),
    scheduleSource: z.enum(['immediate', 'custom', 'deepseek_off_peak']).optional(),
    createdAt: z.string().optional(),
    controlPlane: z.enum(['v1', 'v2']).optional(),
    directPath: z.object({ enabled: z.boolean() }).strict().optional(),
    goldenPath: z.object({ enabled: z.boolean() }).strict().optional(),
    limits: z.object({
      softMinutes: z.number(),
      hardMinutes: z.number(),
      maxTasks: z.number(),
    }).strict(),
  }).strict(),
  tasks: z.array(z.object({
    id: z.string(),
    goal: z.string(),
    guardian: GuardianPolicySchema,
    executorMode: z.enum(['auto', 'codex', 'deepseek']).optional(),
    acceptanceEvidenceBindings: z.array(AcceptanceEvidenceBindingSchema).optional(),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  }).strict()).min(1),
  gitCheckpoint: z.object({
    autoCommit: z.boolean(),
    autoPush: z.boolean(),
    pushRemote: z.object({
      name: z.string(),
      expectedUrl: z.string(),
    }).strict().optional(),
  }).strict(),
  executor: z.object({
    defaultMode: z.enum(['auto', 'codex', 'deepseek']).optional(),
    model: z.string(),
    maxTurns: z.number(),
    allowNpmInstall: z.boolean(),
    allowPythonBootstrap: z.boolean(),
  }).strict(),
  codex: z.object({
    enabled: z.boolean().optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional(),
    quotaProbeCooldownMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  }).strict().optional(),
  notification: z.object({
    email: z.object({
      enabled: z.boolean(),
      notifyOnCompleted: z.boolean().optional(),
    }).strict(),
  }).strict().optional(),
  /**
   * Capability profiles for this session. A profile declares what an agent CAN do
   * (coding / review / ...); which agent fills which role is a Controller decision.
   */
  agents: z.array(z.object({
    id: z.string(),
    provider: z.string(),
    runtimeIdentity: z.string().optional(),
    model: z.string().optional(),
    capabilities: z.object({
      coding: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      review: z.boolean().optional(),
      repoNavigation: z.boolean().optional(),
      debugging: z.boolean().optional(),
      verification: z.boolean().optional(),
    }).strict().optional(),
  }).strict()).min(1).optional(),
  storageUrl: z.string().optional(),
}).strict()

export type TrustedWorkSessionConfig = z.infer<typeof TrustedConfigSchema>

const CREDENTIAL_KEY = /(?:authorization|password|secret|credential|apikey|api_key|oauth|cookie|token)/iu

function assertNoCredentialLikeKeys(value: unknown, path = 'config'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialLikeKeys(entry, `${path}[${index}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new Error(`credential-like config key is forbidden at ${path}.${key}`)
    }
    assertNoCredentialLikeKeys(child, `${path}.${key}`)
  }
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${field} must be non-empty`)
  return trimmed
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function storagePathFromUrl(storageUrl: string): string {
  if (!storageUrl.startsWith('file:')) {
    throw new Error('storageUrl must use a local file: URL')
  }
  return fileURLToPath(storageUrl)
}

export async function validateTrustedWorkSessionConfig(
  input: unknown,
): Promise<TrustedWorkSessionConfig> {
  assertNoCredentialLikeKeys(input)
  const config = TrustedConfigSchema.parse(input)
  if (config.session.scheduledStartAt !== undefined) {
    config.session.scheduledStartAt = normalizeScheduledStart(config.session.scheduledStartAt)
  }
  if (config.session.createdAt !== undefined) config.session.createdAt = normalizeScheduledStart(config.session.createdAt)!
  if (config.notification?.email.enabled === false && config.notification.email.notifyOnCompleted === true) {
    throw new Error('notification.email.notifyOnCompleted requires notification.email.enabled=true')
  }
  config.session.id = requireTrimmed(config.session.id, 'session.id')
  config.session.branch = requireTrimmed(config.session.branch, 'session.branch')
  config.session.targetRepo = requireTrimmed(config.session.targetRepo, 'session.targetRepo')

  if (!isAbsolute(config.session.targetRepo)) {
    throw new Error('session.targetRepo must be absolute')
  }
  const repoStat = await stat(config.session.targetRepo).catch(() => undefined)
  if (repoStat === undefined || !repoStat.isDirectory()) {
    throw new Error('session.targetRepo must be an existing directory')
  }
  if (!Number.isInteger(config.session.limits.maxTasks) || config.session.limits.maxTasks < 1) {
    throw new Error('session.limits.maxTasks must be an integer >= 1')
  }
  if (
    !Number.isFinite(config.session.limits.softMinutes) ||
    config.session.limits.softMinutes < 0 ||
    !Number.isFinite(config.session.limits.hardMinutes) ||
    config.session.limits.hardMinutes <= 0 ||
    config.session.limits.hardMinutes < config.session.limits.softMinutes
  ) {
    throw new Error('session time limits are invalid')
  }

  const taskIds = new Set<string>()
  for (const task of config.tasks) {
    task.id = requireTrimmed(task.id, 'tasks[].id')
    task.goal = requireTrimmed(task.goal, `tasks.${task.id}.goal`)
    if (taskIds.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
    taskIds.add(task.id)
    for (const path of task.guardian.allowedPaths) {
      requireTrimmed(path, `tasks.${task.id}.guardian.allowedPaths[]`)
    }
    if (task.acceptanceEvidenceBindings !== undefined) {
      const criteria = new Set(task.guardian.acceptanceCriteria)
      const bound = new Set<string>()
      for (const binding of task.acceptanceEvidenceBindings) {
        binding.criterion = requireTrimmed(binding.criterion, `tasks.${task.id}.acceptanceEvidenceBindings[].criterion`)
        if (!criteria.has(binding.criterion)) throw new Error(`evidence binding names unknown acceptance criterion: ${binding.criterion}`)
        if (bound.has(binding.criterion)) throw new Error(`duplicate evidence binding: ${binding.criterion}`)
        if (binding.requiredEvidence.length === 0) throw new Error(`evidence binding is empty: ${binding.criterion}`)
        binding.requiredEvidence = binding.requiredEvidence.map((evidence) => requireTrimmed(evidence, `tasks.${task.id}.acceptanceEvidenceBindings[].requiredEvidence[]`))
        bound.add(binding.criterion)
      }
    }
  }

  config.executor.model = requireTrimmed(config.executor.model, 'executor.model')
  if (config.agents !== undefined) {
    const agentIds = new Set<string>()
    const runtimeIdentities = new Set<string>()
    for (const agent of config.agents) {
      agent.id = requireTrimmed(agent.id, 'agents[].id')
      agent.provider = requireTrimmed(agent.provider, 'agents[].provider')
      if (agent.runtimeIdentity !== undefined) {
        agent.runtimeIdentity = requireTrimmed(agent.runtimeIdentity, `agents.${agent.id}.runtimeIdentity`)
      }
      if (agentIds.has(agent.id)) throw new Error(`duplicate agent id: ${agent.id}`)
      agentIds.add(agent.id)
      // Two profiles sharing one runtime identity would silently defeat the
      // independent-review policy, so it is rejected at the trust boundary.
      const identity = agent.runtimeIdentity ?? agent.id
      if (runtimeIdentities.has(identity)) throw new Error(`duplicate agent runtime identity: ${identity}`)
      runtimeIdentities.add(identity)
      if (agent.capabilities === undefined || !Object.values(agent.capabilities).some((value) => value === true)) {
        throw new Error(`agent ${agent.id} declares no capability`)
      }
    }
  }
  if (config.codex !== undefined) {
    const resolved = resolvePersistedCodexConfiguration(config.codex)
    if (!isSupportedCodexConfiguration(resolved.model, resolved.reasoningEffort)) {
      throw new Error('Codex model/reasoning configuration is unsupported')
    }
  }
  if (!Number.isInteger(config.executor.maxTurns) || config.executor.maxTurns < 1) {
    throw new Error('executor.maxTurns must be an integer >= 1')
  }
  if (config.gitCheckpoint.autoPush && !config.gitCheckpoint.autoCommit) {
    throw new Error('autoPush requires autoCommit')
  }
  if (config.gitCheckpoint.autoPush) {
    if (config.gitCheckpoint.pushRemote === undefined) {
      throw new Error('autoPush requires trusted pushRemote policy')
    }
    config.gitCheckpoint.pushRemote.name = requireTrimmed(
      config.gitCheckpoint.pushRemote.name,
      'gitCheckpoint.pushRemote.name',
    )
    config.gitCheckpoint.pushRemote.expectedUrl = requireTrimmed(
      config.gitCheckpoint.pushRemote.expectedUrl,
      'gitCheckpoint.pushRemote.expectedUrl',
    )
  }
  if (config.storageUrl !== undefined) {
    const storagePath = storagePathFromUrl(config.storageUrl)
    if (!isAbsolute(storagePath)) throw new Error('storageUrl file path must be absolute')
    if (isInside(config.session.targetRepo, storagePath)) {
      throw new Error('Work Session storage must be outside targetRepo')
    }
  }
  return config
}

/**
 * Capability profiles declared by the trusted config. Roles are never hardcoded:
 * a profile says what an agent can do, and the Controller decides which profile
 * fills EXECUTE / REVIEW for the current Task and Risk.
 */
export function trustedAgents(
  config: TrustedWorkSessionConfig,
  sessionId: string,
): readonly AgentCapabilityProfile[] | undefined {
  if (config.agents === undefined) return undefined
  return config.agents.map((agent) => ({
    id: agent.id,
    identity: {
      agent: agent.id,
      provider: agent.provider,
      runtimeIdentity: agent.runtimeIdentity ?? `session:${sessionId}:${agent.id}`,
    },
    available: true,
    quotaExhausted: false,
    degraded: false,
    capabilities: {
      coding: agent.capabilities?.coding ?? false,
      reasoning: agent.capabilities?.reasoning ?? false,
      review: agent.capabilities?.review ?? false,
      repoNavigation: agent.capabilities?.repoNavigation ?? false,
      debugging: agent.capabilities?.debugging ?? false,
      verification: agent.capabilities?.verification ?? false,
    },
  }))
}

export async function loadTrustedWorkSessionConfig(
  configPath: string,
): Promise<TrustedWorkSessionConfig> {
  const absolutePath = resolve(configPath)
  const text = await readFile(absolutePath, 'utf8')
  let input: unknown
  try {
    input = JSON.parse(text) as unknown
  } catch {
    throw new Error('Work Session config is not valid JSON')
  }
  return validateTrustedWorkSessionConfig(input)
}

export interface ProductionGitProcessRunner {
  (executable: 'git', args: readonly string[], cwd: string): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

const PRODUCTION_GIT_COMMANDS = new Map<string, readonly string[]>([
  ['git branch --show-current', ['branch', '--show-current']],
  ['git remote get-url --push --all origin', ['remote', 'get-url', '--push', '--all', 'origin']],
  ['git status --porcelain -z --untracked-files=all', ['status', '--porcelain', '-z', '--untracked-files=all']],
  ['git diff --cached --binary', ['diff', '--cached', '--binary']],
  ['git rev-parse HEAD', ['rev-parse', 'HEAD']],
  ['git status --porcelain --untracked-files=all', ['status', '--porcelain', '--untracked-files=all']],
])

function defaultGitProcessRunner(
  executable: 'git',
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      resolveRun({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('close', (exitCode) => {
      resolveRun({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

/**
 * Provider Health source-of-truth: project the real ExecutorRouter / coding-store
 * facts (failover reason, lastErrorKind, availability) into health observations.
 * Never inferred from an Agent's self-report.
 */
function observedProviderHealth(
  execution: { activeExecutor?: string; failoverReason?: string; lastErrorKind?: string; lastError?: string } | undefined,
  availability: { state: 'available' | 'quota_exhausted' | 'unknown'; blockedUntil?: string; nextProbeAt?: string; lastQuotaErrorAt?: string },
  now: string,
): ProviderHealthObservation[] {
  const observations: ProviderHealthObservation[] = []
  const codex = (status: ProviderHealthStatus, reason: string | undefined, retryAfter?: string): void => {
    observations.push({
      provider: 'codex',
      executor: 'codex',
      status,
      ...(reason === undefined ? {} : { reason }),
      observedAt: availability.lastQuotaErrorAt ?? now,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      source: 'runtime',
    })
  }
  const exhausted = execution?.failoverReason === 'codex_quota_exhausted' ||
    execution?.lastErrorKind === 'quota_exhausted' || availability.state === 'quota_exhausted'
  if (exhausted) {
    codex('QUOTA_EXHAUSTED', 'quota exhausted', availability.blockedUntil ?? availability.nextProbeAt)
  } else if (execution?.lastErrorKind === 'transient') {
    codex(/timed out|timeout/iu.test(execution.lastError ?? '') ? 'TIMEOUT' : 'DEGRADED', execution.lastError ?? 'transient network/runtime error')
  } else if (execution?.lastErrorKind === 'auth_required' || execution?.lastErrorKind === 'configuration_error') {
    codex('OFFLINE', execution.lastErrorKind)
  } else if (execution?.lastErrorKind === 'model_unavailable') {
    codex('DEGRADED', execution.lastErrorKind)
  } else if (execution?.activeExecutor === 'codex' && execution.lastErrorKind === undefined) {
    codex('AVAILABLE', undefined)
  }
  return observations
}

export function createProductionGitRunner(
  repoPath: string,
  processRunner: ProductionGitProcessRunner = defaultGitProcessRunner,
): (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return async (command: string) => {
    const args = PRODUCTION_GIT_COMMANDS.get(command)
    if (args === undefined) {
      throw new Error(`unsupported production git command: ${command}`)
    }
    return processRunner('git', args, repoPath)
  }
}

interface ClosableControlRuntime extends WorkSessionControlRuntime {
  close?(): Promise<void>
}

export interface ProductionWorkSessionDependencies {
  /** Scriptable recovery seam; normal production reuses the read-only repair model. */
  autonomousRecovery?: AutonomousRecoveryOptions
  /** Optional presentation-only estimator; injected runtimes otherwise use deterministic ETA. */
  taskEta?: Pick<TaskEtaService, 'project' | 'close'>
  createCodexExecutor?: (options: CodexExecutorOptions) => RouterCodexExecutor
  createBrain?: (options: AskBridgeBrainOptions) => GuardianBrain
  createExecutor?: (options: ClaudeCodeExecutorOptions) => GuardianRecoverableExecutor
  createRuntime?: (config: WorkSessionRuntimeConfig) => ClosableControlRuntime
  gitProcessRunner?: ProductionGitProcessRunner
  serverPort?: number
  env?: NodeJS.ProcessEnv
  createSmtpTransport?: (config: SmtpTransportConfig) => SmtpMailTransport
  notificationRetryDelayMs?: number
  preflight?: (targetRepo: string) => Promise<DependencyHealthReport>
  /** Production V2 adapter seam. V1 remains available only when explicitly selected. */
  createV2Dispatcher?: (input: {
    definition: WorkSessionDefinition
    eventSink?: import('../progress.js').GuardianProgressObserver
    /** The real provider-agnostic dispatcher; a scripted seam may delegate to it. */
    defaultDispatcher: V2ActionDispatcher
  }) => V2ActionDispatcher
  v2Agents?: readonly AgentCapabilityProfile[]
  /** Provider-agnostic reviewer runtimes; default registers the read-only adapters. */
  createReviewerRegistry?: (input: { definition: WorkSessionDefinition; env: NodeJS.ProcessEnv }) => ReviewerRuntimeRegistry
  /** v0.2.4: Runtime Repair seams (refresh/audit/notifier); engine + agents defaulted. */
  runtimeRepair?: {
    refreshProviderHealth?: () => Promise<RuntimeRepairRefresh>
    auditSink?: RuntimeRepairAuditSink
    notifier?: RuntimeRepairNotifier
  }
  /** v0.2.6: a Launchpad Task Contract repair performed before this Session started. */
  preflightRepair?: PreflightRepairRecord
}

export interface ReviewerAvailabilityRefreshOptions {
  agents: readonly AgentCapabilityProfile[]
  /** Real ExecutorRouter / coding-store availability. */
  availability: () => { state: 'available' | 'quota_exhausted' | 'unknown'; blockedUntil?: string; nextProbeAt?: string; lastQuotaErrorAt?: string }
  /** Real provider route probe; must never guess "available". */
  deepSeekRouteAvailable: () => Promise<boolean>
  now?: () => string
}

/**
 * Refresh real provider availability for Runtime Repair. A provider that cannot be
 * probed is left as declared — its failure will surface as a review runtime failure
 * rather than being silently assumed healthy.
 */
export async function refreshReviewerAvailability(
  options: ReviewerAvailabilityRefreshOptions,
): Promise<RuntimeRepairRefresh> {
  const now = options.now?.() ?? new Date().toISOString()
  const availability = options.availability()
  const quotaBlocked = availability.state === 'quota_exhausted' &&
    Date.parse(availability.blockedUntil ?? availability.nextProbeAt ?? '') > Date.now()
  const deepSeekAvailable = await options.deepSeekRouteAvailable()
  const providerHealth: ProviderHealthObservation[] = []
  const agents = options.agents.map((agent) => {
    const provider = agent.identity?.provider ?? agent.id
    if (provider === 'deepseek') {
      providerHealth.push({
        provider,
        status: deepSeekAvailable ? 'AVAILABLE' : 'OFFLINE',
        ...(deepSeekAvailable ? {} : { reason: 'DeepSeek route is not configured in the local Claude CLI' }),
        observedAt: now,
        source: 'runtime',
      })
      return { ...agent, available: deepSeekAvailable }
    }
    if (provider === 'codex') {
      const retryAfter = availability.blockedUntil ?? availability.nextProbeAt
      providerHealth.push({
        provider,
        status: quotaBlocked ? 'QUOTA_EXHAUSTED' : 'AVAILABLE',
        ...(quotaBlocked ? { reason: 'Codex quota exhausted' } : {}),
        ...(quotaBlocked && retryAfter !== undefined ? { retryAfter } : {}),
        observedAt: availability.lastQuotaErrorAt ?? now,
        source: 'runtime',
      })
      return { ...agent, quotaExhausted: quotaBlocked }
    }
    return agent
  })
  return { providerHealth, agents }
}

export interface ProductionWorkSessionUi {
  definition: WorkSessionDefinition
  controller: WorkSessionControlController
  server: WorkSessionControlServer
  runtime: ClosableControlRuntime
  start(): Promise<WorkSessionControlServerAddress>
  isLive(): boolean
  hasActiveSession(): boolean
  close(): Promise<void>
}

export function defaultStorageUrl(sessionId: string, env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA?.trim() || join(homedir(), '.novawing')
  return new URL(`file:///${join(base, 'NovaWing', 'work-sessions', `${sessionId}.db`).replaceAll('\\', '/')}`).href
}

function brainReasoning(env: NodeJS.ProcessEnv): 'auto' | 'instant' | 'medium' | 'high' {
  const value = env.NOVAWING_CHATGPT_REASONING?.trim() || 'high'
  if (value !== 'auto' && value !== 'instant' && value !== 'medium' && value !== 'high') {
    throw new Error('NOVAWING_CHATGPT_REASONING is invalid')
  }
  return value
}

export async function createProductionWorkSessionUi(
  config: TrustedWorkSessionConfig,
  dependencies: ProductionWorkSessionDependencies = {},
): Promise<ProductionWorkSessionUi> {
  const trusted = await validateTrustedWorkSessionConfig(config)
  const env = dependencies.env ?? process.env
  const emailNotifier = trusted.notification?.email.enabled === true
    ? createSmtpWorkSessionNotifierFromEnv({
        env,
        ...(dependencies.createSmtpTransport === undefined
          ? {}
          : { createTransport: dependencies.createSmtpTransport }),
      })
    : undefined
  const toastNotifier = dependencies.createRuntime === undefined ? createWindowsTaskRunNotifier() : undefined
  const notifier = emailNotifier === undefined
    ? undefined
    : toastNotifier === undefined ? emailNotifier : combineWorkSessionNotifiers([emailNotifier, toastNotifier])
  const terminalNotifier = emailNotifier === undefined ? toastNotifier : undefined
  // Explicit channel list: each channel reports its own delivery truth, so a
  // failed Windows toast can no longer mark an accepted email as failed.
  const notificationChannels: readonly NotificationChannelEntry[] = [
    ...(emailNotifier === undefined ? [] : [{ channel: 'EMAIL' as const, notifier: emailNotifier }]),
    ...(toastNotifier === undefined ? [] : [{ channel: 'DESKTOP' as const, notifier: toastNotifier }]),
  ]
  const definition: WorkSessionDefinition = {
    id: trusted.session.id,
    targetRepo: trusted.session.targetRepo,
    branch: trusted.session.branch,
    tasks: trusted.tasks.map((task) => ({ id: task.id, goal: task.goal, constraints: task.guardian.constraints,
      acceptanceCriteria: task.guardian.acceptanceCriteria, allowedPaths: task.guardian.allowedPaths, forbiddenPaths: task.guardian.forbiddenPaths,
      ...(task.acceptanceEvidenceBindings === undefined ? {} : { acceptanceEvidenceBindings: task.acceptanceEvidenceBindings }),
      ...(task.risk === undefined ? {} : { risk: task.risk }) })),
    limits: { ...trusted.session.limits },
    ...(trusted.session.scheduledStartAt === undefined ? {} : { scheduledStartAt: trusted.session.scheduledStartAt }),
    ...(trusted.session.scheduleSource === undefined ? {} : { scheduleSource: trusted.session.scheduleSource }),
    ...(trusted.session.createdAt === undefined ? {} : { createdAt: trusted.session.createdAt }),
    ...(trusted.session.controlPlane === undefined ? {} : { controlPlane: trusted.session.controlPlane }),
    ...(trusted.session.directPath === undefined ? {} : { directPath: { ...trusted.session.directPath } }),
    ...(trusted.session.goldenPath === undefined ? {} : { goldenPath: { ...trusted.session.goldenPath } }),
  }
  const storageUrl = trusted.storageUrl ?? defaultStorageUrl(trusted.session.id, env)
  const storagePath = storagePathFromUrl(storageUrl)
  if (isInside(definition.targetRepo, storagePath)) {
    throw new Error('Work Session storage must be outside targetRepo')
  }
  await mkdir(resolve(storagePath, '..'), { recursive: true })
  const verificationOutputDirectory = `${storagePath}.artifacts`

  const createExecutor = dependencies.createExecutor ?? ((options) => new DeepSeekExecutor(options))
  const taskModes = new Map(trusted.tasks.map((task) => [task.id,
    task.executorMode ?? trusted.executor.defaultMode ?? (trusted.session.scheduleSource === 'deepseek_off_peak' ? 'deepseek' : CODING_EXECUTOR_DEFAULTS.defaultMode)]))
  // One local coordinator even when sessions use different custom workflow storage URLs.
  // Injected executor tests stay isolated with their temporary session storage.
  const codingStore = new CodingExecutionStore(dependencies.createExecutor !== undefined && dependencies.createCodexExecutor === undefined
    ? join(resolve(storagePath, '..'), 'coding-executors.sqlite')
    : defaultCodingExecutionStorePath(env))
  const taskKey = (id: string) => JSON.stringify([definition.id, id])
  const policies = new Map(trusted.tasks.map((task) => [task.id, task.guardian]))
  const gitRunner = createProductionGitRunner(
    definition.targetRepo,
    dependencies.gitProcessRunner,
  )
  let runtime: ClosableControlRuntime | undefined
  let localControlUrl: string | undefined

  const controller = new WorkSessionControlController({
    ...(dependencies.taskEta !== undefined ? { taskEta: dependencies.taskEta }
      : dependencies.createExecutor === undefined && dependencies.createCodexExecutor === undefined &&
        dependencies.createRuntime === undefined && dependencies.createV2Dispatcher === undefined
        ? { taskEta: createRuntimeTaskEtaService({ env }) } : {}),
    readCodingExecutions: () => trusted.tasks.map((task) => {
      const state = codingStore.read(taskKey(task.id))
      return { taskId: task.id, mode: taskModes.get(task.id)!,
        ...(state === undefined ? {} : {
          activeExecutor: state.activeExecutor, history: state.history,
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }),
          ...(state.failoverReason === undefined ? {} : { failoverReason: state.failoverReason }),
          ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
        }) }
    }),
    beforeResume: async () => {
      const availability = codingStore.availability()
      const quotaBlocked = availability.state === 'quota_exhausted' &&
        Date.parse(availability.blockedUntil ?? availability.nextProbeAt ?? '') > Date.now()
      const snapshot = controller.getSnapshot().runtime
      const nextTaskId = snapshot.currentTaskId ?? trusted.tasks.find(task => !snapshot.completedTaskIds?.includes(task.id))?.id
      const executorModes = trusted.tasks.filter(task => task.id === nextTaskId).map((task) => {
        const persisted = codingStore.read(taskKey(task.id))
        const mode = taskModes.get(task.id)!
        return persisted?.activeExecutor ?? (mode === 'auto' && quotaBlocked ? 'deepseek' : mode)
      })
      const report = await (dependencies.preflight?.(definition.targetRepo) ??
        runProductionDependencyPreflight({ env, targetRepo: definition.targetRepo, executorModes, controlPlane: definition.controlPlane ?? 'v1' }))
      requireDependencyPreflightReady(report)
    },
    createRuntime(eventSink, notificationSink) {
      if (trusted.session.controlPlane === 'v2') {
        const inspectRepository = async () => {
          const [branch, head, status, indexDiff] = await Promise.all([
            gitRunner('git branch --show-current'), gitRunner('git rev-parse HEAD'), gitRunner('git status --porcelain -z --untracked-files=all'), gitRunner('git diff --cached --binary'),
          ])
          if (branch.exitCode !== 0 || head.exitCode !== 0 || status.exitCode !== 0 || indexDiff.exitCode !== 0) throw new Error('production V2 repository inspection failed')
          const entries = parseGitStatus(status.stdout)
          return { repositoryIdentity: await realpath(definition.targetRepo), branch: branch.stdout.trim(), headSha: head.stdout.trim(), changedFiles: entries.map((entry) => entry.path),
            worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(definition.targetRepo, entries, { strict: true })).update(indexDiff.stdout).digest('hex') }
        }
        // Reviewer runtimes are keyed by provider. Adding a provider is adding an
        // adapter here; the Controller never learns which provider reviews.
        const reviewerRegistry = dependencies.createReviewerRegistry?.({ definition, env }) ?? new ReviewerRuntimeRegistry([
          createDeepSeekReviewerRuntime({
            cwd: definition.targetRepo,
            model: trusted.agents?.find((agent) => agent.provider === 'deepseek')?.model ?? REVIEW_DEFAULT_MODEL,
            ...(env.NOVAWING_GIT_BASH_PATH?.trim() ? { gitBashPath: env.NOVAWING_GIT_BASH_PATH.trim() } : {}),
          }),
          createCodexReviewerRuntime({ cwd: definition.targetRepo }),
        ])
        const reviewDispatcher = createReviewDispatcher({ registry: reviewerRegistry, inspectRepository })
        const defaultDispatcher: V2ActionDispatcher = {
          inspectRepository,
          dispatch: async ({ action, task: taskState, agent, approvedVerificationCommand, retry, recoveryInstructions }) => {
            // The selected reviewer profile decides the provider; independence and the
            // read-only guarantee are enforced by the dispatcher, not by the runner.
            if (action === 'REVIEW') return reviewDispatcher.dispatch({ agent, task: taskState })
            if (action === 'ANALYZE' || action === 'RECONCILE') return { status: 'BLOCKED' as const, blockers: [`production V2 action ${action} requires a configured dispatcher`] }
            if (action === 'REQUEST_APPROVAL' || action === 'SUSPEND') return { status: 'BLOCKED' as const, blockers: ['human decision required'] }
            const options: ClaudeCodeExecutorOptions = { cwd: definition.targetRepo, model: trusted.executor.model, maxTurns: trusted.executor.maxTurns,
              allowNpmInstall: trusted.executor.allowNpmInstall, allowPythonBootstrap: trusted.executor.allowPythonBootstrap, verificationOutputDirectory, ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }) }
            const router = new ExecutorRouter({
              taskKey: taskKey(taskState.identity.taskId), cwd: definition.targetRepo, store: codingStore,
              mode: taskModes.get(taskState.identity.taskId)!, codexEnabled: trusted.codex?.enabled ?? CODING_EXECUTOR_DEFAULTS.codex.enabled,
              codexModel: resolvePersistedCodexConfiguration(trusted.codex).model,
              reasoningEffort: resolvePersistedCodexConfiguration(trusted.codex).reasoningEffort,
              quotaProbeCooldownMs: trusted.codex?.quotaProbeCooldownMs ?? CODING_EXECUTOR_DEFAULTS.codex.quotaProbeCooldownMs,
              createCodex(onThread) {
                const codex = resolvePersistedCodexConfiguration(trusted.codex)
                return dependencies.createCodexExecutor?.({ ...options, env, onThread, codexModel: codex.model, reasoningEffort: codex.reasoningEffort }) ?? new CodexExecutor({ ...options, env, onThread, codexModel: codex.model, reasoningEffort: codex.reasoningEffort })
              },
              createDeepSeek(handoff) {
                return createExecutor({ ...options, ...(handoff === undefined ? {} : { additionalExecutionContext: 'Codex quota handoff. Inspect repository reality; TaskStateV2 remains the semantic authority.\n' + JSON.stringify(handoff) }) })
              },
              onEvent(event) { eventSink?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0, detail: `${event.type}: ${event.executor ?? event.reason ?? ''}` }) },
            })
            if (retry?.reason === 'NO_OP_EXECUTION') router.prepareNoOpRetry()
            // Reuse the mature dirty-workspace continuation gate with current inspected facts.
            const entries = parseGitStatus((await gitRunner('git status --porcelain --untracked-files=all')).stdout)
            router.setRecoveryCheckpoint({ repoPath: definition.targetRepo, branch: taskState.gitState.branch!, headSha: taskState.gitState.headSha!,
              changedFiles: taskState.gitState.changedFiles, worktreeFingerprint: await computeWorktreeFingerprint(definition.targetRepo, entries) })
            const requiredEvidence = taskState.completion.bindings.flatMap((binding) => binding.requiredEvidence)
            const goldenImplementationOnly = action === 'EXECUTE' &&
              (taskState.execution?.path === 'GOLDEN' || taskState.autonomousRecovery?.phase === 'ADVANCED')
            const transportTask: GuardianTask = { id: taskState.identity.taskId, goal: taskState.goal, state: 'EXECUTING', iteration: 0,
              maxIterations: trusted.executor.maxTurns, constraints: taskState.constraints, acceptanceCriteria: taskState.acceptanceCriteria,
              allowedPaths: taskState.permissions.allowedPaths, forbiddenPaths: taskState.permissions.forbiddenPaths,
              lastReport: { summary: 'TaskStateV2 transport projection', changedFiles: taskState.gitState.changedFiles, commandsRun: [], verificationResults: taskState.verificationState.results, blockers: [] } }
            const report = action === 'VERIFY'
              ? await (() => {
                const planned = taskState.verificationPlan?.steps.map((step) => ({
                  stepId: step.id, command: step.command, cwd: step.cwd,
                  ...(step.originalCommand === undefined ? {} : { originalCommand: step.originalCommand }),
                  ...(step.admission === undefined ? {} : { admission: step.admission }),
                  ...(step.admissionReason === undefined ? {} : { admissionReason: step.admissionReason }),
                  ...(step.sourceManifest === undefined ? {} : { sourceManifest: step.sourceManifest }),
                  ...(step.sourceScript === undefined ? {} : { sourceScript: step.sourceScript }),
                  ...(step.sourceFingerprint === undefined ? {} : { sourceFingerprint: step.sourceFingerprint }),
                }))
                const verificationSteps = planned === undefined ? undefined : [
                  ...(planned.some((step) => step.command === 'git diff --check' && step.cwd === '.')
                    ? [] : [{ stepId: 'baseline-diff-check', command: 'git diff --check', cwd: '.' }]),
                  ...planned,
                ]
                const legacyCommands = [...new Set(['git diff --check', ...requiredEvidence])]
                return router.retryVerification({ task: transportTask, report: {
                  summary: 'Controller requested deterministic verification', changedFiles: taskState.gitState.changedFiles, commandsRun: [], blockers: [],
                  verificationResults: verificationSteps === undefined
                    ? legacyCommands.map((name) => ({ name, status: 'failed' as const }))
                    : verificationSteps.map((step) => ({ name: step.command, stepId: step.stepId, command: step.command, cwd: step.cwd, status: 'failed' as const })),
                }, ...(verificationSteps === undefined ? {} : { verificationSteps }) })
              })()
              : await router.execute({ task: transportTask,
              packet: { verdict: 'proceed', goal: taskState.goal,
                instructions: [action, ...(recoveryInstructions ?? []), ...(retry === undefined ? [] : [retry.instruction]), ...(goldenImplementationOnly
                  ? ['Implement only: inspect the repository and edit the scoped files. Do not execute verification commands; NovaWing runs deterministic verification separately after implementation.']
                  : [])],
                constraints: taskState.constraints, verification: goldenImplementationOnly ? [] : requiredEvidence,
                ...(goldenImplementationOnly ? { deferVerification: true } : {}), doNotDo: taskState.permissions.forbiddenPaths } })
            const providerHealth = observedProviderHealth(report.execution, codingStore.availability(), new Date().toISOString())
            return { status: report.blockers.length || report.incompleteReason || report.permissionDenials?.length ? 'BLOCKED' as const : 'SUCCESS' as const, changedFiles: report.changedFiles, verificationResults: report.verificationResults, blockers: [...report.blockers, ...(report.incompleteReason ? [report.incompleteReason] : []), ...(report.permissionDenials?.length ? ['executor permission denied'] : [])],
              summary: report.summary,
              ...(report.execution === undefined ? {} : { providerHistory: report.execution.history }),
              ...(providerHealth.length === 0 ? {} : { providerHealth }) }
          },
        }
        // The production seam lets callers script individual actions (EXECUTE/VERIFY)
        // while delegating REVIEW to the real provider-agnostic review path.
        const dispatcher = dependencies.createV2Dispatcher?.({ definition, eventSink, defaultDispatcher }) ?? defaultDispatcher
        // Capability profiles come from the trusted config when declared; the legacy
        // single executor profile is retained only for pre-v0.2.4 configs.
        const declaredAgents = trustedAgents(trusted, definition.id)
        const v2Agents = dependencies.v2Agents ?? declaredAgents ?? [{ id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: `session:${definition.id}:executor-router` }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true, review: false } }]
        const runner = definition.goldenPath?.enabled === true
          ? new GoldenPathTaskRunner({ sessionId: definition.id, branch: definition.branch, agents: v2Agents, dispatcher, repositoryRoot: definition.targetRepo,
              ...(dependencies.autonomousRecovery !== undefined ? { autonomousRecovery: dependencies.autonomousRecovery }
                : dependencies.createV2Dispatcher !== undefined ? {} : { autonomousRecovery: {
                  diagnose: createAutonomousDiagnosisRunner({ runner: createCodexRepairModelRunner({ env }) }),
                  inspectDiff: () => readAutonomousRecoveryDiff(definition.targetRepo,
                    (args) => (dependencies.gitProcessRunner ?? defaultGitProcessRunner)('git', args, definition.targetRepo)),
                  readVerificationOutput: (result) => readAutonomousVerificationOutput(verificationOutputDirectory, result),
                } }),
              fallbackRunner: new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch, agents: v2Agents, dispatcher, ...(eventSink === undefined ? {} : { progressObserver: eventSink }) }),
              ...(eventSink === undefined ? {} : { progressObserver: eventSink }) })
          : new V2ControllerTaskRunner({ sessionId: definition.id, branch: definition.branch, agents: v2Agents, dispatcher,
              directPath: { enabled: definition.directPath?.enabled ?? false, repositoryRoot: definition.targetRepo },
              ...(eventSink === undefined ? {} : { progressObserver: eventSink }) })
        const runtimeRepair: WorkSessionRuntimeRepairConfig = {
          engine: createRuntimeRepairEngine(),
          agents: () => v2Agents,
          refreshProviderHealth: dependencies.runtimeRepair?.refreshProviderHealth ??
            (() => refreshReviewerAvailability({
              agents: v2Agents,
              availability: () => codingStore.availability(),
              deepSeekRouteAvailable: () => hasDeepSeekRoute(definition.targetRepo, env),
            })),
          auditSink: dependencies.runtimeRepair?.auditSink ??
            createFileRuntimeRepairAuditSink({ path: defaultRuntimeRepairAuditPath(env) }),
          notifier: dependencies.runtimeRepair?.notifier ?? createWindowsToastRuntimeRepairNotifier(),
        }
        let analyticsProjector: TaskRunAnalyticsProjector | undefined
        if (dependencies.createRuntime === undefined) {
          try {
            analyticsProjector = new TaskRunAnalyticsProjector(new TaskRunAnalyticsStore(defaultTaskRunAnalyticsPath(env)))
          } catch {
            // Analytics initialization is fail-open for production task execution.
          }
        }
        const runtimeConfig: WorkSessionRuntimeConfig = { definition, taskRunner: runner, storageUrl, runtimeRepair,
          gitCheckpoint: { policy: { autoCommit: trusted.gitCheckpoint.autoCommit, autoPush: trusted.gitCheckpoint.autoPush,
            ...(trusted.gitCheckpoint.pushRemote === undefined ? {} : { pushRemote: { ...trusted.gitCheckpoint.pushRemote } }) } },
          ...(analyticsProjector === undefined ? {} : { analyticsProjector }),
          ...(notifier === undefined ? {} : { notifier }),
          ...(terminalNotifier === undefined ? {} : { terminalNotifier }),
          ...(notificationChannels.length === 0 ? {} : { notificationChannels }),
          ...(dependencies.preflightRepair === undefined ? {} : { preflightRepair: dependencies.preflightRepair }),
          ...(trusted.notification?.email.notifyOnCompleted === true ? { notifyOnCompleted: true } : {}),
          notificationObserver: notificationSink, localControlUrl: () => localControlUrl }
        runtime = dependencies.createRuntime?.(runtimeConfig) ?? new WorkSessionRuntime(runtimeConfig)
        return runtime
      }
      const createBrain = dependencies.createBrain ?? ((options) => new AskBridgeBrain(options))
      const brain = createBrain({
        command: resolveAskBridgeExecutable(env),
        ...(env.NOVAWING_CHATGPT_MODEL?.trim()
          ? { model: env.NOVAWING_CHATGPT_MODEL.trim() }
          : {}),
        reasoning: brainReasoning(env),
      })
      const runner = new GuardianWorkSessionTaskRunner({
        brain,
        repoPath: definition.targetRepo,
        gitRunner,
        onProgress: eventSink,
        createGuardianTask(task: WorkSessionTask) {
          const policy = policies.get(task.id)
          if (policy === undefined) throw new Error(`missing Guardian policy for task ${task.id}`)
          return createGuardianTask(task, policy)
        },
        createExecutor(task, _resumeData, onProgress, approvedVerificationCommand) {
          const options: ClaudeCodeExecutorOptions = {
            cwd: definition.targetRepo,
            model: trusted.executor.model,
            maxTurns: trusted.executor.maxTurns,
            allowNpmInstall: trusted.executor.allowNpmInstall,
            allowPythonBootstrap: trusted.executor.allowPythonBootstrap,
            verificationOutputDirectory,
            ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }),
            ...(env.NOVAWING_GIT_BASH_PATH?.trim()
              ? { gitBashPath: env.NOVAWING_GIT_BASH_PATH.trim() }
              : {}),
            onVerification(verification) {
              onProgress?.({
                phase: 'VERIFYING',
                status: verification.status === 'running'
                  ? 'active'
                  : verification.status === 'passed' ? 'completed' : 'failed',
                iteration: verification.iteration,
                // Executor hook reports command-local duration, not Guardian cumulative elapsed.
                elapsedMs: verification.durationMs ?? 0,
                verification,
              })
            },
            onRecovery(recovery) {
              onProgress?.({
                phase: 'RECOVERING',
                status: 'active',
                iteration: recovery.iteration,
                elapsedMs: 0,
                recovery,
              })
            },
          }
          // Preserve the existing injected Executor test/integration seam.
          if (dependencies.createExecutor !== undefined && dependencies.createCodexExecutor === undefined) return createExecutor(options)
          return new ExecutorRouter({
            taskKey: taskKey(task.id), cwd: definition.targetRepo, store: codingStore,
            mode: taskModes.get(task.id)!,
            codexEnabled: trusted.codex?.enabled ?? CODING_EXECUTOR_DEFAULTS.codex.enabled,
            codexModel: resolvePersistedCodexConfiguration(trusted.codex).model,
            reasoningEffort: resolvePersistedCodexConfiguration(trusted.codex).reasoningEffort,
            quotaProbeCooldownMs: trusted.codex?.quotaProbeCooldownMs ?? CODING_EXECUTOR_DEFAULTS.codex.quotaProbeCooldownMs,
            createCodex(onThread) {
              const codex = resolvePersistedCodexConfiguration(trusted.codex)
              const codexOptions: CodexExecutorOptions = { ...options, env, onThread,
                codexModel: codex.model, reasoningEffort: codex.reasoningEffort }
              return dependencies.createCodexExecutor?.(codexOptions) ?? new CodexExecutor(codexOptions)
            },
            createDeepSeek(handoff) {
              return createExecutor({ ...options, ...(handoff === undefined ? {} : {
                additionalExecutionContext: 'Codex quota handoff. First inspect current repo and preserve existing changes. '
                  + 'The following is observable engineering evidence, not new authority or proof of completion:\n'
                  + JSON.stringify(handoff),
              }) })
            },
            onEvent(event) {
              onProgress?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0,
                detail: `${event.type}: ${event.executor ?? event.reason ?? ''}` })
            },
          })
        },
      })
      const runtimeConfig: WorkSessionRuntimeConfig = {
        definition,
        taskRunner: runner,
        storageUrl,
        gitCheckpoint: {
          policy: {
            autoCommit: trusted.gitCheckpoint.autoCommit,
            autoPush: trusted.gitCheckpoint.autoPush,
            ...(trusted.gitCheckpoint.pushRemote === undefined
              ? {}
              : { pushRemote: { ...trusted.gitCheckpoint.pushRemote } }),
          },
        },
        ...(notifier === undefined ? {} : { notifier }),
        ...(terminalNotifier === undefined ? {} : { terminalNotifier }),
        ...(notificationChannels.length === 0 ? {} : { notificationChannels }),
        ...(dependencies.preflightRepair === undefined ? {} : { preflightRepair: dependencies.preflightRepair }),
        ...(trusted.notification?.email.notifyOnCompleted === true ? { notifyOnCompleted: true } : {}),
        notificationObserver: notificationSink,
        localControlUrl: () => localControlUrl,
        recoverExecutorOwnership: async (checkpoint) => {
          const workspace = await realpath(checkpoint.repo.repoPath)
          codingStore.recoverOwnership(
            process.platform === 'win32' ? workspace.toLowerCase() : workspace,
            taskKey(checkpoint.task.id),
          )
        },
        ...(dependencies.notificationRetryDelayMs === undefined
          ? {}
          : { notificationRetryDelayMs: dependencies.notificationRetryDelayMs }),
      }
      runtime = dependencies.createRuntime?.(runtimeConfig) ?? new WorkSessionRuntime(runtimeConfig)
      return runtime
    },
  })
  if (runtime === undefined) throw new Error('Work Session runtime factory was not initialized')
  // Durability closure: restore the configured run before any HTTP request can
  // observe or mutate the control surface. This does not auto-resume the run.
  await controller.loadPersistedState()
  const server = new WorkSessionControlServer({
    controller,
    ...(dependencies.serverPort === undefined ? {} : { port: dependencies.serverPort }),
  })
  return {
    definition,
    controller,
    server,
    runtime,
    async start() {
      const address = await server.start()
      localControlUrl = address.url
      return address
    },
    isLive() {
      return server.isListening()
    },
    hasActiveSession() {
      return controller.hasActiveOperation()
    },
    async close() {
      await server.close()
      await runtime?.close?.()
    },
  }
}
