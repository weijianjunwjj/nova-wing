import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { ClaudeCodeExecutor } from '../packages/development-guardian/claude-code-executor.js'
import type { DelegationPacket } from '../packages/development-guardian/model.js'
import {
  createProductionWorkSessionUi,
  GoldenPathTaskRunner,
  TaskEventLogV2,
  loadTaskStateV2,
  validateTrustedWorkSessionConfig,
  V2ControllerTaskRunner,
  type TaskAction,
  type TaskStateV2,
  type TrustedWorkSessionConfig,
  type WorkSessionRuntimeConfig,
} from 'nova-wing/development-guardian'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import type { AutonomousDiagnosisEvidence } from '../packages/development-guardian/work-session/autonomous-diagnosis.js'

const AGENT = {
  id: 'production-golden-executor',
  identity: { agent: 'production-golden-executor', provider: 'codex', runtimeIdentity: 'production-golden-runtime' },
  available: true,
  quotaExhausted: false,
  degraded: false,
  capabilities: { coding: true, reasoning: true, verification: true, review: true },
} as const

async function fixtureRepo(): Promise<{ repo: string; outside: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'novawing-v030-production-repo-'))
  const outside = await mkdtemp(join(tmpdir(), 'novawing-v030-production-state-'))
  await mkdir(join(repo, 'apps', 'web', 'src'), { recursive: true })
  await mkdir(join(repo, 'apps', 'web', 'tests'), { recursive: true })
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true }, null, 2))
  await writeFile(join(repo, 'apps', 'web', 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: { 'test:filter-empty': 'node --test tests/filter.test.js', typecheck: 'node -e "process.exit(0)"' },
  }, null, 2))
  await writeFile(join(repo, 'apps', 'web', 'src', 'filter.js'), 'export const clearFilters = () => "initial"\n')
  await writeFile(join(repo, 'apps', 'web', 'tests', 'filter.test.js'), [
    'import test from "node:test"',
    'import assert from "node:assert/strict"',
    'import { clearFilters } from "..' + '/src/filter.js"',
    'test("filter empty state", () => assert.equal(clearFilters(), "cleared"))',
    '',
  ].join('\n'))
  execFileSync('git', ['init', '-q', '-b', 'feat/golden-production'], { cwd: repo, windowsHide: true })
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repo, windowsHide: true })
  return { repo, outside }
}

function rawConfig(repo: string, outside: string, options: { golden?: boolean; risk?: 'LOW' | 'HIGH' } = {}): unknown {
  return {
    session: {
      id: `v030-production-${options.risk ?? 'LOW'}-${options.golden === undefined ? 'legacy' : 'launchpad'}`,
      targetRepo: repo,
      branch: 'feat/golden-production',
      controlPlane: 'v2',
      directPath: { enabled: true },
      ...(options.golden === undefined ? {} : { goldenPath: { enabled: options.golden } }),
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 },
    },
    tasks: [{
      id: 'FILTER-EMPTY',
      goal: 'Improve the filtered empty result and clear filters behavior',
      risk: options.risk ?? 'LOW',
      guardian: {
        constraints: ['do not change backend or database', 'do not add dependencies'],
        acceptanceCriteria: ['filtered empty results expose clear filters and reset keyword and status'],
        doNotDo: ['do not change backend'],
        allowedPaths: ['apps/web'],
        forbiddenPaths: ['server/**', 'database/**'],
      },
    }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 4, allowNpmInstall: false, allowPythonBootstrap: false, defaultMode: 'codex' },
    codex: { enabled: true, model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    notification: { email: { enabled: false } },
    storageUrl: pathToFileURL(join(outside, 'session.db')).href,
  }
}

type DispatchResult = {
  status: 'SUCCESS' | 'BLOCKED' | 'FAILED'
  changedFiles?: string[]
  verificationResults?: Array<{ name: string; status: 'passed' | 'failed'; classification?: 'CODE_FAILURE' }>
  providerHistory?: string[]
  blockers?: string[]
}

