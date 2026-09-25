import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The single source of truth for the update feed.
 *
 * The update metadata must never be inferred from `.git/config`: the source repository is private
 * and stays private, and a client must never hold a GitHub token. Updates are therefore served
 * from a separate public binary repository that carries only release assets.
 *
 * This is declared explicitly in every packaging run, so the packaged `app-update.yml` and the
 * generated `latest*.yml` always point here regardless of the checkout's git remotes.
 */
export const UPDATE_FEED = Object.freeze({
  provider: 'github',
  owner: 'weijianjunwjj',
  repo: 'nova-wing-releases',
})

/** electron-builder's publish configuration for this feed. */
export const updateFeedPublishConfig = () => [{ ...UPDATE_FEED }]

/** The `owner/repo` slug, for release tooling that addresses the feed repository. */
export const UPDATE_FEED_REPOSITORY = `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`

/**
 * The cache directory electron-updater reads from the packaged config. Pinned here so the file
 * this build writes and anything that reads it cannot drift apart.
 */
export const UPDATE_FEED_CACHE_DIRECTORY = 'nova-wing-updater'

/** The config file electron-updater reads from the packaged application's resources directory. */
export const PACKAGED_UPDATE_CONFIG_FILE = 'app-update.yml'

/**
 * Every value in the packaged document is a fixed identifier from `UPDATE_FEED`, and each is
 * checked against this before it is written. That check is what lets the document be assembled
 * without a YAML library: a value that would need escaping fails the build rather than producing
 * a malformed document that the updater would misread.
 */
const SAFE_YAML_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** The exact key/value pairs the packaged app must carry. */
export function packagedUpdateConfigValues() {
  return {
    provider: UPDATE_FEED.provider,
    owner: UPDATE_FEED.owner,
    repo: UPDATE_FEED.repo,
    updaterCacheDirName: UPDATE_FEED_CACHE_DIRECTORY,
  }
}

/** The exact packaged document, with a trailing newline. */
export function packagedUpdateConfigText() {
  const lines = []
  for (const [key, value] of Object.entries(packagedUpdateConfigValues())) {
    if (!SAFE_YAML_SCALAR.test(value)) {
      throw new Error(`Refusing to write an update feed value that would need escaping: ${key}=${JSON.stringify(value)}`)
    }
    lines.push(`${key}: ${value}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write the feed into a packaged resources directory.
 *
 * electron-builder only writes this file from its `afterPack` hook, and that hook does not run for
 * a `dir` build (no distributable target) or for a prepackaged NSIS build (`doPack` returns before
 * the hook). NovaWing therefore writes it itself, into the tree the packaged smoke validates and
 * the NSIS build re-packs.
 *
 * @param {string} resourcesDirectory
 */
export async function writePackagedUpdateConfig(resourcesDirectory) {
  await mkdir(resourcesDirectory, { recursive: true })
  const path = join(resourcesDirectory, PACKAGED_UPDATE_CONFIG_FILE)
  await writeFile(path, packagedUpdateConfigText())
  return path
}

/**
 * Read the packaged feed. The document is a flat map, so field order carries no meaning here, and
 * any line this cannot understand is an error rather than something silently skipped.
 *
 * @param {string} resourcesDirectory
 * @returns {Promise<Record<string, string>>}
 */
export async function readPackagedUpdateConfig(resourcesDirectory) {
  const path = join(resourcesDirectory, PACKAGED_UPDATE_CONFIG_FILE)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error(`The packaged update feed is missing: ${path}`)
    }
    throw error
  }
  /** @type {Record<string, string>} */
  const values = {}
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/u.exec(line)
    if (match === null) throw new Error(`Unrecognized line in the packaged update feed: ${raw}`)
    values[match[1]] = match[2].replace(/^[\s"']+|[\s"']+$/gu, '')
  }
  return values
}

/**
 * Assert the packaged feed is exactly what this build promises. Used by the installer phase, so a
 * missing or altered feed fails the build rather than being repaired on the way past.
 *
 * @param {string} resourcesDirectory
 */
export async function verifyPackagedUpdateConfig(resourcesDirectory) {
  const values = await readPackagedUpdateConfig(resourcesDirectory)
  for (const [key, value] of Object.entries(packagedUpdateConfigValues())) {
    if (values[key] !== value) {
      throw new Error(`The packaged update feed ${key} is ${JSON.stringify(values[key])}, expected ${JSON.stringify(value)}`)
    }
  }
  if (values.repo === 'nova-wing') {
    throw new Error('The packaged update feed points at the private source repository')
  }
  return values
}

/**
 * The feed file's bytes, for callers that fold it into a packaged identity. Returns null when the
 * tree has no feed yet, which is the case for the staging audit that runs before it is written.
 *
 * @param {string} resourcesDirectory
 * @returns {Promise<Buffer | null>}
 */
export async function readPackagedUpdateConfigBytes(resourcesDirectory) {
  try {
    return await readFile(join(resourcesDirectory, PACKAGED_UPDATE_CONFIG_FILE))
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Fold the packaged feed into a running identity hash.
 *
 * This is what makes the packaged identity cover the feed: without it, a feed swapped after the
 * packaged smoke validated the tree would hash the same, and an installer built from that tree
 * would carry a file no smoke ever saw. A tree with no feed yet contributes nothing, which is the
 * staging audit that runs before the feed is written.
 *
 * @param {import('node:crypto').Hash} hash
 * @param {Buffer | null} bytes
 */
export function foldPackagedUpdateConfigIntoIdentity(hash, bytes) {
  if (bytes === null) return
  hash.update(PACKAGED_UPDATE_CONFIG_FILE).update('\0').update(bytes).update('\0')
}
