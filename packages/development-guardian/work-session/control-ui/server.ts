/**
 * W005-A Thin Local Control Surface — HTTP + SSE Server
 *
 * Node native http server + Server-Sent Events + vanilla HTML/CSS/JS。
 *
 * 网络安全边界：
 * - 只 bind 127.0.0.1，禁止 0.0.0.0 / :: / LAN / 公网；
 * - mutation endpoint 验证 ephemeral control token + Origin；
 * - 不设置 Access-Control-Allow-Origin: *，不实现 CORS control API；
 * - token 只经首次 HTML bootstrap 注入，不进 DB / log / SSE / URL query / status。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { WorkSessionControlController } from './controller.js'
import type { ControlResumeInput } from './controller.js'
import { renderHtml, APP_JS, STYLES_CSS } from './view.js'
import type { ControlEvent } from './events.js'
import { trackHttpPreconnections } from '../http-preconnections.js'

export interface WorkSessionControlServerOptions {
  controller: WorkSessionControlController
  /** 仅允许覆盖端口（默认 4317）；host 固定 127.0.0.1。 */
  port?: number
}

export interface WorkSessionControlServerAddress {
  host: string
  port: number
  url: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4317
/** POST body 上限；start 不需要 body，仅防御任意 payload。 */
const MAX_BODY_BYTES = 4096

const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** SSE envelope：每个 event 携带 id / timestamp / type / data。 */
interface SseEnvelope {
  id: number
  timestamp: string
  type: string
  data: unknown
}

export class WorkSessionControlServer {
  private readonly controller: WorkSessionControlController
  private readonly port: number
  private readonly token: string
  private readonly server: Server
  private readonly closePreconnections: () => void
  private readonly sseClients = new Set<ServerResponse>()
  private readonly mutationHandlers = new Set<Promise<void>>()

  private address: WorkSessionControlServerAddress | undefined
  private sseId = 0
  private closing = false
  private startOperation: Promise<WorkSessionControlServerAddress> | undefined
  private closeOperation: Promise<void> | undefined

  constructor(options: WorkSessionControlServerOptions) {
    this.controller = options.controller
    this.port = options.port ?? DEFAULT_PORT
    this.token = randomBytes(32).toString('hex')
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.closePreconnections = trackHttpPreconnections(this.server)
  }

  /** 返回实际 host/port/url。host 恒为 127.0.0.1。 */
  getAddress(): WorkSessionControlServerAddress | undefined {
    return this.address
  }

  /** Process-local listener liveness; durable Session state is intentionally separate. */
  isListening(): boolean {
    return this.address !== undefined && this.server.listening
  }

  /** 仅供测试读取，验证 token 不被 status/SSE 泄漏时用。 */
  getTokenForTest(): string {
    return this.token
  }

  start(): Promise<WorkSessionControlServerAddress> {
    if (this.startOperation !== undefined) return this.startOperation
    if (this.closing) return Promise.reject(new Error('Control server is closing'))
    this.startOperation ??= this.startOnce()
    return this.startOperation
  }

