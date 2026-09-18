import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_GIT_BASH_EXECUTABLE,
  DependencyPreflightError,
  SHELL_ENVIRONMENT_INVALID,
  requireDependencyPreflightReady,
  runProductionDependencyPreflight,
  type DependencyCommandRequest,
  type DependencyCommandResult,
} from 'nova-wing/development-guardian'

const fixedNow = () => new Date('2026-08-28T00:00:00.000Z')

function healthyRunner(requests: DependencyCommandRequest[]) {
  return async (request: DependencyCommandRequest): Promise<DependencyCommandResult> => {
    requests.push(request)
    if (request.args.at(-1)?.includes('BASH_VERSION')) {
      return { exitCode: 0, stdout: '5.2.37|MINGW64|msys', stderr: '' }
    }
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }
}

test('preflight reports Brain READY from static availability without a live model call', async () => {
  const requests: DependencyCommandRequest[] = []
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: healthyRunner(requests),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'READY')
  assert.equal(report.canStart, true)
  assert.equal(report.dependencies.find((item) => item.id === 'SHELL')?.state, 'READY')
  assert.equal(report.dependencies.find((item) => item.id === 'BRIDGE')?.state, 'READY')
  const brain = report.dependencies.find((item) => item.id === 'BRAIN')
  assert.equal(brain?.state, 'READY')
  assert.match(brain?.safeMessage ?? '', /no model request/u)
  assert.ok(requests.length >= 5)
  assert.ok(requests.filter((request) => request.executable.toLowerCase().endsWith('bash.exe'))
    .every((request) => request.executable === EXPECTED_GIT_BASH_EXECUTABLE))
})

test('preflight reports an idle default Executor as READY after Codex SDK preflight', async () => {
  let inspected = 0
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: healthyRunner([]),
    accessFile: async () => undefined,
    executorModes: [],
    inspectCodex: async () => { inspected += 1 },
    now: fixedNow,
  })

  assert.equal(report.overall, 'READY')
  assert.equal(report.canStart, true)
  assert.equal(report.dependencies.find((item) => item.id === 'CORE')?.state, 'READY')
  assert.equal(report.dependencies.find((item) => item.id === 'BRAIN')?.state, 'READY')
  assert.equal(report.dependencies.find((item) => item.id === 'EXECUTOR')?.state, 'READY')
  assert.equal(inspected, 1)
})

test('preflight uses the exact configured AskBridge executable without a real model health call', async () => {
  const requests: DependencyCommandRequest[] = []
  const askBridge = 'D:\\Tools\\ask-bridge-test.exe'
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: {
      NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE,
      NOVAWING_ASK_BRIDGE_PATH: askBridge,
    },
    commandRunner: healthyRunner(requests),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.canStart, true)
  const bridgeRequests = requests.filter((request) => request.executable === askBridge)
  assert.deepEqual(bridgeRequests.map((request) => request.args), [['--version'], ['config']])
  assert.equal(bridgeRequests.some((request) => request.args.includes('--provider')), false)
})

test('shell preflight: System32 bash fails closed before any dependency command', async () => {
  const requests: DependencyCommandRequest[] = []
  const actual = 'C:\\Windows\\System32\\bash.exe'
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: actual },
    commandRunner: healthyRunner(requests),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
  assert.equal(report.canStart, false)
  const shell = report.dependencies.find((item) => item.id === 'SHELL')
  assert.equal(shell?.failureType, SHELL_ENVIRONMENT_INVALID)
  assert.equal(shell?.actualExecutable, '')
  assert.match(shell?.safeRemediation ?? '', /Resume/u)
  assert.equal(requests.length, 0)
})

test('shell preflight: WSL relay fingerprint is ENVIRONMENT_REQUIRED', async () => {
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'WSL Relay ERROR: execvpe(/bin/bash) failed',
    }),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
  assert.equal(report.dependencies.find((item) => item.id === 'SHELL')?.failureType, SHELL_ENVIRONMENT_INVALID)
})

test('shell preflight: missing expected executable is ENVIRONMENT_REQUIRED without executing it', async () => {
  let executions = 0
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: async () => { executions += 1; return { exitCode: 0, stdout: '', stderr: '' } },
    accessFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    now: fixedNow,
  })

  assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
  assert.equal(report.canStart, false)
  assert.equal(executions, 0)
})

