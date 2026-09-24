import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/**
 * Third-party runtime distribution notices that must travel with the packaged application.
 *
 * Electron ships `LICENSE` (MIT, Electron contributors) and `LICENSES.chromium.html`
 * (Chromium third-party credits) at the root of its distribution. Electron does not place
 * them inside its own `Electron.app`, and electron-builder only carries them into the
 * Windows payload, so on macOS they have to be added to the bundle deliberately.
 *
 * `source` is the file as it exists in the pinned Electron distribution; `shipped` is the
 * name it carries inside `Contents/Resources/`. The shipped name is kept identical to the
 * Windows payload's so one release has one name per notice and the two can be compared
 * directly. The bytes are never edited, re-wrapped or summarised — they are copied verbatim.
 */
export const DISTRIBUTION_NOTICES = Object.freeze([
  Object.freeze({ source: ['node_modules', 'electron', 'dist', 'LICENSE'], shipped: 'LICENSE.electron.txt', component: 'Electron', license: 'MIT' }),
  Object.freeze({ source: ['node_modules', 'electron', 'dist', 'LICENSES.chromium.html'], shipped: 'LICENSES.chromium.html', component: 'Chromium', license: 'BSD-3-Clause and others' }),
])

export function distributionNoticeSourcePath(root, notice) {
  return join(root, ...notice.source)
}

export function distributionNoticeSourceRelative(notice) {
  return notice.source.join('/')
}

/** electron-builder `extraResources` entries placing each notice in `Contents/Resources/`. */
export function distributionNoticeExtraResources(root) {
  return DISTRIBUTION_NOTICES.map((notice) => ({
    from: distributionNoticeSourcePath(root, notice),
    to: notice.shipped,
  }))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read the notices from the pinned Electron distribution. Throws if the distribution does
 * not actually carry them, so a missing upstream file can never be silently accepted.
 */
export async function readDistributionNoticeSources(root) {
  const records = []
  for (const notice of DISTRIBUTION_NOTICES) {
    const sourcePath = distributionNoticeSourcePath(root, notice)
    let bytes
    try {
      bytes = await readFile(sourcePath)
    } catch (error) {
      throw new Error(`Pinned Electron distribution is missing ${distributionNoticeSourceRelative(notice)}: ${error.message}`)
    }
    assert.ok(bytes.length > 0, `Pinned Electron distribution notice is empty: ${distributionNoticeSourceRelative(notice)}`)
    records.push({ ...notice, sourcePath, sourceRelative: distributionNoticeSourceRelative(notice), bytes })
  }
  return records
}

/**
 * Bundle-level distribution licence audit.
 *
 * This is deliberately separate from the packaged app-content identity (`auditPackage`): the
 * notices live beside the app tree in `Contents/Resources/`, they are third-party runtime
 * notices rather than NovaWing application code, and folding them into the app-content hash
 * would misreport Electron/Chromium material as NovaWing content.
 *
 * It proves three things for every notice: the file exists in the bundle, its bytes are
 * identical to the pinned Electron distribution, and its hash is recorded.
 */
export async function auditBundledDistributionNotices(bundle, root) {
  const resources = join(bundle, 'Contents', 'Resources')
  const sources = await readDistributionNoticeSources(root)
  const notices = []
  for (const source of sources) {
    const shippedPath = join(resources, source.shipped)
    let shippedBytes
    try {
      shippedBytes = await readFile(shippedPath)
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Bundled distribution notice is missing: Contents/Resources/${source.shipped}`)
      }
      throw error
    }
    const sourceSha256 = sha256(source.bytes)
    const shippedSha256 = sha256(shippedBytes)
    assert.equal(
      shippedSha256, sourceSha256,
      `Bundled notice bytes differ from the pinned Electron distribution: Contents/Resources/${source.shipped}`,
    )
    notices.push({
      component: source.component,
      license: source.license,
      source: source.sourceRelative,
      shipped: `Contents/Resources/${source.shipped}`,
      bytes: shippedBytes.length,
      sha256: shippedSha256,
    })
  }
  assert.equal(notices.length, DISTRIBUTION_NOTICES.length, 'Not every distribution notice was audited')
  return {
    name: 'MACOS_BUNDLED_DISTRIBUTION_NOTICES',
    result: 'PASS',
    bundle: relative(root, bundle) || bundle,
    electronVersion: (await readFile(join(root, 'node_modules', 'electron', 'dist', 'version'), 'utf8')).trim(),
    notices,
  }
}

/** Paths of the notices as they appear inside a packaged container. */
export function containerNoticePaths(bundleName) {
  return DISTRIBUTION_NOTICES.map((notice) => `${bundleName}/Contents/Resources/${notice.shipped}`)
}

function verifyNoticeBytesAt(root, notice, filePath, container) {
  const expected = readFileSync(distributionNoticeSourcePath(root, notice))
  let actual
  try {
    actual = readFileSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${container} is missing distribution notice: ${notice.shipped}`)
    throw error
  }
  assert.equal(sha256(actual), sha256(expected), `${container} notice bytes differ from the pinned Electron distribution: ${notice.shipped}`)
  return { shipped: notice.shipped, bytes: actual.length, sha256: sha256(actual) }
}

/**
 * Verify the produced containers themselves carry the notices.
 *
 * The `.app` audit above proves the bundle on disk is correct; it does not prove what the DMG
 * and ZIP actually contain. These checks open each container and read the notices back out.
 * The ZIP is listed rather than extracted (the app payload is not unpacked), and the DMG is
 * mounted read-only and detached again.
 */
export function auditContainerNotices({ root, dmgPath, zipPath, bundleName }) {
  const expectedPaths = containerNoticePaths(bundleName)

  const listed = spawnSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: false })
  assert.equal(listed.status, 0, `Cannot list ZIP ${zipPath}: ${listed.stderr}`)
  const entries = new Set(listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
  const missingFromZip = expectedPaths.filter((path) => !entries.has(path))
  assert.deepEqual(missingFromZip, [], `ZIP ${zipPath} is missing distribution notices`)
  const zipNotices = expectedPaths.map((path) => ({ shipped: path, listed: true }))

  const mountPoint = mkdtempSync(join(tmpdir(), 'novawing-licence-audit-'))
  const attached = spawnSync('/usr/bin/hdiutil',
    ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmgPath],
    { encoding: 'utf8', shell: false })
  assert.equal(attached.status, 0, `Cannot mount DMG ${dmgPath}: ${attached.stderr || attached.stdout}`)
  let dmgNotices
  try {
    const bundleRoot = join(mountPoint, bundleName)
    assert.ok(statSync(bundleRoot).isDirectory(), `Mounted DMG has no ${bundleName}`)
    dmgNotices = DISTRIBUTION_NOTICES.map((notice) =>
      verifyNoticeBytesAt(root, notice, join(bundleRoot, 'Contents', 'Resources', notice.shipped), 'DMG'))
  } finally {
    spawnSync('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { encoding: 'utf8', shell: false })
    rmSync(mountPoint, { recursive: true, force: true })
  }

  return {
    name: 'MACOS_CONTAINER_DISTRIBUTION_NOTICES',
    result: 'PASS',
    dmg: { filename: dmgPath.split('/').pop(), notices: dmgNotices },
    zip: { filename: zipPath.split('/').pop(), notices: zipNotices },
  }
}
