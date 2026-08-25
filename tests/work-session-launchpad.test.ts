import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createNovaWingLaunchpad,
  defaultTrustedConfigDirectory,
  discoverTrustedWorkSessionConfigs,
  findBrowserExecutable,
  loadTrustedWorkSessionConfig,
  openLaunchpadInAppMode,
  type BrowserProcessSpawner,
  type NovaWingLaunchpad,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'

function trustedConfig(overrides: {
  sessionId?: string
  goal?: string
  executorModel?: string
} = {}): unknown {
  return {
    session: {
      id: overrides.sessionId ?? 'launchpad-test',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 4 },
    },
    tasks: [{
      id: 'T010',
      goal: overrides.goal ?? 'AgentRun Persistence',
      guardian: {
        constraints: ['keep scope narrow'],
        acceptanceCriteria: ['tests pass'],
        doNotDo: ['do not expose credentials'],
        allowedPaths: ['packages/**'],
        forbiddenPaths: ['secrets/**'],
      },
    }],
    gitCheckpoint: { autoCommit: true, autoPush: false },
    executor: {
      model: overrides.executorModel ?? 'claude-sonnet',
      maxTurns: 10,
      allowNpmInstall: false,
      allowPythonBootstrap: false,
    },
    notification: { email: { enabled: false } },
  }
}

async function createConfigDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-launchpad-'))
  await writeFile(join(directory, 'fly-weave.json'), JSON.stringify(trustedConfig()), 'utf8')
  return directory
}

interface FakeWorkSessionState {
  createCalls: number
  startCalls: number
  controllerStartCalls: number
  closeCalls: number
  receivedServerPorts: number[]
  receivedConfigIds: string[]
  receivedExecutorModels: string[]
  receivedConfigs: TrustedWorkSessionConfig[]
}

function fakeWorkSessionFactory(
  state: FakeWorkSessionState,
  options: { controllerStarted?: boolean; failWith?: Error } = {},
) {
  return async (config: TrustedWorkSessionConfig, input: { serverPort: 0 }) => {
    state.createCalls += 1
    state.receivedServerPorts.push(input.serverPort)
    state.receivedConfigIds.push(config.session.id)
    state.receivedExecutorModels.push(config.executor.model)
    state.receivedConfigs.push(config)
    if (options.failWith !== undefined) throw options.failWith
    return {
      controller: {
        start() {
          state.controllerStartCalls += 1
          return { started: options.controllerStarted ?? true }
        },
      },
      async start() {
        state.startCalls += 1
        return { url: 'http://127.0.0.1:54321' }
      },
      async close() {
        state.closeCalls += 1
      },
    }
  }
}

function emptyFakeState(): FakeWorkSessionState {
  return {
    createCalls: 0,
    startCalls: 0,
    controllerStartCalls: 0,
    closeCalls: 0,
    receivedServerPorts: [],
    receivedConfigIds: [],
    receivedExecutorModels: [],
    receivedConfigs: [],
  }
}

async function postStart(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined
        ? {}
        : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

async function postCreate(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined ? {} : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

async function postBranch(
  launchpad: NovaWingLaunchpad,
  targetRepo: string,
  headers: { token: string; origin: string },
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/branch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NovaWing-Launchpad-Token': headers.token,
      Origin: headers.origin,
    },
    body: JSON.stringify({ targetRepo }),
  })
}

function composerRequest(requestId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    requestId,
    targetRepo: process.cwd(),
    tasks: [{ id: 'T011', goal: 'Implement a focused persistent model with deterministic tests.' }],
    guardian: { allowedPaths: ['packages/**', 'tests/**'] },
    ...overrides,
  }
}