test('dependency preflight is bounded and reports degradation rather than throwing', async () => {
  const requests: DependencyCommandRequest[] = []
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: async (request) => {
      requests.push(request)
      if (request.args.at(-1)?.includes('BASH_VERSION')) {
        return { exitCode: 0, stdout: '5.2.37|MINGW64|msys', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: '', timedOut: true }
    },
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'DEGRADED')
  assert.equal(report.canStart, false)
  assert.equal(requests.length, 5, 'one shell fingerprint plus bounded Bridge/config/Executor/Git probes')
})

test('Codex/Auto preflight checks ChatGPT authentication without requiring the DeepSeek CLI', async () => {
  const requests: DependencyCommandRequest[] = []
  let inspected = 0
  const options = { platform: 'win32' as const, env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE }, accessFile: async () => undefined, commandRunner: healthyRunner(requests),
    executorModes: ['auto', 'codex'] as const, inspectCodex: async () => { inspected++ } }
  const ready = await runProductionDependencyPreflight(options)
  assert.equal(ready.canStart, true)
  assert.equal(inspected, 1)
  assert.equal(requests.some((r) => r.args.join(' ').includes('claude')), false)
  const blocked = await runProductionDependencyPreflight({ ...options, inspectCodex: async () => { throw { code: 'auth_required' } } })
  assert.equal(blocked.canStart, false)
  assert.equal(blocked.dependencies.find((d) => d.id === 'EXECUTOR')?.failureType, 'auth_required')
})

test('preflight errors name a concrete unavailable dependency, never only its derived Core state', () => {
  const report = {
    overall: 'DEGRADED' as const,
    canStart: false,
    checkedAt: fixedNow().toISOString(),
    dependencies: [
      { id: 'CORE' as const, state: 'DEGRADED' as const },
      { id: 'BRAIN' as const, state: 'UNKNOWN' as const },
      { id: 'EXECUTOR' as const, state: 'UNAVAILABLE' as const, safeMessage: 'Codex authentication is required.' },
    ],
  }
  assert.throws(() => requireDependencyPreflightReady(report), (error: unknown) =>
    error instanceof DependencyPreflightError && error.message === 'Codex authentication is required.')
})

test('Codex SDK preflight still blocks a real Git failure without probing a system codex command', async () => {
  const requests: DependencyCommandRequest[] = []
  const report = await runProductionDependencyPreflight({
    platform: 'win32',
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE, PATH: 'C:\\system-without-codex' },
    targetRepo: 'D:\\VSCode\\fixture',
    accessFile: async () => undefined,
    executorModes: ['codex'],
    inspectCodex: async () => undefined,
    commandRunner: async (request) => {
      requests.push(request)
      if (request.args.at(-1)?.includes('BASH_VERSION')) return { exitCode: 0, stdout: '5.2.37|MINGW64|msys', stderr: '' }
      if (request.args.at(-1)?.includes('git rev-parse')) return { exitCode: 1, stdout: '', stderr: 'git unavailable' }
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  })
  assert.equal(report.canStart, false)
  assert.equal(report.dependencies.find((item) => item.id === 'GIT')?.failureType, 'GIT_UNAVAILABLE')
  assert.equal(requests.some((request) => request.args.join(' ').includes('command -v codex')), false)
})

for (const controlPlane of ['v2', 'v1', undefined] as const) {
  test(`preflight with unavailable AskBridge preserves control-plane requirements: ${controlPlane ?? 'historical'}`, async () => {
    const requests: DependencyCommandRequest[] = []
    const report = await runProductionDependencyPreflight({
    platform: 'win32',
      ...(controlPlane === undefined ? {} : { controlPlane }),
      executorModes: ['codex'], inspectCodex: async () => undefined,
      env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE, NOVAWING_ASK_BRIDGE_PATH: 'missing-ask-bridge.exe' },
      accessFile: async () => undefined,
      commandRunner: async (request) => request.executable === 'missing-ask-bridge.exe'
        ? { exitCode: 1, stdout: '', stderr: 'unavailable' }
        : healthyRunner(requests)(request),
    })
    assert.equal(report.canStart, controlPlane === 'v2')
    assert.equal(report.dependencies.find((item) => item.id === 'BRAIN')?.state, controlPlane === 'v2' ? 'UNKNOWN' : 'UNAVAILABLE')
    assert.equal(report.dependencies.find((item) => item.id === 'EXECUTOR')?.state, 'READY')
  })
}
