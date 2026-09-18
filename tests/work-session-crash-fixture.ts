/** A real process crash after the second task's RUNNING boundary is durable. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
  type WorkSessionDurableState,
  type WorkSessionTaskResult,
} from 'nova-wing/development-guardian'

type InterruptedState = Pick<WorkSessionDurableState, 'sessionId' | 'state' | 'currentTaskId' | 'completedTaskIds'>
interface CrashReady {
  type: 'T2_DURABLE'
  state: InterruptedState
  sideEffects: Array<[string, number]>
}

export async function crashAtSecondTask(
  definition: WorkSessionDefinition,
  storageUrl: string,
  sideEffects?: Map<string, number>,
): Promise<InterruptedState> {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env
  const child = fork(new URL('./work-session-crash-fixture.js', import.meta.url), [
    '--crash-child', JSON.stringify({ definition, storageUrl }),
  ], { execPath: process.execPath, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64_000) })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64_000) })
  const terminated = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    const ready = await new Promise<CrashReady>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Crash fixture did not reach durable T2 within 15 seconds')), 15_000)
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`Crash fixture exited before T2: code=${code}, signal=${signal}`)))
      child.on('message', (message: unknown) => {
        if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'T2_DURABLE') {
          resolve(message as CrashReady)
        }
      })
    })
    clearTimeout(timeout)
    assert.equal(ready.state.sessionId, definition.id)
    assert.equal(ready.state.state, 'RUNNING')
    assert.equal(ready.state.currentTaskId, 'T2')
    assert.deepEqual(ready.state.completedTaskIds, ['T1'])
    assert.deepEqual(ready.sideEffects, [['T1', 1], ['T2', 1]])
    // Deliberately skip graceful runtime.close(): this fixture represents an
    // unexpected process death. kill() is supported on Windows as well as POSIX.
    assert.equal(child.kill('SIGKILL'), true, 'the fixture process must actually be killed')
    const exit = await terminated
    assert.ok(exit.signal === 'SIGKILL' || (process.platform === 'win32' && exit.code !== null && exit.code !== 0),
      `fixture must exit from the requested crash: ${JSON.stringify(exit)}`)
    for (const [taskId, calls] of ready.sideEffects) {
      sideEffects?.set(taskId, (sideEffects.get(taskId) ?? 0) + calls)
    }
    return ready.state
  } catch (cause) {
    throw new Error(`Work Session crash fixture failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause })
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await terminated
  }
}

if (process.argv[2] === '--crash-child') {
  // Keep the IPC channel alive while the task waits for the parent's crash.
  process.on('message', () => undefined)
  const input = JSON.parse(process.argv[3]!) as { definition: WorkSessionDefinition; storageUrl: string }
  const sideEffects = new Map<string, number>()
  const runtime: WorkSessionRuntime = new WorkSessionRuntime({
    definition: input.definition,
    storageUrl: input.storageUrl,
    taskRunner: {
      async run(task): Promise<WorkSessionTaskResult> {
        sideEffects.set(task.id, (sideEffects.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') return { status: 'COMPLETED' }
        assert.equal(task.id, 'T2')
        // Read back through the actual workflow store; reporting in-memory
        // state alone would not prove the parent can recover after the kill.
        const state = await runtime.loadPersistedState()
        assert.ok(state)
        const message: CrashReady = { type: 'T2_DURABLE', state, sideEffects: [...sideEffects] }
        await new Promise<void>((resolve, reject) => {
          assert.ok(process.send)
          process.send(message, undefined, undefined, (error) => error ? reject(error) : resolve())
        })
        return new Promise<never>(() => undefined)
      },
    },
  })
  runtime.start().then(() => {
    throw new Error('Crash fixture unexpectedly completed before the parent killed it')
  }).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
    process.disconnect?.()
  })
}
