import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  executableAvailable,
  missingVerifierExecutable,
  resolveDesktopToolchainEnvironment,
  verifierExecutable,
  type ToolchainProbe,
} from '../packages/development-guardian/platform/posix-toolchain.js'

/** The exact PATH a Finder/Dock launch gives a macOS GUI app. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const temporary: string[] = []
after(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
})

/** A real directory containing real tool files; only --version is faked. */
async function toolDirectory(tools: readonly string[], prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `novawing-${prefix}-`))
  temporary.push(directory)
  for (const tool of tools) await writeFile(join(directory, tool), '', 'utf8')
  return directory
}

function sentinel(directory: string): string {
  return ['node', 'npm', 'npx', 'git'].map((tool) => `__NOVAWING_TOOLCHAIN__ ${join(directory, tool)}`).join('\n')
}

interface ProbeScript {
  shell?: (executable: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string; timedOut?: boolean }
  version?: (executable: string) => boolean
}

/** Fake probe: no real shell, no real toolchain, fully deterministic. */
function fakeProbe(script: ProbeScript): ToolchainProbe {
  return (executable, args, _options) => {
    if (script.shell !== undefined && args[0] === '-lic') return script.shell(executable, args)
    if (script.version !== undefined && args[0] === '--version') {
      return script.version(executable) ? { status: 0, stdout: 'v0.0.0\n', stderr: '' } : { status: 127, stdout: '', stderr: '' }
    }
    return { status: 127, stdout: '', stderr: '' }
  }
}

// A. Finder-like minimal PATH: shell discovery supplies a verified toolchain directory.
test('A: Finder-like PATH is augmented with the discovered toolchain directory', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx', 'git'], 'toolchain-a')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: 0, stdout: sentinel(node), stderr: '' }), version: (executable) => executable.startsWith(node) }),
  })
  assert.equal(resolved.augmented, true)
  assert.equal(resolved.path.split(':')[0], node)
  assert.equal(resolved.tools.node, join(node, 'node'))
  assert.equal(resolved.tools.npm, join(node, 'npm'))
  assert.ok(resolved.sources.includes(`discovered:${node}`))
  // The system directories a GUI launch legitimately owns are preserved.
  for (const entry of GUI_PATH.split(':')) assert.ok(resolved.path.split(':').includes(entry), `lost system PATH entry ${entry}`)
})

// B. A working PATH is left exactly as it is.
test('B: an already working PATH is never rewritten', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx', 'git'], 'toolchain-b')
  const env = { PATH: `${node}:${GUI_PATH}` }
  let shellCalls = 0
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => { shellCalls++; return { status: 0, stdout: '', stderr: '' } }, version: (executable) => executable.startsWith(node) }),
  })
  assert.equal(resolved.augmented, false)
  assert.equal(resolved.path, env.PATH)
  assert.equal(shellCalls, 0, 'discovery must not run when every managed tool already resolves')
})

test('non-darwin hosts keep their PATH verbatim', async () => {
  const env = { PATH: GUI_PATH }
  const resolved = resolveDesktopToolchainEnvironment({ platform: 'linux', env, probe: fakeProbe({}) })
  assert.equal(resolved.augmented, false)
  assert.equal(resolved.path, GUI_PATH)
})

// C. A hanging shell probe must fail closed instead of stalling the Runtime.
test('C: a timing-out shell probe fails closed and never hangs', async () => {
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) }),
  })
  assert.equal(resolved.augmented, false)
  assert.equal(resolved.path, GUI_PATH)
})

// D. Only sentinel lines are trusted; banners, prompts and aliases are discarded.
test('D: noisy shell output cannot inject PATH entries', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx'], 'toolchain-d')
  const noise = [
    'Welcome to your shell!',
    'npm: aliased to npx --no-install',
    'not-a-sentinel /evil/bin',
    '__NOVAWING_TOOLCHAIN__ /evil/bin',
    sentinel(node),
    '__NOVAWING_TOOLCHAIN__ relative/bin',
  ].join('\n')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: 0, stdout: noise, stderr: 'npm: aliased' }), version: (executable) => executable.startsWith(node) }),
  })
  assert.equal(resolved.augmented, true)
  assert.ok(!resolved.path.includes('/evil/bin'), 'unverified sentinel path must be rejected')
  assert.ok(!resolved.path.includes('relative/bin'))
  assert.equal(resolved.tools.npm, join(node, 'npm'))
})

// E. A candidate directory that does not really supply the tool is never added.
test('E: an invalid candidate directory is rejected', async () => {
  const empty = await toolDirectory(['unrelated'], 'toolchain-e')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: 0, stdout: sentinel(empty), stderr: '' }), version: () => false }),
  })
  assert.equal(resolved.augmented, false)
  assert.equal(resolved.path, GUI_PATH)
})

// F. An explicit, valid override is honoured.
test('F: a valid NOVAWING_TOOLCHAIN_PATH override is used', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx'], 'toolchain-f')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH, NOVAWING_TOOLCHAIN_PATH: node }, home: '/nonexistent-home',
    probe: fakeProbe({ version: (executable) => executable.startsWith(node) }),
  })
  assert.equal(resolved.augmented, true)
  assert.equal(resolved.path.split(':')[0], node)
})

