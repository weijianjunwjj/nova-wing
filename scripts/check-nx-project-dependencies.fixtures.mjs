/* global console, process */
/**
 * N0.5 counterexample harness for scripts/check-nx-project-dependencies.mjs.
 *
 * Proves the guard actually rejects drift instead of always printing `ok`.
 * Every scenario runs against a throwaway copy under the OS temp directory, so
 * the real repository and its declared dependencies are never mutated.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guard = join(repositoryRoot, 'scripts', 'check-nx-project-dependencies.mjs')
const projectJsonPaths = {
  core: 'packages/core/project.json',
  sqlite: 'packages/sqlite/project.json',
  'host-snapshot': 'packages/host-snapshot/project.json',
  testing: 'packages/testing/project.json',
  'development-guardian': 'packages/development-guardian/project.json',
  desktop: 'desktop/project.json',
}
const sourceRoots = {
  core: 'packages/core/src',
  sqlite: 'packages/sqlite/src',
  'host-snapshot': 'packages/host-snapshot/src',
  testing: 'packages/testing/src',
  'development-guardian': 'packages/development-guardian',
  desktop: 'desktop/main',
}

let failures = 0
const workspace = mkdtempSync(join(tmpdir(), 'novawing-nx-dep-guard-'))

function report(label, ok, detail) {
  if (!ok) {
    failures += 1
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
}

function makeFixture(name) {
  const root = join(workspace, name)
  for (const [project, sourceRoot] of Object.entries(sourceRoots)) {
    cpSync(join(repositoryRoot, sourceRoot), join(root, sourceRoot), { recursive: true })
  }
  for (const relativePath of Object.values(projectJsonPaths)) {
    cpSync(join(repositoryRoot, relativePath), join(root, relativePath))
  }
  return root
}

function readProjectJson(root, project) {
  return JSON.parse(readFileSync(join(root, projectJsonPaths[project]), 'utf8'))
}

function writeProjectJson(root, project, value) {
  writeFileSync(join(root, projectJsonPaths[project]), `${JSON.stringify(value, null, 2)}\n`)
}

function runGuard(root) {
  const result = spawnSync(process.execPath, [guard, '--root', root], { encoding: 'utf8' })
  return {
    code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout.trim()) : undefined,
  }
}

try {
  // Scenario 0: the untouched copy must pass, proving scenarios 1-3 are not noise.
  {
    const root = makeFixture('baseline')
    const result = runGuard(root)
    report(
      'baseline copy is clean',
      result.code === 0 && result.json?.status === 'ok' && result.json.edges === 4,
      result.stdout,
    )
  }

  // Scenario 1: a real edge removed from implicitDependencies must fail as `missing`.
  {
    const root = makeFixture('missing-edge')
    const project = readProjectJson(root, 'sqlite')
    project.implicitDependencies = []
    writeProjectJson(root, 'sqlite', project)
    const result = runGuard(root)
    const detected = result.json?.missing?.some((entry) => entry.edge === 'sqlite->core') === true
    report(
      'removed real edge is rejected as missing',
      result.code === 1 && result.json?.status === 'fail' && detected,
      result.stdout,
    )
  }

  // Scenario 2: a phantom declared edge must fail as `phantom`.
  {
    const root = makeFixture('phantom-edge')
    const project = readProjectJson(root, 'core')
    project.implicitDependencies = ['desktop']
    writeProjectJson(root, 'core', project)
    const result = runGuard(root)
    const detected = result.json?.phantom?.some((entry) => entry.edge === 'core->desktop') === true
    report(
      'phantom declared edge is rejected',
      result.code === 1 && result.json?.status === 'fail' && detected,
      result.stdout,
    )
  }

  // Scenario 3: a project-level cycle introduced by source imports must fail with a path.
  {
    const root = makeFixture('cycle')
    const coreIndex = join(root, sourceRoots.core, 'index.ts')
    writeFileSync(
      coreIndex,
      `${readFileSync(coreIndex, 'utf8')}\nimport { openSqliteNovaWingStore } from 'nova-wing/sqlite'\nvoid openSqliteNovaWingStore\n`,
    )
    const project = readProjectJson(root, 'core')
    project.implicitDependencies = ['sqlite']
    writeProjectJson(root, 'core', project)
    const result = runGuard(root)
    const path = result.json?.cyclePaths?.[0]
    const detected =
      result.code === 1 &&
      result.json?.cycles === 1 &&
      typeof path === 'string' &&
      path.includes('core') &&
      path.includes('sqlite')
    report('project cycle is rejected with a path', detected, result.stdout)
  }

  // Scenario 4: restoring the fixture must return a clean result (no residue).
  {
    const root = makeFixture('restored')
    const project = readProjectJson(root, 'testing')
    project.implicitDependencies = ['core', 'desktop']
    writeProjectJson(root, 'testing', project)
    if (runGuard(root).code !== 1) {
      report('tampered fixture is rejected before restore', false, 'guard unexpectedly passed')
    }
    project.implicitDependencies = ['core']
    writeProjectJson(root, 'testing', project)
    const result = runGuard(root)
    report(
      'restored fixture passes again',
      result.code === 0 && result.json?.status === 'ok',
      result.stdout,
    )
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

console.log(
  JSON.stringify({
    scenarios: 5,
    failures,
    status: failures === 0 ? 'ok' : 'fail',
  }),
)
process.exitCode = failures === 0 ? 0 : 1
