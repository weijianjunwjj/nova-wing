import { VENV_PYTEST_COMMANDS } from '../../platform/executables.js'
import { platformPaths } from '../../platform/paths.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { access, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  createProductionWorkSessionUi,
  createProductionGitRunner,
  defaultStorageUrl,
  loadTrustedWorkSessionConfig,
  validateTrustedWorkSessionConfig,
  type ProductionGitProcessRunner,
  type ProductionWorkSessionUi,
  type TrustedWorkSessionConfig,
} from '../production.js'
import { WorkSessionRuntime, type PreflightRepairRecord } from '../runtime.js'
import { normalizeScheduledStart, type ScheduleSource } from '../schedule-policy.js'
import {
  CODING_EXECUTOR_DEFAULTS,
  isSupportedCodexConfiguration,
  resolvePersistedCodexConfiguration,
  type ExecutorMode,
} from '../../coding-executor-config.js'
import {
  CodingExecutionStore,
  defaultCodingExecutionStorePath,
  type CodexAvailability,
} from '../coding-execution-store.js'
import {
  deriveDisplayState,
  type WorkSessionDisplayState,
} from '../recoverability.js'
import { analyzeTaskBrief, MAX_TASK_BRIEF_CHARS } from './task-brief.js'
import {
  preflightTaskContract,
  resolveRepairTestEntry,
  TRUSTED_VERIFIER_COMMANDS,
  type TaskContractIssue,
  type TaskContractPreflightResult,
} from './contract-preflight.js'
import type { AcceptanceEvidenceBinding, VerifierCommandCanonicalization } from '../risk-evidence.js'
import {
  AUTO_REPAIR_EXHAUSTED,
  classifyRepairErrorCode,
  hasLlmRepairableIssue,
  isAutoRepairableIssueSet,
  MAX_AUTO_REPAIR_CYCLES,
  parseEffectiveRepairContract,
  protectedVerifierCommands,
  validateMechanicalRepair,
  type ContractRepairProposal,
  type RepairAgentOutcome,
  type RepairClassification,
  type RepairContext,
  type RepairErrorCode,
  type StructuredRepairTask,
} from './repair.js'
import { createDeterministicRepairAgent, type RepairAgent } from './repair-agent.js'
import { createLlmRepairAgent } from './repair-agent-llm.js'
import { REPAIR_DEFAULT_MODEL, REPAIR_DEFAULT_REASONING_EFFORT } from './repair-model.js'
import {
  createFileRepairAuditSink,
  type AutoRepairAuditEvent,
  type AutoRepairAuditSummary,
  type RepairAttemptStage,
  type RepairAuditEntry,
  type RepairAuditSink,
  type RepairProviderIdentity,
} from './repair-audit.js'
import { createDesktopRepairNotifier, type RepairNotifier } from './repair-notifier.js'
import { defaultTaskRunAnalyticsPath, TaskRunAnalyticsStore } from '../task-run-analytics.js'

const LAUNCHPAD_RUNTIME_LOADED_AT_MS = Date.now()

/**
 * A long-lived Launchpad keeps imported executor code in memory. A later
 * `npm run build` replaces dist on disk but cannot hot-reload that process.
 * Refuse to start another real Session after such a rebuild; otherwise a
 * fixed stdin transport can silently execute through stale argv code.
 */
async function assertLaunchpadRuntimeCurrent(): Promise<void> {
  const loadedModule = await stat(fileURLToPath(import.meta.url))
  if (loadedModule.mtimeMs > LAUNCHPAD_RUNTIME_LOADED_AT_MS + 1_000) {
    throw new Error('NovaWing runtime was rebuilt after Launchpad started; restart Launchpad before starting or recovering a Work Session')
  }
}
import { resolveProductionSmtpEnvironment } from '../local-smtp-secrets.js'
import {
  DependencyPreflightError,
  requireDependencyPreflightReady,
  runProductionDependencyPreflight,
  type DependencyHealthReport,
} from '../dependency-health.js'
import {
  LAUNCHPAD_APP_JS,
  LAUNCHPAD_STYLES_CSS,
  renderLaunchpadHtml,
} from './view.js'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 96 * 1024
const SAFE_LAUNCH_ERROR = 'Work Session 启动失败'
const DEFAULT_EXECUTOR_MODEL = 'sonnet'
const DEFAULT_SOFT_MINUTES = 45
const DEFAULT_HARD_MINUTES = 90
const MAX_COMPOSER_TASKS = 10
export const MAX_COMPOSER_TASK_GOAL_CHARS = 8_000
const MAX_COMPLETED_COMPOSER_REQUESTS = 100
const COMPLETED_COMPOSER_REQUEST_TTL_MS = 5 * 60 * 1_000
const MAX_SESSION_PROJECT_SLUG_LENGTH = 48
const SAFE_COMPOSER_SESSION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{12}-[a-f0-9]{6}$/u

const DEFAULT_GUARDIAN_POLICY = {
  constraints: [
    'Keep changes scoped to the requested task.',
    'Do not modify files outside allowedPaths.',
  ],
  acceptanceCriteria: [
    'Implement the requested task.',
    'Run relevant deterministic tests.',
  ],
  doNotDo: [
    'Do not access, expose, or modify credentials or secrets.',
    'Do not modify files outside allowedPaths.',
    'Do not push changes.',
  ],
  forbiddenPaths: ['.env', '**/.env', '**/*secret*', '**/*credential*'],
} as const

export interface LaunchpadConfigSummary {
  executorMode?: ExecutorMode
  codexModel?: string
  codexReasoningEffort?: string
  scheduledStartAt?: string | null
  scheduleSource?: ScheduleSource
  configId: string
  project: string
  taskId: string
  goal: string
  additionalTaskCount: number
  branch: string
  reviewer: 'GPT Reviewer'
  executor: string
  autoCommit: boolean
  autoPush: boolean
  emailEnabled: boolean
  /** T021: 派生展示状态（持久化 state 与当前进程 Runner 存活状态分离）。start() 前为 undefined。 */
  status?: WorkSessionDisplayState
}

interface DiscoveredLaunchpadConfig {
  configPath: string
  config: TrustedWorkSessionConfig
  summary: LaunchpadConfigSummary
}

export interface NovaWingLaunchpadAddress {
  host: typeof LOOPBACK_HOST
  port: number
  url: string
}

interface ManagedWorkSessionApp {
  controller: {
    start(): { started: boolean }
    getSnapshot?(): { runtime: { displayState?: WorkSessionDisplayState } }
  }
  start(): Promise<{ url: string }>
  /** Whether the local control server is still accepting connections. */
  isLive(): boolean
  /** Whether start/resume/recovery work is currently in flight. */
  hasActiveSession(): boolean
  close(): Promise<void>
}

interface LiveWorkSessionApp {
  app: ManagedWorkSessionApp
  controlUrl: string
}

export interface NovaWingLaunchpadDependencies {
  loadConfig?: (configPath: string) => Promise<TrustedWorkSessionConfig>
  resolveEnvironment?: (config: TrustedWorkSessionConfig) => Promise<NodeJS.ProcessEnv>
  createWorkSession?: (
    config: TrustedWorkSessionConfig,
    options: { env: NodeJS.ProcessEnv; serverPort: 0; preflightRepair?: PreflightRepairRecord },
  ) => Promise<ManagedWorkSessionApp>
  gitProcessRunner?: ProductionGitProcessRunner
  shutdownTimeoutMs?: number
  /** T021: 读取某 config 对应持久化 Session 的派生展示状态（缺省读 Mastra storage）。 */
  readSessionStatus?: (config: TrustedWorkSessionConfig) => Promise<WorkSessionDisplayState>
  /** One-shot bounded preflight; production enables it explicitly. */
  preflight?: (targetRepo?: string, controlPlane?: 'v1' | 'v2') => Promise<DependencyHealthReport>
  /** Existing local Codex quota observation; failures intentionally remain unknown. */
  readCodexAvailability?: () => CodexAvailability | Promise<CodexAvailability>
  /** AI Repair & Retry: deterministic agent, optional LLM agent, audit sink, notifier. */
  repairAgent?: RepairAgent
  repairLlmAgent?: RepairAgent
  repairProvider?: RepairProviderIdentity
  repairAudit?: RepairAuditSink
  repairNotifier?: RepairNotifier
  /** Injectable analytics database for isolated tests and alternate local profiles. */
  analyticsPath?: string
}

interface LaunchResult {
  accepted: true
  controlUrl: string
  alreadyStarted?: true
  /** True when the Launchpad repaired the Task Contract before this launch. */
  repaired?: boolean
}

type TaskContractSuccess = Extract<TaskContractPreflightResult, { ok: true }>

type TaskContractFailure = Extract<TaskContractPreflightResult, { ok: false }>

/** Result of the shared contract-repair cascade used by the automatic and manual paths. */
interface ContractRepairOutcome {
  launched?: LaunchResult
  errorCode: RepairErrorCode
  classification: RepairClassification
  repairs: readonly string[]
  reason?: string
  appliedProposal?: ContractRepairProposal
  structuredRepairTask?: StructuredRepairTask
  llmInvoked: boolean
  cycles: number
  exhausted: boolean
  autoEvents: readonly AutoRepairAuditEvent[]
}

/**
 * Automatic preflight repair could not produce a launchable contract within its
 * bounded cycles. The original Task is preserved and the issues are returned.
 */
class AutoRepairExhaustedError extends Error {
  constructor(
    readonly issues: readonly TaskContractIssue[],
    readonly attempt: ContractRepairOutcome,
  ) {
    super('automatic preflight repair stopped without a launchable contract')
  }
}

/** Outcome of a Repair & Retry attempt; success launches, failure preserves the original error. */
type RepairLaunchResult =
  | {
      accepted: true
      controlUrl: string
      alreadyStarted?: true
      repaired: boolean
      repairs: readonly string[]
    }
  | {
      accepted: false
      error: 'TASK_CONTRACT_INVALID'
      issues: readonly TaskContractIssue[]
      repairErrorCode: RepairErrorCode
      repairAttempt: {
        classification: RepairClassification
        reason?: string
        repairs: readonly string[]
        structuredRepairTask?: StructuredRepairTask
        /** Whether the deterministic agent ran before the model was consulted. */
        deterministicAttempted: boolean
        llmInvoked: boolean
        provider: RepairProviderIdentity
      }
    }

interface ComposerRequest {
  directPathEnabled: boolean
  goldenPathEnabled: boolean
  executorMode: ExecutorMode
  codexModel: string
  codexReasoningEffort: string
  scheduledStartAt: string | null
  scheduleSource: ScheduleSource
  requestId: string
  targetRepo: string
  branch?: string
  tasks: Array<{
    id: string
    goal: string
  }>
  executorModel: string
  softMinutes: number
  hardMinutes: number
  autoCommit: boolean
  autoPush: boolean
  pushRemote?: {
    name: string
    expectedUrl: string
  }
  emailEnabled: boolean
  guardian: {
    constraints?: string[]
    acceptanceCriteria?: string[]
    acceptanceEvidenceBindings?: AcceptanceEvidenceBinding[]
    doNotDo?: string[]
    allowedPaths: string[]
    forbiddenPaths?: string[]
  }
}

