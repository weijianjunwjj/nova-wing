import { sessionFetch } from './operator-session.js'
/**
 * W005-A Server Safety — bind / control token / Origin / duplicate / background start / sensitive data
 *
 * CASE A  bind 127.0.0.1 only
 * CASE B  no token → 403
 * CASE C  wrong token → 403
 * CASE D  foreign origin → 403
 * CASE E  same-origin + token → 202
 * CASE F  duplicate start → 409
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

import type { GuardianTaskRecoveryCheckpoint } from '../packages/development-guardian/work-session/index.js'
import {
  startServer,
  postStart,
  makeState,
  sleep,
} from './work-session-w005-a-helpers.js'

await test('W005-A CASE A: server binds 127.0.0.1 only', async () => {
  const s = await startServer()
  try {
    assert.equal(s.address.host, '127.0.0.1')
    assert.notEqual(s.address.host, '0.0.0.0')
    assert.notEqual(s.address.host, '::')
    assert.match(s.address.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CASE B: start without token → 403, runtime not started', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, {})
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CASE C: start with wrong token → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, { token: 'wrong-token' })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CASE D: start with foreign origin → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, { token: s.token, origin: 'http://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CASE E: same-origin + valid token → 202, start count = 1', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, { token: s.token, origin: s.address.url })
    assert.equal(res.status, 202)
    assert.equal(JSON.parse(res.body).accepted, true)
    assert.equal(s.runtime.startCalls, 1)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-A: portless Origin with exact Referer and same-origin metadata → 202', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, {
      token: s.token,
      origin: 'http://127.0.0.1',
      referer: `${s.address.url}/`,
      secFetchSite: 'same-origin',
    })
    assert.equal(res.status, 202)
    assert.equal(s.runtime.startCalls, 1)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-B: portless Origin without Referer → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, {
      token: s.token,
      origin: 'http://127.0.0.1',
      secFetchSite: 'same-origin',
    })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-C: portless Origin with wrong Referer port → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, {
      token: s.token,
      origin: 'http://127.0.0.1',
      referer: 'http://127.0.0.1:9999/',
      secFetchSite: 'same-origin',
    })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-D: portless Origin with cross-site metadata → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, {
      token: s.token,
      origin: 'http://127.0.0.1',
      referer: `${s.address.url}/`,
      secFetchSite: 'cross-site',
    })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-E: foreign Origin remains rejected with a valid token → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, { token: s.token, origin: 'http://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CHROME-LOOPBACK-F: Origin null remains rejected → 403', async () => {
  const s = await startServer()
  try {
    const res = await postStart(s, { token: s.token, origin: 'null' })
    assert.equal(res.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A CASE F: duplicate start → 409, start count stays 1', async () => {
  const s = await startServer()
  try {
    const first = await postStart(s, { token: s.token, origin: s.address.url })
    assert.equal(first.status, 202)
    const second = await postStart(s, { token: s.token, origin: s.address.url })
    assert.equal(second.status, 409)
    assert.equal(s.runtime.startCalls, 1)
  } finally {
    await s.server.close()
  }
})

await test('W005-A background start: 202 returns before runtime promise resolves', async () => {
  const s = await startServer()
  try {
    // 让 runtime.start() 卡在可控 deferred 上
    s.runtime.deferStart()

    const res = await postStart(s, { token: s.token, origin: s.address.url, timeoutMs: 3000 })
    // HTTP 已返回 202，而 deferred 尚未 resolve —— 证明 start 不阻塞整场 Work Session。
    assert.equal(res.status, 202)
    assert.equal(s.runtime.startCalls, 1)

    // 收尾：resolve deferred 让 promise 落地
    s.runtime.startDeferred?.resolve(makeState({ state: 'RUNNING' }))
  } finally {
    await s.server.close()
  }
})

await test('W005-A sensitive data: token/secret never leak into status or events', async () => {
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: {
      id: 'T1',
      goal: 'g',
      state: 'HUMAN_REQUIRED',
      iteration: 1,
      maxIterations: 10,
    },
    provider: {
      chatgptConversationUrl: 'https://chatgpt.example/c/SECRET-CONVO-123',
      claudeSessionId: 'claude-secret-session-456',
    },
    repo: {
      repoPath: '/repo/example',
      branch: 'feat/w005a',
      headSha: 'abcdef1234567890',
      changedFiles: [],
      worktreeFingerprint: 'fp-123',
    },
    capturedAt: '2026-01-01T00:00:00.000Z',
  }

  const s = await startServer()
  try {
    s.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
      currentTaskCheckpoint: checkpoint,
    })

    const statusText = await (await sessionFetch(`${s.address.url}/api/status`)).text()
    assert.ok(!statusText.includes(s.token), 'status must not leak control token')
    assert.ok(!statusText.includes('SECRET-CONVO-123'), 'status must not leak provider url')
    assert.ok(!statusText.includes('claude-secret-session-456'), 'status must not leak session id')

    const html = await (await sessionFetch(`${s.address.url}/`)).text()
    assert.ok(!html.includes(s.token), 'HTML contains no operator credential')
    assert.ok(!html.includes('SECRET-CONVO-123'), 'HTML must not carry provider payload')
    assert.ok(!html.includes('claude-secret-session-456'), 'HTML must not carry session id')
  } finally {
    await s.server.close()
  }
})

/** 发送带自定义 Host header 的请求（模拟 DNS rebinding 攻击）。 */
function requestWithHost(
  port: number,
  path: string,
  method: string,
  hostHeader: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { ...headers, host: hostHeader },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

await test('W005-A CASE P: DNS rebinding Host rejected with 403 on every route', async () => {
  const s = await startServer()
  try {
    const hostileHost = `attacker.example:${s.address.port}`

    const getRoot = await requestWithHost(s.address.port, '/', 'GET', hostileHost)
    assert.equal(getRoot.status, 403)

    const getStatus = await requestWithHost(s.address.port, '/api/status', 'GET', hostileHost)
    assert.equal(getStatus.status, 403)

    const post = await requestWithHost(s.address.port, '/api/session/start', 'POST', hostileHost, {
      'Cookie': s.token,
      Origin: 'http://127.0.0.1',
      Referer: `${s.address.url}/`,
      'Sec-Fetch-Site': 'same-origin',
    })
    assert.equal(post.status, 403)
    assert.equal(s.runtime.startCalls, 0)
  } finally {
    await s.server.close()
  }
})

await test('W005-A background rejection: held promise, no unhandled, SESSION_FAILED', async () => {
  const s = await startServer()
  try {
    s.runtime.deferStart()

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const res = await postStart(s, { token: s.token, origin: s.address.url })
      assert.equal(res.status, 202)

      s.runtime.startDeferred?.reject(new Error('launch exploded'))
      await s.controller.getStartPromise()
      await sleep(30)

      assert.equal(unhandled.length, 0)
      assert.equal(s.controller.getSnapshot().runtime.running, false)
      assert.ok(
        s.controller.getRecentEvents().some((event) => event.type === 'SESSION_FAILED'),
      )

      // server 仍正常响应
      const statusRes = await sessionFetch(`${s.address.url}/api/status`)
      assert.equal(statusRes.status, 200)

      // 没有产生 duplicate writer
      const second = await postStart(s, { token: s.token, origin: s.address.url })
      assert.equal(second.status, 409)
      assert.equal(s.runtime.startCalls, 1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  } finally {
    await s.server.close()
  }
})