await test('Launchpad discovery uses the trusted validator and ignores invalid JSON configs', async () => {
  const directory = await createConfigDirectory()
  try {
    await writeFile(join(directory, 'invalid.json'), '{"credential":"SECRET"}', 'utf8')
    await writeFile(join(directory, 'notes.txt'), JSON.stringify(trustedConfig()), 'utf8')
    const discovered = await discoverTrustedWorkSessionConfigs(directory)
    assert.equal(discovered.length, 1)
    assert.match(discovered[0]!.summary.configId, /^[a-f0-9]{32}$/u)
    assert.equal(discovered[0]!.summary.project, 'Nova-Wing')
    assert.equal(discovered[0]!.summary.taskId, 'T010')
    assert.equal(discovered[0]!.summary.goal, 'AgentRun Persistence')
    assert.equal(discovered[0]!.summary.reviewer, 'GPT Reviewer')
    assert.equal(discovered[0]!.summary.executor, 'claude-sonnet')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad config directory supports NOVAWING_CONFIG_DIR and the LOCALAPPDATA default', () => {
  assert.equal(
    defaultTrustedConfigDirectory({ NOVAWING_CONFIG_DIR: 'D:/trusted-configs' }, 'C:/Users/test'),
    join('D:/trusted-configs'),
  )
  assert.equal(
    defaultTrustedConfigDirectory({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' }, 'C:/ignored'),
    join('C:/Users/test/AppData/Local', 'NovaWing', 'canary-configs'),
  )
})

await test('Launchpad binds only 127.0.0.1 on a dynamic port and renders safe config fields', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    assert.equal(address.host, '127.0.0.1')
    assert.ok(address.port > 0)
    assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
    const html = await (await fetch(address.url)).text()
    assert.match(html, /NovaWing Launchpad/u)
    assert.match(html, /AgentRun Persistence/u)
    assert.match(html, /SYSTEM READY/u)
    assert.match(html, /新建 Work Session/u)
    assert.match(html, /data-composer-tasks/u)
    assert.match(html, /data-task-id/u)
    assert.match(html, /data-task-goal/u)
    assert.match(html, /data-add-task/u)
    assert.match(html, /邮件通知（完成 \/ 失败 \/ 需人工）/u)
    assert.doesNotMatch(html, /name="autoPush"[^>]*disabled/u)
    const advanced = html.match(/<details>[\s\S]*?<\/details>/u)?.[0] ?? ''
    assert.doesNotMatch(advanced, /allowedPaths/u)
    assert.match(html, /name="allowedPaths"[^>]*required/u)
    assert.doesNotMatch(html, /expectedUrl|SMTP_|credential/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer creates a fresh validated session from structured input and reads branch through git argv', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const gitCalls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner(executable, args, cwd) {
        gitCalls.push({ executable, args, cwd })
        return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
      },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const response = await postCreate(launchpad, composerRequest('composer-create-request-0001'), auth)
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()))
    assert.deepEqual(await response.json(), { accepted: true, controlUrl: 'http://127.0.0.1:54321' })
    assert.equal(state.createCalls, 1)
    assert.equal(state.receivedConfigIds.length, 1)
    assert.match(state.receivedConfigIds[0]!, /^nova-wing-\d{12}-[a-f0-9]{6}$/u)
    assert.deepEqual(state.receivedExecutorModels, ['sonnet'])
    assert.equal(state.controllerStartCalls, 1)
    assert.equal(state.receivedConfigs[0]!.tasks[0]!.id, 'T011')
    assert.equal(state.receivedConfigs[0]!.session.limits.maxTasks, 1)
    assert.deepEqual(state.receivedConfigs[0]!.notification, { email: { enabled: false } })
    assert.deepEqual(gitCalls, [{ executable: 'git', args: ['branch', '--show-current'], cwd: process.cwd() }])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer includes completion email notification when enabled', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-email', { emailEnabled: true }), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(state.receivedConfigs[0]!.notification, {
      email: { enabled: true, notifyOnCompleted: true },
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer creates ordered batch tasks with a shared Guardian policy and matching maxTasks', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-batch', {
      tasks: [
        { id: 'T014', goal: 'Implement check_inventory Tool.' },
        { id: 'T015', goal: 'Implement constrained replacement decision.' },
        { id: 'T016', goal: 'Add deterministic coverage.' },
        { id: 'T017', goal: 'Document the result.' },
      ],
    }), { token: launchpad.getTokenForTest(), origin: address.url })
    assert.equal(response.status, 202)
    const config = state.receivedConfigs[0]!
    assert.deepEqual(config.tasks.map((task) => ({ id: task.id, goal: task.goal })), [
      { id: 'T014', goal: 'Implement check_inventory Tool.' },
      { id: 'T015', goal: 'Implement constrained replacement decision.' },
      { id: 'T016', goal: 'Add deterministic coverage.' },
      { id: 'T017', goal: 'Document the result.' },
    ])
    assert.equal(config.session.limits.maxTasks, 4)
    assert.deepEqual(config.tasks.map((task) => task.guardian.allowedPaths), [
      ['packages/**', 'tests/**'], ['packages/**', 'tests/**'], ['packages/**', 'tests/**'], ['packages/**', 'tests/**'],
    ])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer discovers one origin push URL read-only and carries its confirmed identity into auto push config', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const gitCalls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner(executable, args, cwd) {
        gitCalls.push({ executable, args, cwd })
        if (args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/acme/nova-wing.git\n', stderr: '' }
        return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
      },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const discovery = await postBranch(launchpad, process.cwd(), auth)
    assert.deepEqual(await discovery.json(), {
      branch: 'feat/composer',
      pushRemoteStatus: 'available',
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    })
    const response = await postCreate(launchpad, composerRequest('composer-create-request-push', {
      autoPush: true,
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    }), auth)
    assert.equal(response.status, 202)
    assert.deepEqual(state.receivedConfigs[0]!.gitCheckpoint, {
      autoCommit: true,
      autoPush: true,
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    })
    assert.deepEqual(gitCalls[1], {
      executable: 'git', args: ['remote', 'get-url', '--push', '--all', 'origin'], cwd: process.cwd(),
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer remote discovery never exposes credential-bearing or ambiguous origin URLs', async () => {
  const directory = await createConfigDirectory()
  const cases: Array<{ remote: string; available: boolean }> = [
    { remote: 'git@github.com:acme/nova-wing.git\n', available: true },
    { remote: 'ssh://git@github.com/acme/nova-wing.git\n', available: true },
    { remote: 'https://user:pass@github.com/acme/nova-wing.git\n', available: false },
    { remote: 'https://ghp_xxx@github.com/acme/nova-wing.git\n', available: false },
    { remote: 'http://github.com/acme/nova-wing.git\n', available: false },
    { remote: 'https://github.com/acme/nova-wing.git?token=secret\n', available: false },
    { remote: 'https://github.com/acme/nova-wing.git#secret\n', available: false },
    { remote: 'https://github.com/acme/one.git\nhttps://github.com/acme/two.git\n', available: false },
  ]
  try {
    for (const entry of cases) {
      const launchpad = await createNovaWingLaunchpad({
        configDirectory: directory,
        dependencies: {
          async gitProcessRunner(_executable, args) {
            return args[0] === 'remote'
              ? { exitCode: 0, stdout: entry.remote, stderr: '' }
              : { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
          },
        },
      })
      try {
        const address = await launchpad.start()
        const response = await postBranch(launchpad, process.cwd(), {
          token: launchpad.getTokenForTest(), origin: address.url,
        })
        const body = await response.text()
        assert.equal(response.status, 200)
        assert.equal(JSON.parse(body).pushRemoteStatus, entry.available ? 'available' : 'unavailable')
        if (!entry.available) assert.doesNotMatch(body, /user|pass|ghp_xxx|token=secret|#secret|http:\/\//u)
      } finally {
        await launchpad.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer reuses a completed requestId only for the same canonical payload', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const orderedTasks = [
      { id: 'T011', goal: 'Implement a focused persistent model with deterministic tests.' },
      { id: 'T012', goal: 'Implement the follow-up validation.' },
    ]
    const first = await postCreate(launchpad, composerRequest('composer-create-request-0002', { tasks: orderedTasks }), auth)
    const repeated = await postCreate(launchpad, composerRequest('composer-create-request-0002', { tasks: orderedTasks }), auth)
    const second = await postCreate(launchpad, composerRequest('composer-create-request-0003'), auth)
    assert.equal(first.status, 202)
    assert.equal(repeated.status, 202)
    assert.equal(second.status, 202)
    assert.equal(state.createCalls, 2)
    assert.notEqual(state.receivedConfigIds[0], state.receivedConfigIds[1])
    const conflicting = await postCreate(launchpad, composerRequest('composer-create-request-0002', {
      tasks: [...orderedTasks].reverse(),
    }), auth)
    assert.equal(conflicting.status, 409)
    assert.deepEqual(await conflicting.json(), {
      error: 'IDEMPOTENCY_CONFLICT',
      message: '该 requestId 已用于不同的创建请求。',
    })
    assert.equal(state.createCalls, 2)
    const injected = await postCreate(launchpad, {
      ...composerRequest('composer-create-request-0004') as Record<string, unknown>, storageUrl: 'file:///tmp/old.db',
    }, auth)
    assert.equal(injected.status, 400)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer caps a long project basename in generated session ids', async () => {
  const directory = await createConfigDirectory()
  const targetRepo = join(directory, 'a'.repeat(100))
  await mkdir(targetRepo)
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-0009', { targetRepo }), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.match(state.receivedConfigIds[0]!, /^a{48}-\d{12}-[a-f0-9]{6}$/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad close waits for a pending Composer create before closing its app', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  let resolveCreate: (() => void) | undefined
  let signalCreateStarted: (() => void) | undefined
  const createGate = new Promise<void>((resolve) => { resolveCreate = resolve })
  const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve })
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async createWorkSession(config, input) {
        state.createCalls += 1
        state.receivedServerPorts.push(input.serverPort)
        state.receivedConfigIds.push(config.session.id)
        state.receivedExecutorModels.push(config.executor.model)
        signalCreateStarted?.()
        await createGate
        return {
          controller: { start: () => ({ started: true }) },
          async start() { return { url: 'http://127.0.0.1:54321' } },
          async close() { state.closeCalls += 1 },
        }
      },
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const pendingRequest = postCreate(launchpad, composerRequest('composer-create-request-0010'), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    await createStarted
    let closeFinished = false
    const closing = launchpad.close().then(() => { closeFinished = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closeFinished, false)
    resolveCreate?.()
    await closing
    await pendingRequest.catch(() => undefined)
    assert.equal(state.closeCalls, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad close bounds a Composer create that never resolves', async () => {
  const directory = await createConfigDirectory()
  let signalCreateStarted: (() => void) | undefined
  const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve })
  const shutdownTimeoutMs = 20
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      shutdownTimeoutMs,
      async createWorkSession() {
        signalCreateStarted?.()
        return new Promise<never>(() => undefined)
      },
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  let closeTimer: NodeJS.Timeout | undefined
  const keepAliveServer = http.createServer()
  await new Promise<void>((resolve) => keepAliveServer.listen(0, '127.0.0.1', resolve))
  try {
    const address = await launchpad.start()
    const pendingCreate = postCreate(launchpad, composerRequest('composer-create-request-0011'), {
      token: launchpad.getTokenForTest(), origin: address.url,
    }).catch(() => undefined)
    await createStarted
    const startedAt = Date.now()
    await Promise.race([
      launchpad.close(),
      new Promise<void>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Launchpad close exceeded its bounded shutdown timeout')), 500)
      }),
    ])
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    assert.ok(Date.now() - startedAt >= shutdownTimeoutMs, 'close should wait through the bounded shutdown timeout')
    void pendingCreate
  } finally {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    await launchpad.close()
    await new Promise<void>((resolve) => keepAliveServer.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer fails closed for invalid paths, non-git repositories, invalid limits, and missing allowed paths', async () => {
  const directory = await createConfigDirectory()
  const nonGit = await mkdtemp(join(tmpdir(), 'novawing-not-git-'))
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const invalidPath = await postCreate(launchpad, composerRequest('composer-create-request-0005', { targetRepo: 'relative/path' }), auth)
    assert.deepEqual(await invalidPath.json(), { error: 'INVALID_PROJECT_PATH', message: '项目目录必须是存在的绝对路径。' })
    const notGit = await postCreate(launchpad, composerRequest('composer-create-request-0006', { targetRepo: nonGit }), auth)
    assert.equal((await notGit.json() as { error: string }).error, 'NOT_A_GIT_REPOSITORY')
    const badLimits = await postCreate(launchpad, composerRequest('composer-create-request-0007', { softMinutes: 91, hardMinutes: 90 }), auth)
    assert.equal((await badLimits.json() as { error: string }).error, 'INVALID_LIMITS')
    const noPaths = await postCreate(launchpad, composerRequest('composer-create-request-0008', { guardian: {} }), auth)
    assert.equal((await noPaths.json() as { error: string }).error, 'MISSING_ALLOWED_PATHS')
    const emptyTasks = await postCreate(launchpad, composerRequest('composer-create-request-empty', { tasks: [] }), auth)
    assert.equal((await emptyTasks.json() as { error: string }).error, 'INVALID_REQUEST')
    const tooManyTasks = await postCreate(launchpad, composerRequest('composer-create-request-many', {
      tasks: Array.from({ length: 11 }, (_, index) => ({ id: `T${index}`, goal: 'Valid task goal.' })),
    }), auth)
    assert.equal((await tooManyTasks.json() as { error: string }).error, 'INVALID_REQUEST')
    const duplicateTasks = await postCreate(launchpad, composerRequest('composer-create-request-duplicate', {
      tasks: [{ id: 'T011', goal: 'First task.' }, { id: 'T011', goal: 'Second task.' }],
    }), auth)
    assert.equal((await duplicateTasks.json() as { error: string }).error, 'DUPLICATE_TASK_ID')
    const invalidGoal = await postCreate(launchpad, composerRequest('composer-create-request-invalid-goal', {
      tasks: [{ id: 'T011', goal: '   ' }],
    }), auth)
    assert.equal((await invalidGoal.json() as { error: string }).error, 'INVALID_TASK')
    const missingPushRemote = await postCreate(launchpad, composerRequest('composer-create-request-0011', { autoPush: true }), auth)
    assert.equal((await missingPushRemote.json() as { error: string }).error, 'AUTO_PUSH_REMOTE_UNAVAILABLE')
    const pushWithoutCommit = await postCreate(launchpad, composerRequest('composer-create-request-0012', {
      autoPush: true, autoCommit: false, pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    }), auth)
    assert.equal((await pushWithoutCommit.json() as { error: string }).error, 'AUTO_PUSH_REQUIRES_AUTO_COMMIT')
    const malformedPushRemote = await postCreate(launchpad, composerRequest('composer-create-request-0013', {
      autoPush: true, pushRemote: { name: 'origin', expectedUrl: 'not a remote' },
    }), auth)
    assert.equal((await malformedPushRemote.json() as { error: string }).error, 'INVALID_PUSH_REMOTE')
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
    await rm(nonGit, { recursive: true, force: true })
  }
})

await test('Launchpad rejects a foreign Host before serving bootstrap HTML', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const result = await requestWithHost(address.port, 'evil.example')
    assert.equal(result.status, 403)
    assert.doesNotMatch(result.body, new RegExp(launchpad.getTokenForTest(), 'u'))
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad mutation requires both same Origin and the ephemeral token', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    assert.equal((await postStart(launchpad, { configId }, { origin: address.url })).status, 403)
    assert.equal((await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
      origin: 'http://evil.example',
    })).status, 403)
    assert.equal((await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
    })).status, 403)
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Browser can submit only a discovered configId, never an arbitrary config path', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    assert.equal((await postStart(launchpad, { path: 'C:/whatever.json' }, auth)).status, 400)
    assert.equal((await postStart(launchpad, {
      configId: launchpad.getConfigs()[0]!.configId,
      path: 'C:/whatever.json',
    }, auth)).status, 400)
    assert.equal((await postStart(launchpad, { configId: '0'.repeat(32) }, auth)).status, 404)
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad revalidates the config, passes serverPort=0, and returns the real control URL', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  let loadCalls = 0
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async loadConfig(path) {
        loadCalls += 1
        return loadTrustedWorkSessionConfig(path)
      },
      createWorkSession: fakeWorkSessionFactory(state),
      async resolveEnvironment() { return { SAFE_MODEL_NAME: 'test' } },
    },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const response = await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
      origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
    })
    assert.equal(loadCalls, 2, 'discovery plus launch-time revalidation')
    assert.deepEqual(state.receivedServerPorts, [0])
    assert.deepEqual(state.receivedConfigIds, ['launchpad-test'])
    assert.equal(state.controllerStartCalls, 1)
  } finally {
    await launchpad.close()
    assert.equal(state.closeCalls, 1)
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Duplicate clicks reuse one Work Session app and one control URL', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const first = await postStart(launchpad, { configId }, auth)
    const second = await postStart(launchpad, { configId }, auth)
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    assert.equal(state.createCalls, 1)
    assert.equal(state.startCalls, 1)
    assert.equal(state.controllerStartCalls, 1)
    assert.deepEqual(await second.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
      alreadyStarted: true,
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('A durable restored session opens its control surface without starting a duplicate run', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state, { controllerStarted: false }),
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postStart(launchpad, { configId: launchpad.getConfigs()[0]!.configId }, {
      token: launchpad.getTokenForTest(),
      origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
      alreadyStarted: true,
    })
    assert.equal(state.createCalls, 1)
    assert.equal(state.controllerStartCalls, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launch failure returns only a safe product error and permits a later retry', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state, {
        failWith: new Error('SMTP_PASSWORD=raw-secret credential failure'),
      }),
    },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const first = await postStart(launchpad, { configId }, auth)
    const second = await postStart(launchpad, { configId }, auth)
    assert.equal(first.status, 500)
    assert.equal(second.status, 500)
    assert.deepEqual(await first.json(), { error: 'Work Session 启动失败' })
    assert.equal(state.createCalls, 2)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Browser detection prefers Edge and falls back to Chrome', async () => {
  const env = {
    PROGRAMFILES: 'C:/Program Files',
    'PROGRAMFILES(X86)': 'C:/Program Files (x86)',
  }
  const edge = await findBrowserExecutable(env, async () => true)
  assert.equal(edge?.kind, 'edge')
  assert.match(edge?.executable ?? '', /Program Files \(x86\).*Microsoft.*Edge.*msedge\.exe/u)

  const chrome = await findBrowserExecutable(env, async (path) => path.includes('Google'))
  assert.equal(chrome?.kind, 'chrome')
  assert.match(chrome?.executable ?? '', /Program Files.*Google.*Chrome.*chrome\.exe/u)
})

