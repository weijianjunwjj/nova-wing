import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  createProductionWorkSessionUi,
  loadTrustedWorkSessionConfig,
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
const MAX_BODY_BYTES = 4096
const SAFE_LAUNCH_ERROR = 'Work Session 启动失败'

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
  shutdownTimeoutMs?: number
}

interface LaunchResult {
  accepted: true
  controlUrl: string
  alreadyStarted?: true
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
  private readonly shutdownTimeoutMs: number
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly activeStarts = new Map<string, Promise<LaunchResult>>()
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
      Promise.allSettled([...this.activeApps.values()].map((app) => app.close())).then(() => undefined),
      this.shutdownTimeoutMs,
    )
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

    const knownPaths = new Set(['/', '/app.js', '/styles.css', '/api/session/start'])
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
