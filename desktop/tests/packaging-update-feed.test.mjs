import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PACKAGED_UPDATE_CONFIG_FILE, UPDATE_FEED, UPDATE_FEED_CACHE_DIRECTORY, foldPackagedUpdateConfigIntoIdentity,
  packagedUpdateConfigValues, readPackagedUpdateConfig, readPackagedUpdateConfigBytes,
  verifyPackagedUpdateConfig, writePackagedUpdateConfig,
} from '../../scripts/platform/update-feed.mjs'

// The packaged Windows update feed. electron-builder writes app-update.yml from an afterPack hook
// that never runs for NovaWing's Windows builds, so the packaging adapter writes it and the
// installer phase verifies it. Everything here is offline: no network, no feed repository.

async function resourcesDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-feed-'))
  return { directory, resources: join(directory, 'resources') }
}

test('the writer produces the exact document, with a trailing newline', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    const path = await writePackagedUpdateConfig(resources)
    assert.equal(path, join(resources, PACKAGED_UPDATE_CONFIG_FILE))
    const text = await readFile(path, 'utf8')
    assert.equal(text, [
      `provider: ${UPDATE_FEED.provider}`,
      `owner: ${UPDATE_FEED.owner}`,
      `repo: ${UPDATE_FEED.repo}`,
      `updaterCacheDirName: ${UPDATE_FEED_CACHE_DIRECTORY}`,
      '',
    ].join('\n'))
    assert.ok(text.endsWith('\n'), 'the document ends with a newline')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('every written value is a plain scalar, which is why no YAML escaping is attempted', () => {
  // This is the premise that lets the document be assembled without a YAML library.
  for (const [key, value] of Object.entries(packagedUpdateConfigValues())) {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, `${key} would need escaping`)
  }
})

test('the reader does not depend on field order', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    await writePackagedUpdateConfig(resources)
    const original = await readFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), 'utf8')
    const reordered = ['updaterCacheDirName', 'repo', 'owner', 'provider'].map((key) => {
      const value = new RegExp(`^${key}: (.*)$`, 'mu').exec(original)?.[1]
      return `${key}: ${value}`
    }).join('\n')
    await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), `${reordered}\n`)
    const values = await readPackagedUpdateConfig(resources)
    assert.deepEqual(values, packagedUpdateConfigValues())
    await verifyPackagedUpdateConfig(resources)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a feed pointing at the private source repository is refused', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    // The regression this whole file exists for: the private repo a client can never authenticate to.
    await writePackagedUpdateConfig(resources)
    const text = await readFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), 'utf8')
    await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), text.replace(`repo: ${UPDATE_FEED.repo}`, 'repo: nova-wing'))
    await assert.rejects(verifyPackagedUpdateConfig(resources), /repo is "nova-wing"/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const REQUIRED_KEYS = ['provider', 'owner', 'repo', 'updaterCacheDirName']
for (const missing of REQUIRED_KEYS) {
  test(`a feed without ${missing} is refused`, async () => {
    const { resources, directory } = await resourcesDirectory()
    try {
      await writePackagedUpdateConfig(resources)
      const kept = packagedUpdateConfigValues()
      delete kept[missing]
      await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE),
        `${Object.entries(kept).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`)
      await assert.rejects(verifyPackagedUpdateConfig(resources), new RegExp(missing, 'u'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('an empty or unreadable feed is refused rather than read as empty', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    await writePackagedUpdateConfig(resources)
    await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), '')
    await assert.rejects(verifyPackagedUpdateConfig(resources), /provider is undefined/u)

    await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), '- a list item\n')
    await assert.rejects(verifyPackagedUpdateConfig(resources), /Unrecognized line/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the installer phase refuses a missing feed instead of recreating it', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    // Nothing was packaged into this tree: the installer must not repair that on the way past,
    // because the tree the smoke validated is the only one an installer may consume.
    await assert.rejects(verifyPackagedUpdateConfig(resources), /The packaged update feed is missing/u)
    assert.equal(await readPackagedUpdateConfigBytes(resources), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the installer phase refuses a tampered feed', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    await writePackagedUpdateConfig(resources)
    await verifyPackagedUpdateConfig(resources)
    const text = await readFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), 'utf8')
    await writeFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), text.replace('owner: weijianjunwjj', 'owner: someone-else'))
    await assert.rejects(verifyPackagedUpdateConfig(resources), /owner is "someone-else"/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** The same app bytes every time, so any difference in the digest comes from the feed. */
function identityFor(updateConfig) {
  const hash = createHash('sha256')
  hash.update('desktop/main/index.mjs').update('\0').update('app bytes').update('\0')
  foldPackagedUpdateConfigIntoIdentity(hash, updateConfig)
  return hash.digest('hex')
}

test('the packaged identity covers the feed, so a swapped feed cannot keep the same identity', async () => {
  const { resources, directory } = await resourcesDirectory()
  try {
    await writePackagedUpdateConfig(resources)
    const good = await readPackagedUpdateConfigBytes(resources)
    const tampered = Buffer.from((await readFile(join(resources, PACKAGED_UPDATE_CONFIG_FILE), 'utf8')).replace('nova-wing-releases', 'nova-wing'))

    const smokeIdentity = identityFor(good)
    assert.notEqual(identityFor(tampered), smokeIdentity,
      'a feed swapped after the smoke ran must not still match the smoke identity')
    assert.notEqual(identityFor(null), smokeIdentity,
      'a tree with no feed is not the tree the smoke validated')
    // The normal path: the installer re-reads the very file the smoke saw, so the identity holds.
    assert.equal(identityFor(await readPackagedUpdateConfigBytes(resources)), smokeIdentity)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
