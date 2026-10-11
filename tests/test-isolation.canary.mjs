import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { isolatedNodeTestArgs, supportsIsolationNode } from '../scripts/run-isolated-tests.mjs'
import { platformPaths } from '../dist/packages/development-guardian/platform/paths.js'
import './offline-model-guard.mjs'

const inside = (root, path) => path === root || (isAbsolute(path) && !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)))
test('isolation canary: all default state roots and env:{} stay under temporary HOME', () => {
  const root = process.env.NOVAWING_TEST_ROOT
  assert.ok(root && isAbsolute(root), 'ISOLATION_ROOT_MISSING')
  // userInfo reads the OS account record; construct comparisons only, never inspect these paths.
  const actualHome = userInfo().homedir
  const forbidden = [join(actualHome, 'Library', 'Application Support', 'NovaWing'),
    join(actualHome, 'AppData', 'Local', 'NovaWing'), join(actualHome, '.local', 'share', 'NovaWing')]
  assert.notEqual(homedir(), actualHome, 'HOME_NOT_ISOLATED')
  for (const key of ['HOME', 'USERPROFILE', 'NOVAWING_DATA_DIR', 'NOVAWING_CONFIG_DIR', 'XDG_DATA_HOME',
    'XDG_CONFIG_HOME', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL']) {
    assert.ok(inside(root, process.env[key] ?? ''), `UNSAFE_TEST_ENV:${key}`)
  }
  for (const options of [undefined, { env: {} }]) {
    const paths = platformPaths(options)
    for (const [key, path] of Object.entries(paths)) {
      assert.ok(inside(root, path), `DEFAULT_PATH_ESCAPES_ISOLATION:${key}`)
      assert.equal(forbidden.some(prefix => path === prefix || path.startsWith(prefix + sep)), false, `REAL_PROFILE_PATH:${key}`)
    }
  }
  console.log(`CANARY_TEMP_ROOT=${root}`)
  console.log('CANARY_REAL_PROFILE_REFERENCES=0')
})
test('isolation canary: git identity comes only from the temporary global config', () => {
  const config = process.env.GIT_CONFIG_GLOBAL
  assert.ok(config && inside(process.env.NOVAWING_TEST_ROOT, config), 'GIT_CONFIG_NOT_ISOLATED')
  assert.match(readFileSync(config, 'utf8'), /fixture@example\.invalid/u)
  const value = execFileSync('git', ['config', '--global', '--get', 'user.email'], { encoding: 'utf8' }).trim()
  assert.equal(value, 'fixture@example.invalid')
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
})

test('isolation Node gate: rejects v20 and accepts v24', () => {
  assert.equal(supportsIsolationNode('v20.20.2'), false)
  assert.equal(supportsIsolationNode('v24.0.0'), true)
  assert.equal(supportsIsolationNode('v24.21.0'), true)
  assert.equal(supportsIsolationNode('invalid'), false)
})

test('offline guard rejects live model processes before spawn', () => {
  for (const command of ['codex', 'codex.exe', 'claude']) {
    assert.throws(() => spawn(command, ['exec']), { code: 'OFFLINE_MODEL_CALL_BLOCKED' })
    assert.throws(() => execFileSync(command, ['exec']), { code: 'OFFLINE_MODEL_CALL_BLOCKED' })
  }
})

test('offline guard preserves the execFile Promise result contract', async () => {
  const result = await promisify(execFile)(process.execPath, ['-p', '"offline-fixture"'])
  assert.equal(result.stdout.trim(), 'offline-fixture')
  assert.equal(result.stderr, '')
})

test('isolation preload starts a real test child and blocks an uninstalled model executable', () => {
  const root = process.env.NOVAWING_TEST_ROOT
  assert.ok(root && isAbsolute(root))
  const probe = join(root, 'tmp', 'preload 路径.test.mjs')
  const model = join(root, 'tmp', 'never-installed', 'codex.exe')
  writeFileSync(probe, [
    "import assert from 'node:assert/strict'",
    "import { execFileSync } from 'node:child_process'",
    "import test from 'node:test'",
    `test('preload blocks before process creation', () => assert.throws(() => execFileSync(${JSON.stringify(model)}, ['exec']), { code: 'OFFLINE_MODEL_CALL_BLOCKED' }))`,
  ].join('\n'), { flag: 'wx' })
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const output = execFileSync(process.execPath, isolatedNodeTestArgs([probe]), { env, encoding: 'utf8', timeout: 10_000 })
  assert.match(output, /preload blocks before process creation/u)
})
