import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAskBridgeExecutable } from 'nova-wing/development-guardian'

const root = await mkdtemp(join(tmpdir(), 'novawing-ask-bridge-'))
const source = join(root, 'source')
const target = resolveAskBridgeExecutable(process.env)
const patch = fileURLToPath(new URL('../patches/ask-bridge-v0.2.13-composer-state.patch', import.meta.url))
function run(command, args) { execFileSync(command, args, { stdio: 'inherit', shell: false }) }
try {
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', 'v0.2.13', 'https://github.com/doggy8088/ask-bridge.git', source])
  run('git', ['-C', source, 'apply', '--check', patch])
  run('git', ['-C', source, 'apply', patch])
  const manifest = join(source, 'Cargo.toml')
  run('cargo', ['test', '--locked', '--manifest-path', manifest])
  run('cargo', ['build', '--locked', '--release', '--manifest-path', manifest, '--bin', 'ask-bridge'])
  const nativeName = basename(resolveAskBridgeExecutable({}))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(source, 'target', 'release', nativeName), target)
  await chmod(target, 0o755)
  run(target, ['--version'])
  const help = execFileSync(target, ['--help'], { encoding: 'utf8', shell: false })
  if (!help.includes('--operation-id')) throw new Error('Pinned AskBridge capability missing')
  console.log(`Installed ${target}. Run npm run guardian:chatgpt:login next.`)
} finally { await rm(root, { recursive: true, force: true }) }
