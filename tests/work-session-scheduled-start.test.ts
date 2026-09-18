import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { Mastra } from '@mastra/core'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { ScheduledStartStore } from '../packages/development-guardian/work-session/scheduled-start-store.js'
import { getDeepSeekPricingPeriod, normalizeScheduledStart } from '../packages/development-guardian/work-session/schedule-policy.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { deriveDisplayState } from '../packages/development-guardian/work-session/recoverability.js'
import { makeDefinition } from './work-session-w005-a-helpers.js'
import type { WorkSessionDefinition } from '../packages/development-guardian/work-session/model.js'
import type { WorkSessionTaskResult } from '../packages/development-guardian/work-session/task-runner.js'

const cases: Array<[string, string | null, string]> = [
  ['2026-08-31T08:30:00+08:00', null, 'already_off_peak'],
  ['2026-08-31T08:59:59+08:00', null, 'already_off_peak'],
  ['2026-08-31T09:00:00+08:00', '2026-08-31T04:00:00.000Z', 'peak'],
  ['2026-08-31T09:30:00+08:00', '2026-08-31T04:00:00.000Z', 'peak'],
  ['2026-08-31T11:59:59.999+08:00', '2026-08-31T04:00:00.000Z', 'peak'],
  ['2026-08-31T12:00:00+08:00', null, 'already_off_peak'],
  ['2026-08-31T13:59:59+08:00', null, 'already_off_peak'],
  ['2026-08-31T14:00:00+08:00', '2026-08-31T10:00:00.000Z', 'peak'],
  ['2026-08-31T16:30:00+08:00', '2026-08-31T10:00:00.000Z', 'peak'],
  ['2026-08-31T17:59:59.999+08:00', '2026-08-31T10:00:00.000Z', 'peak'],
  ['2026-08-31T18:00:00+08:00', null, 'already_off_peak'],
  ['2026-08-31T20:00:00+08:00', null, 'already_off_peak'],
  ['2026-09-04T17:30:00+08:00', '2026-09-04T10:00:00.000Z', 'peak'],
  ['2026-09-04T20:00:00+08:00', null, 'already_off_peak'],
  ['2026-09-05T00:00:00+08:00', null, 'weekend'],
  ['2026-09-05T10:00:00+08:00', null, 'weekend'],
  ['2026-09-06T16:00:00+08:00', null, 'weekend'],
  ['2026-09-07T00:00:00+08:00', null, 'already_off_peak'],
]
for (const [instant, next, reason] of cases) {
  test(`DeepSeek Beijing boundary ${instant}`, () => {
    const result = getDeepSeekPricingPeriod(new Date(instant))
    assert.equal(result.period, next === null ? 'off_peak' : 'peak')
    assert.equal(result.nextOffPeakAt?.toISOString() ?? null, next)
    assert.equal(result.reason, reason)
  })
}

test('DeepSeek policy is independent of process timezone', () => {
  const moduleUrl = new URL('../packages/development-guardian/work-session/schedule-policy.js', import.meta.url).href
  const code = `import { getDeepSeekPricingPeriod as policy } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(${JSON.stringify(cases.map(([value]) => value))}.map(value => policy(new Date(value)))));`
  const results = ['UTC', 'Asia/Singapore', 'America/New_York', 'Pacific/Honolulu'].map((TZ) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }))
  for (const result of results) assert.equal(result, results[0])
})

test('timestamp parsing rejects malformed and ambiguous dates and normalizes offsets', () => {
  assert.equal(normalizeScheduledStart(undefined), null)
  assert.equal(normalizeScheduledStart(null), null)
  assert.equal(normalizeScheduledStart('2026-08-31T18:00:00+08:00'), '2026-08-31T10:00:00.000Z')
  for (const invalid of ['', 1, {}, 'tomorrow', '2026-08-31T18:00', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+24:00']) {
    assert.throws(() => normalizeScheduledStart(invalid))
  }
  assert.throws(() => getDeepSeekPricingPeriod(new Date(NaN)))
})

async function fixture(t: test.TestContext, overrides: Partial<WorkSessionDefinition> = {}, taskResult: WorkSessionTaskResult | (() => Promise<WorkSessionTaskResult>) = { status: 'COMPLETED' }) {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-scheduled-'))
  const storageUrl = pathToFileURL(join(directory, 'session.db')).href
  let now = Date.parse('2026-08-31T08:20:00Z')
  let calls = 0
  const runtimes: WorkSessionRuntime[] = []
  const definition = makeDefinition({
    id: 'scheduled-test', tasks: [{ id: 'T1', goal: 'one task' }],
    scheduledStartAt: '2026-08-31T10:00:00.000Z', scheduleSource: 'deepseek_off_peak',
    createdAt: new Date(now).toISOString(), ...overrides,
  })
  const create = () => {
    const runtime = new WorkSessionRuntime({
      definition, storageUrl, clock: { now: () => now },
      taskRunner: { async run() { calls++; return typeof taskResult === 'function' ? taskResult() : taskResult } },
    })
    runtimes.push(runtime)
    return runtime
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close()
    // libSQL native handles settle asynchronously on Windows after close().
    await new Promise((resolve) => setTimeout(resolve, 500))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EBUSY') throw error
      t.diagnostic('Windows libSQL retained a temporary DB handle after close; functional assertions are unaffected.')
    })
  })
  return { create, storageUrl, definition, calls: () => calls, clock: { now: () => now }, setNow: (value: string) => { now = Date.parse(value) } }
}