type ComposerParseResult = { ok: true; value: ComposerRequest } | { ok: false; error: ComposerError }
type ComposerError =
  | 'INVALID_PROJECT_PATH'
  | 'NOT_A_GIT_REPOSITORY'
  | 'CANNOT_READ_BRANCH'
  | 'BRANCH_MISMATCH'
  | 'INVALID_TASK_ID'
  | 'INVALID_TASK'
  | 'INVALID_TASK_TOO_LONG'
  | 'DUPLICATE_TASK_ID'
  | 'INVALID_LIMITS'
  | 'MISSING_ALLOWED_PATHS'
  | 'INVALID_GUARDIAN_POLICY'
  | 'AUTO_PUSH_REQUIRES_AUTO_COMMIT'
  | 'AUTO_PUSH_REMOTE_UNAVAILABLE'
  | 'INVALID_PUSH_REMOTE'
  | 'INVALID_REQUEST'
  | 'INVALID_SCHEDULE'
  | 'IDEMPOTENCY_CONFLICT'

const COMPOSER_SAFE_MESSAGES: Record<ComposerError | 'SESSION_START_FAILED', string> = {
  INVALID_PROJECT_PATH: '项目目录必须是存在的绝对路径。',
  NOT_A_GIT_REPOSITORY: '项目目录不是有效的 Git 仓库。',
  CANNOT_READ_BRANCH: '无法读取项目当前 Git 分支。',
  BRANCH_MISMATCH: 'Task Brief 中的分支与项目当前 Git 分支不一致。',
  INVALID_TASK_ID: '请填写有效的 Task ID（仅允许字母、数字、点、下划线和连字符）。',
  INVALID_TASK: '请填写有效的 Task 描述。',
  INVALID_TASK_TOO_LONG: `Task 描述过长，最大 ${MAX_COMPOSER_TASK_GOAL_CHARS} 字符。`,
  DUPLICATE_TASK_ID: 'Task ID 不得重复。',
  INVALID_LIMITS: '时间限制无效：Hard Limit 必须不小于 Soft Limit。',
  MISSING_ALLOWED_PATHS: '请填写至少一个允许修改路径。',
  INVALID_GUARDIAN_POLICY: 'Guardian 规则无效。',
  AUTO_PUSH_REQUIRES_AUTO_COMMIT: 'Auto Push requires Auto Commit。',
  AUTO_PUSH_REMOTE_UNAVAILABLE: '无法确定 Auto Push 的 origin 远端，请填写有效的远端配置。',
  INVALID_PUSH_REMOTE: 'Auto Push remote 配置无效。',
  INVALID_REQUEST: '创建请求无效。',
  INVALID_SCHEDULE: '开始时间无效，请提供包含时区的 ISO 时间。',
  IDEMPOTENCY_CONFLICT: '该 requestId 已用于不同的创建请求。',
  SESSION_START_FAILED: SAFE_LAUNCH_ERROR,
}

interface ComposerCreateEntry {
  canonicalPayload: string
  launch: Promise<LaunchResult>
}

interface CompletedComposerCreateEntry {
  canonicalPayload: string
  result: LaunchResult
  completedAt: number
}

function titleCaseProject(directoryName: string): string {
  return directoryName
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('-')
}

function summaryFromConfig(configId: string, config: TrustedWorkSessionConfig): LaunchpadConfigSummary {
  const firstTask = config.tasks[0]
  if (firstTask === undefined) throw new Error('trusted config has no tasks')
  return {
    configId,
    executorMode: firstTask.executorMode ?? config.executor.defaultMode ?? (config.session.scheduleSource === 'deepseek_off_peak' ? 'deepseek' : CODING_EXECUTOR_DEFAULTS.defaultMode),
    codexModel: resolvePersistedCodexConfiguration(config.codex).model,
    codexReasoningEffort: resolvePersistedCodexConfiguration(config.codex).reasoningEffort,
    scheduledStartAt: config.session.scheduledStartAt ?? null,
    scheduleSource: config.session.scheduleSource ?? 'immediate',
    project: titleCaseProject(basename(config.session.targetRepo)),
    taskId: firstTask.id,
    goal: firstTask.goal,
    additionalTaskCount: config.tasks.length - 1,
    branch: config.session.branch,
    reviewer: 'GPT Reviewer',
    executor: config.executor.model,
    autoCommit: config.gitCheckpoint.autoCommit,
    autoPush: config.gitCheckpoint.autoPush,
    emailEnabled: config.notification?.email.enabled === true,
  }
}

export function defaultTrustedConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.NOVAWING_CONFIG_DIR?.trim()
  if (override !== undefined && override.length > 0) return resolve(override)
  return platformPaths({ env, userHome, platform }).trustedConfig
}

export async function discoverTrustedWorkSessionConfigs(
  configDirectory: string,
  loadConfig: (configPath: string) => Promise<TrustedWorkSessionConfig> = loadTrustedWorkSessionConfig,
): Promise<readonly DiscoveredLaunchpadConfig[]> {
  const entries = await readdir(configDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  })
  const discovered: DiscoveredLaunchpadConfig[] = []

  for (const entry of entries
    .filter((candidate) => candidate.isFile() && candidate.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const configPath = join(configDirectory, entry.name)
    try {
      const config = await loadConfig(configPath)
      const configId = randomBytes(16).toString('hex')
      discovered.push({ configPath, config, summary: summaryFromConfig(configId, config) })
    } catch {
      // One invalid trusted config must not prevent the remaining cards from loading.
    }
  }
  return discovered
}

/**
 * Persists a validated Composer config without ever exposing a partially-written
 * JSON file to trusted-config discovery. Composer session ids are generated by
 * this module and are intentionally constrained before deriving a filename.
 */
