import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { app } from 'electron'

/** Require the external launcher to create fresh directories before Electron starts. */
export function requireDesktopIsolation() {
  const root = process.env.NOVAWING_DESKTOP_SMOKE_ROOT
  assert.ok(root && isAbsolute(root) && /^novawing-desktop-smoke-[A-Za-z0-9]+$/u.test(basename(root)))
  assert.equal(app.isReady(), false, 'Set isolated Electron paths before ready')
  for (const [value, expected] of [
    [root, root], [process.env.NOVAWING_CONFIG_DIR, join(root, 'config')],
    [process.env.NOVAWING_DATA_DIR, join(root, 'data')], [process.cwd(), join(root, 'repo')],
  ]) {
    assert.ok(value && isAbsolute(value) && lstatSync(value).isDirectory())
    assert.equal(resolve(value), expected)
    assert.equal(realpathSync(value), expected)
  }
  for (const [name, directory] of Object.entries({
    userData: 'electron-user-data', sessionData: 'electron-session-data', crashDumps: 'crash-dumps',
  })) {
    const path = join(root, directory)
    mkdirSync(path, { recursive: true })
    app.setPath(name, path)
  }
  return root
}
