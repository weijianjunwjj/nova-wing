import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_GIT_BASH_EXECUTABLE,
  SHELL_ENVIRONMENT_INVALID,
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

test('shell preflight: exact native Git Bash is READY and every command uses the explicit executable', async () => {
  const requests: DependencyCommandRequest[] = []
  const report = await runProductionDependencyPreflight({
    env: { NOVAWING_GIT_BASH_PATH: EXPECTED_GIT_BASH_EXECUTABLE },
    commandRunner: healthyRunner(requests),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'READY')
  assert.equal(report.canStart, true)
  assert.equal(report.dependencies.find((item) => item.id === 'SHELL')?.state, 'READY')
  assert.ok(requests.length >= 5)
  assert.ok(requests.filter((request) => request.executable.toLowerCase().endsWith('bash.exe'))
    .every((request) => request.executable === EXPECTED_GIT_BASH_EXECUTABLE))
})

test('shell preflight: System32 bash fails closed before any dependency command', async () => {
  const requests: DependencyCommandRequest[] = []
  const actual = 'C:\\Windows\\System32\\bash.exe'
  const report = await runProductionDependencyPreflight({
    env: { NOVAWING_GIT_BASH_PATH: actual },
    commandRunner: healthyRunner(requests),
    accessFile: async () => undefined,
    now: fixedNow,
  })

  assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
  assert.equal(report.canStart, false)
  const shell = report.dependencies.find((item) => item.id === 'SHELL')
  assert.equal(shell?.failureType, SHELL_ENVIRONMENT_INVALID)
  assert.equal(shell?.expectedExecutable, EXPECTED_GIT_BASH_EXECUTABLE)
  assert.equal(shell?.actualExecutable, actual)
  assert.match(shell?.safeRemediation ?? '', /Resume/u)
  assert.equal(requests.length, 0)
})

test('shell preflight: WSL relay fingerprint is ENVIRONMENT_REQUIRED', async () => {
  const report = await runProductionDependencyPreflight({
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
