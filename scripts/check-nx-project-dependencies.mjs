/* global console, process */
/**
 * Nx project dependency drift guard (Phase N0.5).
 *
 * Nx `implicitDependencies` are declarative: nothing proves they match reality.
 * This guard derives the real cross-project edges from static source imports of
 * each project's `sourceRoot`, then requires an exact set match against the
 * declared `implicitDependencies`, and finally rejects project-level cycles.
 *
 * Scope: exactly the six projects established in N0. It does not move source,
 * does not add plugins and does not redefine build architecture.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The only projects this guard reasons about; a new project needs a reviewed entry. */
const projectNames = [
  'core',
  'sqlite',
  'host-snapshot',
  'testing',
  'development-guardian',
  'desktop',
]

/** `nova-wing/<name>` package aliases map 1:1 onto the Nx project of the same name. */
const aliasPrefix = 'nova-wing/'

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Never walked; build output and dependencies are not authored source. */
const ignoredDirectories = new Set([
  '.git',
  '.nx',
  '.tmp',
  'artifacts',
  'coverage',
  'dist',
  'dist-tests',
  'node_modules',
  'release-package',
])

function fail(message) {
  throw new Error(message)
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${toPosix(path)}: ${error.message}`)
  }
}

export function loadProjects(root) {
  return projectNames.map((name) => {
    const projectJsonPath = resolve(root, projectRootOf(name), 'project.json')
    const projectJson = readJson(projectJsonPath)
    if (projectJson.name !== name) {
      fail(`${toPosix(projectJsonPath)} declares project name "${projectJson.name}", expected "${name}"`)
    }
    if (typeof projectJson.sourceRoot !== 'string' || projectJson.sourceRoot.length === 0) {
      fail(`${toPosix(projectJsonPath)} has no sourceRoot`)
    }
    const declared = projectJson.implicitDependencies ?? []
    if (!Array.isArray(declared)) {
      fail(`${toPosix(projectJsonPath)} implicitDependencies must be an array`)
    }
    for (const dependency of declared) {
      if (!projectNames.includes(dependency)) {
        fail(`${name} declares unknown implicit dependency "${dependency}"`)
      }
      if (dependency === name) {
        fail(`${name} declares itself as an implicit dependency`)
      }
    }
    const sourceRoot = toPosix(resolve(root, projectJson.sourceRoot))
    const stats = statSync(sourceRoot, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isDirectory()) {
      fail(`${name} sourceRoot does not exist: ${projectJson.sourceRoot}`)
    }
    return {
      name,
      sourceRoot,
      sourceRootRelative: toPosix(projectJson.sourceRoot).replace(/\/+$/u, ''),
      declared: [...new Set(declared)].sort(),
      projectJsonRelative: toPosix(relative(root, projectJsonPath)),
    }
  })
}

function projectRootOf(name) {
  return name === 'desktop' ? 'desktop' : `packages/${name}`
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue
    }
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walk(absolute, files)
      }
      continue
    }
    if (sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(absolute)
    }
  }
  return files
}

/**
 * Removes comments while preserving string literals, so JSDoc `import('...')`
 * type references cannot manufacture phantom edges.
 */
export function stripComments(source) {
  let result = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') {
          result += '\n'
        }
        index += 1
      }
      index += 2
      continue
    }
    if (char === '`') {
      // Template bodies are data, not code: drop them so embedded text cannot
      // look like an import statement.
      index += 1
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          index += 2
          continue
        }
        if (inner === '\n') {
          result += '\n'
        }
        index += 1
        if (inner === '`') {
          break
        }
      }
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      result += char
      index += 1
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          result += inner + (source[index + 1] ?? '')
          index += 2
          continue
        }
        result += inner
        index += 1
        if (inner === quote) {
          break
        }
      }
      continue
    }
    result += char
    index += 1
  }
  return result
}