export async function persistComposedTrustedWorkSessionConfig(
  configDirectory: string,
  config: TrustedWorkSessionConfig,
): Promise<string> {
  const sessionId = config.session.id
  if (!SAFE_COMPOSER_SESSION_ID.test(sessionId)) {
    throw new Error('Composer session id is not safe for config filename')
  }

  const directory = resolve(configDirectory)
  const configPath = join(directory, `${sessionId}.json`)
  const temporaryPath = join(directory, `.${sessionId}.${randomBytes(8).toString('hex')}.tmp`)
  const content = `${JSON.stringify(config, undefined, 2)}\n`

  await mkdir(directory, { recursive: true })
  try {
    await access(configPath)
    throw new Error('Composer config filename collision')
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, configPath)
    return configPath
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export class NovaWingLaunchpad {
  private readonly configDirectory: string
  private readonly configs: Map<string, DiscoveredLaunchpadConfig>
  private readonly loadConfig: (configPath: string) => Promise<TrustedWorkSessionConfig>
  private readonly resolveEnvironment: (config: TrustedWorkSessionConfig) => Promise<NodeJS.ProcessEnv>
  private readonly createWorkSession: NonNullable<NovaWingLaunchpadDependencies['createWorkSession']>
  private readonly gitProcessRunner: ProductionGitProcessRunner | undefined
  private readonly shutdownTimeoutMs: number
  private readonly readSessionStatus: (config: TrustedWorkSessionConfig) => Promise<WorkSessionDisplayState>
  private readonly preflight: NovaWingLaunchpadDependencies['preflight']
  private readonly readCodexAvailability: () => CodexAvailability | Promise<CodexAvailability>
  private readonly repairAgent: RepairAgent
  private readonly repairLlmAgent: RepairAgent
  private readonly repairProvider: RepairProviderIdentity
  private readonly repairAudit: RepairAuditSink
  private readonly repairNotifier: RepairNotifier
  private readonly analyticsPath: string
  private readonly statuses = new Map<string, WorkSessionDisplayState>()
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly activeStarts = new Map<string, Promise<LaunchResult>>()
  private readonly activeDeletes = new Set<string>()
  private readonly activeCreates = new Map<string, ComposerCreateEntry>()
  private readonly completedCreates = new Map<string, CompletedComposerCreateEntry>()
  private readonly liveApps = new Map<string, LiveWorkSessionApp>()

  private address: NovaWingLaunchpadAddress | undefined
  private closed = false
  private scheduleRecoveryTimer: NodeJS.Timeout | undefined
  private scheduleRecovery: Promise<void> | undefined
  private dependencyHealth: DependencyHealthReport = {
    overall: 'READY', canStart: true, checkedAt: new Date(0).toISOString(), dependencies: [],
  }
  private initialExecutorMode: Exclude<ExecutorMode, 'auto'> = 'codex'

  constructor(
    discovered: readonly DiscoveredLaunchpadConfig[],
    configDirectoryOrDependencies: string | NovaWingLaunchpadDependencies = defaultTrustedConfigDirectory(),
    providedDependencies: NovaWingLaunchpadDependencies = {},
  ) {
    const configDirectory = typeof configDirectoryOrDependencies === 'string'
      ? configDirectoryOrDependencies
      : defaultTrustedConfigDirectory()
    const dependencies = typeof configDirectoryOrDependencies === 'string'
      ? providedDependencies
      : configDirectoryOrDependencies
    this.configDirectory = resolve(configDirectory)
    this.configs = new Map(discovered.map((config) => [config.summary.configId, config]))
    this.loadConfig = dependencies.loadConfig ?? loadTrustedWorkSessionConfig
    this.resolveEnvironment = dependencies.resolveEnvironment ?? resolveProductionSmtpEnvironment
    this.createWorkSession = dependencies.createWorkSession ?? (
      async (config, options): Promise<ProductionWorkSessionUi> =>
        createProductionWorkSessionUi(config, options)
    )
    this.shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000
    this.gitProcessRunner = dependencies.gitProcessRunner
    this.readSessionStatus = dependencies.readSessionStatus ?? readProductionSessionStatus
    this.preflight = dependencies.preflight
    this.readCodexAvailability = dependencies.readCodexAvailability ?? (() =>
      new CodingExecutionStore(defaultCodingExecutionStorePath()).availability())
    this.repairAgent = dependencies.repairAgent ?? createDeterministicRepairAgent()
    this.repairLlmAgent = dependencies.repairLlmAgent ?? createLlmRepairAgent()
    this.repairProvider = dependencies.repairProvider ?? {
      id: 'codex',
      model: REPAIR_DEFAULT_MODEL,
      reasoningEffort: REPAIR_DEFAULT_REASONING_EFFORT,
    }
    this.repairAudit = dependencies.repairAudit ?? createFileRepairAuditSink()
    this.repairNotifier = dependencies.repairNotifier ?? createDesktopRepairNotifier()
    this.analyticsPath = dependencies.analyticsPath ?? defaultTaskRunAnalyticsPath()
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  getConfigs(): readonly LaunchpadConfigSummary[] {
    return [...this.configs.values()].map((config) => {
      const status = this.liveApps.get(config.summary.configId)?.app.controller.getSnapshot?.().runtime.displayState ?? this.statuses.get(config.summary.configId)
      return { ...config.summary, ...(status === undefined ? {} : { status }) }
    })
  }

  /** Unknown, failed, stale, and timed-out observations never mean exhausted. */
  private async resolveInitialExecutorMode(): Promise<Exclude<ExecutorMode, 'auto'>> {
    try {
      const availability = await this.readCodexAvailability()
      if (availability.state !== 'quota_exhausted') return 'codex'
      const expiry = availability.blockedUntil ?? availability.nextProbeAt
      if (expiry === undefined) return 'deepseek'
      const expiryMs = Date.parse(expiry)
      return Number.isFinite(expiryMs) && expiryMs > Date.now() ? 'deepseek' : 'codex'
    } catch {
      return 'codex'
    }
  }

  /** T021: 读取每个 config 的持久化状态并派生展示状态。只发现、不自动恢复。 */
  private async hydrateStatuses(): Promise<void> {
    await Promise.all([...this.configs.values()].map(async (config) => {
      const configId = config.summary.configId
      // Storage failures are not evidence of a new/READY session. Propagate them
      // so a corrupt or unreadable completed session cannot be offered as fresh.
      const status = await this.readSessionStatus(config.config)
      this.statuses.set(configId, status)
    }))
  }

  getAddress(): NovaWingLaunchpadAddress | undefined {
    return this.address
  }

  getTokenForTest(): string {
    return this.token
  }

  async start(): Promise<NovaWingLaunchpadAddress> {
    if (this.closed) throw new Error('Launchpad is closed')
    if (this.address !== undefined) return this.address
    await this.hydrateStatuses()
    this.initialExecutorMode = await this.resolveInitialExecutorMode()
    if (this.preflight !== undefined) {
      this.dependencyHealth = await this.preflight(undefined, 'v2').catch(() => ({
        overall: 'DEGRADED' as const,
        canStart: false,
        checkedAt: new Date().toISOString(),
        dependencies: [{ id: 'CORE' as const, state: 'DEGRADED' as const, failureType: 'PREFLIGHT_FAILED', safeMessage: 'Dependency preflight 无法完成。' }],
      }))
    }
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error)
      this.server.once('error', onError)
      this.server.listen(0, LOOPBACK_HOST, () => {
        this.server.off('error', onError)
        resolveStart()
      })
    })
    const address = this.server.address()
    if (typeof address !== 'object' || address === null) {
      throw new Error('Launchpad did not receive a TCP address')
    }
    this.address = {
      host: LOOPBACK_HOST,
      port: address.port,
      url: `http://${LOOPBACK_HOST}:${address.port}`,
    }
    await this.recoverScheduledSessions()
    this.scheduleRecoveryTimer = setInterval(() => { void this.recoverScheduledSessions() }, 5_000)
    this.scheduleRecoveryTimer.unref()
    return this.address
  }

  /** Only scheduled configs are automatically reopened. Existing interrupted runs stay manual. */
  private async recoverScheduledSessions(): Promise<void> {
    if (this.closed || this.scheduleRecovery !== undefined) return
    this.scheduleRecovery = (async () => {
      for (const [id, entry] of this.configs) {
        if (this.closed) break
        if (entry.config.session.scheduledStartAt == null || this.liveApps.has(id) || this.activeDeletes.has(id)) continue
        try {
          const status = await this.readSessionStatus(entry.config)
          this.statuses.set(id, status)
          if (status === 'SCHEDULED') await this.startWorkSession(id)
        } catch { /* Storage/dependency outage: keep the durable gate, retry opening later. */ }
      }
    })()
    try { await this.scheduleRecovery } finally { this.scheduleRecovery = undefined }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.scheduleRecoveryTimer !== undefined) clearInterval(this.scheduleRecoveryTimer)
    await bounded(this.scheduleRecovery ?? Promise.resolve(), this.shutdownTimeoutMs)
    if (this.address !== undefined) {
      const closeListener = new Promise<void>((resolveClose) => {
        this.server.close(() => resolveClose())
        this.server.closeAllConnections()
      })
      await bounded(closeListener, this.shutdownTimeoutMs)
      this.address = undefined
    }

    await bounded(
      Promise.allSettled(this.activeStarts.values()).then(() => undefined),
      this.shutdownTimeoutMs,
    )
    await bounded(
      Promise.allSettled([...this.activeCreates.values()].map(({ launch }) => launch)).then(() => undefined),
      this.shutdownTimeoutMs,
    )
    await bounded(
      Promise.allSettled([...this.liveApps.values()].map(({ app }) => app.close())).then(() => undefined),
      this.shutdownTimeoutMs,
    )
    this.liveApps.clear()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== this.expectedHost()) {
      this.respondJson(response, 403, { error: 'forbidden host' })
      return
    }

    const method = request.method ?? 'GET'
    const path = pathOf(request)
    if (method === 'GET' && path === '/') {
      this.serveHtml(response)
      return
    }
    if (method === 'GET' && path === '/app.js') {
      this.serveAsset(response, 'text/javascript; charset=utf-8', LAUNCHPAD_APP_JS)
      return
    }
    if (method === 'GET' && path === '/api/session/configs') {
      this.respondJson(response, 200, this.getConfigs())
      return
    }
    if (method === 'GET' && path.startsWith('/api/analytics/')) {
      this.serveAnalytics(request, response, path)
      return
    }
    if (method === 'GET' && path === '/styles.css') {
      this.serveAsset(response, 'text/css; charset=utf-8', LAUNCHPAD_STYLES_CSS)
      return
    }
    if (method === 'POST' && path === '/api/session/start') {
      await this.serveStart(request, response)
      return
    }
    if (method === 'POST' && path === '/api/session/create') {
      await this.serveCreate(request, response)
      return
    }
    if (method === 'POST' && path === '/api/session/repair') {
      await this.serveRepair(request, response)
      return
    }
    if (method === 'POST' && path === '/api/session/delete') {
      await this.serveDelete(request, response)
      return
    }
    if (method === 'POST' && path === '/api/session/branch') {
      await this.serveBranch(request, response)
      return
    }
    if (method === 'POST' && path === '/api/session/brief') {
      await this.serveTaskBrief(request, response)
      return
    }

    const knownPaths = new Set([
      '/', '/app.js', '/styles.css', '/api/session/start', '/api/session/create',
      '/api/session/repair', '/api/session/delete', '/api/session/branch', '/api/session/brief', '/api/session/configs',
    ])
    this.respondJson(response, knownPaths.has(path) ? 405 : 404, {
      error: knownPaths.has(path) ? 'method not allowed' : 'not found',
    })
  }

  private serveAnalytics(request: IncomingMessage, response: ServerResponse, path: string): void {
    let store: TaskRunAnalyticsStore | undefined
    try {
      store = new TaskRunAnalyticsStore(this.analyticsPath)
      if (path === '/api/analytics/recent') {
        const raw = new URL(request.url ?? path, this.origin()).searchParams.get('limit') ?? '5'
        const limit = Number(raw)
        if (limit !== 5 && limit !== 10 && limit !== 20) { this.respondJson(response, 400, { error: 'limit must be 5, 10, or 20' }); return }
        this.respondJson(response, 200, store.recent(limit)); return
      }
      if (path === '/api/analytics/reasons') {
        const query = new URL(request.url ?? path, this.origin()).searchParams
        const raw = query.get('limit') ?? '20'
        const limit = Number(raw)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { this.respondJson(response, 400, { error: 'limit must be between 1 and 100' }); return }
        const reasonClass = query.get('class') ?? 'all'
        if (reasonClass !== 'all' && reasonClass !== 'actionable') { this.respondJson(response, 400, { error: 'class must be all or actionable' }); return }
        this.respondJson(response, 200, reasonClass === 'actionable' ? store.actionableReasons(limit) : store.reasons(limit)); return
      }
      const task = path.match(/^\/api\/analytics\/tasks\/([^/]+)$/u)
      if (task !== null) { const rows = store.findByTask(decodeURIComponent(task[1]!)); this.respondJson(response, rows.length === 0 ? 404 : 200, rows.length === 0 ? { error: 'not found' } : rows); return }
      const session = path.match(/^\/api\/analytics\/sessions\/([^/]+)$/u)
      if (session !== null) { const rows = store.findBySession(decodeURIComponent(session[1]!)); this.respondJson(response, rows.length === 0 ? 404 : 200, rows.length === 0 ? { error: 'not found' } : rows); return }
      this.respondJson(response, 404, { error: 'not found' })
    } catch {
      this.respondJson(response, 503, { error: 'analytics unavailable' })
    } finally {
      store?.close()
    }
  }

  private serveHtml(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    response.end(renderLaunchpadHtml({
      configs: this.getConfigs(),
      launchToken: this.token,
      serverOrigin: this.origin(),
      dependencyHealth: this.dependencyHealth,
      initialExecutorMode: this.initialExecutorMode,
    }))
  }

  private serveAsset(response: ServerResponse, contentType: string, body: string): void {
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    response.end(body)
  }

  private async serveStart(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(response, 415, { error: 'content type must be application/json' })
      return
    }

    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const parsed = parseStartBody(body)
    if (!parsed.ok) {
      this.respondJson(response, 400, { error: parsed.error })
      return
    }
    if (!this.configs.has(parsed.configId)) {
      this.respondJson(response, 404, { error: 'unknown config' })
      return
    }

    try {
      const result = await this.startWorkSession(parsed.configId)
      this.respondJson(response, 202, result)
    } catch (error) {
      if (this.respondPreflightError(response, error)) return
      this.respondJson(response, 500, { error: SAFE_LAUNCH_ERROR })
    }
  }

  private async serveCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(response, 415, { error: 'content type must be application/json' })
      return
    }
    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const parsed = parseComposerBody(body)
    if (!parsed.ok) {
      this.respondComposerError(response, 400, parsed.error)
      return
    }
    try {
      const result = await this.createWorkSessionFromComposer(parsed.value)
      this.respondJson(response, 202, result)
    } catch (error) {
      if (this.respondPreflightError(response, error)) return
      if (error instanceof AutoRepairExhaustedError) {
        // Only a contract that the bounded automatic cascade could not repair
        // reaches the operator, and it always carries the remaining issues.
        this.respondJson(response, 400, {
          error: 'TASK_CONTRACT_INVALID',
          issues: error.issues,
          repairable: true,
          repairErrorCode: error.attempt.errorCode,
          autoRepair: {
            result: error.attempt.exhausted ? AUTO_REPAIR_EXHAUSTED : 'AUTO_REPAIR_FAILED',
            maxCycles: MAX_AUTO_REPAIR_CYCLES,
            cycles: error.attempt.cycles,
            exhausted: error.attempt.exhausted,
            classification: error.attempt.classification,
            ...(error.attempt.reason === undefined ? {} : { reason: error.attempt.reason }),
            events: error.attempt.autoEvents,
          },
        })
        return
      }
      if (error instanceof TaskContractPreflightError) {
        const repairErrorCode = classifyRepairErrorCode(error.issues)
        this.respondJson(response, 400, {
          error: 'TASK_CONTRACT_INVALID',
          issues: error.issues,
          repairable: repairErrorCode !== undefined && !error.issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION'),
          ...(repairErrorCode === undefined ? {} : { repairErrorCode }),
        })
        return
      }
      const code = error instanceof ComposerLaunchError ? error.code : 'SESSION_START_FAILED'
      const status = code === 'SESSION_START_FAILED' ? 500 : code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400
      this.respondComposerError(response, status, code)
    }
  }

  private async serveRepair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(response, 415, { error: 'content type must be application/json' })
      return
    }
    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const parsed = parseComposerBody(body)
    if (!parsed.ok) {
      this.respondComposerError(response, 400, parsed.error)
      return
    }
    try {
      const result = await this.repairComposedWorkSession(parsed.value)
      this.respondJson(response, result.accepted ? 202 : 400, result)
    } catch (error) {
      if (this.respondPreflightError(response, error)) return
      if (error instanceof TaskContractPreflightError) {
        this.respondJson(response, 400, { error: 'TASK_CONTRACT_INVALID', issues: error.issues, repairable: false })
        return
      }
      const code = error instanceof ComposerLaunchError ? error.code : 'SESSION_START_FAILED'
      const status = code === 'SESSION_START_FAILED' ? 500 : 400
      this.respondComposerError(response, status, code)
    }
  }

  private async serveDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(response, 415, { error: 'content type must be application/json' })
      return
    }
    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const parsed = parseConfigIdBody(body)
    if (!parsed.ok) {
      this.respondJson(response, 400, { error: 'INVALID_REQUEST' })
      return
    }
    if (!this.configs.has(parsed.configId)) {
      this.respondJson(response, 404, { error: 'UNKNOWN_CONFIG' })
      return
    }
    try {
      await this.deleteWorkSessionConfig(parsed.configId)
      this.respondJson(response, 200, { deleted: true })
    } catch (error) {
      const code = error instanceof DeleteConfigError ? error.code : 'DELETE_FAILED'
      const status = code === 'UNKNOWN_CONFIG' ? 404 : code === 'SESSION_ACTIVE' ? 409 : 500
      this.respondJson(response, status, { error: code })
    }
  }

  private async serveBranch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const targetRepo = parseBranchBody(body)
    if (targetRepo === undefined) {
      this.respondComposerError(response, 400, 'INVALID_PROJECT_PATH')
      return
    }
    const resolved = resolve(targetRepo)
    if (!isAbsolute(targetRepo) || !await isDirectory(resolved)) {
      this.respondComposerError(response, 400, 'INVALID_PROJECT_PATH')
      return
    }
    try {
      const branch = await this.readCurrentBranch(resolved)
      const pushRemote = await this.readOriginPushRemote(resolved)
      this.respondJson(response, 200, {
        branch,
        pushRemoteStatus: pushRemote === undefined ? 'unavailable' : 'available',
        ...(pushRemote === undefined ? {} : { pushRemote }),
      })
    } catch (error) {
      const code = error instanceof ComposerLaunchError ? error.code : 'CANNOT_READ_BRANCH'
      this.respondComposerError(response, 400, code)
    }
  }

  /** Analysis is a non-mutating helper; it never creates or starts a Session. */
  private async serveTaskBrief(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorizeMutation(request, response)) return
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(response, 415, { error: 'content type must be application/json' })
      return
    }
    const body = await readBodyWithLimit(request).catch(() => undefined)
    if (body === undefined) {
      this.respondJson(response, 413, { error: 'payload too large' })
      return
    }
    const brief = parseTaskBriefBody(body)
    if (brief === undefined) {
      this.respondJson(response, 400, { error: 'INVALID_BRIEF' })
      return
    }
    this.respondJson(response, 200, analyzeTaskBrief(brief.value, new Date(), brief.executorMode ?? this.initialExecutorMode))
  }

  private authorizeMutation(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.originMatchesRequest(request)) {
      this.respondJson(response, 403, { error: 'forbidden origin' })
      return false
    }
    const provided = request.headers['x-novawing-launchpad-token']
    if (typeof provided !== 'string' || !tokenMatches(this.token, provided)) {
      this.respondJson(response, 403, { error: 'forbidden' })
      return false
    }
    return true
  }

  private originMatchesRequest(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (origin === this.origin()) return true
    if (
      origin !== `http://${LOOPBACK_HOST}` ||
      request.headers.host !== this.expectedHost() ||
      request.headers['sec-fetch-site'] !== 'same-origin'
    ) {
      return false
    }
    const referer = request.headers.referer
    if (typeof referer !== 'string') return false
    try {
      return new URL(referer).origin === this.origin()
    } catch {
      return false
    }
  }

  private async startWorkSession(configId: string, preflightRepair?: PreflightRepairRecord): Promise<LaunchResult> {
    await assertLaunchpadRuntimeCurrent()
    if (this.activeDeletes.has(configId)) throw new Error('unknown config')
    const existing = this.activeStarts.get(configId)
    if (existing !== undefined) {
      const result = await existing
      return { ...result, alreadyStarted: true }
    }
    const discovered = this.configs.get(configId)
    if (discovered === undefined) throw new Error('unknown config')

    const launch = this.launchWorkSession(configId, discovered, preflightRepair)
    this.activeStarts.set(configId, launch)
    try {
      return await launch
    } finally {
      if (this.activeStarts.get(configId) === launch) this.activeStarts.delete(configId)
    }
  }

  private async deleteWorkSessionConfig(configId: string): Promise<void> {
    const discovered = this.configs.get(configId)
    if (discovered === undefined || this.activeDeletes.has(configId)) {
      throw new DeleteConfigError('UNKNOWN_CONFIG')
    }
    if (this.activeStarts.has(configId)) {
      throw new DeleteConfigError('SESSION_ACTIVE')
    }
    const liveApp = this.liveApps.get(configId)
    if (liveApp !== undefined && this.isBlockingLiveApp(liveApp.app)) {
      throw new DeleteConfigError('SESSION_ACTIVE')
    }
    const configPath = this.resolveTrustedConfigPath(discovered)
    if (configPath === undefined) throw new DeleteConfigError('DELETE_FAILED')

    this.activeDeletes.add(configId)
    try {
      if (liveApp !== undefined) {
        this.liveApps.delete(configId)
        await liveApp.app.close().catch(() => undefined)
      }
      try {
        await unlink(configPath)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw new DeleteConfigError('DELETE_FAILED')
        }
      }
      this.configs.delete(configId)
      this.statuses.delete(configId)
    } finally {
      this.activeDeletes.delete(configId)
    }
  }

  private isBlockingLiveApp(app: ManagedWorkSessionApp): boolean {
    try {
      return app.isLive() && app.hasActiveSession()
    } catch {
      // An indeterminate app is treated as active. Deletion must fail closed.
      return true
    }
  }

  private resolveTrustedConfigPath(discovered: DiscoveredLaunchpadConfig): string | undefined {
    const configPath = resolve(discovered.configPath)
    const relativePath = relative(this.configDirectory, configPath)
    if (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      relativePath.startsWith('..\\') ||
      dirname(configPath) !== this.configDirectory
    ) {
      return undefined
    }
    return configPath
  }

  private async launchWorkSession(
    configId: string,
    discovered: DiscoveredLaunchpadConfig,
    preflightRepair?: PreflightRepairRecord,
  ): Promise<LaunchResult> {
    if (this.closed) throw new Error('Launchpad is closed')
    const existing = this.liveApps.get(configId)
    if (existing !== undefined) {
      try {
        if (existing.app.isLive()) {
          return { accepted: true, controlUrl: existing.controlUrl, alreadyStarted: true }
        }
      } catch {
        // A failed liveness probe retires the stale app before relaunch.
      }
      this.liveApps.delete(configId)
      await existing.app.close().catch(() => undefined)
    }
    const config = await this.loadConfig(discovered.configPath)
    if (config.session.scheduledStartAt == null) await this.assertDependenciesReady(config.session.targetRepo, config.session.controlPlane ?? 'v1')
    const env = await this.resolveEnvironment(config)
    const app = await this.createWorkSession(config, {
      env,
      serverPort: 0,
      ...(preflightRepair === undefined ? {} : { preflightRepair }),
    })
    if (this.closed) {
      await app.close()
      throw new Error('Launchpad is closed')
    }

    try {
      const address = await app.start()
      if (this.closed) {
        await app.close()
        throw new Error('Launchpad is closed')
      }
      const result = app.controller.start()
      this.liveApps.set(configId, { app, controlUrl: address.url })
      return {
        accepted: true,
        controlUrl: address.url,
        ...(result.started ? {} : { alreadyStarted: true }),
      }
    } catch (error) {
      this.liveApps.delete(configId)
      await app.close().catch(() => undefined)
      throw error
    }
  }

  private async createWorkSessionFromComposer(input: ComposerRequest): Promise<LaunchResult> {
    this.pruneCompletedCreates()
    const canonicalPayload = canonicalComposerPayload(input)
    const existing = this.activeCreates.get(input.requestId)
    if (existing !== undefined) {
      if (existing.canonicalPayload !== canonicalPayload) throw new ComposerLaunchError('IDEMPOTENCY_CONFLICT')
      return existing.launch
    }
    const completed = this.completedCreates.get(input.requestId)
    if (completed !== undefined) {
      if (completed.canonicalPayload !== canonicalPayload) throw new ComposerLaunchError('IDEMPOTENCY_CONFLICT')
      return completed.result
    }
    const launch = this.launchComposedWorkSession(input)
    this.activeCreates.set(input.requestId, { canonicalPayload, launch })
    try {
      const result = await launch
      this.completedCreates.set(input.requestId, { canonicalPayload, result, completedAt: Date.now() })
      this.pruneCompletedCreates()
      return result
    } catch (error) {
      this.activeCreates.delete(input.requestId)
      throw error
    } finally {
      this.activeCreates.delete(input.requestId)
    }
  }

  private pruneCompletedCreates(now = Date.now()): void {
    for (const [requestId, entry] of this.completedCreates) {
      if (now - entry.completedAt > COMPLETED_COMPOSER_REQUEST_TTL_MS) this.completedCreates.delete(requestId)
    }
    while (this.completedCreates.size > MAX_COMPLETED_COMPOSER_REQUESTS) {
      const oldestRequestId = this.completedCreates.keys().next().value
      if (oldestRequestId === undefined) return
      this.completedCreates.delete(oldestRequestId)
    }
  }

  private async launchComposedWorkSession(input: ComposerRequest): Promise<LaunchResult> {
    if (this.closed) throw new ComposerLaunchError('SESSION_START_FAILED')
    const targetRepo = resolve(input.targetRepo)
    if (!isAbsolute(input.targetRepo) || !await isDirectory(targetRepo)) {
      throw new ComposerLaunchError('INVALID_PROJECT_PATH')
    }
    if (input.scheduledStartAt === null || Date.parse(input.scheduledStartAt) <= Date.now()) await this.assertDependenciesReady(targetRepo, 'v2')
    const branch = await this.readCurrentBranch(targetRepo)
    if (input.branch !== undefined && input.branch !== branch) {
      throw new ComposerLaunchError('BRANCH_MISMATCH')
    }
    const contract = await preflightTaskContract({
      targetRepo,
      acceptanceCriteria: input.guardian.acceptanceCriteria ?? [],
      acceptanceEvidenceBindings: input.guardian.acceptanceEvidenceBindings ?? [],
        verificationPlannerEnabled: input.directPathEnabled || input.goldenPathEnabled,
    })
    if (contract.ok) return this.buildAndLaunchComposed(input, targetRepo, branch, contract)

    // v0.2.6 Automatic Preflight Repair: when every remaining issue is a
    // mechanical contract-shape problem, the Launchpad runs the existing repair
    // cascade before the operator ever sees a red screen. Anything else — an
    // approval, an ambiguous identity, an unresolvable semantic problem — still
    // fails closed exactly as before.
    if (!isAutoRepairableIssueSet(contract.issues)) throw new TaskContractPreflightError(contract.issues)
    const outcome = await this.cascadeContractRepair({ request: input, targetRepo, branch, preflight: contract, automatic: true })
    if (outcome.launched !== undefined) return outcome.launched
    throw new AutoRepairExhaustedError(contract.issues, outcome)
  }

  private async buildAndLaunchComposed(
    input: ComposerRequest,
    targetRepo: string,
    branch: string,
    contract: TaskContractSuccess,
    preflightRepair?: PreflightRepairRecord,
  ): Promise<LaunchResult> {
    const config = await this.buildComposedConfig(input, targetRepo, branch, contract)
    const configPath = await persistComposedTrustedWorkSessionConfig(this.configDirectory, config)
      .catch(() => { throw new ComposerLaunchError('SESSION_START_FAILED') })
    const configId = randomBytes(16).toString('hex')
    this.configs.set(configId, { configPath, config, summary: summaryFromConfig(configId, config) })
    try {
      return await this.startWorkSession(configId, preflightRepair)
    } catch {
      throw new ComposerLaunchError('SESSION_START_FAILED')
    }
  }

  private async buildComposedConfig(
    input: ComposerRequest,
    targetRepo: string,
    branch: string,
    contract: TaskContractSuccess,
  ): Promise<TrustedWorkSessionConfig> {
    const sessionId = createSessionId(targetRepo)
    return validateTrustedWorkSessionConfig({
      session: {
        id: sessionId,
        // New Composer sessions opt into V2; persisted legacy configs keep their semantics.
        controlPlane: 'v2',
        directPath: { enabled: input.directPathEnabled },
        goldenPath: { enabled: input.goldenPathEnabled },
        targetRepo,
        branch,
        scheduledStartAt: input.scheduledStartAt !== null && Date.parse(input.scheduledStartAt) > Date.now() ? input.scheduledStartAt : null,
        scheduleSource: input.scheduleSource,
        createdAt: new Date().toISOString(),
        limits: { softMinutes: input.softMinutes, hardMinutes: input.hardMinutes, maxTasks: input.tasks.length },
      },
      tasks: input.tasks.map((task) => ({
        id: task.id,
        goal: task.goal,
        guardian: {
          constraints: [...DEFAULT_GUARDIAN_POLICY.constraints, ...(input.guardian.constraints ?? [])],
          acceptanceCriteria: [...DEFAULT_GUARDIAN_POLICY.acceptanceCriteria, ...contract.acceptanceCriteria],
          doNotDo: [...DEFAULT_GUARDIAN_POLICY.doNotDo, ...(input.guardian.doNotDo ?? [])],
          allowedPaths: input.guardian.allowedPaths,
          forbiddenPaths: [...DEFAULT_GUARDIAN_POLICY.forbiddenPaths, ...(input.guardian.forbiddenPaths ?? [])],
        },
        acceptanceEvidenceBindings: composerEvidenceBindings(
          contract.acceptanceCriteria,
          contract.acceptanceEvidenceBindings,
          input.directPathEnabled || input.goldenPathEnabled,
        ),
      })),
      gitCheckpoint: {
        autoCommit: input.autoCommit,
        autoPush: input.autoPush,
        ...(input.autoPush ? { pushRemote: input.pushRemote } : {}),
      },
      executor: {
        defaultMode: input.executorMode,
        model: input.executorModel,
        maxTurns: 10,
        allowNpmInstall: false,
        allowPythonBootstrap: false,
      },
      ...(input.executorMode === 'deepseek' ? {} : { codex: {
        model: input.codexModel,
        reasoningEffort: input.codexReasoningEffort,
      } }),
      notification: {
        email: input.emailEnabled
          ? { enabled: true, notifyOnCompleted: true }
          : { enabled: false },
      },
    }).catch(() => { throw new ComposerLaunchError('INVALID_GUARDIAN_POLICY') })
  }

  /**
   * The one Repair & Retry cascade, shared by the manual "AI 修复并重试" button
   * and by Automatic Preflight Repair:
   *   deterministic agent → validate → re-preflight → launch, then
   *   LLM agent           → validate → re-preflight → launch.
   *
   * Only `validateMechanicalRepair` and `preflightTaskContract` can authorize a
   * repair, so neither agent can widen goals, paths, risk, permissions, or the
   * verifier allowlist. The cascade names one strategy per cycle, so the cycle
   * bound is also the number of distinct strategies: it can never spin.
   */
  private async cascadeContractRepair(input: {
    request: ComposerRequest
    targetRepo: string
    branch: string
    preflight: TaskContractFailure
    automatic: boolean
  }): Promise<ContractRepairOutcome> {
    if (input.preflight.issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION')) {
      throw new TaskContractPreflightError(input.preflight.issues)
    }
    const { request, targetRepo, branch, automatic } = input
    const errorCode = classifyRepairErrorCode(input.preflight.issues) ?? 'TASK_CONTRACT_INVALID'
    // The Repair Agent operates on the parsed criterion/binding shape so inline
    // `criterion => verifier` criteria resolve to the same identities the
    // failing issues reference.
    const originalContract = parseEffectiveRepairContract({
      acceptanceCriteria: request.guardian.acceptanceCriteria ?? [],
      acceptanceEvidenceBindings: request.guardian.acceptanceEvidenceBindings ?? [],
    })
    const context: RepairContext = {
      errorCode,
      issues: input.preflight.issues,
      contract: originalContract,
      targetRepo,
      branch,
      frozen: {
        goals: request.tasks.map((task) => task.goal),
        allowedPaths: request.guardian.allowedPaths,
        forbiddenPaths: request.guardian.forbiddenPaths ?? [],
        constraints: request.guardian.constraints ?? [],
        doNotDo: request.guardian.doNotDo ?? [],
      },
    }

    const testEntry = await resolveRepairTestEntry(targetRepo)
    const allowedVerifiers = [...TRUSTED_VERIFIER_COMMANDS, ...(testEntry === undefined ? [] : [testEntry])]
    // A verifier that is valid but merely awaiting human approval must survive
    // every repair: substituting a weaker command would change what counts as proof.
    const protectedVerifiers = protectedVerifierCommands(input.preflight.verifiers)

    const stages: RepairAttemptStage[] = []
    const autoEvents: AutoRepairAuditEvent[] = []
    const issueCodes = input.preflight.issues.map((issue) => issue.issueCode)
    if (automatic) autoEvents.push({ event: 'AUTO_REPAIR_STARTED', cycle: 1, issueCodes })

    let launched: LaunchResult | undefined
    let appliedProposal: ContractRepairProposal | undefined
    let structuredRepairTask: StructuredRepairTask | undefined
    let llmInvoked = false
    let cycles = 0

    const attempt = async (agent: 'deterministic' | 'llm'): Promise<void> => {
      if (automatic) {
        autoEvents.push(agent === 'deterministic'
          ? { event: 'AUTO_REPAIR_DETERMINISTIC', cycle: cycles, issueCodes, deterministicResolved: false }
          : { event: 'AUTO_REPAIR_LLM_STARTED', cycle: cycles, issueCodes, llmInvoked: true, provider: this.repairProvider })
      }
      let outcome: RepairAgentOutcome | undefined
      let failureReason: string | undefined
      try {
        outcome = agent === 'deterministic'
          ? await this.repairAgent.repair(context)
          : await this.repairLlmAgent.repair(context)
      } catch (error) {
        failureReason = error instanceof Error ? `Repair Agent failed: ${error.message}` : 'Repair Agent failed'
      }
      const stageReason = outcome?.reason ?? failureReason
      const stage: RepairAttemptStage = {
        agent,
        classification: outcome?.classification ?? 'REPAIR_REJECTED',
        repairs: outcome?.proposal?.repairs ?? [],
        ...(stageReason === undefined ? {} : { reason: stageReason }),
      }
      stages.push(stage)
      if (outcome === undefined) return
      if (outcome.structuredRepairTask !== undefined) structuredRepairTask ??= outcome.structuredRepairTask
      if (outcome.classification !== 'REPAIRED' || outcome.proposal === undefined) return

      const validation = validateMechanicalRepair(
        originalContract,
        outcome.proposal,
        allowedVerifiers,
        protectedVerifiers,
      )
      stage.validation = { ok: validation.ok, reasons: validation.ok ? [] : validation.reasons }
      if (!validation.ok) {
        stage.classification = 'REPAIR_REJECTED'
        stage.reason = `unsafe repair rejected: ${validation.reasons.join('; ')}`
        if (automatic) {
          autoEvents.push({ event: 'AUTO_REPAIR_VALIDATED', cycle: cycles, issueCodes, validation: stage.validation, reflightPassed: false, reason: stage.reason })
        }
        return
      }
      const reflight = await preflightTaskContract({
        targetRepo,
        acceptanceCriteria: outcome.proposal.acceptanceCriteria,
        acceptanceEvidenceBindings: outcome.proposal.acceptanceEvidenceBindings,
        verificationPlannerEnabled: request.directPathEnabled || request.goldenPathEnabled,
      })
      stage.reflightPassed = reflight.ok
      if (automatic) {
        autoEvents.push({
          event: 'AUTO_REPAIR_VALIDATED', cycle: cycles, issueCodes, validation: stage.validation, reflightPassed: reflight.ok,
          ...(reflight.ok ? {} : { reason: 'repaired contract still fails preflight; original contract preserved' }),
        })
      }
      if (!reflight.ok) {
        stage.classification = 'REPAIR_REJECTED'
        stage.reason = 'repaired contract still fails preflight; original contract preserved'
        return
      }
      const launchedResult = await this.buildAndLaunchComposed(request, targetRepo, branch, reflight, {
        automatic,
        ...(agent === 'llm' ? { provider: { id: this.repairProvider.id, model: this.repairProvider.model } } : {}),
        repairs: outcome.proposal.repairs,
      })
      launched = { ...launchedResult, repaired: true }
      appliedProposal = outcome.proposal
    }

    for (let cycle = 1; cycle <= MAX_AUTO_REPAIR_CYCLES && launched === undefined; cycle++) {
      const agent: 'deterministic' | 'llm' = cycle === 1 ? 'deterministic' : 'llm'
      // The model is only consulted while a repairable mechanical issue remains.
      if (agent === 'llm' && !hasLlmRepairableIssue(input.preflight.issues)) break
      cycles = cycle
      if (agent === 'llm') llmInvoked = true
      await attempt(agent)
      if (automatic && agent === 'deterministic') {
        const marker = autoEvents.find((event) => event.event === 'AUTO_REPAIR_DETERMINISTIC' && event.cycle === cycle)
        if (marker !== undefined) marker.deterministicResolved = launched !== undefined
      }
    }

    const sessionStarted = launched !== undefined && launched.accepted === true
    const finalStage = stages.at(-1)
    const classification: RepairClassification = launched !== undefined
      ? 'REPAIRED'
      : finalStage?.classification ?? 'REPAIR_REJECTED'
    const reason = launched !== undefined
      ? undefined
      : finalStage?.reason ?? (llmInvoked ? undefined : 'no repairable mechanical issue remained for the model')
    const repairs = appliedProposal?.repairs ?? stages.flatMap((stage) => stage.repairs)
    const exhausted = launched === undefined && cycles >= MAX_AUTO_REPAIR_CYCLES
    if (automatic) {
      autoEvents.push(launched !== undefined
        ? { event: 'AUTO_REPAIR_SUCCEEDED', cycle: Math.max(cycles, 1), issueCodes }
        : {
            event: 'AUTO_REPAIR_FAILED', cycle: Math.max(cycles, 1), issueCodes,
            ...(exhausted ? { reason: AUTO_REPAIR_EXHAUSTED } : reason === undefined ? {} : { reason }),
          })
    }

    await this.recordRepairAttempt({
      errorCode,
      targetRepo,
      branch,
      classification,
      repairs,
      ...(reason === undefined ? {} : { reason }),
      ...(structuredRepairTask === undefined ? {} : { structuredRepairTask }),
      ...(appliedProposal === undefined ? {} : { proposal: appliedProposal }),
      reflightPassed: launched !== undefined,
      sessionStarted,
      deterministicAttempted: true,
      llmInvoked,
      stages,
      ...(automatic
        ? { automatic: true, autoRepair: { maxCycles: MAX_AUTO_REPAIR_CYCLES, cycles, exhausted, events: autoEvents } }
        : {}),
    })
    await this.notifyRepairOutcome({
      kind: sessionStarted ? 'SUCCESS' : 'FAILURE',
      targetRepo,
      errorCode,
      sessionStarted,
    })

    return {
      ...(launched === undefined ? {} : { launched }),
      errorCode,
      classification,
      repairs,
      ...(reason === undefined ? {} : { reason }),
      ...(appliedProposal === undefined ? {} : { appliedProposal }),
      ...(structuredRepairTask === undefined ? {} : { structuredRepairTask }),
      llmInvoked,
      cycles,
      exhausted,
      autoEvents,
    }
  }

  private async repairComposedWorkSession(input: ComposerRequest): Promise<RepairLaunchResult> {
    if (this.closed) throw new ComposerLaunchError('SESSION_START_FAILED')
    const targetRepo = resolve(input.targetRepo)
    if (!isAbsolute(input.targetRepo) || !await isDirectory(targetRepo)) {
      throw new ComposerLaunchError('INVALID_PROJECT_PATH')
    }
    if (input.scheduledStartAt === null || Date.parse(input.scheduledStartAt) <= Date.now()) await this.assertDependenciesReady(targetRepo, 'v2')
    const branch = await this.readCurrentBranch(targetRepo)
    if (input.branch !== undefined && input.branch !== branch) {
      throw new ComposerLaunchError('BRANCH_MISMATCH')
    }

    const preflight = await preflightTaskContract({
      targetRepo,
      acceptanceCriteria: input.guardian.acceptanceCriteria ?? [],
      acceptanceEvidenceBindings: input.guardian.acceptanceEvidenceBindings ?? [],
      verificationPlannerEnabled: input.directPathEnabled || input.goldenPathEnabled,
    })
    if (preflight.ok) {
      const result = await this.buildAndLaunchComposed(input, targetRepo, branch, preflight)
      return { ...result, repaired: false, repairs: [] }
    }
    if (classifyRepairErrorCode(preflight.issues) === undefined) throw new TaskContractPreflightError(preflight.issues)

    const outcome = await this.cascadeContractRepair({ request: input, targetRepo, branch, preflight, automatic: false })
    if (outcome.launched !== undefined) {
      return { ...outcome.launched, repaired: true, repairs: outcome.repairs }
    }
    return {
      accepted: false,
      error: 'TASK_CONTRACT_INVALID',
      issues: preflight.issues,
      repairErrorCode: outcome.errorCode,
      repairAttempt: {
        classification: outcome.classification,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        repairs: outcome.repairs,
        ...(outcome.structuredRepairTask === undefined ? {} : { structuredRepairTask: outcome.structuredRepairTask }),
        deterministicAttempted: true,
        llmInvoked: outcome.llmInvoked,
        provider: this.repairProvider,
      },
    }
  }

  private async recordRepairAttempt(input: {
    errorCode: RepairErrorCode
    targetRepo: string
    branch: string
    classification: RepairClassification
    repairs: readonly string[]
    reason?: string
    structuredRepairTask?: StructuredRepairTask
    proposal?: ContractRepairProposal
    reflightPassed: boolean
    sessionStarted: boolean
    sessionId?: string
    deterministicAttempted: boolean
    llmInvoked: boolean
    stages: readonly RepairAttemptStage[]
    /** True when the Launchpad started this repair without an operator click. */
    automatic?: boolean
    autoRepair?: AutoRepairAuditSummary
  }): Promise<void> {
    const entry: RepairAuditEntry = {
      attemptId: randomBytes(16).toString('hex'),
      timestamp: new Date().toISOString(),
      errorCode: input.errorCode,
      targetRepo: input.targetRepo,
      branch: input.branch,
      classification: input.classification,
      repairs: [...input.repairs],
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      reflightPassed: input.reflightPassed,
      sessionStarted: input.sessionStarted,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.structuredRepairTask === undefined ? {} : { structuredRepairTask: input.structuredRepairTask }),
      deterministicAttempted: input.deterministicAttempted,
      llmInvoked: input.llmInvoked,
      ...(input.llmInvoked ? { provider: this.repairProvider } : {}),
      ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
      stages: input.stages.map((stage) => ({ ...stage, repairs: [...stage.repairs] })),
      notification: { success: input.sessionStarted, failure: !input.sessionStarted },
      ...(input.automatic === true ? { automatic: true } : {}),
      ...(input.autoRepair === undefined ? {} : { autoRepair: input.autoRepair }),
    }
    await this.repairAudit.record(entry).catch(() => {
      // A transient audit failure must not alter the repair outcome.
    })
  }

  private async notifyRepairOutcome(input: {
    kind: 'SUCCESS' | 'FAILURE'
    targetRepo: string
    errorCode: RepairErrorCode
    sessionStarted: boolean
  }): Promise<void> {
    const summary = input.sessionStarted
      ? `已修复并重新创建 Work Session：${basename(input.targetRepo)}`
      : `修复未通过，保留原始 Task：${basename(input.targetRepo)}`
    await this.repairNotifier.notify({
      kind: input.kind,
      targetRepo: input.targetRepo,
      errorCode: input.errorCode,
      summary,
    }).catch(() => {
      // Notifications are best-effort; the audit log is the durable record.
    })
  }

  private async readCurrentBranch(targetRepo: string): Promise<string> {
    const runner = createProductionGitRunner(targetRepo, this.gitProcessRunner)
    const result = await runner('git branch --show-current').catch(() => undefined)
    if (result === undefined || result.exitCode !== 0) {
      throw new ComposerLaunchError('NOT_A_GIT_REPOSITORY')
    }
    const branch = result.stdout.trim()
    if (branch.length === 0) throw new ComposerLaunchError('CANNOT_READ_BRANCH')
    return branch
  }

  private async readOriginPushRemote(targetRepo: string): Promise<{ name: 'origin'; expectedUrl: string } | undefined> {
    const runner = createProductionGitRunner(targetRepo, this.gitProcessRunner)
    const result = await runner('git remote get-url --push --all origin').catch(() => undefined)
    if (result === undefined || result.exitCode !== 0) return undefined
    const urls = [...new Set(result.stdout.split(/\r?\n/u).map((url) => url.trim()).filter(Boolean))]
    return urls.length === 1 && isSafeRemoteUrl(urls[0]!) ? { name: 'origin', expectedUrl: urls[0]! } : undefined
  }

  private respondComposerError(response: ServerResponse, status: number, code: ComposerError | 'SESSION_START_FAILED'): void {
    this.respondJson(response, status, { error: code, message: COMPOSER_SAFE_MESSAGES[code] })
  }

  private async assertDependenciesReady(targetRepo: string, controlPlane: 'v1' | 'v2'): Promise<void> {
    if (this.preflight === undefined) return
    const report = await this.preflight(targetRepo, controlPlane)
    this.dependencyHealth = report
    requireDependencyPreflightReady(report)
  }

  private respondPreflightError(response: ServerResponse, error: unknown): boolean {
    if (!(error instanceof DependencyPreflightError)) return false
    const blocker = error.report.dependencies.find((item) => item.id === 'SHELL' && item.state !== 'READY') ??
      error.report.dependencies.find((item) => item.id !== 'CORE' && (item.state === 'UNAVAILABLE' || item.state === 'DEGRADED'))
    this.respondJson(response, 503, {
      error: 'DEPENDENCY_REQUIRED',
      classification: error.report.overall,
      failureType: blocker?.failureType,
      dependency: blocker?.id,
      message: blocker?.safeMessage,
      expectedExecutable: blocker?.expectedExecutable,
      actualExecutable: blocker?.actualExecutable,
      safeRemediation: blocker?.safeRemediation,
    })
    return true
  }

  private origin(): string {
    return this.address?.url ?? ''
  }

  private expectedHost(): string {
    return this.address === undefined ? '' : `${LOOPBACK_HOST}:${this.address.port}`
  }

  private respondJson(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(payload))
  }
}