async function createProductionCase(input: {
  repo: string
  outside: string
  golden?: boolean
  risk?: 'LOW' | 'HIGH'
  dispatch(action: TaskAction, task: TaskStateV2): Promise<DispatchResult>
}): Promise<{ app: Awaited<ReturnType<typeof createProductionWorkSessionUi>>; config: TrustedWorkSessionConfig; runtime: WorkSessionRuntimeConfig }> {
  const config = await validateTrustedWorkSessionConfig(rawConfig(input.repo, input.outside, {
    ...(input.golden === undefined ? {} : { golden: input.golden }),
    ...(input.risk === undefined ? {} : { risk: input.risk }),
  }))
  let runtime: WorkSessionRuntimeConfig | undefined
  const app = await createProductionWorkSessionUi(config, {
    serverPort: 0,
    env: { NOVAWING_DATA_DIR: input.outside },
    v2Agents: [AGENT],
    createRuntime(value) { runtime = value; return new FakeRuntime(value.definition) },
    createV2Dispatcher: ({ defaultDispatcher }) => ({
      inspectRepository: defaultDispatcher.inspectRepository,
      dispatch: ({ action, task }) => input.dispatch(action, task),
    }),
  })
  assert.ok(runtime)
  return { app, config, runtime }
}

async function createGoldenBoundaryCase(input: {
  repo: string
  outside: string
  failFirstVerification: boolean
}): Promise<{
  app: Awaited<ReturnType<typeof createProductionWorkSessionUi>>
  runtime: WorkSessionRuntimeConfig
  counts: { execute: number; verify: number }
  executePackets: DelegationPacket[]
  verifierCommands: string[]
}> {
  const config = await validateTrustedWorkSessionConfig(rawConfig(input.repo, input.outside, { golden: true }))
  const counts = { execute: 0, verify: 0 }
  const executePackets: DelegationPacket[] = []
  const verifierCommands: string[] = []
  let runtime: WorkSessionRuntimeConfig | undefined
  const app = await createProductionWorkSessionUi(config, {
    serverPort: 0,
    env: { NOVAWING_DATA_DIR: input.outside },
    v2Agents: [AGENT],
    createRuntime(value) { runtime = value; return new FakeRuntime(value.definition) },
    createCodexExecutor(options) {
      return new ClaudeCodeExecutor({ ...options,
        codingRuntime: { label: 'Scripted implementation model', async run({ packet }) {
          counts.execute++
          executePackets.push(structuredClone(packet))
          const implementation = input.failFirstVerification && counts.execute === 1 ? 'broken' : 'cleared'
          await writeFile(join(input.repo, 'apps', 'web', 'src', 'filter.js'), `export const clearFilters = () => "${implementation}"\n`)
          return { summary: 'implementation edited; NovaWing verification follows', commandsRun: ['git_status', 'read_file', 'write_file'], blockers: [] }
        } },
        onVerification(event) {
          if (event.status !== 'running') return
          verifierCommands.push(event.command)
          if (event.command.startsWith('node --test ')) counts.verify++
        },
      })
    },
  })
  assert.ok(runtime)
  return { app, runtime, counts, executePackets, verifierCommands }
}

function assertGoldenImplementationPacket(packet: DelegationPacket): void {
  assert.deepEqual(packet.verification, [], 'Golden EXECUTE must not expose executable verifier commands')
  assert.equal(packet.deferVerification, true, 'Golden EXECUTE must defer baseline and planned verification')
  assert.ok(packet.instructions.some((instruction) => /Do not execute verification commands/u.test(instruction)))
  assert.ok(packet.instructions.some((instruction) => /NovaWing runs deterministic verification separately/u.test(instruction)))
  assert.equal(packet.instructions.some((instruction) => instruction.includes('npm run test:filter-empty')), false)
}

