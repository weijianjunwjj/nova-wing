import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { smokeEnvironment } from './platform/desktop-smoke-environment.mjs'

export const repositoryRoot = resolve(import.meta.dirname, '..')

/** Resolve the installed binary without Electron's implicit download or overrides. */
export async function installedElectronBinary() {
  const directory = dirname(createRequire(import.meta.url).resolve('electron'))
  const executable = (await readFile(join(directory, 'path.txt'), 'utf8')).trim()
  return realpath(join(directory, 'dist', executable))
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
