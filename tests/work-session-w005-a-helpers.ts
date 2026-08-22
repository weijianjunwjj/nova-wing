/**
 * W005-A 测试共享 helper
 * 提供 deterministic fake runtime、definition/state 构造、server 启动封装。
 */

import type {
  WorkSessionDefinition,
  WorkSessionDurableState,
} from '../packages/development-guardian/work-session/index.js'
import type { WorkSessionControlRuntime } from '../packages/development-guardian/work-session/control-ui/events.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'

export function makeDefinition(
  overrides: Partial<WorkSessionDefinition> = {},
): WorkSessionDefinition {
  return {
    id: 'w005a-session',
    targetRepo: '/repo/example',
    branch: 'feat/w005a',
    tasks: [
      { id: 'T1', goal: 'task one' },
      { id: 'T2', goal: 'task two' },
    ],
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    ...overrides,
  }
}

export function makeState(
  overrides: Partial<WorkSessionDurableState> = {},
): WorkSessionDurableState {
  return {
    sessionId: 'w005a-session',
    state: 'READY',
    currentTaskIndex: 0,
    currentTaskId: null,
    completedTaskIds: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

/** 测试专用 deterministic fake runtime。 */
export class FakeRuntime implements WorkSessionControlRuntime {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState | undefined
  loadPersistedStateCalls = 0
  startCalls = 0
  resumeCalls = 0
  resumeInputs: Array<{ decision?: string; approval?: boolean }> = []
  pauseRequested = false
  stopAfterTaskRequested = false
  startDeferred:
    | {
        promise: Promise<WorkSessionDurableState>
        resolve: (state: WorkSessionDurableState) => void
        reject: (error: unknown) => void
      }
    | undefined
  resumeDeferred:
    | {
        promise: Promise<WorkSessionDurableState>
        resolve: (state: WorkSessionDurableState) => void
        reject: (error: unknown) => void
      }
    | undefined

  constructor(definition: WorkSessionDefinition) {
    this.definition = definition
  }

  async loadPersistedState(): Promise<WorkSessionDurableState | undefined> {
    this.loadPersistedStateCalls++
    return this.state
  }

  async start(): Promise<WorkSessionDurableState> {
    this.startCalls++
    if (this.startDeferred !== undefined) {
      return this.startDeferred.promise
    }
    if (this.state === undefined) {
      return makeState({ state: 'RUNNING' })
    }
    return this.state
  }

  async resume(input: { decision?: string; approval?: boolean }): Promise<WorkSessionDurableState> {
    this.resumeCalls++
    this.resumeInputs.push(input)
    if (this.resumeDeferred !== undefined) {
      return this.resumeDeferred.promise
    }
    return this.state ?? makeState({ state: 'RUNNING' })
  }

  requestPause(): { accepted: boolean; reason?: string } {
    if (this.state?.state !== 'RUNNING' || this.pauseRequested) {
      return { accepted: false, reason: 'session is not running' }
    }
    this.pauseRequested = true
    return { accepted: true }
  }

  requestStopAfterTask(): { accepted: boolean; reason?: string } {
    if (this.state?.state !== 'RUNNING' || this.stopAfterTaskRequested) {
      return { accepted: false, reason: 'session is not running' }
    }
    this.stopAfterTaskRequested = true
    return { accepted: true }
  }

  getControlIntents(): { pauseRequested: boolean; stopAfterTaskRequested: boolean } {
    return {
      pauseRequested: this.pauseRequested,
      stopAfterTaskRequested: this.stopAfterTaskRequested,
    }
  }

  getDurableState(): WorkSessionDurableState | undefined {
    return this.state
  }

  getDefinition(): WorkSessionDefinition {
    return this.definition
  }

  /** 让 start() 卡在可控 deferred 上，用于 background start / rejection 测试。 */
  deferStart(): void {
    let resolveFn: ((state: WorkSessionDurableState) => void) | undefined
    let rejectFn: ((error: unknown) => void) | undefined
    const promise = new Promise<WorkSessionDurableState>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    this.startDeferred = {
      promise,
      resolve: (state) => {
        resolveFn?.(state)
      },
      reject: (error) => {
        rejectFn?.(error)
      },
    }
  }

  deferResume(): void {
    let resolveFn: ((state: WorkSessionDurableState) => void) | undefined
    let rejectFn: ((error: unknown) => void) | undefined
    const promise = new Promise<WorkSessionDurableState>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    this.resumeDeferred = {
      promise,
      resolve: (state) => resolveFn?.(state),
      reject: (error) => rejectFn?.(error),
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface StartedServer {
  server: WorkSessionControlServer
  controller: WorkSessionControlController
  runtime: FakeRuntime
  address: { host: string; port: number; url: string }
  token: string
}

export async function startServer(
  overrides: {
    definition?: WorkSessionDefinition
    pollIntervalMs?: number
    port?: number
  } = {},
): Promise<StartedServer> {
  const definition = overrides.definition ?? makeDefinition()
  const runtime = new FakeRuntime(definition)
  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
  })
  const server = new WorkSessionControlServer({ controller, port: overrides.port ?? 0 })
  const address = await server.start()
  return {
    server,
    controller,
    runtime,
    address,
    token: server.getTokenForTest(),
  }
}

/** POST /api/session/start，可注入 Origin / token / 请求超时。 */
export async function postStart(
  s: StartedServer,
  options: {
    token?: string
    origin?: string
    referer?: string
    secFetchSite?: string
    timeoutMs?: number
  } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers['X-NovaWing-Control-Token'] = options.token
  if (options.origin !== undefined) headers['Origin'] = options.origin
  if (options.referer !== undefined) headers.Referer = options.referer
  if (options.secFetchSite !== undefined) headers['Sec-Fetch-Site'] = options.secFetchSite

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  try {
    const res = await fetch(`${s.address.url}/api/session/start`, {
      method: 'POST',
      headers,
      signal: controller.signal,
    })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(timeout)
  }
}
