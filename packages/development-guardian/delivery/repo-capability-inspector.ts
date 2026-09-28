import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { inspectDeliveryTarget, type DeliveryTargetBinding } from './runtime-plan.js'

const run = promisify(execFile)
const MAX_FILES = 5_000
const MAX_FILE_BYTES = 512_000
const allowed = /(?:^|\/)(?:package\.json|[^/]+\.(?:[cm]?[jt]sx?|json|sql|yaml|yml|toml|env\.example)|[^/]+\.schema)$/iu
const excluded = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|vendor|\.next)(?:\/|$)/u
const contractPath = 'verification/blueprints.v1.json'

export interface RepoCapabilityFacts {
  baselineCommit: string
  gitRepositoryIdentity: string
  scannedFileCount: number
  sourceFileCount: number
  scripts: Array<{ name: string; entry: string }>
  routes: Array<{ method: string; route: string; sourceFile: string }>
  routePatterns: Array<{ method: string; pattern: string; sourceFile: string }>
  testFiles: Array<{ path: string; caseNames: string[]; assertionIds: string[]; assertionContractHashes: string[] }>
  sourceEntries: Array<{ path: string; exportedNames: string[]; methodNames: string[] }>
  artifactPaths: string[]
  schemaFiles: string[]
  migrationFiles: string[]
  configurationExamples: string[]
  contract?: { relativePath: string; sha256: string; entries: unknown[] }
}

function safeTrackedPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..') && !excluded.test(path)
}

async function readTracked(root: string, path: string): Promise<string | undefined> {
  if (!safeTrackedPath(path)) return undefined
  const file = resolve(root, path)
  if (!file.startsWith(`${root}${sep}`) || relative(root, file) !== path) return undefined
  const stat = await lstat(file).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined
  if (await realpath(file) !== file) return undefined
  return readFile(file, 'utf8')
}

