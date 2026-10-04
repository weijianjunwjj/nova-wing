import { sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeState, startServer, type StartedServer } from './work-session-w005-a-helpers.js'

async function postControl(
  server: StartedServer,
  path: string,
  options: { token?: string; origin?: string; body?: string; contentType?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers['Cookie'] = options.token
  if (options.origin !== undefined) headers.Origin = options.origin
  if (options.contentType !== undefined) headers['Content-Type'] = options.contentType
  const response = await sessionFetch(`${server.address.url}${path}`, {
    method: 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
  return { status: response.status, body: await response.text() }
}

await test('W005-B B1 control endpoints expose intent separately from durable state', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1' })

    const pause = await postControl(server, '/api/session/pause', {
      token: server.token,
      origin: server.address.url,
    })
    assert.equal(pause.status, 202)
    assert.equal(server.runtime.state.state, 'RUNNING', 'click must not fake SUSPENDED')
    assert.equal(server.controller.getSnapshot().controls.pauseRequested, true)
    assert.equal(
      server.controller.getRecentEvents().at(-1)?.type,
      'PAUSE_REQUESTED',
    )

    const duplicatePause = await postControl(server, '/api/session/pause', {
      token: server.token,
      origin: server.address.url,
    })
    assert.equal(duplicatePause.status, 409)

    const stop = await postControl(server, '/api/session/stop-after-task', {
      token: server.token,
      origin: server.address.url,
    })
    assert.equal(stop.status, 202)
    assert.equal(server.controller.getSnapshot().controls.stopAfterTaskRequested, true)
    assert.equal(
      server.controller.getRecentEvents().at(-1)?.type,
      'STOP_AFTER_TASK_REQUESTED',
    )
  } finally {
    await server.server.close()
  }
})

await test('W005-B B1 control endpoints preserve W005-A mutation gates', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1' })

    assert.equal((await postControl(server, '/api/session/pause')).status, 403)
    assert.equal((await postControl(server, '/api/session/stop-after-task', {
      token: server.token,
      origin: 'http://evil.example',
    })).status, 403)

    const oversized = 'x'.repeat(4097)
    assert.equal((await postControl(server, '/api/session/pause', {
      token: server.token,
      origin: server.address.url,
      body: oversized,
    })).status, 413)
    assert.equal(server.runtime.pauseRequested, false)
  } finally {
    await server.server.close()
  }
})

await test('W005-B B1 control requests reject non-RUNNING states', async () => {
  for (const state of ['READY', 'SUSPENDED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    const server = await startServer()
    try {
      server.runtime.state = makeState({ state })
      assert.equal((await postControl(server, '/api/session/pause', {
        token: server.token,
        origin: server.address.url,
      })).status, 409)
      assert.equal((await postControl(server, '/api/session/stop-after-task', {
        token: server.token,
        origin: server.address.url,
      })).status, 409)
    } finally {
      await server.server.close()
    }
  }
})

await test('W005-B RESUME-B/C/D: background resume is non-echoing and concurrency guarded', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose database mode' },
    })
    server.runtime.deferResume()
    const sensitiveDecision = 'Authorization: Bearer SECRET'
    const first = await postControl(server, '/api/session/resume', {
      token: server.token,
      origin: server.address.url,
      contentType: 'application/json',
      body: JSON.stringify({ decision: sensitiveDecision }),
    })
    assert.equal(first.status, 202)
    assert.equal(server.runtime.resumeCalls, 1)

    const duplicate = await postControl(server, '/api/session/resume', {
      token: server.token,
      origin: server.address.url,
      contentType: 'application/json',
      body: JSON.stringify({ decision: 'another' }),
    })
    assert.equal(duplicate.status, 409)

    // Even if a later provider-derived blocker repeats the decision verbatim,
    // the control plane must not echo it.
    server.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      humanRequired: {
        category: 'DECISION_REQUIRED',
        reason: `provider repeated ${sensitiveDecision}`,
      },
    })
    const status = await sessionFetch(`${server.address.url}/api/status`).then((response) => response.text())
    const observations = JSON.stringify(server.controller.getRecentEvents()) + status
    assert.doesNotMatch(observations, /Authorization: Bearer SECRET/)
    assert.deepEqual(
      server.controller.getRecentEvents().slice(-2).map((event) => event.type),
      ['SESSION_RESUME_REQUESTED', 'SESSION_RESUMED'],
    )
    assert.deepEqual(server.controller.getRecentEvents().at(-1)?.data, {
      taskId: 'T1',
      category: 'DECISION_REQUIRED',
    })

    server.runtime.resumeDeferred?.resolve(makeState({ state: 'COMPLETED' }))
    await server.controller.getResumePromise()
    assert.equal(
      server.controller.getRecentEvents().filter((event) => event.type === 'SESSION_RESUMED').length,
      1,
    )
    assert.doesNotMatch(JSON.stringify(server.controller.getRecentEvents()), /SECRET/)
  } finally {
    await server.server.close()
  }
})

