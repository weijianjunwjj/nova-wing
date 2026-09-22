import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { platformPaths } from 'nova-wing/development-guardian'
import { DESKTOP_IDENTITY } from '../main/identity.mjs'

export async function packagedProbe() {
  assert.ok(app.isPackaged)
  const appPath = app.getAppPath()
  const inside = (path) => {
    const value = relative(appPath, path)
    assert.ok(value && !value.startsWith('..') && !isAbsolute(value), `Dependency escaped package: ${path}`)
    return path
  }
  const require = createRequire(join(appPath, 'package.json'))
  assert.equal(process.env.NOVAWING_GIT_BASH_PATH, undefined)
  assert.equal(process.env.NODE_PATH, undefined)
  const loadPlatform = (name) => import(pathToFileURL(join(appPath, 'dist', 'packages', 'development-guardian', 'platform', `${name}.js`)).href)
  const { nativeGitContract } = await loadPlatform('windows-git')
  const { bundledCodexExecutable } = await loadPlatform('codex-runtime')
  const git = nativeGitContract()
  const execute = (executable, args, env = process.env) => {
    const result = spawnSync(executable, args, { cwd: process.cwd(), env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 })
    assert.equal(result.status, 0, `${executable}: ${result.error ?? result.stderr}`)
    return result.stdout.trim()
  }
  const codex = inside(bundledCodexExecutable())
  const version = execute(codex, ['--version'])
  assert.match(version, /codex/u)
  const gitVersion = execute(git.git, ['--version'])
  assert.match(gitVersion, /^git version /u)
  // Only the host whose product contract defines a shell verifies git through that shell.
  const shellGitVersion = git.shell === undefined ? undefined
    : execute(git.shell, ['--noprofile', '--norc', '-lc', 'git --version'], git.environment)
  if (shellGitVersion !== undefined) assert.equal(shellGitVersion, gitVersion)
  const cli = createRequire(import.meta.resolve('@openai/codex-sdk'))
  inside(cli.resolve('@openai/codex/package.json'))
  const mastra = createRequire(require.resolve('@mastra/libsql'))
  const client = createRequire(mastra.resolve('@libsql/client'))
  inside(client.resolve('libsql'))
  assert.equal(app.getVersion(), DESKTOP_IDENTITY.version)
  const pathKey = Object.keys(git.environment).find((name) => name.toUpperCase() === 'PATH')
  return { result: 'PASS', appPath, resourcesPath: process.resourcesPath, execPath: process.execPath,
    cwd: process.cwd(), userData: app.getPath('userData'), businessPaths: platformPaths(),
    identity: DESKTOP_IDENTITY, git: git.git, gitPath: pathKey === undefined ? null : git.environment[pathKey] ?? null,
    gitVersion, shellGitVersion: shellGitVersion ?? null, codex, version,
    nativeModules: Object.keys(require.cache).filter((path) => path.endsWith('.node')).map(inside) }
}
