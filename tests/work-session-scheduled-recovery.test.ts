import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createScheduledFixture } from './scheduled-start-fixture.js'

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
    await app.launchpad.start()
    return app
  }
  const first = await create()
  const url = first.launchpad.getAddress()!.url
  const result = await fetch(`${url}/api/session/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-NovaWing-Launchpad-Token': first.launchpad.getTokenForTest() },
    body: JSON.stringify({
      requestId: 'schedule-recovery-http-0001', targetRepo: process.cwd(), tasks: [{ id: 'T1', goal: 'offline test' }],
      guardian: { allowedPaths: ['tests/**'] }, autoCommit: false,
      scheduled_start_at: at, schedule_source: 'deepseek_off_peak',
    }),
  })
  assert.equal(result.status, 202)
  assert.equal(first.calls(), 0)
  assert.equal(first.launchpad.getConfigs()[0]?.status, 'SCHEDULED')
  assert.match(await (await fetch(url)).text(), /DeepSeek 闲时 · Off-Peak/)
  const { controlUrl } = await result.json() as { controlUrl: string }
  const snapshot = await (await fetch(`${controlUrl}/api/status`)).json() as { runtime: { state: string; startedAt: null; scheduledStartAt: string } }
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
  const fourth = await create()
  assert.equal(fourth.launchpad.getConfigs()[0]?.status, 'COMPLETED')
  assert.equal(fourth.apps.length, 0)
  assert.equal(fourth.calls(), 0)
})