for (const scheduledStartAt of [null, '2026-08-31T08:00:00Z', '2026-08-31T08:20:00Z']) {
  test(`Immediate / past / due ${scheduledStartAt}`, async (t) => {
    const f = await fixture(t, { scheduledStartAt })
    const result = await f.create().start()
    assert.equal(result.state, 'COMPLETED')
    assert.equal(f.calls(), 1)
    assert.ok(result.startedAt)
  })
}

test('Scheduled waiting has zero execution, ledger, retries, timeout and no suspension; due uses normal workflow', async (t) => {
  const f = await fixture(t, { limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } })
  const runtime = f.create()
  const waiting = await runtime.start()
  assert.equal(waiting.state, 'SCHEDULED')
  assert.equal(deriveDisplayState(waiting, false), 'SCHEDULED')
  assert.equal(waiting.activeElapsedMs, 0)
  assert.equal(waiting.activeSegmentStartedAt, undefined)
  assert.equal(waiting.startedAt, undefined)
  assert.equal(waiting.currentTaskCheckpoint, undefined)
  assert.equal(f.calls(), 0)
  assert.deepEqual(runtime.readExecutionLedger(), [])
  f.setNow('2026-08-31T09:59:59.999Z')
  assert.equal((await runtime.start()).state, 'SCHEDULED')
  f.setNow('2026-08-31T10:00:00Z')
  const result = await runtime.start()
  assert.equal(result.state, 'COMPLETED')
  assert.equal(f.calls(), 1)
  assert.equal(result.startedAt?.toISOString(), '2026-08-31T10:00:00.000Z')
  assert.equal(result.createdAt.toISOString(), '2026-08-31T08:20:00.000Z')
  assert.equal(result.scheduledStartAt, '2026-08-31T10:00:00.000Z')
  assert.equal(result.activeElapsedMs, 0)
  assert.ok(runtime.readExecutionLedger().some((event) => event.eventType === 'TASK_COMPLETED'))
})

function assertDatabaseIntegrity(storageUrl: string): void {
  // Inspect only after every runtime using the session file has closed. Mixing
  // independent SQLite engines while either owns an open connection is unsafe.
  const database = new DatabaseSync(fileURLToPath(storageUrl), { readOnly: true })
  try {
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok'])
  } finally {
    database.close()
  }
}

for (let attempt = 1; attempt <= 3; attempt++) {
  test(`future schedule persists across restart and overdue restart runs only once (${attempt})`, async (t) => {
    const f = await fixture(t)
    const first = f.create()
    assert.equal((await first.start()).state, 'SCHEDULED')
    await first.close()
    assertDatabaseIntegrity(f.storageUrl)
    const second = f.create()
    assert.equal((await second.loadPersistedState())?.state, 'SCHEDULED')
    assert.equal(f.calls(), 0)
    f.setNow('2026-09-01T00:00:00Z')
    assert.equal((await second.start()).state, 'COMPLETED')
    await second.close()
    assertDatabaseIntegrity(f.storageUrl)
    for (let reopen = 0; reopen < 5; reopen++) {
      const runtime = f.create()
      assert.equal((await runtime.loadPersistedState())?.state, 'COMPLETED')
      assert.equal((await runtime.start()).state, 'COMPLETED')
      assert.equal(f.calls(), 1)
      await runtime.close()
      assertDatabaseIntegrity(f.storageUrl)
    }
  })
}

