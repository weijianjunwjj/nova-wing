/* global console */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceRoots = ['packages', 'tests', 'scripts'].map((path) => resolve(repositoryRoot, path))
const coreRoot = resolve(repositoryRoot, 'packages/core/src')
const sqliteRoot = resolve(repositoryRoot, 'packages/sqlite/src')
const testingRoot = resolve(repositoryRoot, 'packages/testing/src')
const hostSnapshotRoot = resolve(repositoryRoot, 'packages/host-snapshot/src')
const publicPackageImports = new Set([
  'nova-wing/core',
  'nova-wing/sqlite',
  'nova-wing/testing',
  'nova-wing/host-snapshot',
])

function fail(message) {
  throw new Error(message)
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function walk(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    fail(`source symlink is forbidden: ${relative(repositoryRoot, path)}`)
  }
  if (!stat.isDirectory()) {
    return [path]
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    walk(resolve(path, entry.name)),
  )
}

const files = sourceRoots.flatMap(walk)
const sourceFiles = files.filter((path) => path.endsWith('.ts') || path.endsWith('.mjs'))
const importPattern = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/gu

for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]
    if (specifier === undefined) {
      continue
    }
    if (specifier.includes('/src/')) {
      fail(`deep source import is forbidden: ${relative(repositoryRoot, file)} -> ${specifier}`)
    }
    if (!specifier.startsWith('.')) {
      if (specifier.startsWith('nova-wing/') && !publicPackageImports.has(specifier)) {
        fail(`non-public NovaWing package import: ${relative(repositoryRoot, file)} -> ${specifier}`)
      }
      if (isInside(coreRoot, file) && specifier === 'node:sqlite') {
        fail('NovaWing core cannot import node:sqlite')
      }
      continue
    }
    const resolvedImport = resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'))
    if (!isInside(repositoryRoot, resolvedImport)) {
      fail(`import escapes NovaWing repository: ${relative(repositoryRoot, file)} -> ${specifier}`)
    }
    if (
      !isInside(coreRoot, file) &&
      !isInside(sqliteRoot, file) &&
      !isInside(testingRoot, file) &&
      !isInside(hostSnapshotRoot, file) &&
      (isInside(coreRoot, resolvedImport) ||
        isInside(sqliteRoot, resolvedImport) ||
        isInside(testingRoot, resolvedImport) ||
        isInside(hostSnapshotRoot, resolvedImport))
    ) {
      fail(`caller bypasses a public package export: ${relative(repositoryRoot, file)}`)
    }
    if (isInside(coreRoot, file) && !isInside(coreRoot, resolvedImport)) {
      fail(`core import crosses its boundary: ${relative(repositoryRoot, file)} -> ${specifier}`)
    }
    if (isInside(sqliteRoot, file) && isInside(testingRoot, resolvedImport)) {
      fail(`SQLite adapter cannot depend on testing: ${relative(repositoryRoot, file)}`)
    }
    if (isInside(hostSnapshotRoot, file) && isInside(testingRoot, resolvedImport)) {
      fail(`host snapshot contract cannot depend on testing: ${relative(repositoryRoot, file)}`)
    }
  }
}

const authoritativeSource = [...walk(coreRoot), ...walk(sqliteRoot)]
  .filter((path) => path.endsWith('.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const forbiddenDomainVocabulary = [
  'StrategyWindow',
  'CapabilityBaseline',
  'MarketPosition',
  'DecisionGate',
  'jobSearchFocus',
  'offerflow',
]
for (const forbidden of forbiddenDomainVocabulary) {
  if (authoritativeSource.toLowerCase().includes(forbidden.toLowerCase())) {
    fail(`authoritative NovaWing code contains host-domain vocabulary: ${forbidden}`)
  }
}

const sqliteSource = walk(sqliteRoot)
  .filter((path) => path.endsWith('.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const sqlTargetPatterns = [
  /\b(?:FROM|INTO|REFERENCES|JOIN)\s+([a-z][a-z0-9_]*)/giu,
  /^\s*UPDATE\s+(?!OF\b|ON\b)([a-z][a-z0-9_]*)/gimu,
]
const allowedNonNovaWingTargets = new Set(['latest_entries', 'sqlite_schema'])
for (const pattern of sqlTargetPatterns) {
  for (const match of sqliteSource.matchAll(pattern)) {
    const target = match[1]?.toLowerCase()
    if (
      target !== undefined &&
      !target.startsWith('nw_') &&
      !allowedNonNovaWingTargets.has(target)
    ) {
      fail(`SQLite source references a non-NovaWing SQL target: ${target}`)
    }
  }
}

const createdTables = [
  ...sqliteSource.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)/giu),
].map((match) => match[1]?.toLowerCase())
if (createdTables.some((table) => table === undefined || !table.startsWith('nw_'))) {
  fail('every NovaWing table must use the nw_ prefix')
}
const expectedTables = ['nw_mainline_entries', 'nw_meta', 'nw_proposals']
if (JSON.stringify([...createdTables].sort()) !== JSON.stringify(expectedTables)) {
  fail(`unexpected migration table set: ${createdTables.join(', ')}`)
}

const hostSnapshotSource = walk(hostSnapshotRoot)
  .filter((path) => path.endsWith('.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
if (hostSnapshotSource.toLowerCase().includes('offerflow')) {
  fail('host snapshot contract must remain independent of a concrete host')
}
if (/[A-Za-z]:[\\/]/u.test(hostSnapshotSource)) {
  fail('host snapshot contract contains an absolute Windows path')
}

const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
const dependencyGroups = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
for (const group of dependencyGroups) {
  for (const [name, value] of Object.entries(packageJson[group] ?? {})) {
    if (
      typeof value !== 'string' ||
      /^(?:file:|link:|workspace:)/u.test(value) ||
      value.startsWith('../') ||
      isAbsolute(value)
    ) {
      fail(`local or invalid dependency is forbidden: ${group}.${name}`)
    }
  }
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
  if (packageJson.scripts?.[hook] !== undefined) {
    fail(`package lifecycle side effect is forbidden: ${hook}`)
  }
}
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (typeof command === 'string' && /(?:npm\s+publish|npm\.cmd\s+publish)/iu.test(command)) {
    fail(`automatic publication is forbidden: ${name}`)
  }
}
if (existsSync(resolve(repositoryRoot, '.gitmodules'))) {
  fail('Git submodules are forbidden')
}

console.log(
  JSON.stringify({
    checkedSourceFiles: sourceFiles.length,
    authoritativeTables: expectedTables,
    dependencySource: 'registry-only',
    hostSnapshotConcreteHostReferences: 0,
    repositoryBoundary: repositoryRoot,
    status: 'ok',
  }),
)
