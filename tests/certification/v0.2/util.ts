/**
 * NovaWing v0.2 automated certification — filesystem/git utilities.
 *
 * The certification runs against real throwaway git repositories under
 * `.tmp/certification/<runId>/<scenario>/`. No developer workspace is touched.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { computeWorktreeFingerprint, parseGitStatus } from '../../../packages/development-guardian/work-session/worktree-fingerprint.js'
import type { RepositoryReality } from '../../../packages/development-guardian/work-session/reconciliation.js'

export const CERTIFICATION_ROOT = resolve(process.cwd(), '.tmp', 'certification')
export const REPO_ROOT = process.cwd()

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolveGit) => {
    execFile('git', [...args], {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveGit({ exitCode: 0, stdout, stderr })
        return
      }
      const code = typeof (error as { code?: unknown }).code === 'number'
        ? ((error as { code?: number }).code as number)
        : 1
      resolveGit({ exitCode: code, stdout, stderr })
    })
  })
}

export async function gitMust(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  const result = await runGit(cwd, args, env)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`)
  }
  return result
}

const GIT_IDENTITY = { 'user.name': 'Certification', 'user.email': 'certification@example.invalid' }

/** Create a fresh git repository with an initial commit on `branch`. */
export async function initFixtureRepo(
  dir: string,
  files: Readonly<Record<string, string>>,
  branch = 'main',
): Promise<string> {
  await mkdir(dir, { recursive: true })
  await gitMust(dir, ['init', '-q', '-b', branch])
  await writeFiles(dir, files)
  await commitAll(dir, 'fixture baseline')
  return realpath(dir)
}

export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

export async function repoWrite(dir: string, relative: string, content: string): Promise<void> {
  const target = join(dir, relative)
  await mkdir(resolve(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

export async function repoRead(dir: string, relative: string): Promise<string> {
  return readFile(join(dir, relative), 'utf8')
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await gitMust(dir, ['add', '-A'])
  await gitMust(dir, ['-c', `user.name=${GIT_IDENTITY['user.name']}`, '-c', `user.email=${GIT_IDENTITY['user.email']}`, 'commit', '-qm', message])
}

/** Discard fixture-local working-tree changes so a later run starts clean. */
export async function resetFixtureRepoToHead(dir: string): Promise<void> {
  await gitMust(dir, ['reset', '--hard', 'HEAD'])
  await gitMust(dir, ['clean', '-fd'])
}

export async function fixtureCommit(dir: string, files: Readonly<Record<string, string>>, message: string): Promise<void> {
  await writeFiles(dir, files)
  await commitAll(dir, message)
}

/** Mirror of the production default V2 repository inspector. */
export async function inspectRepo(repoPath: string): Promise<RepositoryReality> {
  const repo = await realpath(repoPath)
  const [branch, head, status, indexDiff] = await Promise.all([
    gitMust(repo, ['branch', '--show-current']),
    gitMust(repo, ['rev-parse', 'HEAD']),
    gitMust(repo, ['status', '--porcelain', '-z', '--untracked-files=all']),
    gitMust(repo, ['diff', '--cached', '--binary']),
  ])
  const entries = parseGitStatus(status.stdout)
  const content = await computeWorktreeFingerprint(repo, entries, { strict: true })
  return {
    repositoryIdentity: repo,
    branch: branch.stdout.trim(),
    headSha: head.stdout.trim(),
    changedFiles: entries.map((entry) => entry.path),
    worktreeFingerprint: createHash('sha256').update(content).update(indexDiff.stdout).digest('hex'),
  }
}

/** Keep the current branch/head stable but return the authoritative reality. */
export async function headSha(repoPath: string): Promise<string> {
  return (await gitMust(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()
}

export async function currentBranch(repoPath: string): Promise<string> {
  return (await gitMust(repoPath, ['branch', '--show-current'])).stdout.trim()
}

export function certRoot(runId: string): string {
  return join(CERTIFICATION_ROOT, runId)
}

export async function createScenarioDir(runId: string, scenario: string): Promise<{ repo: string; data: string; work: string }> {
  const base = certRoot(runId)
  const repo = join(base, scenario, 'repo')
  const data = join(base, scenario, 'data')
  await mkdir(repo, { recursive: true })
  await mkdir(data, { recursive: true })
  return { repo, data, work: join(base, scenario) }
}

export function storageUrl(dataDir: string): string {
  return pathToFileURL(join(dataDir, 'session.db')).href
}

export function projectUrl(path: string): string {
  return fileURLToPath(path)
}

/** Windows recursive removal with bounded retries for transient file locks. */
export async function removeTree(target: string): Promise<void> {
  if (!existsSync(target)) return
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      const last = attempt === 3
      if (last) throw error
      await new Promise((done) => setTimeout(done, 120))
    }
  }
}

export async function makeTempUnder(root: string, prefix: string): Promise<string> {
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, prefix))
}

export async function fileExists(path: string): Promise<boolean> {
  return existsSync(path)
}
