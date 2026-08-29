import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createProductionGitRunner,
  createProductionWorkSessionUi,
  validateTrustedWorkSessionConfig,
  type ClaudeCodeExecutorOptions,
  type ExecutionReport,
  type GuardianTask,
  type GuardianProgressEvent,
  type ProductionGitProcessRunner,
  type TrustedWorkSessionConfig,
  type WorkSessionRuntimeConfig,
} from 'nova-wing/development-guardian'
import type { GuardianRecoverableExecutor } from '../packages/development-guardian/ports.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'

function rawConfig(storageUrl: string): unknown {
  return {
    session: {
      id: 'production-wiring-test',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    tasks: [
      {
        id: 'T1',
        goal: 'task one',
        guardian: {
          constraints: ['constraint-one'],
          acceptanceCriteria: ['accept-one'],
          doNotDo: ['do-not-one'],
          allowedPaths: ['src/one/**'],
          forbiddenPaths: ['secrets/**'],
        },
      },
      {
        id: 'T2',
        goal: 'task two',
        guardian: {
          constraints: ['constraint-two'],
          acceptanceCriteria: ['accept-two'],
          doNotDo: ['do-not-two'],
          allowedPaths: ['src/two/**'],
          forbiddenPaths: ['dist/**'],
        },
      },
    ],
    gitCheckpoint: {
      autoCommit: true,
      autoPush: false,
      pushRemote: { name: 'origin', expectedUrl: 'https://example.test/repo.git' },
    },
    executor: {
      model: 'sonnet',
      maxTurns: 10,
      allowNpmInstall: false,
      allowPythonBootstrap: false,
    },
    storageUrl,
  }
}

class NeverExecutingExecutor implements GuardianRecoverableExecutor {
  async execute(): Promise<ExecutionReport> {
    throw new Error('blocked Reviewer must not invoke Executor')
  }
}

await test('W005-B B3: trusted config maps to definition and per-task Guardian policy', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w005b-wiring-'))
  try {
    const storageUrl = pathToFileURL(join(temp, 'session.db')).href
    const config = await validateTrustedWorkSessionConfig(rawConfig(storageUrl))
    let runtimeConfig: WorkSessionRuntimeConfig | undefined
    let productionRuntime: FakeRuntime | undefined
    const reviewedTasks: GuardianTask[] = []
    const executorOptions: ClaudeCodeExecutorOptions[] = []
    const gitCalls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
    const durableProgress: GuardianProgressEvent[] = []
    const gitProcessRunner: ProductionGitProcessRunner = async (executable, args, cwd) => {
      gitCalls.push({ executable, args, cwd })
      const stdout = args[0] === 'branch'
        ? 'feat/work-session-mvp\n'
        : args[0] === 'rev-parse'
          ? '6b6c392893d7b3dce17538262d1fb658fa94e773\n'
          : ''
      return { exitCode: 0, stdout, stderr: '' }
    }
    const app = await createProductionWorkSessionUi(config, {
      serverPort: 0,
      env: {
        NOVAWING_CHATGPT_MODEL: 'gpt-test',
        NOVAWING_CHATGPT_REASONING: 'high',
        NOVAWING_ASK_BRIDGE_PATH: 'D:/Tools/ask-bridge-test.exe',
        NOVAWING_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
      },
      createBrain(options) {
        assert.equal(options.model, 'gpt-test')
        assert.equal(options.reasoning, 'high')
        assert.equal(options.command, 'D:/Tools/ask-bridge-test.exe')
        return {
          async review({ task }) {
            reviewedTasks.push(task)
            return {
              verdict: 'blocked',
              goal: task.goal,
              instructions: [],
              constraints: [],
              verification: [],
              doNotDo: [],
              rationale: 'test stop',
            }
          },
        }
      },
      createExecutor(options) {
        executorOptions.push(options)
        return new NeverExecutingExecutor()
      },
      createRuntime(input) {
        runtimeConfig = input
        productionRuntime = new FakeRuntime(input.definition)
        return productionRuntime
      },
      gitProcessRunner,
    })

    assert.deepEqual(app.definition, {
      id: 'production-wiring-test',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      tasks: [{ id: 'T1', goal: 'task one' }, { id: 'T2', goal: 'task two' }],
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    })
    assert.ok(runtimeConfig)
    assert.equal(runtimeConfig?.storageUrl, storageUrl)
    assert.equal(runtimeConfig?.gitCheckpoint?.policy.autoCommit, true)
    assert.equal(runtimeConfig?.gitCheckpoint?.policy.autoPush, false)
    assert.equal(productionRuntime?.loadPersistedStateCalls, 1)

    await runtimeConfig!.taskRunner.run(app.definition.tasks[0]!, undefined, undefined, {
      onProgress: (event) => durableProgress.push(event),
    })
    await runtimeConfig!.taskRunner.run(app.definition.tasks[1]!, undefined, undefined, {
      onProgress: (event) => durableProgress.push(event),
    })
    assert.deepEqual(reviewedTasks.map((task) => ({
      id: task.id,
      constraints: task.constraints,
      acceptanceCriteria: task.acceptanceCriteria,
      doNotDo: task.doNotDo,
      allowedPaths: task.allowedPaths,
      forbiddenPaths: task.forbiddenPaths,
    })), [
      {
        id: 'T1',
        constraints: ['constraint-one'],
        acceptanceCriteria: ['accept-one'],
        doNotDo: ['do-not-one'],
        allowedPaths: ['src/one/**'],
        forbiddenPaths: ['secrets/**'],
      },
      {
        id: 'T2',
        constraints: ['constraint-two'],
        acceptanceCriteria: ['accept-two'],
        doNotDo: ['do-not-two'],
        allowedPaths: ['src/two/**'],
        forbiddenPaths: ['dist/**'],
      },
    ])
    assert.equal(executorOptions.length, 2, 'each Task creates a new Executor instance')
    assert.ok(executorOptions.every((options) =>
      options.cwd === process.cwd() &&
      options.model === 'sonnet' &&
      options.maxTurns === 10 &&
      options.allowNpmInstall === false &&
      options.allowPythonBootstrap === false &&
      options.gitBashPath === 'C:/Program Files/Git/bin/bash.exe',
    ))
    executorOptions[0]?.onVerification?.({
      command: 'npm test', status: 'passed', iteration: 1, durationMs: 100,
    })
    executorOptions[1]?.onVerification?.({
      command: 'npm test', status: 'passed', iteration: 2, durationMs: 100,
    })
    executorOptions[1]?.onRecovery?.({
      reason: 'max_turns', sessionId: 'provider-session', bounded: true, iteration: 2,
    })
    const phaseEvents = app.controller.getRecentEvents().filter((event) =>
      event.type === 'GUARDIAN_PHASE' &&
      (event.data.phase === 'VERIFYING' || event.data.phase === 'RECOVERING'),
    )
    assert.deepEqual(phaseEvents.map((event) => [event.data.phase, event.data.iteration]), [
      ['VERIFYING', 1], ['VERIFYING', 2], ['RECOVERING', 2],
    ])
    assert.deepEqual(durableProgress.filter((event) =>
      event.phase === 'VERIFYING' || event.phase === 'RECOVERING',
    ).map((event) => [event.phase, event.iteration]), [
      ['VERIFYING', 1], ['VERIFYING', 2], ['RECOVERING', 2],
    ])
    assert.ok(gitCalls.every((call) => call.executable === 'git'))
    assert.ok(gitCalls.every((call) => call.cwd === process.cwd()))
    assert.ok(gitCalls.every((call) => call.args[0] !== '-lc'))

    const address = await app.start()
    assert.equal(address.host, '127.0.0.1')
    await app.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W005-B B3: credential-like config keys and invalid trust facts fail fast', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w005b-config-'))
  try {
    const storageUrl = pathToFileURL(join(temp, 'session.db')).href
    const credentialConfig = rawConfig(storageUrl) as Record<string, unknown>
    credentialConfig.apiKey = 'SECRET'
    await assert.rejects(
      validateTrustedWorkSessionConfig(credentialConfig),
      /credential-like config key is forbidden/,
    )

    const duplicate = rawConfig(storageUrl) as TrustedWorkSessionConfig
    duplicate.tasks[1]!.id = 'T1'
    await assert.rejects(validateTrustedWorkSessionConfig(duplicate), /duplicate task id/)

    const missingAllowed = rawConfig(storageUrl) as TrustedWorkSessionConfig
    missingAllowed.tasks[0]!.guardian.allowedPaths = []
    await assert.rejects(validateTrustedWorkSessionConfig(missingAllowed))

    const badPush = rawConfig(storageUrl) as TrustedWorkSessionConfig
    badPush.gitCheckpoint.autoPush = true
    delete badPush.gitCheckpoint.pushRemote
    await assert.rejects(validateTrustedWorkSessionConfig(badPush), /pushRemote/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W005-B B3: production git runner uses fixed git argv and rejects unknown command', async () => {
  const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
  const runner = createProductionGitRunner(process.cwd(), async (executable, args, cwd) => {
    calls.push({ executable, args, cwd })
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  await runner('git branch --show-current')
  await runner('git rev-parse HEAD')
  await runner('git status --porcelain --untracked-files=all')
  assert.deepEqual(calls.map((call) => call.args), [
    ['branch', '--show-current'],
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=all'],
  ])
  assert.ok(calls.every((call) => call.executable === 'git'))
  await assert.rejects(runner('git status; bash -lc evil'), /unsupported production git command/)
})

await test('W005-B B3: browser start body cannot override trusted repo, branch, or tasks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'w005b-browser-scope-'))
  try {
    const config = await validateTrustedWorkSessionConfig(
      rawConfig(pathToFileURL(join(temp, 'session.db')).href),
    )
    const app = await createProductionWorkSessionUi(config, {
      serverPort: 0,
      createBrain: () => ({
        async review() { throw new Error('provider must not be called') },
      }),
      createExecutor: () => new NeverExecutingExecutor(),
      createRuntime: (input) => new FakeRuntime(input.definition),
    })
    const address = await app.start()
    const token = app.server.getTokenForTest()
    const response = await fetch(`${address.url}/api/session/start`, {
      method: 'POST',
      headers: {
        'X-NovaWing-Control-Token': token,
        Origin: address.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetRepo: 'D:/evil',
        branch: 'main',
        tasks: [{ id: 'EVIL', goal: 'override' }],
      }),
    })
    assert.equal(response.status, 202)
    assert.equal(app.definition.targetRepo, process.cwd())
    assert.equal(app.definition.branch, 'feat/work-session-mvp')
    assert.deepEqual(app.definition.tasks.map((task) => task.id), ['T1', 'T2'])
    await app.close()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('W005-B B3: production UI npm script exists and does not expose a token argument', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const command = packageJson.scripts['guardian:work-session:ui']
  if (command === undefined) throw new Error('guardian:work-session:ui script is missing')
  assert.match(command, /guardian-work-session-ui\.mjs/)
  assert.doesNotMatch(command, /token|credential|password|secret/i)
})
