import { npmCommand } from './platform/npm-command.mjs'
/* global process */
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const repositoryRoot = resolve(import.meta.dirname, '..')
export const releaseRoot = resolve(repositoryRoot, 'release-package')
export const githubRegistry = 'https://npm.pkg.github.com'

export function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

export function runNpm(arguments_, cwd = repositoryRoot) {
  const spec = npmCommand(arguments_)
  return run(spec.executable, spec.args, { cwd })
}

export function deriveGitHubRepository() {
  const remote = run('git', ['remote', 'get-url', 'origin']).trim()
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)\/?$/iu,
  )
  if (match === null) {
    throw new Error('origin must identify a GitHub owner and repository')
  }
  const owner = match[1]
  const repository = match[2].replace(/\.git$/iu, '')
  const npmScope = owner.toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(npmScope)) {
    throw new Error('GitHub owner cannot be normalized to a safe npm scope')
  }
  if (!/^[a-z0-9._-]+$/iu.test(repository)) {
    throw new Error('GitHub repository name is not safe package metadata')
  }
  return { npmScope, owner, remote, repository }
}

export function isExactSemVer(version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u.test(version)
}

export function readRootManifest() {
  return JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
}

export function releaseIdentity() {
  const github = deriveGitHubRepository()
  return {
    ...github,
    packageName: `@${github.npmScope}/nova-wing`,
  }
}

export function publicExports() {
  return Object.fromEntries(
    ['core', 'sqlite', 'testing', 'host-snapshot'].map((subpath) => [
      `./${subpath}`,
      {
        types: `./dist/${subpath}/index.d.ts`,
        import: `./dist/${subpath}/index.js`,
      },
    ]),
  )
}

export function createReleaseManifest() {
  const rootManifest = readRootManifest()
  const identity = releaseIdentity()
  if (!isExactSemVer(rootManifest.version)) {
    throw new Error('root package version must be an exact SemVer')
  }
  return {
    name: identity.packageName,
    version: rootManifest.version,
    description: rootManifest.description,
    license: rootManifest.license,
    repository: {
      type: 'git',
      url: `git+https://github.com/${identity.owner}/${identity.repository}.git`,
    },
    engines: rootManifest.engines,
    type: rootManifest.type,
    main: './dist/core/index.js',
    types: './dist/core/index.d.ts',
    exports: publicExports(),
    files: ['dist/**', 'README.md'],
    sideEffects: false,
    publishConfig: {
      registry: githubRegistry,
      access: 'restricted',
    },
    dependencies: {},
  }
}

export function walkFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(root, entry.name)
    return entry.isDirectory() ? walkFiles(child) : [child]
  })
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function inventory(root) {
  return Object.fromEntries(
    walkFiles(root)
      .map((path) => [relative(root, path).replaceAll('\\', '/'), sha256(readFileSync(path))])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function copyBuiltEntry(subpath, packageName) {
  const source = resolve(repositoryRoot, 'dist', 'packages', subpath, 'src')
  const destination = resolve(releaseRoot, 'dist', subpath)
  cpSync(source, destination, { recursive: true })
  for (const path of walkFiles(destination)) {
    if (!/\.(?:js|d\.ts)$/u.test(path)) {
      throw new Error(`unexpected build artifact: ${relative(destination, path)}`)
    }
    const content = readFileSync(path, 'utf8')
      .replaceAll("'nova-wing/", `'${packageName}/`)
      .replaceAll('"nova-wing/', `"${packageName}/`)
    writeFileSync(path, content, 'utf8')
  }
}

export function prepareReleasePackage() {
  if (releaseRoot !== resolve(repositoryRoot, 'release-package')) {
    throw new Error('refusing to clean an unexpected release directory')
  }
  rmSync(releaseRoot, { recursive: true, force: true })
  runNpm(['run', 'build'])
  mkdirSync(resolve(releaseRoot, 'dist'), { recursive: true })
  const manifest = createReleaseManifest()
  for (const subpath of ['core', 'sqlite', 'testing', 'host-snapshot']) {
    copyBuiltEntry(subpath, manifest.name)
  }
  cpSync(resolve(repositoryRoot, 'README.md'), resolve(releaseRoot, 'README.md'))
  writeFileSync(
    resolve(releaseRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  return manifest
}

export function packRelease(destination) {
  const result = JSON.parse(
    runNpm(
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        destination,
        '--cache',
        resolve(destination, '.npm-cache'),
      ],
      releaseRoot,
    ),
  )[0]
  if (
    result === undefined ||
    typeof result.filename !== 'string' ||
    !Array.isArray(result.files)
  ) {
    throw new Error('npm pack did not return an auditable result')
  }
  return result
}