test('runtime close drains an active task and its completed snapshot before releasing storage', async (t) => {
  let releaseTask!: () => void
  let taskEntered!: () => void
  const taskGate = new Promise<void>((resolve) => { releaseTask = resolve })
  const entered = new Promise<void>((resolve) => { taskEntered = resolve })
  const f = await fixture(t, {}, async () => {
    taskEntered()
    await taskGate
    return { status: 'COMPLETED' }
  })
  const runtime = f.create()
  await runtime.loadPersistedState()
  f.setNow('2026-09-01T00:00:00Z')
  const started = runtime.start()
  await entered
  let closeSettled = false
  const closing = runtime.close().finally(() => { closeSettled = true })
  const finished = Promise.allSettled([started, closing])
  try {
    // Advance one event-loop turn, without delaying a write or relying on time.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false, 'close must wait while the TaskRunner is still active')
  } finally {
    releaseTask()
    await finished
  }
  assert.equal((await started).state, 'COMPLETED')
  await closing
  assertDatabaseIntegrity(f.storageUrl)
  const reopened = f.create()
  assert.equal((await reopened.loadPersistedState())?.state, 'COMPLETED')
  assert.equal((await reopened.start()).state, 'COMPLETED')
  assert.equal(f.calls(), 1)
  await reopened.close()
  assertDatabaseIntegrity(f.storageUrl)
})

test('runtime close drains an admitted createRun after its pending snapshot is persisted', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  await runtime.loadPersistedState()
  f.setNow('2026-09-01T00:00:00Z')
  let releaseCreateRun!: () => void
  let snapshotCreated!: () => void
  const createRunGate = new Promise<void>((resolve) => { releaseCreateRun = resolve })
  const created = new Promise<void>((resolve) => { snapshotCreated = resolve })
  // Intercept only the return boundary; Mastra still creates the real run and
  // writes its real pending snapshot before shutdown begins.
  const mastra = (runtime as unknown as { mastra: Mastra }).mastra
  const workflow = mastra.getWorkflow(`work-session-${f.definition.id}`)
  const originalCreateRun = workflow.createRun
  workflow.createRun = async (options) => {
    const run = await originalCreateRun.call(workflow, options)
    snapshotCreated()
    await createRunGate
    return run
  }
  t.after(() => { workflow.createRun = originalCreateRun })
  const started = runtime.start()
  let closing: Promise<void> | undefined
  // Own failures during setup as well, so an assertion cannot leave the gate
  // closed and make the fixture's shutdown wait forever.
  let finished = Promise.allSettled<unknown>([started])
  try {
    await Promise.race([created, started.then(() => assert.fail('createRun gate was not reached'))])
    const workflows = await mastra.getStorage()?.getStore('workflows')
    assert.ok(workflows)
    const snapshot = await workflows.loadWorkflowSnapshot({
      workflowName: `work-session-${f.definition.id}`, runId: f.definition.id,
    })
    assert.equal(snapshot?.status, 'pending')
    assert.deepEqual(snapshot?.value, {})
    assert.equal(f.calls(), 0)

    let closeSettled = false
    const shutdown = runtime.close()
    assert.equal(runtime.close(), shutdown, 'concurrent close calls share the same drain')
    closing = shutdown.finally(() => { closeSettled = true })
    finished = Promise.allSettled([started, closing])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false, 'close must wait for the admitted createRun')
    assert.equal(f.calls(), 0)
  } finally {
    releaseCreateRun()
    await finished
  }
  assert.equal((await started).state, 'COMPLETED')
  await closing
  assert.equal(f.calls(), 1)
  assertDatabaseIntegrity(f.storageUrl)
  const reopened = f.create()
  assert.equal((await reopened.loadPersistedState())?.state, 'COMPLETED')
  assert.equal((await reopened.start()).state, 'COMPLETED')
  assert.equal(f.calls(), 1)
  await reopened.close()
  assertDatabaseIntegrity(f.storageUrl)
})

test('same-instance calls and competing runtime instances claim one due task', async (t) => {
  const f = await fixture(t)
  const a = f.create()
  const b = f.create()
  await a.start()
  await b.loadPersistedState()
  f.setNow('2026-08-31T10:00:00Z')
  await Promise.all([a.start(), a.start(), b.start(), b.start()])
  assert.equal(f.calls(), 1)
})

