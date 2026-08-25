import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import {
  createProductionWorkSessionUi,
  createProductionGitRunner,
  loadTrustedWorkSessionConfig,
  validateTrustedWorkSessionConfig,
  type ProductionGitProcessRunner,
  type ProductionWorkSessionUi,
  type TrustedWorkSessionConfig,
} from '../production.js'
import { resolveProductionSmtpEnvironment } from '../local-smtp-secrets.js'
import {
  LAUNCHPAD_APP_JS,
  LAUNCHPAD_STYLES_CSS,
  renderLaunchpadHtml,
} from './view.js'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 16 * 1024
const SAFE_LAUNCH_ERROR = 'Work Session 启动失败'
const DEFAULT_EXECUTOR_MODEL = 'sonnet'
const DEFAULT_SOFT_MINUTES = 45
const DEFAULT_HARD_MINUTES = 90
const MAX_COMPOSER_TASKS = 10
const MAX_COMPLETED_COMPOSER_REQUESTS = 100
const COMPLETED_COMPOSER_REQUEST_TTL_MS = 5 * 60 * 1_000
const MAX_SESSION_PROJECT_SLUG_LENGTH = 48

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
}

interface DiscoveredLaunchpadConfig {
  configPath: string
  summary: LaunchpadConfigSummary
}

export interface NovaWingLaunchpadAddress {
  host: typeof LOOPBACK_HOST
  port: number
  url: string
}

interface ManagedWorkSessionApp {
  controller: { start(): { started: boolean } }
  start(): Promise<{ url: string }>
  close(): Promise<void>
}

export interface NovaWingLaunchpadDependencies {
  loadConfig?: (configPath: string) => Promise<TrustedWorkSessionConfig>
  resolveEnvironment?: (config: TrustedWorkSessionConfig) => Promise<NodeJS.ProcessEnv>
  createWorkSession?: (
    config: TrustedWorkSessionConfig,
    options: { env: NodeJS.ProcessEnv; serverPort: 0 },
  ) => Promise<ManagedWorkSessionApp>
  gitProcessRunner?: ProductionGitProcessRunner
  shutdownTimeoutMs?: number
}

interface LaunchResult {
  accepted: true
  controlUrl: string
  alreadyStarted?: true
}

