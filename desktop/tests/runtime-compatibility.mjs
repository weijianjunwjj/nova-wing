import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { createResourceTracker } from './resource-tracker.mjs'

const checkNames = [
  'environment', 'isolation', 'guardian_import', 'node_sqlite', 'libsql',
  'runtime_create', 'fake_task', 'runtime_close', 'runtime_reopen', 'resources',
]
/** @typedef {{ status: 'PASS' | 'FAIL', detail?: unknown }} Check */
/** @typedef {{ name: string, close: () => unknown, closed: boolean }} OwnedResource */
/** @type {Record<string, Check>} */
const checks = Object.fromEntries(checkNames.map((name) => [name, { status: 'FAIL', detail: 'Not run' }]))
/** @type {Array<{ check: string, error: unknown }>} */
const errors = []
/** @type {OwnedResource[]} */
const resources = []
const environment = {
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  chrome: process.versions.chrome ?? null,
  v8: process.versions.v8,
  modules: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  cwd: process.cwd(),
}

/** @param {unknown} error @param {number} [depth] @returns {unknown} */
function describeError(error, depth = 0) {
  if (!(error instanceof Error)) return String(error)
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...('code' in error ? { code: error.code } : {}),
    ...(depth < 4 && error.cause !== undefined ? { cause: describeError(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError
      ? { errors: error.errors.map((/** @type {unknown} */ item) => describeError(item, depth + 1)) } : {}),
  }
}

/** @param {string} name @param {unknown} detail */
function pass(name, detail) {
  checks[name] = { status: 'PASS', detail }
}

/** @param {string} name @param {unknown} error */
function fail(name, error) {
  const detail = describeError(error)
  checks[name] = { status: 'FAIL', detail }
  errors.push({ check: name, error: detail })
}

/** @param {string} name @param {() => unknown} close */
function own(name, close) {
  const resource = { name, close, closed: false }
  resources.push(resource)
  return resource
}

/** @param {OwnedResource} resource */
async function closeOwned(resource) {
  if (resource.closed) return
  await resource.close()
  resource.closed = true
}

/** @param {string | undefined} value @param {string} label */
function absoluteDirectory(value, label) {
  assert.ok(value && isAbsolute(value), `${label} must be an explicit absolute directory`)
  const directory = resolve(value)
  assert.ok(lstatSync(directory).isDirectory(), `${label} must be an existing directory, not a symlink`)
  assert.equal(realpathSync(directory), directory, `${label} must not escape through symlinks`)
  return directory
}

// Validate before any NovaWing import or app readiness; never fall back to user paths.
let smokeRoot
try {
  assert.ok(process.versions.electron, 'This entry requires real Electron Main')
  assert.equal(process.type, 'browser', 'This entry must run in Electron Main')
  pass('environment', 'Real Electron Main process')
  smokeRoot = absoluteDirectory(process.env.NOVAWING_DESKTOP_SMOKE_ROOT, 'smoke root')
  assert.match(basename(smokeRoot), /^novawing-desktop-smoke-[A-Za-z0-9]+$/u)
  for (const [label, actual, expected] of [
    ['config', process.env.NOVAWING_CONFIG_DIR, join(smokeRoot, 'config')],
    ['data', process.env.NOVAWING_DATA_DIR, join(smokeRoot, 'data')],
    ['cwd', process.cwd(), join(smokeRoot, 'repo')],
  ]) {
    assert.equal(absoluteDirectory(actual, label ?? 'directory'), expected)
  }
  assert.equal(app.isReady(), false, 'Electron data paths must be isolated before readiness')
  for (const name of /** @type {const} */ (['userData', 'sessionData'])) {
    const directory = join(smokeRoot, `electron-${name}`)
    mkdirSync(directory, { recursive: true })
    absoluteDirectory(directory, name)
    app.setPath(name, directory)
  }
  pass('isolation', { root: smokeRoot, config: process.env.NOVAWING_CONFIG_DIR, data: process.env.NOVAWING_DATA_DIR })
} catch (error) {
  fail(checks.environment?.status === 'PASS' ? 'isolation' : 'environment', error)
}

/** @returns {Record<string, number>} */
function activeResources() {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

/** @param {Record<string, number>} baseline */
function resourceDelta(baseline) {
  const active = activeResources()
  const extra = Object.fromEntries(Object.entries(active)
    .map(([name, count]) => [name, count - (baseline[name] ?? 0)])
    .filter(([, count]) => typeof count === 'number' && count > 0))
  return { active, extra }
}

/** @type {Record<string, number> | undefined} */
let baseline
/** @type {typeof import('nova-wing/development-guardian') | undefined} */
let guardian
/** @type {ReturnType<typeof createResourceTracker> | undefined} */
let resourceTracker

async function runCompatibility() {
  try {
    await app.whenReady()
    if (checks.isolation?.status === 'PASS' && smokeRoot !== undefined) {
      // Initialize stdio before measuring: result/log pipes are host resources.
      await new Promise((done) => process.stdout.write('', done))
      await new Promise((done) => process.stderr.write('', done))
      await nextTurn()
      baseline = activeResources()
      resourceTracker = createResourceTracker()

      try {
        guardian = await import('nova-wing/development-guardian')
        for (const name of /** @type {const} */ ([
          'createProductionWorkSessionUi', 'createNovaWingLaunchpad', 'WorkSessionRuntime', 'FakeTaskRunner',
        ])) assert.equal(typeof guardian[name], 'function', `Missing production export ${name}`)
        pass('guardian_import', {
          module: import.meta.resolve('nova-wing/development-guardian'),
          productionFactory: 'createProductionWorkSessionUi',
          launchpadFactory: 'createNovaWingLaunchpad',
        })
      } catch (error) { fail('guardian_import', error) }

      try {
        const { DatabaseSync } = await import('node:sqlite')
        const database = new DatabaseSync(join(smokeRoot, 'data', 'node-sqlite.db'))
        const owner = own('node:sqlite', () => {
          database.close()
          assert.equal(database.isOpen, false, 'node:sqlite connection must close')
        })
        database.exec('CREATE TABLE compatibility (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        database.prepare('INSERT INTO compatibility (value) VALUES (?)').run('electron-main')
        assert.equal(database.prepare('SELECT value FROM compatibility WHERE id = 1').get()?.value, 'electron-main')
        await closeOwned(owner)
        pass('node_sqlite', { create: true, insert: true, select: true, closed: true })
      } catch (error) { fail('node_sqlite', error) }

      try {
        // Match ScheduledStartStore's actual dependency resolution, including nested installs.
        const requireMastra = createRequire(createRequire(import.meta.url).resolve('@mastra/libsql'))
        const requireClient = createRequire(requireMastra.resolve('@libsql/client'))
        /** @type {typeof import('libsql')} */
        const Database = requireClient('libsql')
        const database = new Database(join(smokeRoot, 'data', 'libsql.db'))
        const owner = own('libsql', () => {
          database.close()
          assert.equal(database.open, false, 'libSQL native connection must close')
        })
        database.exec('CREATE TABLE compatibility (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        database.prepare('INSERT INTO compatibility (value) VALUES (?)').run('electron-native')
        const row = /** @type {{ value: string } | undefined} */ (database.prepare('SELECT value FROM compatibility WHERE id = 1').get())
        assert.equal(row?.value, 'electron-native')
        await closeOwned(owner)
        pass('libsql', { module: requireClient.resolve('libsql'), initialize: true, insert: true, select: true, closed: true })
      } catch (error) { fail('libsql', error) }

      if (guardian !== undefined && checks.guardian_import?.status === 'PASS'
        && checks.node_sqlite?.status === 'PASS' && checks.libsql?.status === 'PASS') {
        let phase = 'runtime_create'
        try {
          const { WorkSessionRuntime, FakeTaskRunner } = guardian
          const now = Date.now()
          /** @type {import('nova-wing/development-guardian').WorkSessionDefinition} */
          const definition = {
            id: 'desktop-compatibility',
            targetRepo: join(smokeRoot, 'repo'),
            branch: 'desktop-smoke-fixture',
            tasks: [{ id: 'T1', goal: 'Complete one offline compatibility fixture' }],
            limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 },
            // An already-due schedule also exercises the existing native scheduled store.
            scheduledStartAt: new Date(now - 1_000).toISOString(),
            createdAt: new Date(now - 2_000).toISOString(),
            scheduleSource: 'custom',
          }
          const storageUrl = pathToFileURL(join(smokeRoot, 'data', 'session.db')).href
          const taskRunner = new FakeTaskRunner({ T1: { type: 'COMPLETED' } })
          const runtime = new WorkSessionRuntime({ definition, taskRunner, storageUrl })
          const runtimeOwner = own('runtime:first', () => runtime.close())
          const initial = await runtime.loadPersistedState()
          assert.equal(initial?.state, 'SCHEDULED')
          assert.equal(taskRunner.getExecutionCount('T1'), 0)
          pass('runtime_create', { storageUrl, loadedState: initial.state, executedTasks: 0 })

          phase = 'fake_task'
          const settled = await runtime.start()
          assert.equal(settled.state, 'COMPLETED')
          assert.deepEqual(settled.completedTaskIds, ['T1'])
          assert.equal(taskRunner.getExecutionCount('T1'), 1)
          assert.equal((await runtime.verifySnapshot()).status, 'success')
          assert.ok(runtime.readExecutionLedger().some((event) => event.eventType === 'TASK_COMPLETED'))
          pass('fake_task', { runner: 'FakeTaskRunner', state: settled.state, executions: 1, persistedSnapshot: true, ledger: true })

          phase = 'runtime_close'
          await closeOwned(runtimeOwner)
          phase = 'runtime_reopen'
          const reopenedRunner = new FakeTaskRunner({ T1: { type: 'COMPLETED' } })
          const reopened = new WorkSessionRuntime({ definition, taskRunner: reopenedRunner, storageUrl })
          const reopenedOwner = own('runtime:reopened', () => reopened.close())
          const restored = await reopened.loadPersistedState()
          assert.equal(restored?.state, 'COMPLETED')
          assert.equal(restored.sessionId, definition.id)
          assert.deepEqual(restored.completedTaskIds, ['T1'])
          assert.equal(reopenedRunner.getExecutionCount('T1'), 0)
          assert.ok(reopened.readExecutionLedger().some((event) => event.eventType === 'TASK_COMPLETED'))
          pass('runtime_reopen', { state: restored.state, sessionId: restored.sessionId, completedTaskIds: restored.completedTaskIds, executions: 0 })
          phase = 'runtime_close'
          await closeOwned(reopenedOwner)
          pass('runtime_close', { first: true, reopened: true })
        } catch (error) { fail(phase, error) }
      }
    }
  } catch (error) {
    fail('environment', error)
  } finally {
    // A failure in one close must not prevent attempts to close every other owner.
    for (const resource of resources.toReversed()) {
      if (!resource.closed) {
        try { await closeOwned(resource) } catch (error) {
          fail(resource.name.startsWith('runtime:') ? 'runtime_close' : resource.name === 'node:sqlite' ? 'node_sqlite' : 'libsql', error)
        }
      }
    }
    if (baseline !== undefined && resourceTracker !== undefined) {
      try {
        await nextTurn()
        await nextTurn()
        let observed = resourceDelta(baseline)
        let tracked = resourceTracker.snapshot()
        // Native close callbacks can finish on subsequent event-loop turns.
        for (let attempt = 0; (Object.keys(observed.extra).length > 0 || tracked.live.length > 0) && attempt < 20; attempt++) {
          await delay(25)
          await nextTurn()
          // Let the smoke's own polling timer receive its destroy callback.
          await nextTurn()
          observed = resourceDelta(baseline)
          tracked = resourceTracker.snapshot()
        }
        const detail = {
          baseline,
          ...observed,
          tracked,
          connections: resources.map(({ name, closed }) => ({ name, closed })),
          scope: 'Resources created since production import tracked by asyncId, including unref handles; normal Electron and child exit checked externally',
        }
        assert.ok(resources.every((resource) => resource.closed), `Unclosed resources: ${JSON.stringify(detail)}`)
        assert.deepEqual(tracked.live, [], `Residual resources created during runtime smoke: ${JSON.stringify(detail)}`)
        assert.deepEqual(observed.extra, {}, `Residual HTTP, timer, child process or other Node resources: ${JSON.stringify(detail)}`)
        pass('resources', detail)
      } catch (error) { fail('resources', error) } finally { resourceTracker.stop() }
    }
  }

  /** @type {number[]} */
  let childPids = []
  try {
    childPids = app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid)
  } catch (error) { fail('resources', error) }
  const result = errors.length === 0 && checkNames.every((name) => checks[name]?.status === 'PASS') ? 'PASS' : 'FAIL'
  process.exitCode = result === 'PASS' ? 0 : 1
  await new Promise((done) => process.stdout.write(`DESKTOP_COMPATIBILITY_RESULT ${JSON.stringify({ environment, checks, childPids, errors, result })}\n`, done))
  // Do not force-exit: the outer runner verifies normal exit and owns the timeout.
  app.quit()
}

// Finish ESM evaluation before waiting for Electron's ready event.
void runCompatibility()
