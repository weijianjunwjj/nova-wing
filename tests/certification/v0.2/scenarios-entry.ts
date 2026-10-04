import { mintSession, startOperator, sessionFetch } from '../../operator-session.js'
/**
 * S01 — Launchpad default V2 entry (real HTTP create).
 * S16 — explicit controlPlane=v1 keeps Guardian composition.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNovaWingLaunchpad, discoverTrustedWorkSessionConfigs } from '../../../packages/development-guardian/work-session/launchpad/server.js'
import { createProductionWorkSessionUi } from '../../../packages/development-guardian/work-session/production.js'
import { V2ControllerTaskRunner } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { GuardianWorkSessionTaskRunner } from '../../../packages/development-guardian/work-session/guardian-task-runner.js'
import type { WorkSessionRuntimeConfig } from '../../../packages/development-guardian/work-session/runtime.js'
import type { TaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import type { GuardianBrain } from '../../../packages/development-guardian/ports.js'
import type { DependencyHealthReport } from '../../../packages/development-guardian/work-session/dependency-health.js'
import type { TrustedWorkSessionConfig } from '../../../packages/development-guardian/work-session/production.js'
import { FakeRuntime } from '../../work-session-w005-a-helpers.js'
import type { CertificationScenario } from './scenario.js'
import { buildTrustedConfig } from './harness.js'
import { initFixtureRepo, removeTree } from './util.js'

interface Capture {
  runtimeConfig?: WorkSessionRuntimeConfig
}

function healthyReport(): DependencyHealthReport {
  return { overall: 'READY', canStart: true, checkedAt: new Date().toISOString(), dependencies: [] }
}

async function postCreate(launchpad: { getAddress(): { url: string } | undefined; mintBootstrapUrl(): string }, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return sessionFetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': await mintSession(launchpad), Origin: address.url },
    body: JSON.stringify(body),
  })
}

export const s01: CertificationScenario = {
  id: 'S01',
  title: 'Launchpad HTTP creation defaults to V2 (no Guardian Brain preflight)',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'src/helper.ts': 'export const value = 1\n' })
    const configsDir = join(ctx.dirs.root, 'configs')
    await mkdir(configsDir, { recursive: true })
    const capture: Capture = {}
    let codexCalls = 0
    const phases: string[] = []
    const observedPreflights: Array<'v1' | 'v2'> = []
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configsDir, dependencies: {
      resolveEnvironment: async () => ({ NOVAWING_DATA_DIR: ctx.dirs.data }),
      preflight: (_targetRepo, controlPlane) => {
        if (controlPlane !== undefined) observedPreflights.push(controlPlane)
        return Promise.resolve(healthyReport())
      },
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: (config, input) => createProductionWorkSessionUi(config, {
        ...input,
        createRuntime(value) { capture.runtimeConfig = value; return new FakeRuntime(value.definition) },
        createBrain() { throw new Error('AskBridge transport must never be constructed for V2') },
        createCodexExecutor: () => ({
          async execute() {
            codexCalls++
            return { summary: 'launchpad v2 first-boundary dispatch', changedFiles: [], commandsRun: [], verificationResults: [], blockers: [] }
          },
        }),
      }),
    } })
    try {
      const address = await startOperator(launchpad)
      h.check(address !== undefined, 'Launchpad started on an ephemeral address')
      const safeRunId = ctx.dirs.runId.replace(/[^a-zA-Z0-9_-]/gu, '') || 'run'
      const body = {
        requestId: `cert-s01-${safeRunId}-00000000`,
        targetRepo: repo,
        tasks: [{ id: 'D01', goal: 'Fix a focused source helper' }],
        guardian: { allowedPaths: ['src/**'] },
        autoCommit: false,
      }
      const response = await postCreate(launchpad, body)
      h.check(response.status === 202, `POST /api/session/create returned 202 (got ${response.status} ${(await response.text()).slice(0, 200)})`)

      const discovered = await discoverTrustedWorkSessionConfigs(configsDir)
      h.check(discovered.length === 1, 'one trusted config persisted by Launchpad')
      const persisted = discovered[0]!
      h.check(persisted.config.session.controlPlane === 'v2', 'persisted config session.controlPlane === v2')
      const serialized = JSON.parse(await readFile(persisted.configPath, 'utf8')) as TrustedWorkSessionConfig
      h.check(serialized.session.controlPlane === 'v2', 'persisted JSON on disk carries controlPlane v2')
      const runtimeConfig = capture.runtimeConfig
      h.check(runtimeConfig !== undefined, 'production composition produced a runtime config')
      h.check(runtimeConfig?.definition.controlPlane === 'v2', 'composition definition controlPlane === v2')
      h.check(runtimeConfig?.taskRunner instanceof V2ControllerTaskRunner, 'production runner is V2ControllerTaskRunner (not Guardian)')
      h.check(observedPreflights.length > 0 && observedPreflights.every((cp) => cp === 'v2'), 'dependency preflight is invoked for the v2 control plane')

      const states: TaskStateV2[] = []
      const first = await runtimeConfig!.taskRunner.run(runtimeConfig!.definition.tasks[0]!, undefined, undefined, {
        shouldPauseAutonomousWork: () => codexCalls > 0,
        persistTaskStateV2: async (state) => { states.push(structuredClone(state)) },
        onProgress: (event) => { phases.push(event.phase) },
      })
      h.check(codexCalls === 1, 'first dispatch is a single executor boundary (no Guardian orchestration loop)')
      h.check(first.taskStateV2?.identity.taskId === 'D01', 'controller dispatched the Launchpad task id')
      h.check(states[0]?.gitState.headSha !== undefined, 'real repository inspection precedes controller dispatch')
      h.check(!/REVIEW|BRAIN/iu.test(phases.join(' ')), 'no Guardian REVIEW/BRAIN phase appeared for V2')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configsDir)
    }
  },
}

export const s16: CertificationScenario = {
  id: 'S16',
  title: 'Explicit controlPlane=v1 still composes Guardian (V2 fixes did not break V1)',
  group: 'compatibility',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'src/legacy.ts': 'export const legacy = true\n' })
    const capture: Capture = {}
    let brainConstruction = 0
    const config = await buildTrustedConfig({
      sessionId: 'v1-compat-session',
      repo,
      controlPlane: 'v1',
      tasks: [{ id: 'T1', goal: 'legacy path', acceptanceCriteria: ['completed'], allowedPaths: ['src/**'] }],
    })
    const app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: ctx.dirs.data },
      createRuntime(value) { capture.runtimeConfig = value; return new FakeRuntime(value.definition) },
      createBrain: () => { brainConstruction++; return {} as unknown as GuardianBrain },
    })
    try {
      h.check(capture.runtimeConfig !== undefined, 'composition produced a V1 runtime config')
      h.check(capture.runtimeConfig?.definition.controlPlane === 'v1', 'definition preserves explicit controlPlane v1')
      h.check(capture.runtimeConfig?.taskRunner instanceof GuardianWorkSessionTaskRunner, 'explicit v1 still composes GuardianWorkSessionTaskRunner')
      h.check(!(capture.runtimeConfig?.taskRunner instanceof V2ControllerTaskRunner), 'v1 does not select V2ControllerTaskRunner')
      h.check(brainConstruction === 1, 'v1 composition constructs its Brain transport')
      h.check(app.definition.tasks[0]!.id === 'T1', 'v1 composition preserves task definition')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}
