import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, stat, readFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardianShellCommand, shellProbeContract } from '../packages/development-guardian/platform/shell.js'
import { platformPaths } from '../packages/development-guardian/platform/paths.js'
import { pythonRuntime } from '../packages/development-guardian/platform/executables.js'
import { codexRuntimeTarget } from '../packages/development-guardian/platform/codex-runtime.js'
import { secretProtectionStrategy } from '../packages/development-guardian/platform/secret-protection.js'
import { commandEnvironment } from '../packages/development-guardian/platform/environment.js'
import { runProductionDependencyPreflight } from '../packages/development-guardian/work-session/dependency-health.js'
import { saveLocalSmtpSecrets, loadLocalSmtpSecrets } from '../packages/development-guardian/work-session/local-smtp-secrets.js'
import { createWindowsToastRepairNotifier } from '../packages/development-guardian/platform/windows-repair-notifier.js'

for (const platform of ['win32', 'darwin', 'linux'] as const) for (const arch of ['x64', 'arm64'] as const) {
  test(`UNIT ${platform}/${arch}: shell, Codex, paths, permissions, preflight, Git`, async () => {
    const windows = platform === 'win32'
    const env = { NOVAWING_GIT_BASH_PATH: 'E:/Portable Git/bin/bash.exe', LOCALAPPDATA: 'C:/Users/test/AppData/Local',
      XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' }
    const userHome = windows ? 'C:/Users/test' : '/home/test'
    const opts = { platform, env, userHome }
    const shell = guardianShellCommand('git --version', opts)
    assert.equal(shell.executable, windows ? env.NOVAWING_GIT_BASH_PATH : 'bash')
    const probe = shellProbeContract(opts)
    const fingerprint = windows ? `5.2|${arch === 'arm64' ? 'MINGWARM64' : 'MINGW64'}|msys` : '3.2.57(1)-release'
    assert.equal(probe.valid(fingerprint, ''), true)
    assert.equal(probe.valid('not-a-shell', ''), false)
    assert.equal(probe.valid('5.2|MINGW64|msys', 'WSL relay'), false)
    if (windows) {
      // MSYS2 reports `cygwin` for the shell's own OSTYPE; the native identity is unchanged.
      assert.equal(probe.valid('5.2|MINGW64|cygwin', ''), true)
      assert.equal(probe.valid('5.3.15(2)-release|MINGWARM64|cygwin', ''), true)
      assert.equal(probe.valid('5.3.15(2)-release|UCRT64|cygwin', ''), true)
      assert.equal(probe.valid('5.2|CYGWIN|cygwin', ''), false, 'a plain Cygwin shell has no MINGW MSYSTEM')
      assert.equal(probe.valid('5.2|MINGW64|gnu', ''), false)
      assert.equal(probe.valid('5.2|MINGW64|cygwin', 'WSL relay'), false)
      assert.equal(probe.valid('5.3.15(2)-release|UCRT64|cygwin', 'WSL relay'), false)
    }
    const paths = platformPaths(opts)
    assert.equal(paths.data, windows ? 'C:\\Users\\test\\AppData\\Local\\NovaWing' : platform === 'darwin' ? '/home/test/Library/Application Support/NovaWing' : '/data/NovaWing')
    assert.equal(paths.secrets, windows ? 'C:\\Users\\test\\AppData\\Local\\NovaWing\\secrets' : platform === 'darwin' ? '/home/test/Library/Application Support/NovaWing/secrets' : '/cfg/NovaWing/secrets')
    assert.equal(secretProtectionStrategy(platform), windows ? 'windows-acl' : 'posix-mode')
    const target = codexRuntimeTarget(platform, arch)
    assert.equal(target.packageName, `@openai/codex-${platform}-${arch}`)
    assert.equal(target.binaryName, windows ? 'codex.exe' : 'codex')
    assert.equal(pythonRuntime(platform).venv, windows ? '.venv/Scripts/python.exe' : '.venv/bin/python')
    for (const failure of ['none', 'shell', 'git', 'throw', 'timeout'] as const) {
      const calls: string[] = []
      const result = await runProductionDependencyPreflight({ ...opts, controlPlane: 'v2', executorModes: ['codex'], inspectCodex: async () => undefined,
        accessFile: async () => undefined,
        commandRunner: async (request) => {
          const command = request.args.at(-1) ?? ''; calls.push(command)
          if (failure === 'throw') throw new Error('probe failed')
          if (command.includes('BASH_VERSION')) return { exitCode: failure === 'shell' ? 1 : 0, stdout: fingerprint, stderr: '', timedOut: failure === 'timeout' }
          return { exitCode: failure === 'git' ? 1 : 0, stdout: '', stderr: '' }
        } })
      assert.equal(result.canStart, failure === 'none')
      assert.equal(calls.some((call) => call.includes('git --version')), failure === 'none' || failure === 'git')
      assert.equal(result.dependencies.some((item) => item.id === 'BRIDGE' || item.id === 'BRAIN'), false)
      if (!windows) assert.doesNotMatch(JSON.stringify(result), /Git Bash|LOCALAPPDATA|MINGW|Windows/)
    }
  })
}

test('XDG relative values are ignored; overrides and default state paths agree', () => {
  const paths = platformPaths({ platform: 'linux', userHome: '/home/test', env: { XDG_CONFIG_HOME: 'bad', XDG_DATA_HOME: 'relative' } })
  assert.equal(paths.config, '/home/test/.config/NovaWing')
  assert.equal(paths.data, '/home/test/.local/share/NovaWing')
  assert.equal(platformPaths({ platform: 'darwin', userHome: '/home/test', env: { LOCALAPPDATA: '/accidental' } }).data, '/home/test/Library/Application Support/NovaWing')
})

test('non-Windows optional notification cannot call its Windows adapter', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    await createWindowsToastRepairNotifier({ platform, spawnToast: async () => { throw new Error('must not call') } }).notify({ kind: 'SUCCESS', targetRepo: '/repo', summary: 'done' })
  }
})

