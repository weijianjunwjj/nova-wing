import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Test harness only: isolate before importing application code or starting node --test.
const root = await mkdtemp(join(await realpath(tmpdir()), 'novawing-isolated-tests-'))
const directories = ['home', 'data', 'config', 'xdg-data', 'xdg-config', 'tmp', 'local', 'roaming']
for (const directory of directories) await mkdir(join(root, directory))
const gitConfig = join(root, 'gitconfig')
await writeFile(gitConfig, '[user]\n\tname = NovaWing Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n', { mode: 0o600 })
const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
  NOVAWING_DATA_DIR: join(root, 'data'), NOVAWING_CONFIG_DIR: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
  LOCALAPPDATA: join(root, 'local'), APPDATA: join(root, 'roaming'),
  TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
  GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', NOVAWING_TEST_ROOT: root }
// Nested test children must not inherit node:test's worker identity or user preload options.
for (const key of Object.keys(env)) if (/^(NODE_TEST_CONTEXT|NODE_OPTIONS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/u.test(key)) delete env[key]
console.log(`ISOLATION_ROOT=${root}`)
console.log(`ISOLATION_ENV=${JSON.stringify(Object.fromEntries(['HOME', 'NOVAWING_DATA_DIR', 'NOVAWING_CONFIG_DIR',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'].map(key => [key, env[key]])))}`)
async function run(command, args) {
  const child = spawn(command, args, { env, stdio: 'inherit', shell: false })
  const stop = signal => child.kill(signal)
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM')
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
}
try {
  const canary = fileURLToPath(new URL('../tests/test-isolation.canary.mjs', import.meta.url))
  const code = await run(process.execPath, ['--test', canary])
  if (code !== 0) process.exitCode = code
  else {
    console.log('ISOLATION_CANARY=PASS')
    const args = process.argv.slice(2)
    if (args[0] === '--canary-only') process.exitCode = 0
    else if (args[0] === '--exec') {
      if (!args[1]) throw new Error('Missing isolated command')
      process.exitCode = await run(args[1], args.slice(2))
    } else process.exitCode = await run(process.execPath, ['--test', ...args])
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log('ISOLATION_CLEANUP=PASS')
}