interface ComposerRequest {
  requestId: string
  targetRepo: string
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
  | 'INVALID_TASK_ID'
  | 'INVALID_TASK'
  | 'DUPLICATE_TASK_ID'
  | 'INVALID_LIMITS'
  | 'MISSING_ALLOWED_PATHS'
  | 'INVALID_GUARDIAN_POLICY'
  | 'AUTO_PUSH_REQUIRES_AUTO_COMMIT'
  | 'AUTO_PUSH_REMOTE_UNAVAILABLE'
  | 'INVALID_PUSH_REMOTE'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'

const COMPOSER_SAFE_MESSAGES: Record<ComposerError | 'SESSION_START_FAILED', string> = {
  INVALID_PROJECT_PATH: '项目目录必须是存在的绝对路径。',
  NOT_A_GIT_REPOSITORY: '项目目录不是有效的 Git 仓库。',
  CANNOT_READ_BRANCH: '无法读取项目当前 Git 分支。',
  INVALID_TASK_ID: '请填写有效的 Task ID（仅允许字母、数字、点、下划线和连字符）。',
  INVALID_TASK: '请填写有效的 Task 描述。',
  DUPLICATE_TASK_ID: 'Task ID 不得重复。',
  INVALID_LIMITS: '时间限制无效：Hard Limit 必须不小于 Soft Limit。',
  MISSING_ALLOWED_PATHS: '请填写至少一个允许修改路径。',
  INVALID_GUARDIAN_POLICY: 'Guardian 规则无效。',
  AUTO_PUSH_REQUIRES_AUTO_COMMIT: 'Auto Push requires Auto Commit。',
  AUTO_PUSH_REMOTE_UNAVAILABLE: '无法确定 Auto Push 的 origin 远端，请填写有效的远端配置。',
  INVALID_PUSH_REMOTE: 'Auto Push remote 配置无效。',
  INVALID_REQUEST: '创建请求无效。',
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
): string {
  const override = env.NOVAWING_CONFIG_DIR?.trim()
  if (override !== undefined && override.length > 0) return resolve(override)
  const localAppData = env.LOCALAPPDATA?.trim() || join(userHome, 'AppData', 'Local')
  return join(localAppData, 'NovaWing', 'canary-configs')
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
      discovered.push({ configPath, summary: summaryFromConfig(configId, config) })
    } catch {
      // One invalid trusted config must not prevent the remaining cards from loading.
    }
  }
  return discovered
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export class NovaWingLaunchpad {
  private readonly configs: Map<string, DiscoveredLaunchpadConfig>
  private readonly loadConfig: (configPath: string) => Promise<TrustedWorkSessionConfig>
  private readonly resolveEnvironment: (config: TrustedWorkSessionConfig) => Promise<NodeJS.ProcessEnv>
  private readonly createWorkSession: NonNullable<NovaWingLaunchpadDependencies['createWorkSession']>
  private readonly gitProcessRunner: ProductionGitProcessRunner | undefined
  private readonly shutdownTimeoutMs: number
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly activeStarts = new Map<string, Promise<LaunchResult>>()
  private readonly activeCreates = new Map<string, ComposerCreateEntry>()
  private readonly completedCreates = new Map<string, CompletedComposerCreateEntry>()
  private readonly activeApps = new Map<string, ManagedWorkSessionApp>()

  private address: NovaWingLaunchpadAddress | undefined
  private closed = false

  constructor(
    discovered: readonly DiscoveredLaunchpadConfig[],
    dependencies: NovaWingLaunchpadDependencies = {},
  ) {
    this.configs = new Map(discovered.map((config) => [config.summary.configId, config]))
    this.loadConfig = dependencies.loadConfig ?? loadTrustedWorkSessionConfig
    this.resolveEnvironment = dependencies.resolveEnvironment ?? resolveProductionSmtpEnvironment
    this.createWorkSession = dependencies.createWorkSession ?? (
      async (config, options): Promise<ProductionWorkSessionUi> =>
        createProductionWorkSessionUi(config, options)
    )
    this.shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000
    this.gitProcessRunner = dependencies.gitProcessRunner
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  getConfigs(): readonly LaunchpadConfigSummary[] {
    return [...this.configs.values()].map((config) => ({ ...config.summary }))
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
    return this.address
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
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
    await bounded(Promise.allSettled([...this.activeApps.values()].map((app) => app.close())).then(() => undefined), this.shutdownTimeoutMs)
    this.activeApps.clear()
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
    if (method === 'POST' && path === '/api/session/branch') {
      await this.serveBranch(request, response)
      return
    }

    const knownPaths = new Set(['/', '/app.js', '/styles.css', '/api/session/start', '/api/session/create', '/api/session/branch'])
    this.respondJson(response, knownPaths.has(path) ? 405 : 404, {
      error: knownPaths.has(path) ? 'method not allowed' : 'not found',
    })
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
    } catch {
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
      const code = error instanceof ComposerLaunchError ? error.code : 'SESSION_START_FAILED'
      const status = code === 'SESSION_START_FAILED' ? 500 : code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400
      this.respondComposerError(response, status, code)
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

  private async startWorkSession(configId: string): Promise<LaunchResult> {
    const existing = this.activeStarts.get(configId)
    if (existing !== undefined) {
      const result = await existing
      return { ...result, alreadyStarted: true }
    }
    const discovered = this.configs.get(configId)
    if (discovered === undefined) throw new Error('unknown config')

    const launch = this.launchWorkSession(configId, discovered)
    this.activeStarts.set(configId, launch)
    try {
      return await launch
    } catch (error) {
      this.activeStarts.delete(configId)
      throw error
    }
  }

  private async launchWorkSession(
    configId: string,
    discovered: DiscoveredLaunchpadConfig,
  ): Promise<LaunchResult> {
    if (this.closed) throw new Error('Launchpad is closed')
    const config = await this.loadConfig(discovered.configPath)
    const env = await this.resolveEnvironment(config)
    const app = await this.createWorkSession(config, { env, serverPort: 0 })
    if (this.closed) {
      await app.close()
      throw new Error('Launchpad is closed')
    }

    this.activeApps.set(configId, app)
    try {
      const address = await app.start()
      if (this.closed) {
        await app.close()
        this.activeApps.delete(configId)
        throw new Error('Launchpad is closed')
      }
      const result = app.controller.start()
      return {
        accepted: true,
        controlUrl: address.url,
        ...(result.started ? {} : { alreadyStarted: true }),
      }
    } catch (error) {
      this.activeApps.delete(configId)
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
    const branch = await this.readCurrentBranch(targetRepo)
    const sessionId = createSessionId(targetRepo)
    const config = await validateTrustedWorkSessionConfig({
      session: {
        id: sessionId,
        targetRepo,
        branch,
        limits: { softMinutes: input.softMinutes, hardMinutes: input.hardMinutes, maxTasks: input.tasks.length },
      },
      tasks: input.tasks.map((task) => ({
        id: task.id,
        goal: task.goal,
        guardian: {
          constraints: [...DEFAULT_GUARDIAN_POLICY.constraints, ...(input.guardian.constraints ?? [])],
          acceptanceCriteria: [...DEFAULT_GUARDIAN_POLICY.acceptanceCriteria, ...(input.guardian.acceptanceCriteria ?? [])],
          doNotDo: [...DEFAULT_GUARDIAN_POLICY.doNotDo, ...(input.guardian.doNotDo ?? [])],
          allowedPaths: input.guardian.allowedPaths,
          forbiddenPaths: [...DEFAULT_GUARDIAN_POLICY.forbiddenPaths, ...(input.guardian.forbiddenPaths ?? [])],
        },
      })),
      gitCheckpoint: {
        autoCommit: input.autoCommit,
        autoPush: input.autoPush,
        ...(input.autoPush ? { pushRemote: input.pushRemote } : {}),
      },
      executor: {
        model: input.executorModel,
        maxTurns: 10,
        allowNpmInstall: false,
        allowPythonBootstrap: false,
      },
      notification: {
        email: input.emailEnabled
          ? { enabled: true, notifyOnCompleted: true }
          : { enabled: false },
      },
    }).catch(() => { throw new ComposerLaunchError('INVALID_GUARDIAN_POLICY') })
    const env = await this.resolveEnvironment(config).catch(() => { throw new ComposerLaunchError('SESSION_START_FAILED') })
    const app = await this.createWorkSession(config, { env, serverPort: 0 }).catch(() => {
      throw new ComposerLaunchError('SESSION_START_FAILED')
    })
    if (this.closed) {
      await app.close()
      throw new ComposerLaunchError('SESSION_START_FAILED')
    }
    this.activeApps.set(sessionId, app)
    try {
      const address = await app.start()
      if (this.closed) throw new Error('closed')
      app.controller.start()
      return { accepted: true, controlUrl: address.url }
    } catch {
      this.activeApps.delete(sessionId)
      await app.close().catch(() => undefined)
      throw new ComposerLaunchError('SESSION_START_FAILED')
    }
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
    targetRepo: input.targetRepo,
    tasks: input.tasks,
    executorModel: input.executorModel,
    softMinutes: input.softMinutes,
    hardMinutes: input.hardMinutes,
    autoCommit: input.autoCommit,
    autoPush: input.autoPush,
    pushRemote: input.pushRemote,
    emailEnabled: input.emailEnabled,
    guardian: input.guardian,
  })
}

export async function createNovaWingLaunchpad(options: {
  configDirectory?: string
  env?: NodeJS.ProcessEnv
  dependencies?: NovaWingLaunchpadDependencies
} = {}): Promise<NovaWingLaunchpad> {
  const configDirectory = options.configDirectory ?? defaultTrustedConfigDirectory(options.env)
  const loadConfig = options.dependencies?.loadConfig ?? loadTrustedWorkSessionConfig
  const discovered = await discoverTrustedWorkSessionConfigs(configDirectory, loadConfig)
  return new NovaWingLaunchpad(discovered, options.dependencies)
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
  ])
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false, error: 'INVALID_REQUEST' }
  if (typeof record.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(record.requestId)) {
    return { ok: false, error: 'INVALID_REQUEST' }
  }
  if (typeof record.targetRepo !== 'string' || record.targetRepo.trim().length === 0) {
    return { ok: false, error: 'INVALID_PROJECT_PATH' }
  }
  const tasks = parseComposerTasks(record.tasks)
  if (tasks === 'invalid-id') return { ok: false, error: 'INVALID_TASK_ID' }
  if (tasks === 'invalid-task') return { ok: false, error: 'INVALID_TASK' }
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
  const autoCommit = record.autoCommit ?? true
  const autoPush = record.autoPush ?? false
  const emailEnabled = record.emailEnabled ?? false
  if (typeof autoCommit !== 'boolean' || typeof autoPush !== 'boolean' || typeof emailEnabled !== 'boolean') {
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
      requestId: record.requestId,
      targetRepo: record.targetRepo.trim(),
      tasks,
      executorModel: executorModel.trim(),
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

function parseComposerTasks(value: unknown): ComposerRequest['tasks'] | 'invalid-id' | 'invalid-task' | 'duplicate-id' | undefined {
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
    if (goal.length === 0 || task.goal.length > 8_000) return 'invalid-task'
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

function parseComposerGuardian(value: unknown): ComposerRequest['guardian'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const allowed = new Set(['constraints', 'acceptanceCriteria', 'doNotDo', 'allowedPaths', 'forbiddenPaths'])
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined
  const allowedPaths = stringArray(record.allowedPaths)
  if (allowedPaths === undefined || allowedPaths.length === 0) return undefined
  const constraints = optionalStringArray(record, 'constraints')
  const acceptanceCriteria = optionalStringArray(record, 'acceptanceCriteria')
  const doNotDo = optionalStringArray(record, 'doNotDo')
  const forbiddenPaths = optionalStringArray(record, 'forbiddenPaths')
  if (constraints === 'invalid' || acceptanceCriteria === 'invalid' || doNotDo === 'invalid' || forbiddenPaths === 'invalid') return undefined
  return { ...(constraints === undefined ? {} : { constraints }), ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }), ...(doNotDo === undefined ? {} : { doNotDo }), allowedPaths, ...(forbiddenPaths === undefined ? {} : { forbiddenPaths }) }
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
