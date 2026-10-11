/* global console */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceRoots = ['packages', 'tests', 'scripts', 'desktop'].map((path) => resolve(repositoryRoot, path))
const desktopRoot = resolve(repositoryRoot, 'desktop')
const packageRoots = ['packages', 'dist/packages'].map((path) => resolve(repositoryRoot, path))
const publicPackageImports = new Set(['nova-wing/development-guardian'])

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
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu

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

      continue
    }
    const resolvedImport = resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'))
    if (!isInside(repositoryRoot, resolvedImport)) {
      fail(`import escapes NovaWing repository: ${relative(repositoryRoot, file)} -> ${specifier}`)
    }
    if (isInside(desktopRoot, file) && packageRoots.some((root) => isInside(root, resolvedImport))) {
      fail(`desktop caller bypasses a public package export: ${relative(repositoryRoot, file)} -> ${specifier}`)
    }

  }
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
    dependencySource: 'registry-only',
    repositoryBoundary: repositoryRoot,
    status: 'ok',
  }),
)
