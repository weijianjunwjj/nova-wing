#!/usr/bin/env node
/**
 * Third-party licence pipeline for a packaged desktop application.
 *
 * This is a driver, not a scanner. Every fact it records comes from a mature, existing tool:
 *
 *   - `@cyclonedx/cyclonedx-npm` produces the SBOM.
 *   - `license-checker` enumerates the licences of the packages actually present in the
 *     shipped tree being audited.
 *   - `generate-license-file` emits the notice document from the repository's production
 *     dependency graph, with each dependency's licence text reproduced verbatim.
 *
 * It never writes, paraphrases or summarises licence text itself. If a mature tool is
 * unavailable, or the notices do not cover the shipped packages, it reports the gap instead
 * of a passing result.
 *
 * Availability is decided by running the real command, never by a `--version` probe: the
 * tools disagree about what `--version` exits with, and probing on exit status alone would
 * report working tooling as missing.
 *
 * Usage: node scripts/third-party-notices.mjs [--app <packaged app root>]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts', 'desktop')

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const appRoot = resolve(arg('--app') ?? join(root, 'artifacts', 'desktop', 'staging-mac'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: false, ...options })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

function reason(result) {
  return `${result.error?.message ?? result.stderr ?? ''}`.trim().replace(/\s+/gu, ' ').slice(0, 300)
}

/** Best-effort version string for the report. Never used to decide availability. */
function toolVersion(name) {
  const probe = run('npx', ['--yes', name, '--version'], { cwd: root })
  const match = /\bv?(\d+\.\d+\.\d+)\b/u.exec(`${probe.stdout}\n${probe.stderr}`)
  return match === null ? 'unknown' : match[1]
}

/** Every package directory present in the shipped tree, as name@version. */
function packagedPackages(appRoot) {
  const found = new Set()
  const record = (dir) => {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (manifest.name && manifest.version) found.add(`${manifest.name}@${manifest.version}`)
    } catch { /* not a package root */ }
    walk(join(dir, 'node_modules'))
  }
  const walk = (modulesDir, depth = 0) => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(modulesDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        let scoped = []
        try { scoped = readdirSync(join(modulesDir, entry.name), { withFileTypes: true }) } catch { /* unreadable scope */ }
        for (const inner of scoped) if (inner.isDirectory()) record(join(modulesDir, entry.name, inner.name))
        continue
      }
      record(join(modulesDir, entry.name))
    }
  }
  walk(join(appRoot, 'node_modules'))
  return found
}

if (!existsSync(appRoot)) {
  console.error(`THIRD_PARTY_NOTICES_TOOLING_GAP: no packaged app root at ${appRoot}`)
  process.exit(1)
}

const tools = {
  sbom: `@cyclonedx/cyclonedx-npm ${toolVersion('@cyclonedx/cyclonedx-npm')}`,
  inventory: `license-checker ${toolVersion('license-checker')}`,
  notices: `generate-license-file ${toolVersion('generate-license-file')}`,
}
const gaps = []

// 1. SBOM of the shipped tree, produced by CycloneDX's own npm tool.
const sbomPath = join(output, 'sbom-packed.json')
const sbomRun = run('npx', ['--yes', '@cyclonedx/cyclonedx-npm',
  '--output-format', 'json', '--output-file', sbomPath, '--ignore-npm-errors'], { cwd: appRoot })
let sbom = null
if (sbomRun.status !== 0 || !existsSync(sbomPath)) {
  gaps.push(`@cyclonedx/cyclonedx-npm failed: ${reason(sbomRun)}`)
} else {
  sbom = JSON.parse(readFileSync(sbomPath, 'utf8'))
  if (sbom.bomFormat !== 'CycloneDX') gaps.push('SBOM is not a CycloneDX document')
}

// 2. Licence inventory of the shipped tree, enumerated by license-checker.
const inventoryRun = run('npx', ['--yes', 'license-checker', '--production', '--json', '--start', appRoot], { cwd: root })
let inventory = null
if (inventoryRun.status !== 0) {
  gaps.push(`license-checker failed: ${reason(inventoryRun)}`)
} else {
  inventory = JSON.parse(inventoryRun.stdout)
  writeFileSync(join(output, 'third-party-license-inventory.json'), JSON.stringify({
    name: 'THIRD_PARTY_LICENSE_INVENTORY',
    appRoot,
    tool: tools.inventory,
    packageCount: Object.keys(inventory).length,
    packages: inventory,
  }, null, 2))
}

// 3. Notices from the production dependency graph, emitted verbatim by generate-license-file.
const noticesPath = join(output, 'THIRD_PARTY_NOTICES.txt')
const noticesRun = run('npx', ['--yes', 'generate-license-file',
  '--input', join(root, 'package.json'), '--output', noticesPath, '--overwrite'], { cwd: root })
let covered = null
if (noticesRun.status !== 0 || !existsSync(noticesPath)) {
  gaps.push(`generate-license-file failed: ${reason(noticesRun)}`)
} else {
  covered = new Set([...readFileSync(noticesPath, 'utf8').matchAll(/^\s*-\s+(\S+@\S+)\s*$/gmu)].map((match) => match[1]))
}

// 4. Coverage: nothing shipped may be absent from the notices.
const shipped = packagedPackages(appRoot)
const uncovered = covered === null ? [...shipped].sort() : [...shipped].filter((id) => !covered.has(id)).sort()
const coverage = { shippedPackages: shipped.size, noticeEntries: covered?.size ?? 0, uncovered }

const result = gaps.length > 0 ? 'TOOLING_GAP' : uncovered.length === 0 ? 'PASS' : 'FAIL'
writeFileSync(join(output, 'third-party-notices-audit.json'), JSON.stringify({
  name: 'THIRD_PARTY_NOTICES',
  result,
  appRoot,
  tools,
  sbom: sbom === null ? null : { specVersion: sbom.specVersion, componentCount: (sbom.components ?? []).length, file: 'sbom-packed.json' },
  notices: 'THIRD_PARTY_NOTICES.txt',
  inventory: inventory === null ? null : 'third-party-license-inventory.json',
  licenceTextWrittenByModel: false,
  coverage,
  gaps,
}, null, 2))

if (gaps.length > 0) {
  console.error(`THIRD_PARTY_NOTICES_TOOLING_GAP: ${gaps.join('; ')}`)
  process.exit(1)
}
console.log(`THIRD_PARTY_NOTICES ${result}: ${coverage.noticeEntries} notice entries, ${coverage.shippedPackages} shipped packages, ${uncovered.length} uncovered`)
if (uncovered.length > 0) {
  console.error(`Uncovered shipped packages: ${uncovered.slice(0, 20).join(', ')}${uncovered.length > 20 ? ` (+${uncovered.length - 20} more)` : ''}`)
  process.exit(1)
}
