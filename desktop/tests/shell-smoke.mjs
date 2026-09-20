import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'

async function runShellSmoke() {
  const root = process.env.NOVAWING_DESKTOP_SMOKE_ROOT
  const result = { result: 'FAIL', checks: {}, childPids: [], errors: [] }
  try {
    assert.ok(root && isAbsolute(root) && basename(root).startsWith('novawing-desktop-smoke-'))
    assert.equal(resolve(process.cwd()), join(root, 'repo'))
    for (const [name, directory] of Object.entries({
      userData: 'electron-user-data', sessionData: 'electron-session-data', crashDumps: 'crash-dumps',
    })) {
      const path = join(root, directory)
      mkdirSync(path, { recursive: true })
      app.setPath(name, path)
    }
    const { bootstrapReady } = await import('../main/index.mjs')
    const bootstrapWindow = await bootstrapReady
    assert.equal(bootstrapWindow.isVisible(), true)
    assert.equal(bootstrapWindow.webContents.getTitle(), 'NovaWing Desktop Bootstrap')
    const nodeAccess = await bootstrapWindow.webContents.executeJavaScript(
      '({ require: typeof require, process: typeof process })',
    )
    assert.deepEqual(nodeAccess, { require: 'undefined', process: 'undefined' })
    result.checks = { shell_start: { status: 'PASS' }, renderer_node_access: { status: 'PASS' } }
    result.childPids = app.getAppMetrics().map(({ pid }) => pid).filter((pid) => pid !== process.pid)
    // Exercise the actual window-all-closed -> app.quit policy from the dev entry.
    const closed = once(bootstrapWindow, 'closed')
    bootstrapWindow.close()
    await closed
    assert.equal(bootstrapWindow.isDestroyed(), true)
    result.checks.window_close = { status: 'PASS' }
    result.result = 'PASS'
  } catch (error) {
    result.errors.push(String(error?.stack ?? error))
    process.exitCode = 1
    app.quit()
  } finally {
    console.log(`DESKTOP_SHELL_RESULT ${JSON.stringify(result)}`)
  }
}

void runShellSmoke()
