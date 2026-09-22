import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { smokeEnvironment } from './platform/desktop-smoke-environment.mjs'
import { requireInstalledElectron } from './platform/desktop-dependency-preflight.mjs'

export const repositoryRoot = resolve(import.meta.dirname, '..')

/** Resolve the pinned installed binary; fails closed rather than downloading or falling back. */
export async function installedElectronBinary() {
  return realpath(requireInstalledElectron().binary)
}

/** Both interactive bootstrap and smoke use a fresh, disposable offline profile. */
export async function createDesktopIsolation() {
  assert.equal(process.versions.electron, undefined, 'Isolation must be prepared by external Node')
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'novawing-desktop-smoke-'))
  const cleanup = async () => {
    // Verify the exact mkdtemp target and symlink identity before recursive deletion.
    assert.equal(dirname(root), parent)
    assert.match(basename(root), /^novawing-desktop-smoke-[A-Za-z0-9]+$/u)
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  try {
    for (const directory of ['config', 'data', 'repo', 'home', 'tmp', 'home/roaming', 'home/local', 'home/config', 'home/data', 'home/cache']) {
      await mkdir(join(root, directory), { recursive: true })
    }
    return { root, env: smokeEnvironment(root), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