  private async startOnce(): Promise<WorkSessionControlServerAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server.once('error', onError)
      this.server.listen(this.port, DEFAULT_HOST, () => {
        this.server.off('error', onError)
        resolve()
      })
    })

    const address = this.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.port
    this.address = {
      host: DEFAULT_HOST,
      port,
      url: `http://${DEFAULT_HOST}:${port}`,
    }
    this.controller.setServerInfo(this.address.host, this.address.port, this.address.url)
    return this.address
  }

  /** Admission closes before draining; SSE ends before waiting on HTTP close. */
  close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation
    const completion = Promise.withResolvers<void>()
    this.closeOperation = completion.promise
    this.closing = true
    const errors: unknown[] = []
    try { this.controller.stopAdmission() } catch (error) { errors.push(error) }
    let controllerClose: Promise<void>
    try { controllerClose = this.controller.close() } catch (error) { controllerClose = Promise.reject(error) }
    const handlers = [...this.mutationHandlers]
    void (async () => {
      for (const result of await Promise.allSettled([this.startOperation, controllerClose, ...handlers])) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      for (const res of this.sseClients) {
        try { res.end() } catch (error) { errors.push(error) }
      }
      this.sseClients.clear()
      if (this.server.listening) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.server.close((error) => error === undefined ? resolve() : reject(error))
            this.closePreconnections()
          })
          this.address = undefined
        } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Control server shutdown failed')
    })().then(completion.resolve, completion.reject)
    return this.closeOperation
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) {
      // Rejected requests own no work, including requests failing the Host gate.
      // Their unfinished bodies must not keep listener cleanup open.
      res.setHeader('Connection', 'close')
      req.resume()
    }
    // W005-A FINAL: strict Host gate —— 先于任何路由，拒绝 DNS rebinding。
    // 不返回 HTML/bootstrap/status/SSE，也不执行 mutation。
    if (req.headers.host !== this.expectedHost()) {
      return this.respondJson(res, 403, { error: 'forbidden host' })
    }
    if (this.closing) return this.respondJson(res, 503, { error: 'Control server is closing' })

    const method = req.method ?? 'GET'
    const path = this.pathOf(req)
    if (method === 'POST') this.trackMutationHandler(res)

    res.setHeader('Cache-Control', 'no-store')

    if (method === 'GET' && path === '/') return this.serveHtml(res)
    if (method === 'GET' && path === '/app.js') return this.serveAppJs(res)
    if (method === 'GET' && path === '/styles.css') return this.serveCss(res)
    if (method === 'GET' && path === '/api/status') return this.serveStatus(res)
    if (method === 'GET' && path === '/api/events') return this.serveEvents(req, res)
    if (method === 'POST' && path === '/api/session/start') {
      return this.serveStart(req, res)
    }
    if (method === 'POST' && path === '/api/session/pause') {
      return this.servePause(req, res)
    }
    if (method === 'POST' && path === '/api/session/stop-after-task') {
      return this.serveStopAfterTask(req, res)
    }
    if (method === 'POST' && path === '/api/session/resume') {
      return this.serveResume(req, res)
    }
    if (method === 'POST' && path === '/api/session/resume-recoverable') {
      return this.serveResumeRecoverable(req, res)
    }
    if (method === 'POST' && path === '/api/session/approve-verification') {
      return this.serveApproveVerification(req, res)
    }
    if (method === 'POST' && path === '/api/session/reject-verification') {
      if (!this.authorizeMutation(req, res)) return
      return this.readBodyWithLimit(req, res, () => {
        const result = this.controller.rejectPendingVerification()
        this.respondJson(res, result.accepted ? 202 : 409,
          result.accepted ? { accepted: true } : { error: result.reason })
      })
    }
    if (method === 'POST' && path === '/api/session/runtime-repair') {
      return this.serveRuntimeRepair(req, res)
    }
    if (method === 'POST' && path === '/api/session/recover-checkpoint') {
      return this.serveRecoverCheckpoint(req, res)
    }

    const knownPaths = new Set([
      '/',
      '/app.js',
      '/styles.css',
      '/api/status',
      '/api/events',
      '/api/session/start',
      '/api/session/pause',
      '/api/session/stop-after-task',
      '/api/session/resume',
      '/api/session/resume-recoverable',
      '/api/session/approve-verification',
      '/api/session/reject-verification',
      '/api/session/runtime-repair',
      '/api/session/recover-checkpoint',
    ])
    if (knownPaths.has(path)) {
      return this.respondJson(res, 405, { error: 'method not allowed' })
    }
    return this.respondJson(res, 404, { error: 'not found' })
  }

  private pathOf(req: IncomingMessage): string {
    const raw = req.url ?? '/'
    const index = raw.indexOf('?')
    return index === -1 ? raw : raw.slice(0, index)
  }

  /** Request receipt and operation admission are separate: drain body/response
   * handling, but only admit controller work once the complete body is valid. */
  private trackMutationHandler(res: ServerResponse): void {
    let finish!: () => void
    const operation = new Promise<void>((resolve) => { finish = resolve })
    this.mutationHandlers.add(operation)
    const settled = (): void => {
      this.mutationHandlers.delete(operation)
      res.off('finish', settled)
      res.off('close', settled)
      finish()
    }
    res.once('finish', settled)
    res.once('close', settled)
  }

  private serveHtml(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // script-src 'self'：bootstrap token 走 application/json data 标签，非 inline script。
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    res.end(
      renderHtml({
        controlToken: this.token,
        serverOrigin: this.origin(),
      }),
    )
  }

  private serveAppJs(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(APP_JS)
  }

  private serveCss(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(STYLES_CSS)
  }

  private serveStatus(res: ServerResponse): void {
    this.respondJson(res, 200, this.controller.getSnapshot())
  }

  private serveStart(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) {
      return
    }
    this.readBodyWithLimit(req, res, () => {
      const result = this.controller.start()
      if (result.started) {
        this.respondJson(res, 202, { accepted: true })
      } else {
        this.respondJson(res, 409, { error: 'session already started' })
      }
    })
  }

  private servePause(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) {
      return
    }
    this.readBodyWithLimit(req, res, () => {
      const result = this.controller.requestPause()
      if (result.accepted) {
        this.respondJson(res, 202, { accepted: true })
      } else {
        this.respondJson(res, 409, { error: result.reason ?? 'pause rejected' })
      }
    })
  }

  private serveStopAfterTask(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) {
      return
    }
    this.readBodyWithLimit(req, res, () => {
      const result = this.controller.requestStopAfterTask()
      if (result.accepted) {
        this.respondJson(res, 202, { accepted: true })
      } else {
        this.respondJson(res, 409, { error: result.reason ?? 'stop after task rejected' })
      }
    })
  }

  private serveResume(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) {
      return
    }
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(res, 415, { error: 'content type must be application/json' })
      return
    }
    this.readBodyWithLimit(req, res, (body) => {
      const parsed = parseResumeBody(body)
      if (!parsed.ok) {
        this.respondJson(res, 400, { error: parsed.error })
        return
      }
      const result = this.controller.resume(parsed.input)
      if (result.accepted) {
        this.respondJson(res, 202, { accepted: true })
      } else {
        this.respondJson(res, 409, { error: result.reason ?? 'resume rejected' })
      }
    })
  }

  private serveResumeRecoverable(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) {
      return
    }
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      this.respondJson(res, 415, { error: 'content type must be application/json' })
      return
    }
    this.readBodyWithLimit(req, res, (body) => {
      const parsed = parseResumeBody(body)
      if (!parsed.ok) {
        this.respondJson(res, 400, { error: parsed.error })
        return
      }
      const result = this.controller.resumeRecoverable(parsed.input)
      if (result.accepted) {
        this.respondJson(res, 202, { accepted: true })
      } else {
        this.respondJson(res, 409, { error: result.reason ?? 'recoverable resume rejected' })
      }
    })
  }

  private serveRecoverCheckpoint(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) return
    this.readBodyWithLimit(req, res, () => {
      const result = this.controller.recoverFailedCheckpoint()
      if (result.accepted) this.respondJson(res, 202, { accepted: true })
      else this.respondJson(res, 409, { error: result.reason ?? 'checkpoint recovery rejected' })
    })
  }

  private serveApproveVerification(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) return
    this.readBodyWithLimit(req, res, (body) => {
      // This endpoint deliberately accepts only an empty body: command identity
      // is read from durable runtime state, never supplied by the browser.
      if (body.trim().length !== 0) return this.respondJson(res, 400, { error: 'approval body must be empty' })
      const result = this.controller.approvePendingVerificationAndContinue()
      if (result.accepted) this.respondJson(res, 202, { accepted: true })
      else this.respondJson(res, 409, { error: result.reason ?? 'verification approval rejected' })
    })
  }

  private serveRuntimeRepair(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorizeMutation(req, res)) return
    this.readBodyWithLimit(req, res, (body) => {
      // The runtime owns diagnosis/repair/resume; the browser supplies no decision data.
      if (body.trim().length !== 0) return this.respondJson(res, 400, { error: 'runtime repair body must be empty' })
      const result = this.controller.repairRuntimeAndResume()
      if (result.accepted) this.respondJson(res, 202, { accepted: true })
      else this.respondJson(res, 409, { error: result.reason ?? 'runtime repair rejected' })
    })
  }

  private authorizeMutation(req: IncomingMessage, res: ServerResponse): boolean {
    // 1. Origin 校验：同源、或 Chromium loopback 端口省略兼容；无 Origin 的非浏览器请求放行。
    const origin = req.headers.origin
    if (origin !== undefined && !this.originMatchesRequest(req)) {
      this.respondJson(res, 403, { error: 'forbidden origin' })
      return false
    }

    // 2. control token 校验（timing-safe）。
    const token = req.headers['x-novawing-control-token']
    if (typeof token !== 'string' || !this.tokenMatches(token)) {
      this.respondJson(res, 403, { error: 'forbidden' })
      return false
    }
    return true
  }

  /**
   * Chromium may omit the port from a loopback Origin. Accept that one form only
   * when the already strict Host, a same-origin Referer, and fetch metadata all
   * bind the request back to this exact listener origin.
   */
  private originMatchesRequest(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === this.origin()) {
      return true
    }

    if (
      origin !== 'http://127.0.0.1' ||
      req.headers.host !== this.expectedHost() ||
      req.headers['sec-fetch-site'] !== 'same-origin'
    ) {
      return false
    }

    const referer = req.headers.referer
    if (typeof referer !== 'string') {
      return false
    }

    try {
      return new URL(referer).origin === this.origin()
    } catch {
      return false
    }
  }

  private readBodyWithLimit(
    req: IncomingMessage,
    res: ServerResponse,
    onDone: (body: string) => void,
  ): void {
    let size = 0
    let body = ''
    let settled = false
    const fail = (): void => {
      if (!settled) {
        settled = true
        this.respondJson(res, 413, { error: 'payload too large' })
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail()
        req.destroy()
      } else {
        body += chunk.toString('utf8')
      }
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        // Receiving a body is not control-operation admission. Recheck at the
        // dispatch boundary so a slow request cannot mutate after shutdown.
        if (this.closing) return this.respondJson(res, 503, { error: 'Control server is closing' })
        onDone(body)
      }
    })
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': SSE_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.flushHeaders?.()

    this.writeSse(res, 'connected', {
      id: this.nextSseId(),
      timestamp: new Date().toISOString(),
      type: 'connected',
      data: {},
    })
    this.writeSse(res, 'snapshot', {
      id: this.nextSseId(),
      timestamp: new Date().toISOString(),
      type: 'snapshot',
      data: this.controller.getSnapshot(),
    })

    const unsubscribe = this.controller.subscribe({
      onEvent: (event) => {
        const sseEvent = event.type === 'GUARDIAN_PHASE' ? 'guardian' : event.type === 'TASK_PHASE' ? 'task' : 'activity'
        this.writeSse(res, sseEvent, envelopeFromEvent(event, this.nextSseId()))
      },
      onSnapshot: (snapshot) => {
        this.writeSse(res, 'snapshot', {
          id: this.nextSseId(),
          timestamp: new Date().toISOString(),
          type: 'snapshot',
          data: snapshot,
        })
      },
    })

    this.sseClients.add(res)
    const cleanup = (): void => {
      unsubscribe()
      this.sseClients.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  private writeSse(res: ServerResponse, sseEvent: string, envelope: SseEnvelope): void {
    res.write(`event: ${sseEvent}\ndata: ${JSON.stringify(envelope)}\n\n`)
  }

  private nextSseId(): number {
    return ++this.sseId
  }

  private tokenMatches(provided: string): boolean {
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token)
    if (a.length !== b.length) {
      return false
    }
    return timingSafeEqual(a, b)
  }

  private origin(): string {
    return this.address?.url ?? `http://${DEFAULT_HOST}:${this.port}`
  }

  /** 由实际 bind 端口构造的 trusted Host；不是从 request Host 动态生成。 */
  private expectedHost(): string {
    const port = this.address?.port ?? this.port
    return `${DEFAULT_HOST}:${port}`
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': JSON_CONTENT_TYPE, 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
}

