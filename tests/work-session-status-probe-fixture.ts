import { startOperator } from './operator-session.js'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { join } from 'node:path'

import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errorTree)] : [error]
}

const directory = process.argv[2]!
const scenario = process.argv[3]!
const scheduled = scenario === 'scheduled-cleanup'
const loadError = new Error('probe load failed')
const closeError = new Error('probe cleanup failed')
const originalLoad = WorkSessionRuntime.prototype.loadPersistedState
const originalClose = WorkSessionRuntime.prototype.close
let closes = 0

if (scenario === 'load-and-cleanup') {
  WorkSessionRuntime.prototype.loadPersistedState = async function () {
    await originalLoad.call(this)
    throw loadError
  }
}
WorkSessionRuntime.prototype.close = async function () {
  closes++
  await originalClose.call(this)
  if (!scheduled || closes > 1) throw closeError
}

const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, shutdownMode: 'strict', dependencies: {
  analyticsPath: join(directory, 'analytics.db'), readCodexAvailability: () => ({ state: 'available' }),
  createWorkSession: async () => { throw new Error('read-only probe must never create a Production runner') },
} })
try {
  if (scheduled) {
    await startOperator(launchpad)
    assert.equal(closes, 2, 'hydration and scheduled recovery each use a read-only owner')
  } else {
    await assert.rejects(launchpad.start(), (error) => {
      assert.ok(errorTree(error).includes(closeError))
      assert.equal(errorTree(error).includes(loadError), scenario === 'load-and-cleanup')
      return true
    })
    assert.equal(closes, 1)
  }
  await assert.rejects(launchpad.close(), (error) => {
    assert.ok(errorTree(error).includes(closeError))
    assert.equal(errorTree(error).includes(loadError), scenario === 'load-and-cleanup')
    return true
  })
  assert.equal((launchpad as unknown as { server: Server }).server.listening, false)
  process.stdout.write(`STATUS_PROBE_LIFECYCLE_PASS ${scenario}\n`)
} finally {
  await launchpad.close().catch(() => {})
  WorkSessionRuntime.prototype.loadPersistedState = originalLoad
  WorkSessionRuntime.prototype.close = originalClose
}
