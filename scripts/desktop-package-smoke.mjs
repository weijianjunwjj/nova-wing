import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { desktopPackaging } from './platform/desktop-package-resolver.mjs'
import { repositoryRoot } from './desktop-isolation.mjs'

// Disposable validation overlay outside the source tree. The shipped tree is
// audited before copying and never contains these offline test/fixture files.
const packaged = await desktopPackaging()
const audit = await packaged.auditPackage(packaged.packagedAppRoot)
const parent = await realpath(tmpdir())
const root = await mkdtemp(join(parent, 'novawing-desktop-package-'))
try {
  const appRoot = await packaged.stagePackagedSmokeCopy(root)
  for (const path of ['desktop/tests', 'desktop/main/isolated-fixture.mjs', 'scripts/platform/desktop-smoke-environment.mjs']) {
    await cp(join(repositoryRoot, path), join(appRoot, path), { recursive: true })
  }
  const original = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  const child = spawn(process.execPath, [join(repositoryRoot, 'scripts', 'desktop-smoke.mjs')], {
    env: { ...process.env, NOVAWING_PACKAGED_SMOKE_APP_ROOT: appRoot,
      NOVAWING_PACKAGED_SMOKE_SHA256: audit.sha256,
      NOVAWING_PACKAGED_SMOKE_MANIFEST: JSON.stringify(original) }, stdio: 'inherit', shell: false,
  })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 0, 'Packaged Electron smoke failed')
} finally {
  assert.equal(dirname(root), parent)
  assert.ok(basename(root).startsWith('novawing-desktop-package-'))
  assert.equal(await realpath(root), root)
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