const specifierPatterns = [
  /(?:\bfrom|\bimport)\s*\(?\s*(['"])([^'"]+)\1/gu,
  /\brequire\s*\(\s*(['"])([^'"]+)\1/gu,
  /^\s*import\s+(['"])([^'"]+)\1/gmu,
]

/** Extracts static/`export from`/side-effect/dynamic/require specifiers. */
export function collectSpecifiers(source) {
  const cleaned = stripComments(source)
  const specifiers = new Set()
  for (const pattern of specifierPatterns) {
    for (const match of cleaned.matchAll(pattern)) {
      if (match[2] !== undefined) {
        specifiers.add(match[2])
      }
    }
  }
  return specifiers
}

const nodeBuiltinPattern = /^node:/u

function projectOwningFile(projects, absoluteFile) {
  const matches = projects.filter((project) => {
    const path = relative(project.sourceRoot, absoluteFile)
    return path === '' || (!path.startsWith('..') && !isAbsolute(path))
  })
  if (matches.length > 1) {
    fail(`source file belongs to multiple projects: ${toPosix(absoluteFile)}`)
  }
  return matches[0]
}

function resolveProject(projects, owningProject, absoluteFile, specifier) {
  if (specifier.startsWith(aliasPrefix)) {
    const name = specifier.slice(aliasPrefix.length).split('/')[0]
    if (!projectNames.includes(name)) {
      fail(`unreviewed NovaWing package alias "${specifier}" in ${toPosix(absoluteFile)}`)
    }
    return name
  }
  if (!specifier.startsWith('.')) {
    // Node builtins and third-party npm packages are out of scope.
    if (nodeBuiltinPattern.test(specifier)) {
      return undefined
    }
    return undefined
  }
  const base = resolve(dirname(absoluteFile), specifier)
  for (const project of projects) {
    if (project.name === owningProject.name) {
      continue
    }
    const path = relative(project.sourceRoot, base)
    if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
      return project.name
    }
  }
  return undefined
}

export function deriveRealEdges(root) {
  const projects = loadProjects(root)
  const edges = new Map()
  const files = []
  for (const project of projects) {
    for (const file of walk(project.sourceRoot)) {
      files.push(file)
      const owner = projectOwningFile(projects, file)
      if (owner === undefined) {
        fail(`source file is outside every project sourceRoot: ${toPosix(file)}`)
      }
      for (const specifier of collectSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolveProject(projects, owner, file, specifier)
        if (target === undefined || target === owner.name) {
          continue
        }
        const key = `${owner.name}->${target}`
        if (!edges.has(key)) {
          edges.set(key, { source: owner.name, target, evidence: [] })
        }
        edges.get(key).evidence.push(`${toPosix(relative(root, file))} -> ${specifier}`)
      }
    }
  }
  for (const edge of edges.values()) {
    edge.evidence.sort()
  }
  if (files.length === 0) {
    fail('no source files were found under any project sourceRoot; refusing to report a clean graph')
  }
  return { projects, edges, scannedFiles: files.length }
}

/** Iterative Tarjan SCC; every SCC with >1 node, or a self-loop, is a cycle. */
export function findCycles(projects, edges) {
  const adjacency = new Map(projects.map((project) => [project.name, []]))
  for (const edge of edges.values()) {
    adjacency.get(edge.source)?.push(edge.target)
  }
  for (const targets of adjacency.values()) {
    targets.sort()
  }
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  let counter = 0

  for (const start of projectNames) {
    if (index.has(start)) {
      continue
    }
    const work = [{ node: start, childIndex: 0 }]
    index.set(start, counter)
    low.set(start, counter)
    counter += 1
    stack.push(start)
    onStack.add(start)
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const targets = adjacency.get(frame.node) ?? []
      if (frame.childIndex < targets.length) {
        const child = targets[frame.childIndex]
        frame.childIndex += 1
        if (!index.has(child)) {
          index.set(child, counter)
          low.set(child, counter)
          counter += 1
          stack.push(child)
          onStack.add(child)
          work.push({ node: child, childIndex: 0 })
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(child)))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1]
        low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = []
        let member = stack.pop()
        while (member !== undefined) {
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) {
            break
          }
          member = stack.pop()
        }
        component.sort()
        components.push(component)
      }
    }
  }

  return components
    .filter((component) => component.length > 1)
    .sort((left, right) => left.length - right.length || left[0].localeCompare(right[0]))
}

/** Builds a readable closed walk through the component, e.g. `a -> b -> a`. */
export function cyclePath(component, edges) {
  const members = new Set(component)
  const adjacency = new Map(component.map((name) => [name, []]))
  for (const edge of edges.values()) {
    if (members.has(edge.source) && members.has(edge.target)) {
      adjacency.get(edge.source).push(edge.target)
    }
  }
  for (const targets of adjacency.values()) {
    targets.sort()
  }
  const path = []
  const visited = new Set()
  let current = component[0]
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    path.push(current)
    current = adjacency.get(current)?.find((target) => members.has(target))
  }
  return `${[...path, path[0]].join(' -> ')}`
}

export function evaluate(root) {
  const { projects, edges } = deriveRealEdges(root)
  const real = new Set([...edges.values()].map((edge) => `${edge.source}->${edge.target}`))
  const declared = new Set()
  const declaredOwners = new Map()
  for (const project of projects) {
    for (const dependency of project.declared) {
      declared.add(`${project.name}->${dependency}`)
      declaredOwners.set(`${project.name}->${dependency}`, project.projectJsonRelative)
    }
  }

  const missing = []
  for (const [key, edge] of [...edges.entries()].sort()) {
    if (!declared.has(key)) {
      missing.push({
        edge: key,
        source: edge.source,
        target: edge.target,
        evidence: [...new Set(edge.evidence)].slice(0, 5),
        fix: `add "${edge.target}" to ${projectNames.includes(edge.source) ? projectRootOf(edge.source) : edge.source}/project.json implicitDependencies`,
      })
    }
  }
  const phantom = [...declared]
    .filter((key) => !real.has(key))
    .sort()
    .map((key) => ({
      edge: key,
      declaredIn: declaredOwners.get(key),
      fix: `remove "${key.split('->')[1]}" from ${declaredOwners.get(key)} implicitDependencies, or restore a real import`,
    }))

  const components = findCycles(projects, edges)
  const cycles = components.map((component) => ({
    projects: component,
    path: cyclePath(component, edges),
  }))

  const ok = missing.length === 0 && phantom.length === 0 && cycles.length === 0
  return {
    ok,
    projects: projects.map((project) => ({
      name: project.name,
      sourceRoot: project.sourceRootRelative,
      declared: project.declared,
    })),
    edges: [...real].sort(),
    projectCount: projects.length,
    missing,
    phantom,
    cycles,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root')
  const root = rootIndex === -1 ? resolve(import.meta.dirname, '..') : resolve(process.argv[rootIndex + 1])
  const result = evaluate(root)
  if (result.ok) {
    const summary = {
      projects: result.projectCount,
      edges: result.edges.length,
      cycles: 0,
      status: 'ok',
    }
    if (process.argv.includes('--verbose')) {
      summary.projectNames = result.projects.map((project) => project.name)
      summary.realEdges = result.edges
    }
    console.log(JSON.stringify(summary))
  } else {
    console.log(
      JSON.stringify(
        {
          projects: result.projectCount,
          edges: result.edges.length,
          realEdges: result.edges,
          cycles: result.cycles.length,
          missing: result.missing,
          phantom: result.phantom,
          cyclePaths: result.cycles.map((cycle) => cycle.path),
          status: 'fail',
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}