class ComposerLaunchError extends Error {
  constructor(readonly code: ComposerError | 'SESSION_START_FAILED') {
    super(code)
  }
}

class TaskContractPreflightError extends Error {
  constructor(readonly issues: readonly TaskContractIssue[]) {
    super('TASK_CONTRACT_INVALID')
  }
}

class DeleteConfigError extends Error {
  constructor(readonly code: 'UNKNOWN_CONFIG' | 'SESSION_ACTIVE' | 'DELETE_FAILED') {
    super(code)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

function createSessionId(targetRepo: string): string {
  const project = (basename(targetRepo).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'session')
    .slice(0, MAX_SESSION_PROJECT_SLUG_LENGTH)
  const timestamp = new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 12)
  return `${project}-${timestamp}-${randomBytes(3).toString('hex')}`
}

function canonicalComposerPayload(input: ComposerRequest): string {
  return JSON.stringify({
    directPathEnabled: input.directPathEnabled,
    goldenPathEnabled: input.goldenPathEnabled,
    targetRepo: input.targetRepo,
    branch: input.branch,
    tasks: input.tasks,
    executorModel: input.executorModel,
    executorMode: input.executorMode,
    codexModel: input.codexModel,
    codexReasoningEffort: input.codexReasoningEffort,
    softMinutes: input.softMinutes,
    hardMinutes: input.hardMinutes,
    autoCommit: input.autoCommit,
    autoPush: input.autoPush,
    pushRemote: input.pushRemote,
    emailEnabled: input.emailEnabled,
    guardian: input.guardian,
    scheduledStartAt: input.scheduledStartAt,
    scheduleSource: input.scheduleSource,
  })
}

export async function createNovaWingLaunchpad(options: {
  configDirectory?: string
  env?: NodeJS.ProcessEnv
  dependencies?: NovaWingLaunchpadDependencies
  enableProductionPreflight?: boolean
} = {}): Promise<NovaWingLaunchpad> {
  const configDirectory = options.configDirectory ?? defaultTrustedConfigDirectory(options.env)
  const loadConfig = options.dependencies?.loadConfig ?? loadTrustedWorkSessionConfig
  const discovered = await discoverTrustedWorkSessionConfigs(configDirectory, loadConfig)
  const dependencies = options.enableProductionPreflight === true
    ? {
        ...options.dependencies,
        preflight: options.dependencies?.preflight ?? ((targetRepo?: string, controlPlane: 'v1' | 'v2' = 'v2') =>
          runProductionDependencyPreflight({
            // Launchpad's default Composer route is Codex. Check its local SDK
            // prerequisites at cold start so the topbar reports availability,
            // not whether an active Task has already selected a route.
            executorModes: ['codex'],
            controlPlane,
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(targetRepo === undefined ? {} : { targetRepo }),
          })),
      }
    : options.dependencies
  const launchpadDependencies: NovaWingLaunchpadDependencies = {
    ...dependencies,
    analyticsPath: dependencies?.analyticsPath ?? defaultTaskRunAnalyticsPath(options.env),
    resolveEnvironment: dependencies?.resolveEnvironment ?? ((config) => resolveProductionSmtpEnvironment(config, options.env)),
    readCodexAvailability: dependencies?.readCodexAvailability ?? (() =>
      new CodingExecutionStore(defaultCodingExecutionStorePath(options.env)).availability()),
  }
  return new NovaWingLaunchpad(discovered, configDirectory, launchpadDependencies)
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? '/').split('?', 1)[0] ?? '/'
}

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
}

