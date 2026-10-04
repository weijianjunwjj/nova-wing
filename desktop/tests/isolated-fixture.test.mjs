import { sessionFetch as fetch, mintSession } from './operator-session.mjs'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createNovaWingLaunchpad } from 'nova-wing/development-guardian'
import { createIsolatedLaunchpadFixture } from '../main/isolated-fixture.mjs'
import { createDesktopIsolation } from '../../scripts/desktop-isolation.mjs'

test('isolated fixture uses real Launchpad, production UI and persisted Runtime with one gated fake task', async () => {
  const isolation = await createDesktopIsolation()
  const { root } = isolation
  let fixture
  let launchpad
  try {
    fixture = await createIsolatedLaunchpadFixture({ root, env: {}, holdTasks: true })
    launchpad = await createNovaWingLaunchpad({ configDirectory: fixture.configDirectory, env: fixture.env, dependencies: fixture.dependencies })
    const address = await launchpad.start()
    const headers = { 'Content-Type': 'application/json', Origin: address.url, 'Cookie': await mintSession(launchpad) }
    const outside = await fetch(`${address.url}/api/session/create`, {
      method: 'POST', headers, body: JSON.stringify({ ...fixture.createRequest, requestId: 'desktop-blocked-fixture-0001', targetRepo: root }),
    })
    assert.notEqual(outside.status, 202)
    assert.equal(fixture.getEvidence().runtimeCreateCount, 0)
    const response = await fetch(`${address.url}/api/session/create`, { method: 'POST', headers, body: JSON.stringify(fixture.createRequest) })
    const result = await response.json()
    assert.equal(response.status, 202, JSON.stringify(result))
    assert.match(result.controlUrl, /^http:\/\/127\.0\.0\.1:\d+$/u)
    const deadline = Date.now() + 15_000
    while (fixture.getEvidence().taskRunCount === 0 && Date.now() < deadline) await delay(20)
    assert.equal(fixture.getEvidence().taskRunCount, 1)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 0)
    const running = await (await fetch(`${result.controlUrl}/api/status`)).json()
    assert.equal(running.runtime.state, 'RUNNING')
    fixture.releaseTasks()
    while (fixture.getEvidence().sessions[0]?.durableState?.state !== 'COMPLETED' && Date.now() < deadline) await delay(20)
    const states = await fixture.getPersistedStates()
    assert.equal(states[0].state, 'COMPLETED')
    assert.deepEqual(states[0].completedTaskIds, ['DESKTOP-SMOKE-001'])
    assert.equal(fixture.getEvidence().productionUiCreateCount, 1)
    assert.equal(fixture.getEvidence().runtimeCreateCount, 1)
    assert.equal(fixture.getEvidence().fakeExecutionCount, 1)
    assert.equal(fixture.getEvidence().forbiddenCapabilityAttempts, 0)
    await launchpad.close()
    assert.equal(fixture.getEvidence().runtimeCloseCount, 1)
  } finally {
    fixture?.releaseTasks()
    await launchpad?.close()
    await isolation.cleanup()
  }
})
