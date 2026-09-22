import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../..')

/** The only sanctioned repair: the pinned package's own installer, never an implicit download. */
export const electronRepairCommand = 'node node_modules/electron/install.js'

/**
 * Verify the installed Electron runtime before packaging or smoke.
 *
 * npm may complete without running Electron's postinstall (observed with npm 11 and a
 * mirrored registry), leaving no `dist/`. Fail here with an explicit repair command
 * instead of letting a later path read surface an opaque ENOENT.
 */
export function requireInstalledElectron() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  const pinned = manifest.devDependencies.electron
  const directory = dirname(createRequire(import.meta.url).resolve('electron'))
  const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version
  assert.equal(installed, pinned, `Electron ${installed} does not match the pinned ${pinned}`)
  const pathFile = join(directory, 'path.txt')
  assert.ok(existsSync(pathFile), `Electron ${pinned} runtime is not installed. Run: ${electronRepairCommand}`)
  const binary = join(directory, 'dist', readFileSync(pathFile, 'utf8').trim())
  assert.ok(existsSync(binary), `Electron ${pinned} runtime dist is incomplete. Run: ${electronRepairCommand}`)
  return { version: pinned, directory, binary }
}