await test('W005-B RESUME-C: non-SUSPENDED state returns 409', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({ state: 'RUNNING', currentTaskId: 'T1' })
    const response = await postControl(server, '/api/session/resume', {
      token: server.token,
      origin: server.address.url,
      contentType: 'application/json',
      body: JSON.stringify({ decision: 'docker' }),
    })
    assert.equal(response.status, 409)
    assert.equal(server.runtime.resumeCalls, 0)
  } finally {
    await server.server.close()
  }
})

await test('resume-recoverable keeps unresolved decisions gated but accepts domain-reconciled approval', async () => {
  const unresolved = await startServer()
  try {
    unresolved.runtime.state = makeState({
      state: 'SUSPENDED', currentTaskId: 'T023',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose migration policy' },
    })
    const rejected = await postControl(unresolved, '/api/session/resume-recoverable', {
      token: unresolved.token, origin: unresolved.address.url,
      contentType: 'application/json', body: '{}',
    })
    assert.equal(rejected.status, 409)
    assert.match(rejected.body, /a decision is required/u)
    assert.equal(unresolved.runtime.durableVerificationRecoveryCalls, 0)
  } finally {
    await unresolved.server.close()
  }

  const recoverable = await startServer()
  try {
    recoverable.runtime.state = makeState({
      state: 'SUSPENDED', currentTaskId: 'T023',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'stale verification blocker' },
    })
    recoverable.runtime.durableVerificationRecoveryAvailable = true
    const accepted = await postControl(recoverable, '/api/session/resume-recoverable', {
      token: recoverable.token, origin: recoverable.address.url,
      contentType: 'application/json', body: '{}',
    })
    assert.equal(accepted.status, 202)
    await recoverable.controller.getResumePromise()
    assert.equal(recoverable.runtime.durableVerificationRecoveryCalls, 1)
    assert.equal(recoverable.runtime.resumeCalls, 0)
    assert.deepEqual(recoverable.runtime.resumeInputs, [], 'must not fabricate user resume input')
  } finally {
    await recoverable.server.close()
  }
})

