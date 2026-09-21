import assert from 'node:assert/strict'
import { type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createWindowsToastRepairNotifier } from '../packages/development-guardian/platform/windows-repair-notifier.js'
import { createWindowsToastRuntimeRepairNotifier } from '../packages/development-guardian/platform/windows-runtime-repair-notifier.js'
import { createWindowsTaskRunNotifier } from '../packages/development-guardian/platform/windows-task-run-notifier.js'
import type { WorkSessionCompletedNotification } from '../packages/development-guardian/work-session/notifier.js'

class ControlledWorker extends EventEmitter {
  readonly stderr = new PassThrough()
  kills = 0
  kill() { this.kills++; return true }
}

function workerFixture() {
  const worker = new ControlledWorker()
  let spawns = 0
  const spawnProcess = ((_command: string, _args: readonly string[], options: { windowsHide: boolean }) => {
    assert.equal(options.windowsHide, true)
    spawns++
    return worker
  }) as unknown as typeof spawn
  return { worker, spawnProcess, spawns: () => spawns }
}

const completed: WorkSessionCompletedNotification = {
  notificationId: 'strict-worker-test',
  session: { id: 'strict-worker-session', targetRepo: 'D:/test-fixture', branch: 'main' },
  completedTaskIds: ['STRICT-001'],
  completionReason: 'ALL_TASKS_COMPLETED',
}

function deliver(kind: 'repair' | 'runtime-repair' | 'task', spawnProcess: typeof spawn, shutdownMode?: 'strict' | 'bounded') {
  const options = { platform: 'win32' as const, timeoutMs: 10, spawnProcess, ...(shutdownMode === undefined ? {} : { shutdownMode }) }
  if (kind === 'runtime-repair') {
    return createWindowsToastRuntimeRepairNotifier(options).notify({ kind: 'SUCCESS', sessionId: 'strict-worker-session', summary: 'runtime worker lifecycle test' })
  }
  return kind === 'repair'
    ? createWindowsToastRepairNotifier(options).notify({ kind: 'SUCCESS', targetRepo: 'D:/test-fixture', summary: 'worker lifecycle test' })
    : createWindowsTaskRunNotifier(options).notifyCompleted!(completed)
}

async function assertPending(operation: Promise<unknown>) {
  let settled = false
  void operation.then(() => { settled = true }, () => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'strict notification ownership lasts through child close')
}

for (const kind of ['repair', 'runtime-repair', 'task'] as const) {
  test(`strict ${kind} notification timeout waits for child close and preserves the timeout error`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workerFixture()
    const operation = deliver(kind, fixture.spawnProcess, 'strict')
    const failure = assert.rejects(operation, /timed out/)
    try {
      context.mock.timers.tick(10)
      assert.equal(fixture.spawns(), 1)
      assert.equal(fixture.worker.kills, 1)
      await assertPending(operation)
      fixture.worker.emit('exit', 0)
      await assertPending(operation)
      // Even exit code 0 after a timeout cannot turn delivery into success.
      fixture.worker.emit('close', 0)
      await failure
    } finally {
      fixture.worker.emit('close', 0)
      fixture.worker.stderr.destroy()
      await operation.catch(() => undefined)
    }
  })

  test(`strict ${kind} notification keeps ownership after child error until close`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workerFixture()
    const operation = deliver(kind, fixture.spawnProcess, 'strict')
    const failure = assert.rejects(operation, /spawn failure/)
    try {
      fixture.worker.emit('error', new Error('spawn failure'))
      await assertPending(operation)
      fixture.worker.emit('close', -1)
      await failure
      assert.equal(fixture.spawns(), 1)
    } finally {
      fixture.worker.emit('close', -1)
      fixture.worker.stderr.destroy()
      await operation.catch(() => undefined)
    }
  })

  test(`strict ${kind} notification success waits for child pipes to close after exit`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workerFixture()
    const operation = deliver(kind, fixture.spawnProcess, 'strict')
    try {
      fixture.worker.emit('exit', 0)
      await assertPending(operation)
      fixture.worker.emit('close', 0)
      await operation
      assert.equal(fixture.worker.kills, 0)
    } finally {
      fixture.worker.emit('close', 0)
      fixture.worker.stderr.destroy()
      await operation.catch(() => undefined)
    }
  })

  test(`default ${kind} notification retains bounded timeout compatibility`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workerFixture()
    const operation = deliver(kind, fixture.spawnProcess)
    const failure = assert.rejects(operation, /timed out/)
    try {
      context.mock.timers.tick(10)
      await failure
      assert.equal(fixture.worker.kills, 1)
    } finally {
      fixture.worker.emit('exit', 0)
      fixture.worker.emit('close', 0)
      fixture.worker.stderr.destroy()
      await operation.catch(() => undefined)
    }
  })
}

test('strict task notification reports a failed channel only after worker close', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = workerFixture()
  const notifier = createWindowsTaskRunNotifier({ platform: 'win32', timeoutMs: 10, shutdownMode: 'strict', spawnProcess: fixture.spawnProcess })
  const operation = notifier.notifyChannels!('COMPLETED', completed)
  try {
    context.mock.timers.tick(10)
    await assertPending(operation)
    fixture.worker.emit('close', 0)
    const channels = await operation
    assert.equal(channels.length, 1)
    assert.equal(channels[0]!.status, 'FAILED')
  } finally {
    fixture.worker.emit('close', 0)
    fixture.worker.stderr.destroy()
    await operation
  }
})
