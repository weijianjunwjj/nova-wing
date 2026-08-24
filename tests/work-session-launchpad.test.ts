import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
}

function fakeWorkSessionFactory(
  state: FakeWorkSessionState,
  options: { controllerStarted?: boolean; failWith?: Error } = {},
) {
  return async (config: TrustedWorkSessionConfig, input: { serverPort: 0 }) => {
    state.createCalls += 1
    state.receivedServerPorts.push(input.serverPort)
    state.receivedConfigIds.push(config.session.id)
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
    assert.doesNotMatch(html, /expectedUrl|SMTP_|credential/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
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
