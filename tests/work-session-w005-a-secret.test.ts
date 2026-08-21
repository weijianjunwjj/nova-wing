/**
 * W005-A Secret Regression — Guardian raw detail / credential 不得进入浏览器。
 *
 * GuardianProgressEvent.detail 即使携带 bearer token / credential URL，
 * 也不得出现在 /api/status、SSE、recentEvents / debug payload。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import type { GuardianProgressEvent } from '../packages/development-guardian/progress.js'
import { FakeRuntime, makeDefinition } from './work-session-w005-a-helpers.js'

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

await test('W005-A secret: guardian raw detail never reaches browser surfaces', async () => {
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
    emitProgress?.({
      phase: 'REVIEWING',
      status: 'active',
      iteration: 1,
      elapsedMs: 100,
      detail: 'Authorization: Bearer SUPER_SECRET_TOKEN',
    })

    // 1. /api/status snapshot 不含 secret
    const statusBody = await (await fetch(`${address.url}/api/status`)).text()
    assert.ok(!statusBody.includes('SUPER_SECRET_TOKEN'))
    assert.ok(!statusBody.includes('Bearer'))

    // 2. recentEvents / debug payload 不含 secret
    const recentText = JSON.stringify(controller.getRecentEvents())
    assert.ok(!recentText.includes('SUPER_SECRET_TOKEN'))

    // 3. SSE guardian event 不含 secret / credential
    const client = await openSse(`${address.url}/api/events`)
    await readUntil(client, (t) => t.includes('event: snapshot'))

    emitProgress?.({
      phase: 'EXECUTING',
      status: 'active',
      iteration: 1,
      elapsedMs: 200,
      detail: 'cloning https://user:password@example.com/repo.git',
    })
    const sseText = await readUntil(client, (t) => t.includes('event: guardian'))
    assert.ok(!sseText.includes('SUPER_SECRET_TOKEN'))
    assert.ok(!sseText.includes('user:password'))
    assert.ok(!sseText.includes('example.com'))
    assert.ok(!sseText.includes('password'))

    // 结构化字段仍然保留
    assert.ok(sseText.includes('"phase":"EXECUTING"'))
    assert.ok(sseText.includes('"status":"active"'))
  } finally {
    await server.close()
  }
})