await test('App Mode uses spawn argv without a shell and browser absence does not crash', async () => {
  const calls: Array<{
    executable: string
    args: readonly string[]
    shell: boolean
    detached: boolean
  }> = []
  let unrefCalled = false
  const spawnBrowser: BrowserProcessSpawner = (executable, args, options) => {
    calls.push({ executable, args, shell: options.shell, detached: options.detached })
    return {
      once() { return undefined },
      unref() { unrefCalled = true },
    }
  }
  const env = { 'PROGRAMFILES(X86)': 'C:/Program Files (x86)' }
  const opened = await openLaunchpadInAppMode('http://127.0.0.1:43199', {
    env,
    pathExists: async () => true,
    spawnBrowser,
  })
  assert.deepEqual(opened, { opened: true, browser: 'edge' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args.slice(0, 2), [
    '--app=http://127.0.0.1:43199',
    '--new-window',
  ])
  assert.equal(calls[0]!.shell, false)
  assert.equal(calls[0]!.detached, true)
  assert.equal(unrefCalled, true)

  let spawnCalled = false
  const unavailable = await openLaunchpadInAppMode('http://127.0.0.1:43199', {
    env,
    pathExists: async () => false,
    spawnBrowser() {
      spawnCalled = true
      throw new Error('must not spawn')
    },
  })
  assert.deepEqual(unavailable, { opened: false })
  assert.equal(spawnCalled, false)
})

await test('Repository exposes the launchpad npm script and relocatable hidden VBS entry', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(
    packageJson.scripts['guardian:launchpad'],
    'npm run build && node scripts/guardian-launchpad.mjs',
  )
  const vbs = await readFile(join(process.cwd(), 'NovaWing.vbs'), 'utf8')
  assert.match(vbs, /WScript\.ScriptFullName/u)
  assert.match(vbs, /shell\.Run command, 0, False/u)
  assert.doesNotMatch(vbs, /D:\\VSCode\\nova-wing/iu)
})

function requestWithHost(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: { Host: hostHeader },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', rejectRequest)
    request.end()
  })
}
