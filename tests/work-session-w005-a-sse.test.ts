/**
 * W005-A SSE — text/event-stream、connected/snapshot/activity/guardian、
 * 状态变化广播、subscriber cleanup、shutdown。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { GuardianProgressEvent } from '../packages/development-guardian/progress.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import {
  startServer,
  makeState,
  sleep,
  FakeRuntime,
  makeDefinition,
} from './work-session-w005-a-helpers.js'

interface SseClient {
  reader: ReadableStreamDefaultReader<Uint8Array>
  buffer: string
}

async function openSse(url: string): Promise<SseClient> {
  const res = await fetch(url)
  if (!res.body) {
    throw new Error('SSE response has no body')
  }
  return { reader: res.body.getReader(), buffer: '' }
}

async function readUntil(
  client: SseClient,
  predicate: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  while (!predicate(client.buffer)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('SSE read timed out')
    }
    const result = await Promise.race([
      client.reader.read(),
      new Promise<{ value: undefined; done: false }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: false }), Math.min(remaining, 200)),
      ),
    ])
    if (result.done) {
      break
    }
    if (result.value !== undefined) {
      client.buffer += decoder.decode(result.value, { stream: true })
    }
  }
  return client.buffer
}

await test('W005-A SSE: text/event-stream with connected + snapshot', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.address.url}/api/events`)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const client: SseClient = { reader: res.body!.getReader(), buffer: '' }
    const text = await readUntil(client, (t) => t.includes('event: snapshot'))
    assert.ok(text.includes('event: connected'), 'must receive connected first')
    assert.ok(text.includes('event: snapshot'), 'must receive initial snapshot')
  } finally {
    await s.server.close()
  }
})

await test('W005-A SSE: observes RUNNING → T1 → completed T1 → SUSPENDED HUMAN_REQUIRED', async () => {
  const s = await startServer()
  try {
    const client = await openSse(`${s.address.url}/api/events`)
    await readUntil(client, (t) => t.includes('event: snapshot'))

    // 基线：RUNNING 且无 current task（首次 poll 建立 prev 基线）
    s.runtime.state = makeState({ state: 'RUNNING' })
    await sleep(60)

    // RUNNING + current T1
    s.runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1' })
    await readUntil(client, (t) => t.includes('TASK_STARTED'))

    // T1 completed（currentTaskId 保持 T1，与真实 runtime 一致）
    s.runtime.state = makeState({
      state: 'RUNNING',
      currentTaskId: 'T1',
      completedTaskIds: ['T1'],
    })
    await readUntil(client, (t) => t.includes('TASK_COMPLETED'))

    // SUSPENDED HUMAN_REQUIRED
    s.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      completedTaskIds: ['T1'],
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
    })
    const final = await readUntil(
      client,
      (t) => t.includes('HUMAN_REQUIRED') && t.includes('DECISION_REQUIRED'),
    )
    assert.ok(final.includes('choose database mode'))
  } finally {
    await s.server.close()
  }
})

await test('W005-A SSE: guardian progress maps to event: guardian', async () => {
  const runtime = new FakeRuntime(makeDefinition())
  let emitProgress: ((event: GuardianProgressEvent) => void) | undefined
  const controller = new WorkSessionControlController({
    createRuntime: (eventSink) => {
      emitProgress = eventSink
      return runtime
    },
    pollIntervalMs: 10,
  })
  const server = new WorkSessionControlServer({ controller, port: 0 })
  const address = await server.start()
  try {
    const client = await openSse(`${address.url}/api/events`)
    await readUntil(client, (t) => t.includes('event: connected'))

    emitProgress?.({ phase: 'REVIEWING', status: 'active', iteration: 1, elapsedMs: 100 })
    const text = await readUntil(client, (t) => t.includes('event: guardian'))
    assert.ok(text.includes('"phase":"REVIEWING"'))
  } finally {
    await server.close()
  }
})

await test('W005-A SSE: subscriber count returns to 0 after client disconnect', async () => {
  const s = await startServer()
  try {
    const client = await openSse(`${s.address.url}/api/events`)
    await readUntil(client, (t) => t.includes('event: connected'))
    assert.equal(s.controller.getSubscriberCount(), 1)

    await client.reader.cancel()
    await sleep(80)
    assert.equal(s.controller.getSubscriberCount(), 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A shutdown: close clears SSE clients, polling timer, and http listener', async () => {
  const s = await startServer()
  // 触发 polling timer
  const res = await fetch(`${s.address.url}/api/session/start`, {
    method: 'POST',
    headers: { 'X-NovaWing-Control-Token': s.token, Origin: s.address.url },
  })
  assert.equal(res.status, 202)

  const client = await openSse(`${s.address.url}/api/events`)
  await readUntil(client, (t) => t.includes('event: connected'))
  assert.equal(s.controller.getSubscriberCount(), 1)

  // close 必须正常返回（不挂进程、不留 open handle）
  await s.server.close()
  assert.equal(s.controller.getSubscriberCount(), 0)
})