await test('v0.3.1 production Golden exhausted uses diagnosis then implementation-only Advanced and exact verifier contract', async () => {
  const fixture = await fixtureRepo()
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const config = await validateTrustedWorkSessionConfig(rawConfig(fixture.repo, fixture.outside, { golden: true }))
    let runtime: WorkSessionRuntimeConfig | undefined
    const packets: DelegationPacket[] = []
    const evidence: AutonomousDiagnosisEvidence[] = []
    const commands: string[] = []
    app = await createProductionWorkSessionUi(config, {
      serverPort: 0, env: { NOVAWING_DATA_DIR: fixture.outside }, v2Agents: [AGENT],
      createRuntime(value) { runtime = value; return new FakeRuntime(value.definition) },
      autonomousRecovery: {
        inspectDiff: async () => execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: fixture.repo, encoding: 'utf8', windowsHide: true }),
        readVerificationOutput: async (result) => result.rawOutputRef === undefined ? undefined : readFile(result.rawOutputRef, 'utf8'),
        diagnose: async (input) => {
          evidence.push(input)
          return { recoverable: true, diagnosis: 'The return value is still broken.', strategy: 'FIX_IMPLEMENTATION', instructions: 'Return the cleared filter state; preserve tests.',
            requiresHuman: false, humanReason: null, requiredAuthority: [], paths: ['apps/web/src/filter.js'], commands: [] }
        },
      },
      createCodexExecutor(options) {
        return new ClaudeCodeExecutor({ ...options, codingRuntime: { label: 'Scripted autonomous fixture', async run({ packet }) {
          packets.push(structuredClone(packet))
          if (packets.length !== 2) await writeFile(join(fixture.repo, 'apps/web/src/filter.js'), `export const clearFilters = () => "${packets.length === 1 ? 'broken' : 'cleared'}"\n`)
          return { summary: `Executor attempt ${packets.length}`, commandsRun: ['git_status', 'read_file', ...(packets.length === 2 ? [] : ['write_file'])], blockers: [] }
        } }, onVerification(event) { if (event.status === 'running') commands.push(event.command) } })
      },
    })
    assert.ok(runtime)
    const events = new TaskEventLogV2()
    const result = await runtime.taskRunner.run(runtime.definition.tasks[0]!, undefined, undefined, { taskEventLog: events, recoveryInstructions: ['Only change the src implementation.'] })
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired ?? result))
    assert.equal(packets.length, 3)
    packets.forEach(assertGoldenImplementationPacket)
    assert.ok(packets[2]!.instructions.includes('Return the cleared filter state; preserve tests.'))
    assert.ok(packets[2]!.instructions.includes('Only change the src implementation.'))
    assert.equal(evidence.length, 1)
    assert.deepEqual(evidence[0]!.task.autonomousRecovery?.executorHistory.map((item) => item.summary), ['Executor attempt 1', 'Executor attempt 2'])
    assert.ok(evidence[0]!.verifierOutputs.some((item) => /broken|cleared/u.test(item.output)))
    assert.equal(commands.filter((command) => command === 'node --test tests/filter.test.js').length, 2)
    assert.equal(result.taskStateV2?.autonomousRecovery?.goldenExecuteCount, 2)
    assert.equal(result.taskStateV2?.autonomousRecovery?.goldenVerifyCount, 1)
    assert.equal(result.taskStateV2?.actionBudget?.recoveryConsumed, 3)
    assert.equal(events.count('ADVANCED_RECOVERY'), 1)
    const targeted = result.completionEvidence?.verificationResults.find((item) => item.stepId === 'targeted-test')
    assert.equal(targeted?.cwd, 'apps/web')
    assert.equal(targeted?.status, 'passed')
  } finally { await app?.close(); await rm(fixture.repo, { recursive: true, force: true }); await rm(fixture.outside, { recursive: true, force: true }) }
})

