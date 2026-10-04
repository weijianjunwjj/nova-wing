import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createScheduledFixture } from './scheduled-start-fixture.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'

test('Launchpad HTTP creation, scheduled list, restart reopening, overdue dispatch and terminal restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-schedule-http-'))
  let now = Date.now()
  const at = new Date(now + 3_600_000).toISOString()
  const instances: Awaited<ReturnType<typeof createScheduledFixture>>[] = []
  t.after(async () => {
    for (const instance of instances) await instance.launchpad.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EBUSY') throw error
      t.diagnostic('Windows libSQL temporary DB handle remains until process exit.')
    })
  })
  const create = async () => {
    const app = await createScheduledFixture(directory, { now: () => now })
    instances.push(app)
    await startOperator(app.launchpad)
    return app
  }
  const first = await create()
  const url = first.launchpad.getAddress()!.url
  const result = await sessionFetch(`${url}/api/session/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'Cookie': await mintSession(first.launchpad) },
    body: JSON.stringify({
      requestId: 'schedule-recovery-http-0001', targetRepo: process.cwd(), tasks: [{ id: 'T1', goal: 'offline test' }],
      guardian: { allowedPaths: ['tests/**'] }, autoCommit: false,
      scheduled_start_at: at, schedule_source: 'deepseek_off_peak',
    }),
  })
  assert.equal(result.status, 202)
  assert.equal(first.calls(), 0)
  assert.equal(first.launchpad.getConfigs()[0]?.status, 'SCHEDULED')
  assert.match(await (await sessionFetch(url)).text(), /DeepSeek 闲时 · Off-Peak/)
  const { controlUrl } = await result.json() as { controlUrl: string }
  await mintSession(first.apps[0]!.server)
  const snapshot = await (await sessionFetch(`${controlUrl}/api/status`)).json() as { runtime: { state: string; startedAt: null; scheduledStartAt: string } }
  assert.equal(snapshot.runtime.state, 'SCHEDULED')
  assert.equal(snapshot.runtime.startedAt, null)
  assert.equal(snapshot.runtime.scheduledStartAt, at)
  await first.launchpad.close()
  const second = await create()
  assert.equal(second.apps.length, 1)
  assert.equal(second.launchpad.getConfigs()[0]?.status, 'SCHEDULED')
  assert.equal(second.calls(), 0)
  await second.launchpad.close()
  now += 7_200_000
  const third = await create()
  const deadline = Date.now() + 5_000
  while (third.apps[0]?.runtime.getDurableState()?.state !== 'COMPLETED' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(third.apps[0]?.runtime.getDurableState()?.state, 'COMPLETED')
  assert.equal(third.calls(), 1)
  await third.launchpad.close()
  const databasePath = join(directory, `${third.apps[0]!.runtime.getRunId()}.db`)
  for (let reopen = 0; reopen < 5; reopen++) {
    // Each Launchpad start creates short-lived status runtimes during discovery
    // and scheduled recovery. Those reads must preserve the durable terminal state.
    const terminal = await create()
    assert.equal(terminal.launchpad.getConfigs()[0]?.status, 'COMPLETED')
    assert.equal(terminal.apps.length, 0)
    assert.equal(terminal.calls(), 0)
    await terminal.launchpad.close()
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok'])
    } finally {
      database.close()
    }
  }
})

test('Launchpad propagates a failed durable status read instead of reporting READY', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-schedule-read-error-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'scheduled.json'), JSON.stringify({
    session: {
      id: 'scheduled-read-error', targetRepo: process.cwd(), branch: 'main',
      scheduledStartAt: '2099-01-01T00:00:00.000Z', scheduleSource: 'custom',
      limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 },
    },
    tasks: [{ id: 'T1', goal: 'read stored state', guardian: {
      constraints: [], acceptanceCriteria: [], doNotDo: [],
      allowedPaths: ['tests/**'], forbiddenPaths: [],
    } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false },
    notification: { email: { enabled: false } },
  }))
  const storageError = Object.assign(new Error('SQLITE_IOERR_SHORT_READ'), { code: 'SQLITE_IOERR', extendedCode: 522 })
  let reads = 0
  let starts = 0
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    async readSessionStatus() { reads++; throw storageError },
    async createWorkSession() { starts++; throw new Error('must not start after a failed durable read') },
    resolveEnvironment: async () => ({}),
  } })
  t.after(() => launchpad.close())
  assert.equal(launchpad.getConfigs().length, 1)
  await assert.rejects(launchpad.start(), (error) => error === storageError)
  assert.equal(reads, 1)
  assert.equal(starts, 0)
  assert.equal(launchpad.getAddress(), undefined)
  assert.equal(launchpad.getConfigs()[0]?.status, undefined)
})