await test('W005-B resume policy accepts only category-specific safe input', async () => {
  const allowed = [
    { category: 'DECISION_REQUIRED', body: { decision: 'docker' } },
    { category: 'STALLED', body: { decision: 'continue with option B' } },
    { category: 'ENVIRONMENT_REQUIRED', body: { approval: true } },
    { category: 'CREDENTIAL_REQUIRED', body: { approval: true } },
  ] as const
  for (const item of allowed) {
    const server = await startServer()
    try {
      server.runtime.state = makeState({
        state: 'SUSPENDED',
        currentTaskId: 'T1',
        humanRequired: { category: item.category, reason: 'resolve outside' },
      })
      const response = await postControl(server, '/api/session/resume', {
        token: server.token,
        origin: server.address.url,
        contentType: 'application/json',
        body: JSON.stringify(item.body),
      })
      assert.equal(response.status, 202, item.category)
      assert.equal(server.runtime.resumeCalls, 1)
    } finally {
      await server.server.close()
    }
  }

  const rejected = [
    'PERMISSION_REQUIRED',
    'SAFETY_BLOCKED',
    'REPO_DRIFT',
    'BUDGET_EXHAUSTED',
  ]
  for (const category of rejected) {
    const server = await startServer()
    try {
      server.runtime.state = makeState({
        state: 'SUSPENDED',
        currentTaskId: 'T1',
        humanRequired: { category, reason: 'blocked' },
      })
      const response = await postControl(server, '/api/session/resume', {
        token: server.token,
        origin: server.address.url,
        contentType: 'application/json',
        body: JSON.stringify({ approval: true }),
      })
      assert.equal(response.status, 409, category)
      assert.equal(server.runtime.resumeCalls, 0, category)
    } finally {
      await server.server.close()
    }
  }
})

await test('W005-B RESUME-G: USER_PAUSED accepts only empty object', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      suspensionReason: 'USER_PAUSED',
    })
    const accepted = await postControl(server, '/api/session/resume', {
      token: server.token,
      origin: server.address.url,
      contentType: 'application/json',
      body: '{}',
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(server.runtime.resumeInputs, [{}])
  } finally {
    await server.server.close()
  }

  const server2 = await startServer()
  try {
    server2.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      suspensionReason: 'USER_PAUSED',
    })
    const rejected = await postControl(server2, '/api/session/resume', {
      token: server2.token,
      origin: server2.address.url,
      contentType: 'application/json',
      body: JSON.stringify({ decision: 'not allowed' }),
    })
    assert.equal(rejected.status, 409)
    assert.equal(server2.runtime.resumeCalls, 0)
  } finally {
    await server2.server.close()
  }
})

await test('W005-B resume schema rejects malformed, unknown, credential and oversized input', async () => {
  const server = await startServer()
  try {
    server.runtime.state = makeState({
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose' },
    })
    const base = {
      token: server.token,
      origin: server.address.url,
      contentType: 'application/json',
    }
    assert.equal((await postControl(server, '/api/session/resume', {
      ...base,
      body: '{bad',
    })).status, 400)
    assert.equal((await postControl(server, '/api/session/resume', {
      ...base,
      body: JSON.stringify({ decision: 'docker', extra: true }),
    })).status, 400)
    assert.equal((await postControl(server, '/api/session/resume', {
      ...base,
      body: JSON.stringify({ credential: 'SECRET' }),
    })).status, 400)
    assert.equal((await postControl(server, '/api/session/resume', {
      token: server.token,
      origin: server.address.url,
      body: '{}',
    })).status, 415)
    assert.equal((await postControl(server, '/api/session/resume', {
      ...base,
      body: JSON.stringify({ decision: 'x'.repeat(4_100) }),
    })).status, 413)
    assert.equal(server.runtime.resumeCalls, 0)
  } finally {
    await server.server.close()
  }
})

await test('W005-B decision UI uses textarea/value/textContent and has no credential input', async () => {
  const server = await startServer()
  try {
    const html = await sessionFetch(`${server.address.url}/`).then((response) => response.text())
    const app = await sessionFetch(`${server.address.url}/app.js`).then((response) => response.text())
    assert.match(html, /<textarea id="decision-input"/)
    assert.doesNotMatch(html, /type="password"/i)
    assert.doesNotMatch(html, /credential-input|api-key|token-input/i)
    assert.match(app, /input\.value\.trim\(\)/)
    assert.match(app, /textContent/)
    assert.doesNotMatch(app, /innerHTML/)
    assert.doesNotMatch(app, /console\./)
  } finally {
    await server.server.close()
  }
})
