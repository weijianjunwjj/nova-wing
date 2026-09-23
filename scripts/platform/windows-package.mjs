import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { DESKTOP_IDENTITY } from '../../desktop/main/identity.mjs'
import { updateFeedPublishConfig } from './update-feed.mjs'

export const root = resolve(import.meta.dirname, '../..')
export const output = join(root, 'artifacts', 'desktop')
export const packagedExecutable = (appRoot) => join(appRoot, '..', '..', 'NovaWing.exe')
export const unpacked = join(output, 'win-unpacked')
export const packagedBundleRoot = unpacked
export const packagedAppRoot = join(unpacked, 'resources', 'app')
/** Windows toasts deliver without a signing identity; the native delivery gate stays strict. */
export const nativeNotificationGate = () => 'REQUIRED'
const stage = join(output, 'staging')
const denied = /(?:^|\/)(?:tests?|__tests__|docs?|\.git|\.github|artifacts|logs?|fixtures?|examples?|coverage|\.cache|\.bin)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:db|sqlite(?:-wal|-shm|-journal)?|log|pem|key|pfx|map)$/iu

async function removeOwned(path) {
  const distance = relative(output, path)
  assert.ok(distance && !distance.startsWith('..') && !isAbsolute(distance))
  try { assert.equal(await realpath(path), path); await rm(path, { recursive: true, force: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

export async function auditPackage(appDirectory) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false, `Package symlink: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else files.push(relative(appDirectory, path).replaceAll('\\', '/'))
    }
  }
  await walk(appDirectory)
  assert.deepEqual(files.filter((file) => denied.test(file)), [], 'Forbidden package content')
  const manifest = JSON.parse(await readFile(join(appDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'nova-wing')
  assert.equal(manifest.version, DESKTOP_IDENTITY.version)
  assert.equal(manifest.main, 'desktop/main/index.mjs')
  for (const path of ['desktop/main/index.mjs', 'desktop/assets/app.ico', 'dist/packages/development-guardian/index.js',
    'node_modules/@openai/codex-sdk/package.json', 'node_modules/@openai/codex/package.json',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-package.json',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path/rg.exe',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-command-runner.exe',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe']) {
    assert.ok(files.includes(path), `Missing packaged resource: ${path}`)
  }
  assert.ok(files.some((file) => file.includes('@libsql/win32-x64-msvc/') && file.endsWith('.node')))
  assert.equal(files.includes('desktop/main/isolated-fixture.mjs'), false)
  assert.equal(files.some((file) => /^node_modules\/(?:electron|electron-builder|typescript)\//u.test(file)), false)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(file).update('\0')
    for await (const chunk of createReadStream(join(appDirectory, file))) hash.update(chunk)
    hash.update('\0')
  }
  const report = { name: 'PACKAGED_CONTENT_AUDIT', result: 'PASS', appDirectory, sha256: hash.digest('hex'), files: files.sort() }
  await writeFile(join(output, 'packaged-content-audit.json'), JSON.stringify(report, null, 2))
  console.log(`PACKAGED_CONTENT_AUDIT PASS (${files.length} files)`)
  return report
}

/** Copy the unpacked bundle into a disposable root and return the packaged app root. */
export async function stagePackagedSmokeCopy(disposableRoot) {
  await cp(unpacked, disposableRoot, { recursive: true })
  return join(disposableRoot, 'resources', 'app')
}

export async function prepareStage() {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  await mkdir(output, { recursive: true })
  await removeOwned(stage)
  await mkdir(stage)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, version: DESKTOP_IDENTITY.version, productName: DESKTOP_IDENTITY.appName,
    description: 'NovaWing Desktop', author: 'NovaWing', license: manifest.license,
    type: manifest.type, main: 'desktop/main/index.mjs', exports: manifest.exports,
    dependencies: manifest.dependencies,
  }, null, 2))
  await cp(join(root, 'desktop', 'main'), join(stage, 'desktop', 'main'), {
    recursive: true, filter: (path) => !path.endsWith('isolated-fixture.mjs'),
  })
  await cp(join(root, 'desktop', 'assets'), join(stage, 'desktop', 'assets'), { recursive: true })
  await cp(join(root, 'dist', 'packages'), join(stage, 'dist', 'packages'), { recursive: true })
  // Lockfile production graph only. No install/rebuild mutates root dependencies.
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (!location.startsWith('node_modules/') || metadata.dev || metadata.devOptional) continue
    if (metadata.os && !metadata.os.includes('win32') || metadata.cpu && !metadata.cpu.includes('x64')) continue
    const from = join(root, location)
    try { await lstat(from) } catch (error) { if (metadata.optional && error.code === 'ENOENT') continue; throw error }
    await cp(from, join(stage, location), { recursive: true, filter: async (path) => {
      const local = relative(from, path).split(sep).join('/')
      if (!local) return true
      assert.equal((await lstat(path)).isSymbolicLink(), false, `Dependency link: ${path}`)
      return !local.split('/').includes('node_modules') && !denied.test(local)
    } })
  }
  await auditPackage(stage)
  return manifest
}

export async function packageWindows(installer = false) {
  const manifest = installer ? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) : await prepareStage()
  if (installer) {
    const audit = await auditPackage(join(unpacked, 'resources', 'app'))
    const proof = JSON.parse(await readFile(join(output, 'package-smoke', 'result.json'), 'utf8'))
    assert.equal(proof.result, 'PASS', 'Unpacked smoke must pass before NSIS')
    assert.equal(proof.packageSha256, audit.sha256, 'Smoke evidence must match the exact package')
  }
  const paths = await build({
    targets: Platform.WINDOWS.createTarget(installer ? 'nsis' : 'dir', Arch.x64), publish: 'never',
    ...(installer ? { prepackaged: unpacked } : {}),
    config: {
      appId: DESKTOP_IDENTITY.appUserModelId, productName: DESKTOP_IDENTITY.appName,
      directories: { app: stage, output, buildResources: join(root, 'desktop', 'assets') },
      electronVersion: manifest.devDependencies.electron,
      electronDist: join(root, 'node_modules', 'electron', 'dist'),
      asar: false, npmRebuild: false, nodeGypRebuild: false,
      files: ['**/*'],
      win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: join(root, 'desktop', 'assets', 'app.ico') },
      nsis: { oneClick: true, perMachine: false, allowElevation: false, createDesktopShortcut: true,
        createStartMenuShortcut: true, deleteAppDataOnUninstall: false, runAfterFinish: false },
      // Explicit feed, never inferred from the checkout's git remote.
      publish: updateFeedPublishConfig(),
      // GitHub-safe by construction: no spaces, so latest.yml names the real asset instead of a
      // rewritten safe name that no release would ever carry.
      artifactName: 'NovaWing-Setup-${version}-${arch}.${ext}',
    },
  })
  await auditPackage(join(unpacked, 'resources', 'app'))
  if (installer) {
    const path = paths.find((entry) => entry.endsWith('.exe'))
    assert.ok(path)
    const bytes = await readFile(path)
    await writeFile(join(output, 'installer.json'), JSON.stringify({ path, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...DESKTOP_IDENTITY,
      electron: manifest.devDependencies.electron, builder: manifest.devDependencies['electron-builder'],
      arch: 'x64', signed: false }, null, 2))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageWindows(process.argv.includes('--installer'))
}
