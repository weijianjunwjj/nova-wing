import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

/**
 * Verify an electron-builder update metadata file against the artifacts it names.
 *
 * This is the gate that keeps `latest.yml` honest. electron-builder can write a metadata `path`
 * that no release asset carries — most easily by rewriting a name GitHub would not accept — and an
 * updater that follows it would 404. Every reference is therefore checked against the real bytes
 * before the metadata is allowed to leave the build.
 *
 * Usage:
 *   node scripts/platform/verify-update-metadata.mjs \
 *     --metadata artifacts/desktop/latest.yml \
 *     --files-dir artifacts/desktop \
 *     --expect-version 0.4.1 \
 *     [--expect-path "NovaWing-Setup-0.4.1-x64.exe"]
 */

function parseArguments(argv) {
  const options = { metadata: null, filesDir: null, expectVersion: null, expectPaths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--metadata') { options.metadata = value; index += 1 } else if (flag === '--files-dir') {
      options.filesDir = value; index += 1
    } else if (flag === '--expect-version') { options.expectVersion = value; index += 1 } else if (flag === '--expect-path') {
      options.expectPaths.push(value); index += 1
    } else throw new Error(`unknown argument: ${flag}`)
  }
  for (const key of ['metadata', 'filesDir', 'expectVersion']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) throw new Error(`--${key === 'filesDir' ? 'files-dir' : key.replace('expectVersion', 'expect-version')} is required`)
  }
  return options
}

function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

export async function verifyUpdateMetadata({ metadataPath, filesDir, expectVersion, expectPaths = [] }) {
  // js-yaml ships as CommonJS here; both 3.x and 4.x expose load through the default export.
  const document = yaml.load(await readFile(metadataPath, 'utf8'))
  assert.ok(document !== null && typeof document === 'object', `${metadataPath} is not a metadata document`)

  assert.equal(document.version, expectVersion, `${metadataPath} declares version ${document.version}, expected ${expectVersion}`)
  assert.ok(Array.isArray(document.files) && document.files.length > 0, `${metadataPath} names no files`)
  assert.equal(typeof document.path, 'string', `${metadataPath} has no primary path`)
  assert.equal(document.path, document.files[0].url, `${metadataPath} primary path ${document.path} is not the first listed file ${document.files[0].url}`)

  const present = new Set(await readdir(filesDir))
  const verified = []
  for (const entry of document.files) {
    assert.equal(typeof entry.url, 'string', `${metadataPath} has a file entry without a url`)
    assert.equal(typeof entry.sha512, 'string', `${metadataPath} entry ${entry.url} has no sha512`)
    // A metadata reference that no asset satisfies would hand the updater a 404.
    assert.ok(present.has(entry.url), `${metadataPath} references ${entry.url}, which is not among the produced assets`)
    const bytes = await readFile(join(filesDir, entry.url))
    assert.equal(sha512Base64(bytes), entry.sha512, `${metadataPath} sha512 for ${entry.url} does not match the artifact`)
    if (typeof entry.size === 'number') {
      assert.equal(entry.size, bytes.length, `${metadataPath} size for ${entry.url} does not match the artifact`)
    }
    verified.push({ url: entry.url, size: bytes.length })
  }

  for (const expected of expectPaths) {
    assert.ok(
      document.files.some((entry) => entry.url === expected),
      `${metadataPath} does not reference the required asset ${expected}`,
    )
  }

  return { version: document.version, path: document.path, files: verified }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  const report = await verifyUpdateMetadata({
    metadataPath: options.metadata, filesDir: options.filesDir,
    expectVersion: options.expectVersion, expectPaths: options.expectPaths,
  })
  console.log(`UPDATE_METADATA PASS ${basename(options.metadata)} version=${report.version} path=${report.path} files=${report.files.length}`)
  for (const file of report.files) console.log(`  ${file.url} (${file.size} bytes)`)
}