await test('v0.3.0 production A: Launchpad-style LOW config selects Golden with zero Controller decisions', async () => {
  const fixture = await fixtureRepo()
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const created = await createGoldenBoundaryCase({ ...fixture, failFirstVerification: false })
    app = created.app
    const events = new TaskEventLogV2()
    assert.ok(created.runtime.taskRunner instanceof GoldenPathTaskRunner)
    const result = await created.runtime.taskRunner.run(created.runtime.definition.tasks[0]!, undefined, undefined, { taskEventLog: events })
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired ?? result.completionEvidence ?? result))
    assert.deepEqual(created.counts, { execute: 1, verify: 1 })
    assert.equal(created.executePackets.length, 1)
    assertGoldenImplementationPacket(created.executePackets[0]!)
    assert.ok(created.verifierCommands.includes('node --test tests/filter.test.js'), 'VERIFY executes the safely normalized task-local verifier')
    const targeted = result.completionEvidence?.verificationResults.find((item) => item.stepId === 'targeted-test')
    assert.deepEqual({ command: targeted?.command, cwd: targeted?.cwd, status: targeted?.status },
      { command: 'node --test tests/filter.test.js', cwd: 'apps/web', status: 'passed' })
    assert.equal(result.completionEvidence?.verificationResults.some((item) => item.command?.includes('apps/web/apps/web')), false)
    assert.equal(events.count('CONTROLLER_DECIDED'), 0)
    assert.equal(events.count('TASK_SUSPENDED'), 0)
  } finally {
    await app?.close()
    await rm(fixture.repo, { recursive: true, force: true })
    await rm(fixture.outside, { recursive: true, force: true })
  }
})

await test('v0.3.0 production B: legacy config without goldenPath remains on the existing runner', async () => {
  const fixture = await fixtureRepo()
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const created = await createProductionCase({ ...fixture, async dispatch() { return { status: 'FAILED' } } })
    app = created.app
    assert.equal(created.config.session.goldenPath, undefined)
    assert.equal(created.runtime.definition.goldenPath, undefined)
    assert.ok(created.runtime.taskRunner instanceof V2ControllerTaskRunner)
    assert.ok(!(created.runtime.taskRunner instanceof GoldenPathTaskRunner))
  } finally {
    await app?.close()
    await rm(fixture.repo, { recursive: true, force: true })
    await rm(fixture.outside, { recursive: true, force: true })
  }
})

await test('v0.3.0 production C: Launchpad-style HIGH task falls back to advanced Controller', async () => {
  const fixture = await fixtureRepo()
  const actions: TaskAction[] = []
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const created = await createProductionCase({ ...fixture, golden: true, risk: 'HIGH', async dispatch(action) {
      actions.push(action)
      return { status: 'BLOCKED', blockers: ['bounded test stop'] }
    } })
    app = created.app
    const events = new TaskEventLogV2()
    let persisted: TaskStateV2 | undefined
    const result = await created.runtime.taskRunner.run(created.runtime.definition.tasks[0]!, undefined, undefined, { taskEventLog: events,
      async persistTaskStateV2(state) { persisted = structuredClone(state) } })
    if (result.humanRequired?.reason === 'invalid persisted TaskStateV2' && persisted !== undefined) loadTaskStateV2(persisted)
    assert.notEqual(result.status, 'COMPLETED')
    assert.equal(result.taskStateV2?.execution?.path, 'CONTROLLER', JSON.stringify(result))
    assert.ok(events.has('CONTROLLER_DECIDED'))
    assert.ok(actions.length > 0, 'advanced Controller owns the post-fallback action')
  } finally {
    await app?.close()
    await rm(fixture.repo, { recursive: true, force: true })
    await rm(fixture.outside, { recursive: true, force: true })
  }
})

await test('v0.3.0 production D: one CODE_FAILURE gets one fix and a second passing VERIFY', async () => {
  const fixture = await fixtureRepo()
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const created = await createGoldenBoundaryCase({ ...fixture, failFirstVerification: true })
    app = created.app
    const events = new TaskEventLogV2()
    const result = await created.runtime.taskRunner.run(created.runtime.definition.tasks[0]!, undefined, undefined, { taskEventLog: events })
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired ?? result.completionEvidence ?? result))
    assert.deepEqual(created.counts, { execute: 2, verify: 2 })
    assert.equal(created.executePackets.length, 2)
    created.executePackets.forEach(assertGoldenImplementationPacket)
    assert.equal(created.verifierCommands.filter((command) => command === 'node --test tests/filter.test.js').length, 2)
    assert.equal(events.count('CONTROLLER_DECIDED'), 0)
    assert.equal(events.count('TASK_SUSPENDED'), 0)
  } finally {
    await app?.close()
    await rm(fixture.repo, { recursive: true, force: true })
    await rm(fixture.outside, { recursive: true, force: true })
  }
})