// G. An explicit but unusable override is rejected and never silently replaced by discovery.
test('G: an invalid override is rejected without silent fallback', async () => {
  const other = await toolDirectory(['node', 'npm', 'npx'], 'toolchain-g')
  let shellCalls = 0
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH, NOVAWING_TOOLCHAIN_PATH: '/no/such/dir' }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => { shellCalls++; return { status: 0, stdout: sentinel(other), stderr: '' } }, version: () => false }),
  })
  assert.equal(resolved.augmented, false)
  assert.equal(shellCalls, 0, 'an explicit override must never fall back to shell discovery')
  assert.ok(resolved.issues.some((issue) => issue.includes('NOVAWING_TOOLCHAIN_PATH')))
  assert.ok(!resolved.path.includes(other))
})

test('override rejects shell expansion and relative entries', async () => {
  for (const override of ['$HOME/bin', 'relative/bin', '/tmp/../etc']) {
    const resolved = resolveDesktopToolchainEnvironment({
      platform: 'darwin', env: { PATH: GUI_PATH, NOVAWING_TOOLCHAIN_PATH: override }, home: '/nonexistent-home',
      probe: fakeProbe({ version: () => true }),
    })
    assert.equal(resolved.augmented, false, `override must be rejected: ${override}`)
  }
})

// H. The verifier preflight that replaces exit 127 -> UNKNOWN with ENVIRONMENT_REQUIRED.
test('H: a verifier whose tool is missing is detected before it is spawned', () => {
  const gui = { PATH: GUI_PATH }
  assert.equal(missingVerifierExecutable('npm test', gui), 'npm')
  assert.equal(missingVerifierExecutable('node --test test/sum.test.mjs', gui), 'node')
  assert.equal(missingVerifierExecutable('git diff --check', gui), undefined, 'git lives in /usr/bin')
  // A repo-local path is resolved by the shell against the verifier cwd; a venv may
  // legitimately not exist until bootstrap creates it, so it is never a missing toolchain.
  assert.equal(missingVerifierExecutable('.venv/bin/python -m pytest', gui), undefined)
  assert.equal(missingVerifierExecutable('./tools/check.sh', gui), undefined)
})

test('I: once the toolchain is resolved the verifier executable is available', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx'], 'toolchain-i')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: 0, stdout: sentinel(node), stderr: '' }), version: (executable) => executable.startsWith(node) }),
  })
  assert.equal(missingVerifierExecutable('npm test', resolved.env), undefined)
  assert.equal(executableAvailable('npm', resolved.env), true)
})

// J. Git keeps resolving exactly as the real Finder real-host proved.
test('J: git continues to resolve after augmentation', async () => {
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ version: (executable) => executable === '/usr/bin/git' || executable.startsWith('/usr/bin') }),
  })
  assert.equal(resolved.tools.git, '/usr/bin/git')
  assert.ok(resolved.path.split(':').includes('/usr/bin'))
})

// K. Codex is never supplied by PATH; only the bundle vendor may provide it.
test('K: the resolver never contributes a codex executable', async () => {
  const node = await toolDirectory(['node', 'npm', 'npx', 'codex'], 'toolchain-k')
  const resolved = resolveDesktopToolchainEnvironment({
    platform: 'darwin', env: { PATH: GUI_PATH }, home: '/nonexistent-home',
    probe: fakeProbe({ shell: () => ({ status: 0, stdout: sentinel(node), stderr: '' }), version: (executable) => executable.startsWith(node) }),
  })
  // `ToolchainTools` has no codex member at all; the runtime check guards the shape too.
  assert.ok(!Object.keys(resolved.tools).includes('codex'))
  for (const tool of Object.keys(resolved.tools)) {
    assert.ok(['git', 'node', 'npm', 'npx'].includes(tool), `unexpected managed tool: ${tool}`)
  }
})

test('verifierExecutable extracts only a bare program name', () => {
  assert.equal(verifierExecutable('npm test'), 'npm')
  assert.equal(verifierExecutable('  pnpm  run  build'), 'pnpm')
  assert.equal(verifierExecutable('git diff --check'), 'git')
  assert.equal(verifierExecutable('.venv/Scripts/python.exe -m pytest'), undefined, 'path-carrying')
  assert.equal(verifierExecutable('./tools/check.sh'), undefined, 'path-carrying')
  assert.equal(verifierExecutable('. dot-command'), undefined)
  assert.equal(verifierExecutable(''), undefined)
})

test('executableAvailable understands Windows PATHEXT resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-pathtext-'))
  temporary.push(directory)
  await writeFile(join(directory, 'npm.cmd'), '', 'utf8')
  assert.equal(executableAvailable('npm', { PATH: directory }, 'win32'), true)
  assert.equal(executableAvailable('npm', { PATH: directory }, 'darwin'), false, 'POSIX never resolves a bare name to .cmd')
})