function envelopeFromEvent(event: ControlEvent, id: number): SseEnvelope {
  return {
    id,
    timestamp: event.timestamp,
    type: event.type,
    data: event.data,
  }
}

function parseResumeBody(body: string):
  | { ok: true; input: ControlResumeInput }
  | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return { ok: false, error: 'malformed JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'resume body must be an object' }
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => !['decision', 'approval', 'recovery', 'taskId', 'generation'].includes(key))) {
    return { ok: false, error: 'resume body contains unknown fields' }
  }
  if (['decision', 'approval', 'recovery'].filter((key) => record[key] !== undefined).length > 1) {
    return { ok: false, error: 'resume body must contain decision or approval, not both' }
  }
  const scope: Pick<ControlResumeInput, 'taskId' | 'generation'> = {}
  if (record.taskId !== undefined) {
    if (typeof record.taskId !== 'string' || !record.taskId.trim()) return { ok: false, error: 'taskId must be a nonempty string' }
    scope.taskId = record.taskId
  }
  if (record.generation !== undefined) {
    if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 0) {
      return { ok: false, error: 'generation must be a nonnegative integer' }
    }
    scope.generation = record.generation
  }
  if (record.recovery !== undefined) {
    if (record.recovery !== 'diagnose' || scope.taskId === undefined || scope.generation === undefined) {
      return { ok: false, error: 'diagnosis requires the current taskId and generation' }
    }
    return { ok: true, input: { ...scope, recovery: 'diagnose' } }
  }
  if (record.decision !== undefined) {
    if (typeof record.decision !== 'string') {
      return { ok: false, error: 'decision must be a string' }
    }
    const decision = record.decision.trim()
    if (decision.length < 1 || decision.length > 2_000) {
      return { ok: false, error: 'decision must be 1..2000 characters' }
    }
    return { ok: true, input: { ...scope, decision } }
  }
  if (record.approval !== undefined) {
    if (typeof record.approval !== 'boolean') {
      return { ok: false, error: 'approval must be a boolean' }
    }
    return { ok: true, input: { ...scope, approval: record.approval } }
  }
  return { ok: true, input: scope }
}