function parseStartBody(body: string):
  | { ok: true; configId: string }
  | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return { ok: false, error: 'malformed JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'start body must be an object' }
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'configId')) {
    return { ok: false, error: 'start body must contain only configId' }
  }
  if (typeof record.configId !== 'string' || !/^[a-f0-9]{32}$/u.test(record.configId)) {
    return { ok: false, error: 'configId is invalid' }
  }
  return { ok: true, configId: record.configId }
}

function parseConfigIdBody(body: string):
  | { ok: true; configId: string }
  | { ok: false } {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
    const record = parsed as Record<string, unknown>
    if (
      Object.keys(record).length !== 1 ||
      !Object.hasOwn(record, 'configId') ||
      typeof record.configId !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(record.configId)
    ) {
      return { ok: false }
    }
    return { ok: true, configId: record.configId }
  } catch {
    return { ok: false }
  }
}

function parseComposerBody(body: string): ComposerParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  const record = parsed as Record<string, unknown>
  const allowed = new Set([
    'requestId', 'targetRepo', 'tasks', 'executorModel', 'softMinutes', 'hardMinutes',
    'autoCommit', 'autoPush', 'pushRemote', 'emailEnabled', 'guardian',
    'scheduled_start_at', 'schedule_source', 'executorMode', 'codexModel', 'codexReasoningEffort', 'branch', 'directPathEnabled', 'goldenPathEnabled',
  ])
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false, error: 'INVALID_REQUEST' }
  let scheduledStartAt: string | null
  try { scheduledStartAt = normalizeScheduledStart(record.scheduled_start_at) } catch {
    return { ok: false, error: 'INVALID_SCHEDULE' }
  }
  const scheduleSource = record.schedule_source ?? (scheduledStartAt === null ? 'immediate' : 'custom')
  if (scheduleSource !== 'immediate' && scheduleSource !== 'custom' && scheduleSource !== 'deepseek_off_peak') {
    return { ok: false, error: 'INVALID_SCHEDULE' }
  }
  // Legacy off-peak requests implied DeepSeek; explicit Auto/Codex must never imply it.
  const executorMode = record.executorMode ?? (scheduleSource === 'deepseek_off_peak' ? 'deepseek' : CODING_EXECUTOR_DEFAULTS.defaultMode)
  if (executorMode !== 'auto' && executorMode !== 'codex' && executorMode !== 'deepseek') return { ok: false, error: 'INVALID_REQUEST' }
  if (scheduleSource === 'deepseek_off_peak' && executorMode !== 'deepseek') return { ok: false, error: 'INVALID_SCHEDULE' }
  if (typeof record.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(record.requestId)) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  if (typeof record.targetRepo !== 'string' || record.targetRepo.trim().length === 0) {
    return { ok: false, error: 'INVALID_PROJECT_PATH' }
  }
  const branch = record.branch
  if (branch !== undefined && (typeof branch !== 'string' || !isSafeBranch(branch.trim()))) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  const tasks = parseComposerTasks(record.tasks)
  if (tasks === 'invalid-id') return { ok: false, error: 'INVALID_TASK_ID' }
  if (tasks === 'invalid-task') return { ok: false, error: 'INVALID_TASK' }
  if (tasks === 'too-long') return { ok: false, error: 'INVALID_TASK_TOO_LONG' }
  if (tasks === 'duplicate-id') return { ok: false, error: 'DUPLICATE_TASK_ID' }
  if (tasks === undefined) return { ok: false, error: 'INVALID_REQUEST' }
  const softMinutes = record.softMinutes ?? DEFAULT_SOFT_MINUTES
  const hardMinutes = record.hardMinutes ?? DEFAULT_HARD_MINUTES
  if (!isValidMinuteLimit(softMinutes, true) || !isValidMinuteLimit(hardMinutes, false) || hardMinutes < softMinutes) {
    return { ok: false, error: 'INVALID_LIMITS' }
  }
  const executorModel = record.executorModel ?? DEFAULT_EXECUTOR_MODEL
  if (typeof executorModel !== 'string' || executorModel.trim().length === 0 || executorModel.length > 120) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  const codexModel = record.codexModel ?? CODING_EXECUTOR_DEFAULTS.codex.model
  const codexReasoningEffort = record.codexReasoningEffort ?? CODING_EXECUTOR_DEFAULTS.codex.reasoningEffort
  if (typeof codexModel !== 'string' || typeof codexReasoningEffort !== 'string' ||
      !isSupportedCodexConfiguration(codexModel, codexReasoningEffort)) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  const autoCommit = record.autoCommit ?? true
  const autoPush = record.autoPush ?? false
  const emailEnabled = record.emailEnabled ?? false
  const directPathEnabled = record.directPathEnabled ?? false
  const goldenPathEnabled = record.goldenPathEnabled ?? false
  if (typeof autoCommit !== 'boolean' || typeof autoPush !== 'boolean' || typeof emailEnabled !== 'boolean' || typeof directPathEnabled !== 'boolean' || typeof goldenPathEnabled !== 'boolean') {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  if (autoPush && !autoCommit) return { ok: false, error: 'AUTO_PUSH_REQUIRES_AUTO_COMMIT' }
  const pushRemote = autoPush ? parseComposerPushRemote(record.pushRemote) : undefined
  if (autoPush && record.pushRemote === undefined) return { ok: false, error: 'AUTO_PUSH_REMOTE_UNAVAILABLE' }
  if (autoPush && pushRemote === undefined) return { ok: false, error: 'INVALID_PUSH_REMOTE' }
  const guardian = parseComposerGuardian(record.guardian)
  if (guardian === undefined) {
    return { ok: false, error: hasAllowedPaths(record.guardian) ? 'INVALID_GUARDIAN_POLICY' : 'MISSING_ALLOWED_PATHS' }
  }
  return {
    ok: true,
    value: {
      directPathEnabled,
      goldenPathEnabled,
      requestId: record.requestId,
      scheduledStartAt,
      scheduleSource,
      targetRepo: record.targetRepo.trim(),
      ...(branch === undefined ? {} : { branch: branch.trim() }),
      tasks,
      executorModel: executorModel.trim(),
      executorMode,
      codexModel,
      codexReasoningEffort,
      softMinutes,
      hardMinutes,
      autoCommit,
      autoPush,
      ...(pushRemote === undefined ? {} : { pushRemote }),
      emailEnabled,
      guardian,
    },
  }
}

