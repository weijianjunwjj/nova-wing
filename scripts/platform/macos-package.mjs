import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { DESKTOP_IDENTITY } from '../../desktop/main/identity.mjs'
import { requireInstalledElectron } from './desktop-dependency-preflight.mjs'

export const root = resolve(import.meta.dirname, '../..')
export const output = join(root, 'artifacts', 'desktop')
export const appName = DESKTOP_IDENTITY.appName
export const bundleName = `${appName}.app`
export const unpacked = join(output, 'mac-arm64')
export const packagedBundle = join(unpacked, bundleName)
export const packagedAppRoot = join(packagedBundle, 'Contents', 'Resources', 'app')
/** Mirrors the Windows layout helper: the executable lives beside the staged app tree. */
export const packagedExecutable = (appRoot) => join(appRoot, '..', '..', 'MacOS', appName)
export const packagedBundleRoot = packagedBundle
export const appRootWithin = (bundle) => join(bundle, 'Contents', 'Resources', 'app')

/**
 * Real bundle signing state. macOS only delivers native notifications for a bundle signed
 * for distribution, so the smoke gate is derived from the artifact and never assumed.
 */
export function bundleSigningState(bundle = packagedBundle) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8', shell: false })
  const inspection = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const adhoc = /\(adhoc\)|Signature=adhoc/u.test(inspection)
  const authority = /^Authority=(.+)$/mu.exec(inspection)?.[1]?.trim() ?? null
  return { inspected: result.status === 0, authority, adhoc, signedForDistribution: authority !== null && !adhoc }
}

/** An ad-hoc bundle cannot validate native delivery; only a distribution signature restores the gate. */
export const nativeNotificationGate = () =>
  bundleSigningState().signedForDistribution ? 'REQUIRED' : 'NEEDS_SIGNED_VALIDATION'

/** Copy the .app into a disposable root and return its packaged app root. */
export async function stagePackagedSmokeCopy(disposableRoot) {
  const bundle = join(disposableRoot, bundleName)
  // Framework symlinks inside an .app must stay relative: resolving them to absolute paths
  // pointing back at the source invalidates the bundle and Electron dies before ready.
  await cp(packagedBundle, bundle, { recursive: true, verbatimSymlinks: true })
  return appRootWithin(bundle)
}
const stage = join(output, 'staging-mac')
const codexVendor = 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin'
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
  for (const path of ['desktop/main/index.mjs', 'desktop/assets/tray.png', 'desktop/assets/trayTemplate.png',
    'dist/packages/development-guardian/index.js', 'node_modules/@openai/codex-sdk/package.json',
    'node_modules/@openai/codex/package.json', `${codexVendor}/codex-package.json`,
    `${codexVendor}/bin/codex`, `${codexVendor}/bin/codex-code-mode-host`, `${codexVendor}/codex-path/rg`]) {
    assert.ok(files.includes(path), `Missing packaged resource: ${path}`)
  }
  assert.ok(files.some((file) => file.includes('@libsql/darwin-arm64/') && file.endsWith('.node')),
    'Missing packaged libSQL darwin-arm64 native module')
  assert.equal(files.some((file) => /codex-win32|codex-darwin-x64|@libsql\/win32/u.test(file)), false,
    'Foreign-target native content is packaged')
  assert.equal(files.includes('desktop/main/isolated-fixture.mjs'), false)
  assert.equal(files.some((file) => /^node_modules\/(?:electron|electron-builder|typescript)\//u.test(file)), false)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(file).update('\0')
    for await (const chunk of createReadStream(join(appDirectory, file))) hash.update(chunk)
    hash.update('\0')
  }
  const report = { name: 'MACOS_PACKAGED_CONTENT_AUDIT', result: 'PASS', appDirectory, sha256: hash.digest('hex'), files: files.sort() }
  await writeFile(join(output, 'macos-packaged-content-audit.json'), JSON.stringify(report, null, 2))
  console.log(`MACOS_PACKAGED_CONTENT_AUDIT PASS (${files.length} files)`)
  return report
}

/** Read identity from the built Info.plist; never trust the staging manifest alone. */
export function auditBundle() {
  const info = join(packagedBundle, 'Contents', 'Info.plist')
  const plist = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { encoding: 'utf8', shell: false })
  assert.equal(plist.status, 0, `Cannot read bundle Info.plist: ${plist.stderr}`)
  const manifest = JSON.parse(plist.stdout)
  assert.equal(manifest.CFBundleIdentifier, DESKTOP_IDENTITY.appUserModelId)
  assert.equal(manifest.CFBundleShortVersionString, DESKTOP_IDENTITY.version)
  assert.equal(manifest.CFBundleName, appName)
  return manifest
}

export async function prepareStage() {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  const electron = requireInstalledElectron()
  await mkdir(output, { recursive: true })
  await removeOwned(stage)
  await mkdir(stage)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, version: DESKTOP_IDENTITY.version, productName: appName,
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
    if (metadata.os && !metadata.os.includes('darwin')) continue
    if (metadata.cpu && !metadata.cpu.includes('arm64')) continue
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
  return { manifest, electron }
}

export async function packageMac() {
  const { manifest, electron } = await prepareStage()
  await build({
    targets: Platform.MAC.createTarget('dir', Arch.arm64), publish: 'never',
    config: {
      appId: DESKTOP_IDENTITY.appUserModelId, productName: appName,
      directories: { app: stage, output, buildResources: join(root, 'desktop', 'assets') },
      electronVersion: electron.version,
      electronDist: join(root, 'node_modules', 'electron', 'dist'),
      asar: false, npmRebuild: false, nodeGypRebuild: false,
      files: ['**/*'],
      mac: { target: [{ target: 'dir', arch: ['arm64'] }], category: 'public.app-category.developer-tools' },
      artifactName: `NovaWing ${DESKTOP_IDENTITY.version}.\${ext}`,
    },
  })
  const audit = await auditPackage(packagedAppRoot)
  const info = auditBundle()
  const signing = bundleSigningState()
  await writeFile(join(output, 'macos-package.json'), JSON.stringify({
    bundle: packagedBundle, executable: packagedExecutable(packagedAppRoot), sha256: audit.sha256,
    electron: manifest.devDependencies.electron, builder: manifest.devDependencies['electron-builder'],
    arch: 'arm64', appName, version: DESKTOP_IDENTITY.version,
    CFBundleIdentifier: info.CFBundleIdentifier, signing, nativeNotificationGate: nativeNotificationGate(),
  }, null, 2))
  console.log(`MACOS_PACKAGE PASS: ${packagedBundle}`)
  return { bundle: packagedBundle, executable: packagedExecutable(packagedAppRoot), sha256: audit.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageMac()
}