test('dead process claim before workflow creation is recoverable; live owner cannot be stolen', async (t) => {
  const f = await fixture(t)
  const moduleUrl = new URL('../packages/development-guardian/work-session/scheduled-start-store.js', import.meta.url).href
  const store = new ScheduledStartStore(f.storageUrl)
  store.ensure(f.definition.id, f.definition.scheduledStartAt!, 'custom', f.definition.createdAt!)
  const code = `import { ScheduledStartStore } from ${JSON.stringify(moduleUrl)};
    const store = new ScheduledStartStore(${JSON.stringify(f.storageUrl)});
    if (!store.claim('scheduled-test', '2026-09-01T00:00:00.000Z')) process.exit(2);
    store.close();`
  execFileSync(process.execPath, ['--input-type=module', '-e', code])
  assert.equal(store.claim(f.definition.id, '2026-09-01T00:00:00.000Z'), true)
  assert.equal(store.claim(f.definition.id, '2026-09-01T00:00:00.000Z'), false)
  store.releaseUnstarted(f.definition.id)
  store.close()
  f.setNow('2026-09-01T00:00:00Z')
  assert.equal((await f.create().start()).state, 'COMPLETED')
  assert.equal(f.calls(), 1)
})

test('cancelled Scheduled task never starts, including after restart', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  await runtime.loadPersistedState()
  assert.equal(runtime.requestStopAfterTask().accepted, true)
  f.setNow('2026-09-01T00:00:00Z')
  assert.equal((await runtime.start()).state, 'CANCELLED')
  await runtime.close()
  assert.equal((await f.create().start()).state, 'CANCELLED')
  assert.equal(f.calls(), 0)
})

test('controller poll automatically dispatches due gate and exposes separate timestamps', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, clock: f.clock, pollIntervalMs: 5 })
  t.after(() => controller.close())
  await controller.loadPersistedState()
  const waiting = controller.getSnapshot().runtime
  assert.equal(waiting.displayState, 'SCHEDULED')
  assert.equal(waiting.createdAt, f.definition.createdAt)
  assert.equal(waiting.startedAt, null)
  assert.equal(waiting.completedAt, null)
  f.setNow('2026-08-31T10:00:00Z')
  const deadline = Date.now() + 5_000
  while (runtime.getDurableState()?.state !== 'COMPLETED' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.getDurableState()?.state, 'COMPLETED')
  assert.equal(f.calls(), 1)
  assert.ok(controller.getSnapshot().runtime.startedAt)
  assert.ok(controller.getSnapshot().runtime.completedAt)
})

test('execution failure after dispatch stays in the existing failure lifecycle, never scheduler-retried', async (t) => {
  const f = await fixture(t, {}, { status: 'FAILED', error: 'test execution failure' })
  const runtime = f.create()
  await runtime.loadPersistedState()
  f.setNow('2026-08-31T10:00:00Z')
  await runtime.start().catch(() => undefined)
  assert.equal(runtime.getDurableState()?.state, 'FAILED')
  await runtime.start()
  assert.equal(f.calls(), 1)
})

test('cancellation while dispatch preflight is pending wins before executor claim', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  let release!: () => void
  const preflight = new Promise<void>((resolve) => { release = resolve })
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, clock: f.clock, beforeResume: () => preflight })
  t.after(() => controller.close())
  await controller.loadPersistedState()
  f.setNow('2026-08-31T10:00:00Z')
  controller.start()
  assert.equal(controller.requestStopAfterTask().accepted, true)
  release()
  await controller.getStartPromise()
  assert.equal(runtime.getDurableState()?.state, 'CANCELLED')
  assert.equal(f.calls(), 0)
  assert.ok(controller.getRecentEvents().some((event) => event.type === 'SCHEDULE_CANCELLED'))
})

test('closing the control app during pending schedule preflight prevents late dispatch', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  let release!: () => void
  const preflight = new Promise<void>((resolve) => { release = resolve })
  const controller = new WorkSessionControlController({ createRuntime: () => runtime, clock: f.clock, beforeResume: () => preflight })
  await controller.loadPersistedState()
  f.setNow('2026-08-31T10:00:00Z')
  controller.start()
  controller.close()
  release()
  await controller.getStartPromise()
  assert.equal(runtime.getDurableState()?.state, 'SCHEDULED')
  assert.equal(f.calls(), 0)
})

test('runtime shutdown racing a due gate prevents a late start and preserves restartability', async (t) => {
  const f = await fixture(t)
  const runtime = f.create()
  await runtime.loadPersistedState()
  f.setNow('2026-08-31T10:00:00Z')
  const pending = runtime.start()
  const rejected = assert.rejects(pending, /closed/)
  await runtime.close()
  await rejected
  assert.equal(f.calls(), 0)
  assert.equal((await f.create().start()).state, 'COMPLETED')
  assert.equal(f.calls(), 1)
})
