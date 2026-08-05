/* global console, process */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(import.meta.dirname, '..')
const distRoot = resolve(repositoryRoot, 'dist/packages')

function runNpm(arguments_) {
  const npmCli = process.env.npm_execpath
  const command = npmCli === undefined
    ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    : process.execPath
  const args = npmCli === undefined ? arguments_ : [npmCli, ...arguments_]
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`npm ${arguments_.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name)
    return entry.isDirectory() ? walk(child) : [child]
  })
}

function distInventory() {
  return Object.fromEntries(
    walk(distRoot)
      .map((path) => [
        relative(distRoot, path).replaceAll('\\', '/'),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

runNpm(['run', 'build'])
const firstBuild = distInventory()
runNpm(['run', 'build'])
const secondBuild = distInventory()
if (JSON.stringify(firstBuild) !== JSON.stringify(secondBuild)) {
  throw new Error('repeated builds produced a different runtime file list or SHA-256')
}

const packResult = JSON.parse(runNpm(['pack', '--dry-run', '--json']))[0]
if (packResult === undefined || !Array.isArray(packResult.files)) {
  throw new Error('npm pack --dry-run did not return an auditable file list')
}
const paths = packResult.files.map((file) => file.path).sort()
const forbidden = paths.filter((path) => {
  if (path === 'package.json' || path === 'README.md') {
    return false
  }
  return !/^dist\/packages\/.+\.(?:js|d\.ts)$/u.test(path)
})
if (forbidden.length > 0) {
  throw new Error(`tarball contains forbidden files: ${forbidden.join(', ')}`)
}
for (const fragment of ['tests/', 'scripts/', 'docs/', 'node_modules/', '.map', '.sqlite']) {
  if (paths.some((path) => path.toLowerCase().includes(fragment))) {
    throw new Error(`tarball contains forbidden path fragment: ${fragment}`)
  }
}
for (const subpath of ['core', 'sqlite', 'testing', 'host-snapshot']) {
  for (const extension of ['js', 'd.ts']) {
    const required = `dist/packages/${subpath}/src/index.${extension}`
    if (!paths.includes(required)) {
      throw new Error(`tarball is missing ${required}`)
    }
  }
}

console.log(JSON.stringify({
  deterministicBuildFiles: Object.keys(secondBuild).length,
  keyArtifactSha256: Object.fromEntries(
    Object.entries(secondBuild).filter(([path]) => path.endsWith('/src/index.js')),
  ),
  packedFileCount: paths.length,
  packedFiles: paths,
  status: 'ok',
}, null, 2))