/** Reads only tracked, ordinary, bounded project files. It never invokes project scripts. */
export async function inspectRepoCapabilities(target: DeliveryTargetBinding): Promise<RepoCapabilityFacts> {
  const before = await inspectDeliveryTarget(target.canonicalPath)
  if (!before.clean || before.baselineCommit !== target.baselineCommit ||
    before.gitRepositoryIdentity !== target.gitRepositoryIdentity || before.canonicalPath !== target.canonicalPath)
    throw new Error('Repository baseline changed before capability inspection.')
  const { stdout } = await run('git', ['ls-files', '-z', '--cached'], {
    cwd: target.canonicalPath, encoding: 'buffer', timeout: 10_000, maxBuffer: 4_000_000,
  })
  const tracked = (stdout as Buffer).toString('utf8').split('\0').filter(Boolean)
  if (tracked.length > MAX_FILES) throw new Error('Repository exceeds bounded inspection scope.')
  const facts: RepoCapabilityFacts = { baselineCommit: target.baselineCommit,
    gitRepositoryIdentity: target.gitRepositoryIdentity, scannedFileCount: 0, sourceFileCount: 0,
    scripts: [], routes: [], routePatterns: [], testFiles: [], sourceEntries: [], artifactPaths: [],
    schemaFiles: [], migrationFiles: [], configurationExamples: [] }
  for (const path of tracked) {
    if ((!allowed.test(path) && path !== contractPath) || !safeTrackedPath(path)) continue
    const source = await readTracked(target.canonicalPath, path)
    if (source === undefined) continue
    facts.scannedFileCount += 1
    facts.artifactPaths.push(path)
    if (path === 'package.json') {
      try {
        const parsed = JSON.parse(source) as { scripts?: Record<string, unknown> }
        facts.scripts = Object.entries(parsed.scripts ?? {}).filter((item): item is [string, string] =>
          typeof item[1] === 'string' && item[1].length <= 300).map(([name, entry]) => ({ name, entry }))
      } catch { /* Invalid package metadata is not evidence. */ }
    }
    if (path === contractPath) {
      try {
        const parsed = JSON.parse(source) as { schemaVersion?: unknown; entries?: unknown }
        if (parsed.schemaVersion === 1 && Array.isArray(parsed.entries) && parsed.entries.length <= 500)
          facts.contract = { relativePath: path, sha256: createHash('sha256').update(source).digest('hex'), entries: parsed.entries }
      } catch { /* An invalid contract never produces a candidate. */ }
    }
    if (/\.(?:[cm]?[jt]sx?)$/iu.test(path)) {
      facts.sourceFileCount += 1
      const routes = [...source.matchAll(/\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]{1,160})['"`]/giu)]
      for (const match of routes) facts.routes.push({ method: match[1]!.toUpperCase(), route: match[2]!, sourceFile: path })
      const nativeRoutes = [...source.matchAll(/\bmethod\s*={2,3}\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*&&\s*p\s*={2,3}\s*['"`]([^'"`]{1,160})['"`]/gu)]
      for (const match of nativeRoutes) facts.routes.push({ method: match[1]!, route: match[2]!, sourceFile: path })
      for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*p\.match\s*\(\s*\/([^\n]{1,240})\/\s*\)/gu)) {
        const name = match[1]!
        const method = new RegExp(`\\bmethod\\s*={2,3}\\s*['\"\x60](GET|POST|PUT|PATCH|DELETE)['\"\x60]\\s*&&\\s*${name}\\b`, 'u').exec(source)?.[1]
        if (method) facts.routePatterns.push({ method, pattern: match[2]!, sourceFile: path })
      }
      const exportedNames = [...source.matchAll(/\bexport\s+(?:(?:async|default)\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gu)]
        .map((match) => match[1]!)
      for (const match of source.matchAll(/\bmodule\.exports\s*=\s*\{([^}]{1,2000})\}/gu))
        exportedNames.push(...match[1]!.split(',').map((item) => item.trim().split(':')[0]!.trim())
          .filter((item) => /^[A-Za-z_$][\w$]*$/u.test(item)))
      const methodNames = [...source.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^\n]{0,200}\)\s*\{/gmu)]
        .map((match) => match[1]!).filter((name) => !['if', 'for', 'while', 'switch', 'catch'].includes(name)).slice(0, 100)
      if (exportedNames.length || methodNames.length) facts.sourceEntries.push({ path,
        exportedNames: [...new Set(exportedNames)].slice(0, 100), methodNames })
      if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./iu.test(path)) {
        const caseNames = [...source.matchAll(/\b(?:test|it|describe)\s*\(\s*['"`]([^'"`]{1,180})['"`]/gu)]
          .map((match) => match[1]!).slice(0, 200)
        const assertionIds = [...new Set([...source.matchAll(/\b(?:assertionId|assertion_id)\s*[:=]\s*['"`]([A-Za-z][A-Za-z0-9_-]{0,79})['"`]/gu)]
          .map((match) => match[1]!))].slice(0, 200)
        const assertionContractHashes = [...new Set([...source.matchAll(/\bassertionContractHash\s*[:=]\s*['"`]([a-f0-9]{64})['"`]/gu)]
          .map((match) => match[1]!))].slice(0, 200)
        facts.testFiles.push({ path, caseNames, assertionIds, assertionContractHashes })
      }
    }
    if (/(?:schema|\.schema\.|schema\.)/iu.test(path)) facts.schemaFiles.push(path)
    if (/(?:migration|migrations)/iu.test(path)) facts.migrationFiles.push(path)
    if (/(?:\.env\.example|config\.example|example\.config)/iu.test(path)) facts.configurationExamples.push(path)
  }
  const after = await inspectDeliveryTarget(target.canonicalPath)
  if (!after.clean || after.baselineCommit !== before.baselineCommit || after.gitRepositoryIdentity !== before.gitRepositoryIdentity)
    throw new Error('Repository changed during capability inspection.')
  return facts
}

/** Exact bounded source supplied to the independent reviewer, outside telemetry and planner matching. */
export async function readRepositoryReviewMaterial(target: DeliveryTargetBinding, facts: RepoCapabilityFacts,
  paths: readonly string[]): Promise<Array<{ path: string; sha256: string; source: string }>> {
  if (facts.baselineCommit !== target.baselineCommit || paths.length > 4) throw new Error('Review material scope is invalid.')
  const before = await inspectDeliveryTarget(target.canonicalPath)
  if (!before.clean || before.baselineCommit !== target.baselineCommit) throw new Error('Review target drifted.')
  const material = []
  let totalBytes = 0
  for (const path of [...new Set(paths)]) {
    if (!facts.artifactPaths.includes(path) || !/\.(?:[cm]?[jt]sx?)$/iu.test(path))
      throw new Error('Review source is outside inspected project code.')
    const source = await readTracked(target.canonicalPath, path)
    if (source === undefined) throw new Error('Review source is unavailable.')
    totalBytes += Buffer.byteLength(source)
    if (totalBytes > 50_000) throw new Error('Review source exceeds bounded context.')
    material.push({ path, sha256: createHash('sha256').update(source).digest('hex'), source })
  }
  const after = await inspectDeliveryTarget(target.canonicalPath)
  if (!after.clean || after.baselineCommit !== before.baselineCommit) throw new Error('Review target drifted.')
  return material
}
