import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isGitForWindowsVersion,
  isNativeGitBashIdentity,
  resolveWindowsGitInstallation,
} from '../packages/development-guardian/platform/windows-git.js'

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

// The resolver's real contract predicates, driven by fixed shell output, so these cases exercise
// the shipped gate end to end without spawning a process. MSYS2 changed the shell's own OSTYPE
// from `msys` to `cygwin`; both are the native identity, and neither admits a plain Cygwin shell.
const identityProbe = (shell: string, version: string) =>
  ((_: string, __: string) => isNativeGitBashIdentity(shell) && isGitForWindowsVersion(version))

test('Native Git Bash identity accepts the legacy msys and the current cygwin OSTYPE', () => {
  assert.equal(isNativeGitBashIdentity('5.2.9(1)-release|MINGW64|msys'), true)
  assert.equal(isNativeGitBashIdentity('5.1.0(1)-release|MINGW32|msys'), true)
  assert.equal(isNativeGitBashIdentity('5.3.15(2)-release|MINGW64|cygwin'), true)
  assert.equal(isNativeGitBashIdentity('5.3.15(2)-release|UCRT64|cygwin'), true)
})

test('Native Git Bash identity still refuses a plain Cygwin shell and unknown MSYSTEM', () => {
  for (const output of [
    '5.3.15(2)-release|CYGWIN|cygwin',
    '5.3.15(2)-release||cygwin',
    '5.3.15(2)-release|UCRT32|msys',
    '5.3.15(2)-release|CLANG64|cygwin',
    '5.3.15(2)-release|MINGW64|gnu',
    '5.3.15(2)-release|MINGW64|cygwin|extra',
  ]) assert.equal(isNativeGitBashIdentity(output), false, output)
})

test('Git version gate still requires a native Git for Windows build', () => {
  assert.equal(isGitForWindowsVersion('git version 2.55.0.windows.5'), true)
  assert.equal(isGitForWindowsVersion('git version 2.43.0'), false)
  assert.equal(isGitForWindowsVersion('git version 2.43.0.msys'), false)
})

test('Legacy Git for Windows installation keeps resolving', () => {
  const result = resolveWindowsGitInstallation({ ...base, registryRoots: () => [install],
    probe: identityProbe('5.2.9(1)-release|MINGW64|msys', 'git version 2.43.0.windows.1') })
  assert.equal(result.root, install)
  assert.equal(result.git, `${install}\\cmd\\git.exe`)
})

test('Current Git for Windows installation resolves on the hosted-runner identity', () => {
  const result = resolveWindowsGitInstallation({ ...base, registryRoots: () => [install],
    probe: identityProbe('5.3.15(2)-release|MINGW64|cygwin', 'git version 2.55.0.windows.5') })
  assert.equal(result.root, install)
  assert.equal(result.git, `${install}\\cmd\\git.exe`)
})

test('UCRT64 Git for Windows resolves from registry and its new PATH layout', () => {
  const ucrtFiles = new Set([...files, `${install}\\ucrt64\\bin\\git.exe`])
  const ucrt = { ...base, exists: (path: string) => ucrtFiles.has(path),
    probe: identityProbe('5.3.15(2)-release|UCRT64|cygwin', 'git version 2.56.0.windows.1') }
  for (const discovery of [
    { env: {}, registryRoots: () => [install] },
    { env: { Path: `${install}\\ucrt64\\bin` }, registryRoots: () => [] },
  ]) {
    const result = resolveWindowsGitInstallation({ ...ucrt, ...discovery })
    assert.equal(result.root, install)
    assert.equal(result.git, `${install}\\cmd\\git.exe`)
  }
  assert.throws(() => resolveWindowsGitInstallation({ ...ucrt, registryRoots: () => [install],
    exists: (path) => ucrtFiles.has(path) && !path.endsWith('msys-2.0.dll') }))
  assert.throws(() => resolveWindowsGitInstallation({ ...ucrt, registryRoots: () => [install],
    probe: identityProbe('5.3.15(2)-release|UCRT64|cygwin', 'git version 2.56.0') }))
})

test('A cygwin OSTYPE alone never admits a plain Cygwin installation', () => {
  const cygwinLayout = new Set([`${install}\\bin\\bash.exe`, `${install}\\cmd\\git.exe`, `${install}\\usr\\bin\\cygwin1.dll`])
  const identity = identityProbe('5.3.15(2)-release|MINGW64|cygwin', 'git version 2.55.0.windows.5')
  // Cygwin layout: no msys-2.0.dll.
  assert.throws(() => resolveWindowsGitInstallation({ ...base, registryRoots: () => [install],
    exists: (path) => cygwinLayout.has(path), probe: identity }))
  // Complete layout, but a non-Windows Git build.
  assert.throws(() => resolveWindowsGitInstallation({ ...base, registryRoots: () => [install],
    probe: identityProbe('5.3.15(2)-release|MINGW64|cygwin', 'git version 2.43.0') }))
  // Complete layout and Git build, but a Cygwin shell identity.
  assert.throws(() => resolveWindowsGitInstallation({ ...base, registryRoots: () => [install],
    probe: identityProbe('5.3.15(2)-release|CYGWIN|cygwin', 'git version 2.55.0.windows.5') }))
})

test('Explicit override is not a fingerprint bypass', () => {
  for (const shell of ['5.3.15(2)-release|CYGWIN|cygwin', '5.3.15(2)-release||cygwin', '5.3.15(2)-release|MINGW64|gnu']) {
    assert.throws(() => resolveWindowsGitInstallation({ ...base,
      env: { NOVAWING_GIT_BASH_PATH: `${install}\\bin\\bash.exe` }, registryRoots: () => [install],
      probe: identityProbe(shell, 'git version 2.55.0.windows.5') }), shell)
  }
  const accepted = resolveWindowsGitInstallation({ ...base,
    env: { NOVAWING_GIT_BASH_PATH: `${install}\\bin\\bash.exe` }, registryRoots: () => [install],
    probe: identityProbe('5.3.15(2)-release|MINGW64|cygwin', 'git version 2.55.0.windows.5') })
  assert.equal(accepted.source, 'explicit')
})