function parseComposerTasks(value: unknown): ComposerRequest['tasks'] | 'invalid-id' | 'invalid-task' | 'too-long' | 'duplicate-id' | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPOSER_TASKS) return undefined
  const tasks: ComposerRequest['tasks'] = []
  const ids = new Set<string>()
  for (const valueTask of value) {
    if (valueTask === null || typeof valueTask !== 'object' || Array.isArray(valueTask)) return undefined
    const task = valueTask as Record<string, unknown>
    if (Object.keys(task).length !== 2 || typeof task.id !== 'string' || typeof task.goal !== 'string') return undefined
    const id = task.id.trim()
    const goal = task.goal.trim()
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(id)) return 'invalid-id'
    if (goal.length === 0) return 'invalid-task'
    if (task.goal.length > MAX_COMPOSER_TASK_GOAL_CHARS) return 'too-long'
    if (ids.has(id)) return 'duplicate-id'
    ids.add(id)
    tasks.push({ id, goal })
  }
  return tasks
}

function parseComposerPushRemote(value: unknown): ComposerRequest['pushRemote'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.name !== 'string' || typeof record.expectedUrl !== 'string') return undefined
  const name = record.name.trim()
  const expectedUrl = record.expectedUrl.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) && isSafeRemoteUrl(expectedUrl)
    ? { name, expectedUrl }
    : undefined
}

function isSafeRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0 &&
        url.search.length === 0 && url.hash.length === 0 && url.hostname.length > 0 && url.pathname.length > 1
    } catch {
      return false
    }
  }
  if (value.startsWith('ssh://')) {
    try {
      const url = new URL(value)
      return url.protocol === 'ssh:' && url.username === 'git' && url.password.length === 0 &&
        url.search.length === 0 && url.hash.length === 0 && url.hostname.length > 0 && url.pathname.length > 1
    } catch {
      return false
    }
  }
  return /^git@[A-Za-z0-9.-]+:[^/?#\s][^?#\s]*$/u.test(value)
}

function parseBranchBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return Object.keys(record).length === 1 && typeof record.targetRepo === 'string' && record.targetRepo.trim().length > 0
      ? record.targetRepo.trim()
      : undefined
  } catch {
    return undefined
  }
}

function parseTaskBriefBody(body: string): { value: string; executorMode?: ExecutorMode } | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'brief' && key !== 'executorMode') || typeof record.brief !== 'string' || record.brief.trim().length === 0 || record.brief.length > MAX_TASK_BRIEF_CHARS) return undefined
    if (record.executorMode !== undefined && record.executorMode !== 'auto' && record.executorMode !== 'codex' && record.executorMode !== 'deepseek') return undefined
    return { value: record.brief, ...(record.executorMode === undefined ? {} : { executorMode: record.executorMode }) }
  } catch {
    return undefined
  }
}

function isSafeBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value) && !value.includes('..') && !value.endsWith('.lock') && !value.includes('@{')
}

function parseComposerGuardian(value: unknown): ComposerRequest['guardian'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const allowed = new Set(['constraints', 'acceptanceCriteria', 'acceptanceEvidenceBindings', 'doNotDo', 'allowedPaths', 'forbiddenPaths'])
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined
  const allowedPaths = stringArray(record.allowedPaths)
  if (allowedPaths === undefined || allowedPaths.length === 0) return undefined
  const constraints = optionalStringArray(record, 'constraints')
  const acceptanceCriteria = optionalStringArray(record, 'acceptanceCriteria')
  const acceptanceEvidenceBindings = parseAcceptanceEvidenceBindings(record.acceptanceEvidenceBindings)
  const doNotDo = optionalStringArray(record, 'doNotDo')
  const forbiddenPaths = optionalStringArray(record, 'forbiddenPaths')
  if (constraints === 'invalid' || acceptanceCriteria === 'invalid' || acceptanceEvidenceBindings === 'invalid' || doNotDo === 'invalid' || forbiddenPaths === 'invalid') return undefined
  return { ...(constraints === undefined ? {} : { constraints }), ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }), ...(acceptanceEvidenceBindings === undefined ? {} : { acceptanceEvidenceBindings }), ...(doNotDo === undefined ? {} : { doNotDo }), allowedPaths, ...(forbiddenPaths === undefined ? {} : { forbiddenPaths }) }
}

function parseAcceptanceEvidenceBindings(value: unknown): AcceptanceEvidenceBinding[] | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) return 'invalid'
  const bindings: AcceptanceEvidenceBinding[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'invalid'
    const record = item as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'criterion' && key !== 'requiredEvidence' && key !== 'requiresApproval' && key !== 'commandCanonicalizations')) return 'invalid'
    if (typeof record.criterion !== 'string' || record.criterion.length > 500) return 'invalid'
    const requiredEvidence = verifierStringArray(record.requiredEvidence)
    const commandCanonicalizations = parseCommandCanonicalizations(record.commandCanonicalizations)
    if (requiredEvidence === undefined || commandCanonicalizations === 'invalid' || (record.requiresApproval !== undefined && typeof record.requiresApproval !== 'boolean')) return 'invalid'
    // These records remain untrusted request input. Preflight recomputes proof
    // against the actual criterion and command before approval classification.
    bindings.push({ criterion: record.criterion.trim(), requiredEvidence, ...(record.requiresApproval === undefined ? {} : { requiresApproval: record.requiresApproval }),
      ...(commandCanonicalizations === undefined ? {} : { commandCanonicalizations }) })
  }
  return bindings
}

function verifierStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== 'string' || entry.length > 500)) return undefined
  return value.map((entry) => entry.trim())
}

function parseCommandCanonicalizations(value: unknown): VerifierCommandCanonicalization[] | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) return 'invalid'
  const records: VerifierCommandCanonicalization[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'invalid'
    const record = item as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'sourceText' && key !== 'command' && key !== 'grammar' && key !== 'assessment')) return 'invalid'
    if (typeof record.sourceText !== 'string' || record.sourceText.length === 0 || record.sourceText.length > 500 ||
      typeof record.command !== 'string' || record.command.length === 0 || record.command.length > 500 ||
      record.grammar !== 'acceptance-command-v1' || (record.assessment !== 'ALLOWED' && record.assessment !== 'APPROVAL_REQUIRED')) return 'invalid'
    records.push({ sourceText: record.sourceText, command: record.command, grammar: record.grammar, assessment: record.assessment })
  }
  return records
}

function looksLikeTestVerifierCommand(command: string): boolean {
  if (VENV_PYTEST_COMMANDS.some((value) => command.trim() === value || command.trim().startsWith(`${value} `))) return true
  return /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|node\s+--test\b|npx\s+(?:vitest|jest)\b|(?:vitest|jest)\b)/iu.test(command.trim())
}

function composerEvidenceBindings(
  criteria: readonly string[],
  explicit: readonly AcceptanceEvidenceBinding[],
  verificationPlannerEnabled = false,
): AcceptanceEvidenceBinding[] {
  const criterionSet = new Set(criteria)
  const byCriterion = new Map<string, AcceptanceEvidenceBinding>()
  for (const binding of explicit) {
    if (!criterionSet.has(binding.criterion) || byCriterion.has(binding.criterion)) throw new ComposerLaunchError('INVALID_GUARDIAN_POLICY')
    byCriterion.set(binding.criterion, binding)
  }
  const explicitEvidence = [...new Set(explicit.flatMap((binding) => binding.requiredEvidence))]
  // Only preflight bindings can supply executable commands. Re-reading the
  // criterion here would override explicit RHS authority and leak prose again.
  const custom = criteria.map((criterion) => byCriterion.get(criterion)).filter((binding): binding is AcceptanceEvidenceBinding => binding !== undefined)
  const relevantTests = explicitEvidence.filter(looksLikeTestVerifierCommand)
  const testCanonicalizations = explicit.flatMap((binding) => binding.commandCanonicalizations ?? []).filter((proof) => relevantTests.includes(proof.command))
  return [
    { criterion: DEFAULT_GUARDIAN_POLICY.acceptanceCriteria[0], requiredEvidence: ['git diff --check'] },
    ...(relevantTests.length > 0
      ? [{ criterion: DEFAULT_GUARDIAN_POLICY.acceptanceCriteria[1], requiredEvidence: relevantTests,
        ...(testCanonicalizations.length === 0 ? {} : { commandCanonicalizations: testCanonicalizations }) }]
      : verificationPlannerEnabled ? [] : [{ criterion: DEFAULT_GUARDIAN_POLICY.acceptanceCriteria[1], requiredEvidence: ['npm test'] }]),
    ...custom,
  ]
}

function hasAllowedPaths(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const paths = (value as Record<string, unknown>).allowedPaths
  return Array.isArray(paths) && paths.some((path) => typeof path === 'string' && path.trim().length > 0)
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: 'constraints' | 'acceptanceCriteria' | 'doNotDo' | 'forbiddenPaths',
): string[] | 'invalid' | undefined {
  if (record[key] === undefined) return undefined
  return stringArray(record[key]) ?? 'invalid'
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 500)) return undefined
  return value.map((entry) => entry.trim())
}

function isValidMinuteLimit(value: unknown, allowZero: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && value <= 24 * 60
}

function readBodyWithLimit(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    let size = 0
    let settled = false
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        rejectBody(new Error('payload too large'))
        request.resume()
        return
      }
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (!settled) {
        settled = true
        resolveBody(body)
      }
    })
    request.on('error', (error) => {
      if (!settled) {
        settled = true
        rejectBody(error)
      }
    })
  })
}

async function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, timeoutMs)
    timer.unref()
  })
  await Promise.race([work, timeout])
  if (timer !== undefined) clearTimeout(timer)
}

/**
 * T021: 生产默认的 Launchpad 状态读取。读 Mastra workflow 持久化 domain state，
 * 不创建/启动 Runner（loadPersistedState 只 hydrate，不执行）。db 文件不存在即 READY。
 */
async function readProductionSessionStatus(
  config: TrustedWorkSessionConfig,
): Promise<WorkSessionDisplayState> {
  const storageUrl = config.storageUrl ?? defaultStorageUrl(config.session.id, process.env)
  const exists = await stat(fileURLToPath(storageUrl))
    .then((entry) => entry.isFile())
    .catch(() => false)
  if (!exists) {
    return config.session.scheduledStartAt == null ? 'READY' : 'SCHEDULED'
  }

  const definition = {
    id: config.session.id,
    targetRepo: config.session.targetRepo,
    branch: config.session.branch,
    tasks: config.tasks.map((task) => ({ id: task.id, goal: task.goal })),
    limits: { ...config.session.limits },
    scheduledStartAt: config.session.scheduledStartAt ?? null,
    scheduleSource: config.session.scheduleSource ?? 'immediate',
    ...(config.session.createdAt === undefined ? {} : { createdAt: config.session.createdAt }),
  }
  const runtime = new WorkSessionRuntime({
    definition,
    storageUrl,
    taskRunner: {
      async run() {
        return { status: 'FAILED' as const, error: 'read-only session status probe' }
      },
    },
  })
  try {
    const state = await runtime.loadPersistedState()
    // Launchpad 不持有活动 Runner：非终态即 RECOVERABLE。
    return deriveDisplayState(state, false)
  } finally {
    await runtime.close()
  }
}
