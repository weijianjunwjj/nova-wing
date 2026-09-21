import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveWindowsGitInstallation } from '../packages/development-guardian/platform/windows-git.js'

const install = 'D:\\Tools\\Git'
const files = new Set([`${install}\\bin\\bash.exe`, `${install}\\cmd\\git.exe`, `${install}\\usr\\bin\\msys-2.0.dll`])
const base = { env: {}, exists: (path: string) => files.has(path), probe: () => true }

test('Git discovers a custom registry installation without env or PATH', () => {
  const result = resolveWindowsGitInstallation({ ...base, registryRoots: () => [install] })
  assert.equal(result.root, install)
  assert.equal(result.source, 'registry')
  assert.equal(result.git, `${install}\\cmd\\git.exe`)
})
test('Git derives PATH installation; never discovers arbitrary bash', () => {
  assert.equal(resolveWindowsGitInstallation({ ...base, env: { Path: `${install}\\cmd` }, registryRoots: () => [] }).root, install)
  assert.throws(() => resolveWindowsGitInstallation({ ...base, env: { Path: 'C:\\arbitrary' }, registryRoots: () => [] }))
})
test('Git override fails closed and never falls through to registry', () => {
  for (const override of ['bash', 'C:\\Windows\\System32\\bash.exe', 'C:\\other\\bash.exe', 'Z:\\Git\\bin\\bash.exe']) {
    assert.throws(() => resolveWindowsGitInstallation({ ...base,
      env: { NOVAWING_GIT_BASH_PATH: override }, registryRoots: () => [install] }))
  }
})
test('Git refuses incomplete layout and false fingerprints', () => {
  assert.throws(() => resolveWindowsGitInstallation({ ...base, registryRoots: () => [install], probe: () => false }))
  assert.throws(() => resolveWindowsGitInstallation({ ...base, registryRoots: () => [install], exists: (path) => path.endsWith('bash.exe') }))
})
test('Environment override precedes trusted config and automatic discovery', () => {
  const result = resolveWindowsGitInstallation({ ...base, env: { NOVAWING_GIT_BASH_PATH: `${install}\\bin\\bash.exe` },
    gitBashPath: 'Z:\\Git\\bin\\bash.exe', registryRoots: () => { assert.fail('must not consult registry') } })
  assert.equal(result.source, 'explicit')
})
