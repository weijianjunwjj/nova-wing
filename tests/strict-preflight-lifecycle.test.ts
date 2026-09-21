import assert from 'node:assert/strict'
import { type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runProductionDependencyPreflight } from '../packages/development-guardian/work-session/dependency-health.js'

class ProbeWorker extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kills = 0
  kill() { this.kills++; return true }
}

function workers() {
  const children: ProbeWorker[] = []
  const waiting = new Map<number, (child: ProbeWorker) => void>()
  let finishing = false
  const finish = (child: ProbeWorker) => {
    child.stdout.write('5.2.37|MINGW64|msys')
    child.emit('close', 0)
    child.stdout.destroy()
    child.stderr.destroy()
  }
  const spawnProcess = ((_command: string, _args: readonly string[], options: { shell: boolean; windowsHide: boolean }) => {
    assert.equal(options.shell, false)
    assert.equal(options.windowsHide, true)
    const child = new ProbeWorker()
    children.push(child)
    waiting.get(children.length)?.(child)
    if (finishing) queueMicrotask(() => finish(child))
    return child
  }) as unknown as typeof spawn
  return {
    spawnProcess,
    children,
    spawned(count: number) {
      const child = children[count - 1]
      return child === undefined ? new Promise<ProbeWorker>((resolve) => waiting.set(count, resolve)) : Promise.resolve(child)
    },
    finishAll() {
      finishing = true
      for (const child of children) finish(child)
    },
  }
}

function run(spawnProcess: typeof spawn, shutdownMode?: 'strict' | 'bounded') {
  return runProductionDependencyPreflight({
    platform: 'win32', controlPlane: 'v2', executorModes: ['codex'],
    env: { NOVAWING_GIT_BASH_PATH: 'D:/Git/bin/bash.exe' },
    accessFile: async () => undefined,
    inspectCodex: async () => undefined,
    timeoutMs: 10,
    spawnProcess,
    ...(shutdownMode === undefined ? {} : { shutdownMode }),
  })
}

async function assertPending(operation: Promise<unknown>) {
  let settled = false
  void operation.then(() => { settled = true }, () => { settled = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'strict preflight must retain the probe until child close')
}

for (const outcome of ['timeout', 'error'] as const) {
  test(`strict dependency preflight waits for child close after ${outcome} and reports unavailable`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workers()
    const operation = run(fixture.spawnProcess, 'strict')
    try {
      const child = await fixture.spawned(1)
      child.stdout.write('5.2.37|MINGW64|msys')
      if (outcome === 'timeout') {
        context.mock.timers.tick(10)
        assert.equal(child.kills, 1)
      } else {
        child.emit('error', new Error('controlled spawn failure'))
      }
      await assertPending(operation)
      child.emit('exit', 0)
      await assertPending(operation)
      child.emit('close', 0)
      const report = await operation
      assert.equal(report.canStart, false)
      assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
      assert.equal(report.dependencies.find((item) => item.id === 'SHELL')?.state, 'UNAVAILABLE')
      assert.equal(fixture.children.length, 1, 'a failed shell cannot dispatch follow-up probes')
    } finally {
      fixture.finishAll()
      await operation
    }
  })

  test(`default dependency preflight retains bounded completion after ${outcome}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = workers()
    const operation = run(fixture.spawnProcess)
    try {
      const child = await fixture.spawned(1)
      if (outcome === 'timeout') context.mock.timers.tick(10)
      else child.emit('error', new Error('controlled spawn failure'))
      const report = await operation
      assert.equal(report.canStart, false)
      assert.equal(report.overall, 'ENVIRONMENT_REQUIRED')
      assert.equal(fixture.children.length, 1)
      assert.equal(child.kills, outcome === 'timeout' ? 1 : 0)
    } finally {
      fixture.finishAll()
      await operation
    }
  })
}

test('strict dependency preflight waits for close on every successful probe and preserves READY', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = workers()
  const operation = run(fixture.spawnProcess, 'strict')
  try {
    const shell = await fixture.spawned(1)
    shell.stdout.write('5.2.37|MINGW64|msys')
    shell.emit('exit', 0)
    await assertPending(operation)
    assert.equal(fixture.children.length, 1)
    shell.emit('close', 0)
    const git = await fixture.spawned(2)
    git.emit('exit', 0)
    await assertPending(operation)
    git.emit('close', 0)
    const report = await operation
    assert.equal(report.canStart, true)
    assert.equal(report.overall, 'READY')
    assert.equal(report.dependencies.find((item) => item.id === 'SHELL')?.state, 'READY')
    assert.equal(report.dependencies.find((item) => item.id === 'GIT')?.state, 'READY')
    assert.equal(fixture.children.length, 2)
    assert.ok(fixture.children.every((child) => child.kills === 0))
  } finally {
    fixture.finishAll()
    await operation
  }
})