test('macOS inherited Linux locale uses universal C; verifier child context is removed', () => {
  assert.deepEqual(commandEnvironment({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NODE_TEST_CONTEXT: 'child-v8' }, 'darwin'), { LANG: 'C', LC_ALL: 'C' })
  assert.equal(commandEnvironment({ LANG: 'en_US.UTF-8' }, 'darwin').LANG, 'en_US.UTF-8')
})

test('static guard rejects platform literals in common source, including newly created files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-boundary-'))
  try {
    await mkdir(join(root, 'packages'))
    for (const source of ["const shell = 'D:\\\\Git\\\\bin\\\\bash.exe'", "const root = process.env.LOCALAPPDATA", "spawn('powershell.exe')", "const p = '/Applications/Thing'", "const locale = 'C.UTF-8'", "const env = 'XDG_DATA_HOME'", "const p = 'MINGW64'", "const c = 'icacls'"]) {
      await writeFile(join(root, 'packages', 'new-runtime.ts'), source)
      const result = spawnSync(process.execPath, ['scripts/check-platform-boundaries.mjs', '--root', root], { encoding: 'utf8' })
      assert.equal(result.status, 1, source)
      assert.match(result.stderr, /new-runtime.ts/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('platform guard scans both Desktop Main and the Electron compatibility entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-desktop-platform-'))
  try {
    for (const directory of ['main', 'tests']) {
      const folder = join(root, 'desktop', directory)
      await mkdir(folder, { recursive: true })
      const entry = join(folder, 'new-entry.mjs')
      await writeFile(entry, 'const environment = { platform: process.platform }\nconsole.log(environment)\n')
      let result = spawnSync(process.execPath, ['scripts/check-platform-boundaries.mjs', '--root', root], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      for (const source of ["spawn('powershell.exe')", "const path = process.env.LOCALAPPDATA", "if (process.platform === 'win32') run()"]) {
        await writeFile(entry, source)
        result = spawnSync(process.execPath, ['scripts/check-platform-boundaries.mjs', '--root', root], { encoding: 'utf8' })
        assert.equal(result.status, 1, source)
        assert.match(result.stderr, new RegExp(`desktop/${directory}/new-entry\\.mjs`))
      }
      await rm(entry)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('package guard scans Desktop imports and requires public NovaWing exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-desktop-package-'))
  try {
    for (const directory of ['scripts', 'tests', 'desktop/main', 'desktop/tests', 'packages/development-guardian']) {
      await mkdir(join(root, directory), { recursive: true })
    }
    const checker = join(root, 'scripts', 'check-boundaries.mjs')
    await writeFile(checker, await readFile('scripts/check-boundaries.mjs', 'utf8'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    const keyword = ['im', 'port'].join('')
    for (const directory of ['main', 'tests']) {
      const entry = join(root, 'desktop', directory, 'new-entry.mjs')
      await writeFile(entry, `${keyword} { WorkSessionRuntime } from 'nova-wing/development-guardian'\n`)
      let result = spawnSync(process.execPath, [checker], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      for (const specifier of ['nova-wing/development-guardian/internal', '../../packages/development-guardian/index.js', '../../dist/packages/development-guardian/index.js', '../../packages/core/src/index.js', '../../../outside.mjs']) {
        for (const source of [`${keyword} '${specifier}'`, `${keyword} { value } from '${specifier}'`, `await ${keyword}('${specifier}')`]) {
          await writeFile(entry, source)
          result = spawnSync(process.execPath, [checker], { encoding: 'utf8' })
          assert.equal(result.status, 1, `${directory}: ${source}\n${result.stdout}`)
          assert.match(result.stderr, /non-public NovaWing package import|bypasses a public package export|deep source import is forbidden|import escapes NovaWing repository/)
          assert.ok(result.stderr.includes(join('desktop', directory, 'new-entry.mjs')), result.stderr)
        }
      }
      await rm(entry)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

const secrets = { NOVAWING_SMTP_HOST: 'smtp.invalid', NOVAWING_SMTP_PORT: '465', NOVAWING_SMTP_SECURE: 'true', NOVAWING_SMTP_USER: 'test', NOVAWING_SMTP_PASS: 'fixture-secret', NOVAWING_NOTIFY_FROM: 'a@example.test', NOVAWING_NOTIFY_TO: 'b@example.test' }
test('REAL HOST secret persistence: private atomic replacement and fail-closed permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-permissions-'))
  const path = join(root, 'private', 'smtp.json')
  const inheritedModulePath = process.env.PSModulePath
  try {
    if (secretProtectionStrategy() === 'windows-acl') {
      const modules = join(root, 'parent-modules')
      const securityModule = join(modules, 'Microsoft.PowerShell.Security')
      await mkdir(securityModule, { recursive: true })
      await writeFile(join(securityModule, 'Microsoft.PowerShell.Security.psd1'), "@{ RootModule = 'Microsoft.PowerShell.Security.psm1'; ModuleVersion = '1.0.0'; FunctionsToExport = @('Get-Acl', 'Set-Acl'); CmdletsToExport = @() }")
      await writeFile(join(securityModule, 'Microsoft.PowerShell.Security.psm1'), "throw 'NOVAWING_INCOMPATIBLE_PARENT_POWERSHELL_MODULE'")
      process.env.PSModulePath = modules
      const incompatible = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security"], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      assert.equal(incompatible.status, 1)
      assert.match(incompatible.stderr, /NOVAWING_INCOMPATIBLE_PARENT_POWERSHELL_MODULE/)
    }
    await saveLocalSmtpSecrets(secrets, { path })
    assert.deepEqual(await loadLocalSmtpSecrets(path), secrets)
    // Every replacement re-protects the existing directory. This must not need
    // audit ACL privileges, even after its inheritance was disabled on creation.
    const replacement = { ...secrets, NOVAWING_SMTP_PASS: 'replacement-secret' }
    await saveLocalSmtpSecrets(replacement, { path })
    assert.deepEqual(await loadLocalSmtpSecrets(path), replacement)
    if (secretProtectionStrategy() === 'posix-mode') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700)
      await chmod(path, 0o644)
      await assert.rejects(loadLocalSmtpSecrets(path), /safely/)
      await chmod(path, 0o600)
      await symlink(join(root, 'private'), join(root, 'link'))
      await assert.rejects(saveLocalSmtpSecrets(secrets, { path: join(root, 'link', 'smtp.json') }), /Unsafe/)
    }
    const original = await readFile(path, 'utf8')
    await assert.rejects(saveLocalSmtpSecrets({ ...secrets, NOVAWING_SMTP_PASS: 'replacement' }, { path, restrictAcl: async () => { throw new Error('permission denied') } }), /permission denied/)
    assert.equal(await readFile(path, 'utf8'), original)
  } finally {
    if (inheritedModulePath === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = inheritedModulePath
    await rm(root, { recursive: true, force: true })
  }
})


test('REAL HOST cold Launchpad preflight resolves bundled Codex without selecting a Task', async () => {
  const report = await runProductionDependencyPreflight({ controlPlane: 'v2', executorModes: ['codex'] })
  for (const id of ['SHELL', 'GIT', 'RUNTIME', 'EXECUTOR']) {
    assert.equal(report.dependencies.find((entry) => entry.id === id)?.state, 'READY', JSON.stringify(report))
  }
  assert.equal(report.canStart, true)
})
