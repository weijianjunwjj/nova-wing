import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createResourceTracker } from './resource-tracker.mjs'

test('tracks an unref timer by identity despite replacement of a baseline timer', async () => {
  const baselineTimer = setTimeout(() => {}, 60_000).unref()
  const tracker = createResourceTracker()
  const runtimeTimer = setTimeout(() => {}, 60_000).unref()
  try {
    clearTimeout(baselineTimer)
    await nextTurn()
    const observed = tracker.snapshot()
    assert.equal(observed.created.Timeout, 1)
    assert.equal(observed.live.length, 1)
    assert.equal(observed.live[0].type, 'Timeout')
    assert.equal(observed.live[0].refed, false)

    clearTimeout(runtimeTimer)
    // destroy hooks are delivered on a later turn than clearTimeout.
    await nextTurn()
    await nextTurn()
    assert.deepEqual(tracker.snapshot().live, [])
  } finally {
    clearTimeout(baselineTimer)
    clearTimeout(runtimeTimer)
    tracker.stop()
  }
})
