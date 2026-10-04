import { startOperator, sessionFetch } from './operator-session.js'
/**
 * W005-A remote review closure:
 * - raw launch/runtime failure 不得进入 Web payload；
 * - RUNNING active elapsed 必须包含当前未 settle segment；
 * - active-time SSE snapshot 最多按秒更新且不写 recent event；
 * - SUSPENDED 墙钟时间不计入 active elapsed。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import {
  FakeRuntime,
  makeDefinition,
  makeState,
  postStart,
  sleep,
  startServer,
} from './work-session-w005-a-helpers.js'

const MIN = 60_000

await test('W005-A remote closure: raw launch error never reaches Web surfaces', async () => {
  const s = await startServer()
  try {
    s.runtime.deferStart()

    const res = await postStart(s, { token: s.token, origin: s.address.url })
    assert.equal(res.status, 202)

    s.runtime.startDeferred?.reject(
      new Error('Authorization: Bearer SUPER_SECRET_LAUNCH'),
    )
    await s.controller.getStartPromise()
    await sleep(30)

    const statusText = await (await sessionFetch(`${s.address.url}/api/status`)).text()
    const recentText = JSON.stringify(s.controller.getRecentEvents())
    const snapshotText = JSON.stringify(s.controller.getSnapshot())

    for (const text of [statusText, recentText, snapshotText]) {
      assert.ok(!text.includes('SUPER_SECRET_LAUNCH'))
      assert.ok(!text.includes('Bearer'))
    }

    assert.ok(
      s.controller.getRecentEvents().some(
        (event) =>
          event.type === 'SESSION_FAILED' &&
          event.data.message === 'Work Session 失败。请检查本地诊断信息。',
      ),
    )
  } finally {
    await s.server.close()
  }
})

await test('W005-A remote closure: durable failureReason never reaches Web surfaces', async () => {
  const s = await startServer({ pollIntervalMs: 10 })
  try {
    s.runtime.state = makeState({ state: 'RUNNING' })
    await sleep(30)

    s.runtime.state = makeState({
      state: 'FAILED',
      failureReason: 'https://user:password@example.com/repo.git',
    })
    await sleep(40)

    const statusText = await (await sessionFetch(`${s.address.url}/api/status`)).text()
    const recentText = JSON.stringify(s.controller.getRecentEvents())
    const snapshotText = JSON.stringify(s.controller.getSnapshot())

    for (const text of [statusText, recentText, snapshotText]) {
      assert.ok(!text.includes('password'))
      assert.ok(!text.includes('user:password'))
      assert.ok(!text.includes('example.com'))
    }

    assert.equal(s.controller.getSnapshot().runtime.state, 'FAILED')
    assert.ok(
      s.controller.getRecentEvents().some(
        (event) =>
          event.type === 'SESSION_FAILED' &&
          event.data.message === 'Work Session 失败。请检查本地诊断信息。',
      ),
    )
  } finally {
    await s.server.close()
  }
})

await test('W005-A ACTIVE-1: RUNNING display elapsed includes current active segment', async () => {
  let now = 8 * MIN
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({
    state: 'RUNNING',
    activeElapsedMs: 5 * MIN,
    activeSegmentStartedAt: 0,
  })

  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    pollIntervalMs: 10,
    clock: { now: () => now },
  })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await startOperator(server)
  try {
    const status = (await (await sessionFetch(`${address.url}/api/status`)).json()) as {
      runtime: { activeElapsedMs?: number }
    }
    assert.equal(status.runtime.activeElapsedMs, 13 * MIN)

    now += 1
    const next = controller.getSnapshot()
    assert.equal(next.runtime.activeElapsedMs, 13 * MIN + 1)
  } finally {
    await server.close()
  }
})

await test('W005-A ACTIVE-2: elapsed second change broadcasts snapshot without recent event spam', async () => {
  let now = 8 * MIN
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({
    state: 'RUNNING',
    activeElapsedMs: 5 * MIN,
    activeSegmentStartedAt: 0,
  })

  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    pollIntervalMs: 10,
    clock: { now: () => now },
  })

  const snapshots: number[] = []
  const eventsBefore = controller.getRecentEvents().length
  const unsubscribe = controller.subscribe({
    onEvent: () => {},
    onSnapshot: (snapshot) => {
      if (snapshot.runtime.activeElapsedMs !== undefined) {
        snapshots.push(snapshot.runtime.activeElapsedMs)
      }
    },
  })

  try {
    await sleep(30)
    const baselineSnapshotCount = snapshots.length
    const baselineEventCount = controller.getRecentEvents().length

    now += 2_000
    await sleep(40)

    assert.ok(snapshots.length > baselineSnapshotCount)
    assert.equal(snapshots.at(-1), 13 * MIN + 2_000)
    assert.equal(controller.getRecentEvents().length, baselineEventCount)
    assert.equal(eventsBefore, 0)
  } finally {
    unsubscribe()
    controller.close()
  }
})

await test('W005-A ACTIVE-3: SUSPENDED wall-clock time does not increase display elapsed', async () => {
  let now = 8 * MIN
  const runtime = new FakeRuntime(makeDefinition())
  runtime.state = makeState({
    state: 'SUSPENDED',
    activeElapsedMs: 13 * MIN,
    humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
  })

  const controller = new WorkSessionControlController({
    createRuntime: () => runtime,
    pollIntervalMs: 10,
    clock: { now: () => now },
  })
  try {
    assert.equal(controller.getSnapshot().runtime.activeElapsedMs, 13 * MIN)
    now += 3 * 60 * MIN
    assert.equal(controller.getSnapshot().runtime.activeElapsedMs, 13 * MIN)
  } finally {
    controller.close()
  }
})
