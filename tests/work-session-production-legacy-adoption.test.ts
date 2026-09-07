/**
 * Production Legacy Adoption Entry Point
 *
 * The production gate recognizes only the original pre-existing dirty subtype,
 * derives all facts from trusted config, and delegates resumption to W003.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  adoptProductionLegacyWorkSession,
  LEGACY_PRE_EXISTING_DIRTY_REASON,
  type GuardianTaskRecoveryCheckpoint,
  type LegacyRecoveryGitRunner,
  type ProductionLegacyAdoptionRuntime,
  type TrustedWorkSessionConfig,
  type WorkSessionDurableState,
  type WorkSessionState,
} from 'nova-wing/development-guardian'
import { startServer } from './work-session-w005-a-helpers.js'

function trustedConfig(): TrustedWorkSessionConfig {
  return {
    session: {
      id: 'fly-weave-canary-001',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
    },
    tasks: [
      {
        id: 'T001',
        goal: 'earlier task',
        guardian: {
          constraints: ['T001 constraint'],
          acceptanceCriteria: ['T001 accepted'],
          doNotDo: ['T001 forbidden action'],
          allowedPaths: ['src/t001/**'],
          forbiddenPaths: ['dist/**'],
        },
      },
      {
        id: 'T002',
        goal: 'continue the trusted T002 implementation',
        guardian: {
          constraints: ['preserve public behavior'],
          acceptanceCriteria: ['npm run check passes'],
          doNotDo: ['do not reset the worktree'],
          allowedPaths: ['src/t002/**'],
          forbiddenPaths: ['secrets/**'],
        },
      },
    ],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: {
      model: 'sonnet',
      maxTurns: 10,
      allowNpmInstall: false,
      allowPythonBootstrap: false,
    },
  }
}

function persistedState(
  overrides: Partial<WorkSessionDurableState> = {},
): WorkSessionDurableState {
  return {
    sessionId: 'fly-weave-canary-001',
    state: 'SUSPENDED',
    currentTaskIndex: 1,
    currentTaskId: 'T002',
    completedTaskIds: ['T001'],
    humanRequired: {
      category: 'REPO_DRIFT',
      reason: LEGACY_PRE_EXISTING_DIRTY_REASON,
    },
    createdAt: new Date('2026-08-22T00:00:00.000Z'),
    updatedAt: new Date('2026-08-22T00:01:00.000Z'),
    ...overrides,
  }
}

function readOnlyGitRunner(
  branch = 'feat/work-session-mvp',
  calls: string[] = [],
): LegacyRecoveryGitRunner {
  return async (command) => {
    calls.push(command)
    const stdout = command === 'git branch --show-current'
      ? `${branch}\n`
      : command === 'git rev-parse HEAD'
        ? '1467cdc39eb32ebd6d42884b85dcf8ad58c6898e\n'
        : ''
    return { exitCode: 0, stdout, stderr: '' }
  }
}

class AdoptionRuntime implements ProductionLegacyAdoptionRuntime {
  loadCalls = 0
  resumeCalls = 0
  resumeOptions: Array<{
    sessionId: string
    checkpoint: GuardianTaskRecoveryCheckpoint
  }> = []

  constructor(
    readonly persisted: WorkSessionDurableState | undefined,
    readonly resumed = persistedState({ state: 'COMPLETED', currentTaskId: null }),
  ) {}

  async loadPersistedState(): Promise<WorkSessionDurableState | undefined> {
    this.loadCalls += 1
    return this.persisted
  }

  async resumeFromRecoveryCheckpoint(options: {
    sessionId: string
    checkpoint: GuardianTaskRecoveryCheckpoint
  }): Promise<WorkSessionDurableState> {
    this.resumeCalls += 1
    this.resumeOptions.push(options)
    return this.resumed
  }
}

await test('ADOPT-CLI-A: exact legacy dirty suspension adopts trusted T002 facts and resumes once', async () => {
  const runtime = new AdoptionRuntime(persistedState())
  const result = await adoptProductionLegacyWorkSession(trustedConfig(), runtime, {
    gitRunner: readOnlyGitRunner(),
  })

  assert.equal(runtime.loadCalls, 1)
  assert.equal(runtime.resumeCalls, 1)
  assert.equal(result.finalState.state, 'COMPLETED')
  assert.deepEqual(runtime.resumeOptions.map((entry) => entry.sessionId), [
    'fly-weave-canary-001',
  ])
  const checkpoint = runtime.resumeOptions[0]!.checkpoint
  assert.deepEqual(checkpoint.provider, {}, 'provider sessions are optional for legacy recovery')
  assert.deepEqual({
    id: checkpoint.task.id,
    goal: checkpoint.task.goal,
    constraints: checkpoint.task.constraints,
    acceptanceCriteria: checkpoint.task.acceptanceCriteria,
    doNotDo: checkpoint.task.doNotDo,
    allowedPaths: checkpoint.task.allowedPaths,
    forbiddenPaths: checkpoint.task.forbiddenPaths,
    repoPath: checkpoint.repo.repoPath,
  }, {
    id: 'T002',
    goal: 'continue the trusted T002 implementation',
    constraints: ['preserve public behavior'],
    acceptanceCriteria: ['npm run check passes'],
    doNotDo: ['do not reset the worktree'],
    allowedPaths: ['src/t002/**'],
    forbiddenPaths: ['secrets/**'],
    repoPath: process.cwd(),
  })
})

await test('ADOPT-CLI-B: actual checkpoint drift is rejected before adoption or providers', async () => {
  const runtime = new AdoptionRuntime(persistedState({
    humanRequired: {
      category: 'REPO_DRIFT',
      reason: 'REPO_DRIFT: worktree files changed since checkpoint',
    },
  }))
  const gitCalls: string[] = []
  await assert.rejects(
    adoptProductionLegacyWorkSession(trustedConfig(), runtime, {
      gitRunner: readOnlyGitRunner('feat/work-session-mvp', gitCalls),
    }),
    /not the legacy pre-existing dirty case/,
  )
  assert.equal(gitCalls.length, 0)
  assert.equal(runtime.resumeCalls, 0, 'W003 resume/provider path must not start')
})

await test('ADOPT-CLI-C: non-SUSPENDED states are rejected', async (t) => {
  const states: WorkSessionState[] = ['READY', 'RUNNING', 'FAILED', 'COMPLETED', 'CANCELLED']
  for (const state of states) {
    await t.test(state, async () => {
      const runtime = new AdoptionRuntime(persistedState({ state }))
      const gitCalls: string[] = []
      await assert.rejects(
        adoptProductionLegacyWorkSession(trustedConfig(), runtime, {
          gitRunner: readOnlyGitRunner('feat/work-session-mvp', gitCalls),
        }),
        new RegExp(`session state is ${state}`),
      )
      assert.equal(gitCalls.length, 0)
      assert.equal(runtime.resumeCalls, 0)
    })
  }
})

await test('ADOPT-CLI-D: persisted currentTaskId absent from trusted config is rejected', async () => {
  const runtime = new AdoptionRuntime(persistedState({ currentTaskId: 'T999' }))
  await assert.rejects(
    adoptProductionLegacyWorkSession(trustedConfig(), runtime),
    /current Task T999 is absent from trusted config/,
  )
  assert.equal(runtime.resumeCalls, 0)
})

await test('ADOPT-CLI-E: browser and CLI expose no adoption overrides', async () => {
  const scriptPath = join(process.cwd(), 'scripts', 'guardian-work-session-adopt.mjs')
  const script = await readFile(scriptPath, 'utf8')
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }
  assert.equal(
    packageJson.scripts['guardian:work-session:adopt'],
    'npm run build && node scripts/guardian-work-session-adopt.mjs',
  )
  assert.doesNotMatch(script, /--(?:repo|task|goal|allowed-path|branch|checkpoint)\b/u)
  assert.doesNotMatch(script, /\.start\s*\(/u, 'adoption CLI must not start the HTTP server')

  const productionSource = await readFile(
    join(
      process.cwd(),
      'packages',
      'development-guardian',
      'work-session',
      'production-legacy-adoption.ts',
    ),
    'utf8',
  )
  assert.doesNotMatch(productionSource, /loadWorkflowSnapshot|persistWorkflowSnapshot/u)

  const invalidCli = spawnSync(process.execPath, [scriptPath, '--repo', 'D:/evil'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(invalidCli.status, 1)
  assert.match(invalidCli.stderr, /--config <path>/)

  const server = await startServer()
  try {
    const response = await fetch(`${server.address.url}/api/session/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: 'D:/evil',
        taskId: 'EVIL',
        goal: 'override',
        allowedPaths: ['**'],
      }),
    })
    assert.equal(response.status, 404)
    assert.equal(server.runtime.startCalls, 0)
    assert.equal(server.runtime.resumeCalls, 0)
  } finally {
    await server.server.close()
  }
})

await test('ADOPT-CLI-F: adoption Git inspection is read-only before resume', async () => {
  const runtime = new AdoptionRuntime(persistedState())
  const commands: string[] = []
  await adoptProductionLegacyWorkSession(trustedConfig(), runtime, {
    gitRunner: readOnlyGitRunner('feat/work-session-mvp', commands),
  })
  assert.deepEqual(commands, [
    'git branch --show-current',
    'git rev-parse HEAD',
    'git status --porcelain --untracked-files=all',
  ])
  assert.ok(commands.every((command) =>
    !/\b(?:reset|clean|checkout|stash|commit|add)\b/u.test(command),
  ))
  assert.equal(runtime.resumeCalls, 1)
})

await test('ADOPT-CLI-G: adopted checkpoint branch mismatch rejects before W003 resume', async () => {
  const runtime = new AdoptionRuntime(persistedState())
  await assert.rejects(
    adoptProductionLegacyWorkSession(trustedConfig(), runtime, {
      gitRunner: readOnlyGitRunner('main'),
    }),
    /checkpoint branch mismatch/,
  )
  assert.equal(runtime.resumeCalls, 0)
})
