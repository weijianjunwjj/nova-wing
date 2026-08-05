/* global console */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  createReleaseManifest,
  deriveGitHubRepository,
  githubRegistry,
  inventory,
  isExactSemVer,
  packRelease,
  prepareReleasePackage,
  publicExports,
  readRootManifest,
  releaseIdentity,
  releaseRoot,
  repositoryRoot,
  sha256,
  walkFiles,
} from './release-lib.mjs'

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function safeCleanup(path) {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(path))
  if (!relativeToTemp.startsWith('..') && !isAbsolute(relativeToTemp)) {
    rmSync(path, { recursive: true, force: true })
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'nova-wing-release-inspect-'))
try {
  const rootManifest = readRootManifest()
  requireCondition(rootManifest.private === true, 'repository root must remain private')
  requireCondition(rootManifest.license === 'UNLICENSED', 'repository root must remain UNLICENSED')

  const expectedManifest = createReleaseManifest()
  const firstManifest = prepareReleasePackage()
  const firstInventory = inventory(releaseRoot)
  const secondManifest = prepareReleasePackage()
  const secondInventory = inventory(releaseRoot)
  requireCondition(same(firstManifest, secondManifest), 'release manifests are not deterministic')
  requireCondition(
    same(firstInventory, secondInventory),
    'repeated release preparation changed the file inventory or SHA-256',
  )

  const manifest = JSON.parse(readFileSync(resolve(releaseRoot, 'package.json'), 'utf8'))
  const identity = releaseIdentity()
  requireCondition(!Object.hasOwn(manifest, 'private'), 'release manifest must not contain private')
  requireCondition(manifest.name === identity.packageName, 'release package name is incorrect')
  requireCondition(isExactSemVer(manifest.version), 'release version is not exact SemVer')
  requireCondition(same(manifest, expectedManifest), 'release manifest differs from policy')
  requireCondition(manifest.publishConfig?.registry === githubRegistry, 'registry must be GitHub Packages')
  requireCondition(manifest.publishConfig?.access === 'restricted', 'package access must be restricted')
  requireCondition(same(manifest.exports, publicExports()), 'release exports are incorrect')
  requireCondition(!Object.hasOwn(manifest, 'scripts'), 'release manifest must not inherit scripts')
  requireCondition(!Object.hasOwn(manifest, 'devDependencies'), 'release manifest inherited test tooling')
  requireCondition(same(manifest.dependencies, {}), 'release package has unexpected runtime dependencies')

  const firstPackDirectory = resolve(temporaryRoot, 'first')
  const secondPackDirectory = resolve(temporaryRoot, 'second')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(firstPackDirectory)
  mkdirSync(secondPackDirectory)
  const firstPack = packRelease(firstPackDirectory)
  const secondPack = packRelease(secondPackDirectory)
  const firstTarball = readFileSync(resolve(firstPackDirectory, firstPack.filename))
  const secondTarball = readFileSync(resolve(secondPackDirectory, secondPack.filename))
  requireCondition(firstPack.filename === secondPack.filename, 'tarball filename is not deterministic')
  requireCondition(sha256(firstTarball) === sha256(secondTarball), 'tarball SHA-256 is not deterministic')

  const packedFiles = firstPack.files.map((file) => file.path).sort()
  const forbiddenFiles = packedFiles.filter((path) => {
    if (path === 'package.json' || path === 'README.md') {
      return false
    }
    return !/^dist\/(?:core|sqlite|testing|host-snapshot)\/.+\.(?:js|d\.ts)$/u.test(path)
  })
  requireCondition(forbiddenFiles.length === 0, `tarball contains forbidden files: ${forbiddenFiles.join(', ')}`)
  for (const fragment of [
    '.git',
    '.map',
    '.npmrc',
    '.sqlite',
    'docs/',
    'node_modules/',
    'scripts/',
    'src/',
    'tests/',
  ]) {
    requireCondition(
      !packedFiles.some((path) => path.toLowerCase().includes(fragment)),
      `tarball contains forbidden path fragment: ${fragment}`,
    )
  }

  for (const subpath of ['core', 'sqlite', 'testing', 'host-snapshot']) {
    for (const extension of ['js', 'd.ts']) {
      requireCondition(
        packedFiles.includes(`dist/${subpath}/index.${extension}`),
        `tarball is missing dist/${subpath}/index.${extension}`,
      )
    }
  }

  const credentialPattern = /(?:_authToken\s*=|github_pat_[0-9a-z_]+|gh[pousr]_[0-9a-z]{20,}|npm_[0-9a-z]{20,})/iu
  const absolutePathPattern = /(?:(?:^|[^a-z0-9+.-])[a-z]:[\\/]|file:\/\/\/)/imu
  const unscopedPrefix = `nova-${'wing'}/`
  for (const path of walkFiles(releaseRoot)) {
    const content = readFileSync(path, 'utf8')
    requireCondition(!credentialPattern.test(content), 'release package contains credential-shaped content')
    requireCondition(!absolutePathPattern.test(content), 'release package contains an absolute local path')
    requireCondition(
      !content.includes(`from '${unscopedPrefix}`) && !content.includes(`from "${unscopedPrefix}`),
      'release artifact contains the unscoped internal package name',
    )
  }

  const npmrc = readFileSync(resolve(repositoryRoot, '.npmrc'), 'utf8').trim()
  requireCondition(
    npmrc === `@${identity.npmScope}:registry=${githubRegistry}`,
    'project .npmrc must contain only the credential-free scoped registry mapping',
  )

  const workflow = readFileSync(
    resolve(repositoryRoot, '.github', 'workflows', 'publish-github-packages.yml'),
    'utf8',
  )
  requireCondition(/^on:\s*\r?\n\s+workflow_dispatch:/mu.test(workflow), 'workflow must be manual only')
  requireCondition(!/^\s+push:/mu.test(workflow), 'ordinary pushes must not trigger publication')
  requireCondition(
    /^permissions:\s*\r?\n\s+contents: read\s*\r?\n\s+packages: write\s*$/mu.test(workflow),
    'workflow permissions are not minimal',
  )
  requireCondition(workflow.includes('actions/checkout@v4'), 'checkout action must pin its major version')
  requireCondition(workflow.includes('actions/setup-node@v4'), 'setup-node action must pin its major version')
  requireCondition(!credentialPattern.test(workflow), 'workflow contains a hard-coded token')
  requireCondition(
    workflow.includes('npm publish ./release-package --ignore-scripts --registry=https://npm.pkg.github.com'),
    'publish command must target only release-package and GitHub Packages',
  )
  requireCondition(!workflow.includes('registry.npmjs.org'), 'workflow references the public npm registry')
  requireCondition(
    !/run:[^\n]*\$\{\{\s*inputs\./u.test(workflow),
    'workflow input must not be interpolated into a shell command',
  )

  const github = deriveGitHubRepository()
  const keyArtifactSha256 = Object.fromEntries(
    Object.entries(secondInventory).filter(([path]) => /dist\/(?:core|sqlite|testing|host-snapshot)\/index\.(?:js|d\.ts)$/u.test(path)),
  )
  console.log(JSON.stringify({
    access: manifest.publishConfig.access,
    deterministicFiles: Object.keys(secondInventory).length,
    fileCount: packedFiles.length,
    files: packedFiles,
    github: `${github.owner}/${github.repository}`,
    keyArtifactSha256,
    name: manifest.name,
    registry: manifest.publishConfig.registry,
    safetyChecks: 15,
    status: 'ok',
    tarball: firstPack.filename,
    tarballSha256: sha256(firstTarball),
    tarballSize: firstTarball.length,
    version: manifest.version,
  }, null, 2))
} finally {
  safeCleanup(temporaryRoot)
}
