import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProductionWorkSessionUi, defaultStorageUrl, deriveDisplayState,
  FakeTaskRunner, loadTrustedWorkSessionConfig, ReviewerRuntimeRegistry, validateTrustedWorkSessionConfig, WorkSessionRuntime,
} from 'nova-wing/development-guardian'
import { smokeEnvironment } from '../../scripts/platform/desktop-smoke-environment.mjs'

/** @typedef {import('nova-wing/development-guardian').TrustedWorkSessionConfig} TrustedConfig */
/** @typedef {import('nova-wing/development-guardian').ProductionWorkSessionUi} ProductionUi */

function requireInside(root, target) {
  const distance = relative(root, resolve(target))
  if (!distance || distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) {
    throw new Error('Desktop fixture path must remain inside its isolated root')
  }
}

/**
 * Phase 1B deliberately runs only an isolated, offline profile. The production
 * factories still own composition, HTTP, SSE, controller and runtime lifecycle.
 * The existing dependency seams replace external capabilities and the runner.
 *
 * @param {{ root: string, env: NodeJS.ProcessEnv, holdTasks?: boolean }} options
 */
export async function createIsolatedLaunchpadFixture({ root, env, holdTasks = false }) {
  if (!isAbsolute(root) || env === undefined) throw new Error('Desktop fixture requires an absolute root and explicit environment')
  const fixtureRoot = await realpath(root)
  const fixtureEnv = smokeEnvironment(fixtureRoot, env)
  const configDirectory = join(fixtureRoot, 'config')
  const dataDirectory = join(fixtureRoot, 'data')
  const repoDirectory = join(fixtureRoot, 'repo')
  const branch = 'desktop-smoke-fixture'
  for (const directory of [configDirectory, dataDirectory, repoDirectory]) {
    requireInside(fixtureRoot, directory)
    await mkdir(directory, { recursive: true })
    requireInside(fixtureRoot, await realpath(directory))
  }
  if ((await readdir(configDirectory)).length !== 0) throw new Error('Desktop bootstrap requires an empty isolated config directory')
  await writeFile(join(repoDirectory, 'fixture.txt'), 'NovaWing offline desktop fixture\n', { encoding: 'utf8', flag: 'wx' })

  const evidence = {
    fixtureControlPlane: 'v1',
    productionUiCreateCount: 0, runtimeCreateCount: 0, runtimeCloseCount: 0,
    runtimeCloseAttemptCount: 0, taskRunCount: 0, forbiddenCapabilityAttempts: 0,
    gitBranchReadCount: 0, suppressedNotificationCount: 0,
  }
  /** @type {Array<{ sessionId: string, storageUrl: string, runtime: WorkSessionRuntime, runner: FakeTaskRunner, app?: ProductionUi, runtimeCreateCount: number, runtimeCloseCount: number, runtimeCloseAttemptCount: number, taskRunCount: number, runtimeStartErrors: unknown[] }>} */
  const sessions = []
  let taskGate = Promise.withResolvers()
  let taskStarted = Promise.withResolvers()
  /** @type {Map<string, {gate: PromiseWithResolvers<void>, started: PromiseWithResolvers<void>, behavior?: import('nova-wing/development-guardian').FakeTaskBehavior, error?: Error, desktopNotifier?: import('nova-wing/development-guardian').WorkSessionNotifier | null}>} */
  const taskControls = new Map()
  const allowedSchedules = new Set()
  if (!holdTasks) taskGate.resolve(undefined)

  /** @returns {never} */
  function forbidden() {
    evidence.forbiddenCapabilityAttempts++
    throw new Error('External execution is unavailable in the isolated desktop fixture')
  }
  async function assertFixtureRepo(targetRepo) {
    if (!isAbsolute(targetRepo) || resolve(targetRepo) !== repoDirectory || await realpath(targetRepo) !== repoDirectory) {
      throw new Error('Desktop bootstrap accepts only its temporary repository fixture')
    }
  }
  /** @param {TrustedConfig} config @param {'v1' | 'v2'} [controlPlane] */
  async function assertFixtureConfig(config, controlPlane = 'v1') {
    await assertFixtureRepo(config.session.targetRepo)
    if (config.session.branch !== branch || config.session.controlPlane !== controlPlane ||
        (config.session.scheduledStartAt != null && !allowedSchedules.has(config.session.scheduledStartAt)) || config.gitCheckpoint.autoCommit ||
        config.gitCheckpoint.autoPush || config.notification?.email.enabled) {
      throw new Error('Desktop fixture permits only explicitly admitted offline tasks without Git mutations or email')
    }
    const storagePath = fileURLToPath(config.storageUrl ?? defaultStorageUrl(config.session.id, fixtureEnv))
    requireInside(dataDirectory, storagePath)
  }
  /** @type {import('nova-wing/development-guardian').ProductionGitProcessRunner} */
  const gitProcessRunner = async (command, args, cwd) => {
    await assertFixtureRepo(cwd)
    if (command === 'git' && args.join(' ') === 'branch --show-current') {
      evidence.gitBranchReadCount++
      return { exitCode: 0, stdout: `${branch}\n`, stderr: '' }
    }
    // The existing Composer probes an optional push remote after its branch read.
    if (command === 'git' && args.join(' ') === 'remote get-url --push --all origin') {
      return { exitCode: 2, stdout: '', stderr: 'Offline fixture has no push remote' }
    }
    return forbidden()
  }
  /** @returns {Promise<import('nova-wing/development-guardian').DependencyHealthReport>} */
  async function preflight(targetRepo) {
    if (targetRepo !== undefined) await assertFixtureRepo(targetRepo)
    return { overall: 'READY', canStart: true, checkedAt: new Date().toISOString(), dependencies: [] }
  }
  const suppressedNotifier = { async notify() { evidence.suppressedNotificationCount++ } }
  /** @type {import('nova-wing/development-guardian').NovaWingLaunchpadDependencies} */
  const dependencies = {
    async loadConfig(configPath) {
      requireInside(configDirectory, configPath)
      requireInside(configDirectory, await realpath(configPath))
      const config = await loadTrustedWorkSessionConfig(configPath)
      if (!/^repo-[0-9]{12}-[a-f0-9]{6}$/u.test(config.session.id) || resolve(configPath) !== join(configDirectory, `${config.session.id}.json`)) {
        throw new Error('Desktop fixture accepts only its generated Composer config')
      }
      if (config.session.controlPlane === 'v2') {
        await assertFixtureConfig(config, 'v2')
        // FakeTaskRunner implements the existing v1 task contract. Persist that
        // explicit fixture choice before Production UI composition; do not forge
        // the V2 Controller authorization required by real V2 completion.
        const offlineConfig = await validateTrustedWorkSessionConfig({
          ...config, session: { ...config.session, controlPlane: 'v1' },
          storageUrl: defaultStorageUrl(config.session.id, fixtureEnv),
        })
        await writeFile(configPath, `${JSON.stringify(offlineConfig, null, 2)}\n`, 'utf8')
        return offlineConfig
      }
      await assertFixtureConfig(config)
      return config
    },
    async resolveEnvironment(config) {
      await assertFixtureConfig(config)
      return { ...fixtureEnv }
    },
    preflight,
    gitProcessRunner,
    analyticsPath: join(dataDirectory, 'task-run-analytics.db'),
    readCodexAvailability: () => ({ state: 'unknown' }),
    async readSessionStatus(config) {
      await assertFixtureConfig(config)
      const owned = sessions.find((entry) => entry.sessionId === config.session.id)
      if (owned === undefined) throw new Error('Desktop fixture does not recover pre-existing sessions')
      return deriveDisplayState(owned.runtime.getDurableState(), owned.app?.hasActiveSession() ?? false)
    },
    repairAgent: { id: 'desktop-fixture-no-repair', async repair() { return forbidden() } },
    repairLlmAgent: { id: 'desktop-fixture-no-model', async repair() { return forbidden() } },
    repairAudit: { async record() {} },
    repairNotifier: suppressedNotifier,
    async createWorkSession(config, options) {
      await assertFixtureConfig(config)
      evidence.productionUiCreateCount++
      // Main-only fault injection for the notification smoke. It cannot be set
      // by a Composer request and never admits SMTP or any external execution.
      const taskControl = taskControls.get(config.tasks[0]?.id)
      const app = await createProductionWorkSessionUi(config, {
        ...options, env: { ...fixtureEnv }, preflight, gitProcessRunner,
        ...(taskControl && Object.hasOwn(taskControl, 'desktopNotifier')
          ? { desktopNotifier: taskControl.desktopNotifier } : {}),
        createBrain: () => ({ review: async () => forbidden() }),
        createExecutor: forbidden, createCodexExecutor: forbidden,
        createReviewerRegistry: () => new ReviewerRuntimeRegistry(),
        runtimeRepair: {
          refreshProviderHealth: async () => forbidden(),
          auditSink: { async record() {} }, notifier: suppressedNotifier,
        },
        createRuntime(runtimeConfig) {
          requireInside(dataDirectory, fileURLToPath(runtimeConfig.storageUrl))
          const runner = new FakeTaskRunner(Object.fromEntries(runtimeConfig.definition.tasks.map((task) => [task.id, { type: 'COMPLETED' }])))
          /** @type {import('nova-wing/development-guardian').WorkSessionTaskRunner} */
          const taskRunner = {
            async run(...args) {
              evidence.taskRunCount++
              owned.taskRunCount++
              taskStarted.resolve(undefined)
              const control = taskControls.get(args[0].id)
              control?.started.resolve(undefined)
              await (control?.gate.promise ?? taskGate.promise)
              if (control?.error) throw control.error
              if (control?.behavior) runner.setBehavior(args[0].id, control.behavior)
              return runner.run(...args)
            },
          }
          const runtime = new WorkSessionRuntime({ ...runtimeConfig, taskRunner, notificationRetryDelayMs: 0 })
          const owned = {
            sessionId: runtimeConfig.definition.id, storageUrl: runtimeConfig.storageUrl, runtime, runner,
            runtimeCreateCount: 1, runtimeCloseCount: 0, runtimeCloseAttemptCount: 0, taskRunCount: 0,
            runtimeStartErrors: [],
          }
          evidence.runtimeCreateCount++
          sessions.push(owned)
          const startObserved = runtime.startWithActivityObserver.bind(runtime)
          runtime.startWithActivityObserver = (...args) => {
            const operation = startObserved(...args)
            void operation.catch((error) => { owned.runtimeStartErrors.push(error) })
            return operation
          }
          const close = runtime.close.bind(runtime)
          runtime.close = async () => {
            evidence.runtimeCloseAttemptCount++
            owned.runtimeCloseAttemptCount++
            await close()
            evidence.runtimeCloseCount++
            owned.runtimeCloseCount++
          }
          return runtime
        },
      })
      const owned = sessions.find((entry) => entry.runtime === app.runtime)
      if (owned === undefined) throw new Error('Production UI did not retain the owned real Runtime')
      owned.app = app
      return app
    },
  }

  function getEvidence() {
    const entries = sessions.map(({ sessionId, storageUrl, runtime, runner, runtimeCreateCount, runtimeCloseCount, runtimeCloseAttemptCount, taskRunCount }) => ({
      sessionId, storageUrl, runtimeCreateCount, runtimeCloseCount, runtimeCloseAttemptCount, taskRunCount,
      fakeExecutionCount: runtime.getDefinition().tasks.reduce((sum, task) => sum + runner.getExecutionCount(task.id), 0),
      durableState: structuredClone(runtime.getDurableState()),
    }))
    return { ...evidence, fakeExecutionCount: entries.reduce((sum, entry) => sum + entry.fakeExecutionCount, 0), sessions: entries }
  }
  return {
    root: fixtureRoot, env: fixtureEnv, configDirectory, dataDirectory, repoDirectory, branch, dependencies, evidence,
    releaseTasks() {
      taskGate.resolve(undefined)
      for (const control of taskControls.values()) control.gate.resolve(undefined)
    },
    /** Explicitly gate one fake task without changing any production scheduling. */
    armTask(taskId, options = {}) {
      if (taskControls.has(taskId)) throw new Error('A fixture task can only be armed once')
      const control = { gate: Promise.withResolvers(), started: Promise.withResolvers(), ...options }
      taskControls.set(taskId, control)
      return { started: control.started.promise, release() { control.gate.resolve(undefined) } }
    },
    allowFutureSchedule(value) {
      if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new Error('Fixture schedule must be in the future')
      allowedSchedules.add(value)
    },
    getSession(sessionId) { return sessions.find((entry) => entry.sessionId === sessionId) },
    holdNextTasks() {
      if (sessions.some(({ runtime }) => runtime.getDurableState()?.state !== 'COMPLETED')) {
        throw new Error('Only a settled isolated fixture can arm its next task gate')
      }
      taskGate = Promise.withResolvers()
      taskStarted = Promise.withResolvers()
      return { started: taskStarted.promise }
    },
    getEvidence,
    async getPersistedStates() {
      return Promise.all(sessions.map(async ({ runtime }) => {
        if (runtime.getDurableState()?.state !== 'COMPLETED') throw new Error('Persistence inspection requires a completed fake workload')
        const snapshot = await runtime.verifySnapshot()
        if (!snapshot.exists || snapshot.status !== 'success') throw new Error('Completed workflow snapshot was not persisted')
        return runtime.loadPersistedState()
      }))
    },
    createRequest: {
      requestId: 'desktop-offline-fixture-0001', targetRepo: repoDirectory, branch,
      tasks: [{ id: 'DESKTOP-SMOKE-001', goal: 'Complete one offline desktop fixture' }],
      guardian: { allowedPaths: ['fixture.txt'] }, autoCommit: false, autoPush: false, emailEnabled: false,
      directPathEnabled: false, goldenPathEnabled: false,
    },
  }
}
