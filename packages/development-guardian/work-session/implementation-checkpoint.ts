/**
 * Host-owned implementation checkpoint handoff.
 *
 * The VERIFY action of a Delivery Task may legitimately create one real Git
 * implementation commit, which moves repository HEAD.  The Controller still
 * holds the repository observation it dispatched against, so that new commit
 * must be handed back to the Controller as a *host-owned* fact:
 *
 * - only this module, after running every Git gate itself, can issue the
 *   one-time authority;
 * - the authority is a process-local object identity.  A model-returned SHA, a
 *   copied/persisted JSON record, a `structuredClone` or a mere descendant
 *   commit can never obtain it;
 * - the Controller consumes it at most once and only when its own independent
 *   after-observation is exactly the verified, clean commit;
 * - a commit that happened while ownership was not confirmed (crash, ambiguity)
 *   is never auto-adopted, reset, or re-labelled.
 */

import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { scopeBlockers } from '../claude-code-executor.js'
import {
  checkpointImplementationForVerification,
  createDefaultCommandRunner,
  type GitCheckpointCommandRunner,
} from './git-checkpoint.js'
import { computeWorktreeFingerprint, normalizePath, parseGitStatus } from './worktree-fingerprint.js'
import type { RepositoryReality } from './reconciliation.js'

export type ImplementationCheckpointAction = 'EXECUTE' | 'VERIFY'

/** Stable machine-readable refusals; every one of them is fail-closed. */
export type ImplementationCheckpointReason =
  | 'CHECKPOINT_IDENTITY_CHANGED'
  | 'CHECKPOINT_BRANCH_CHANGED'
  | 'CHECKPOINT_HEAD_CHANGED'
  | 'CHECKPOINT_PARENT_MISMATCH'
  | 'CHECKPOINT_WORKTREE_DIRTY'
  | 'CHECKPOINT_CONTENT_MISMATCH'
  | 'CHECKPOINT_EMPTY_CHANGE_SET'
  | 'CHECKPOINT_PATH_UNSAFE'
  | 'CHECKPOINT_SYMLINK_REJECTED'
  | 'CHECKPOINT_HARDLINK_REJECTED'
  | 'CHECKPOINT_ENTRY_NOT_REGULAR'
  | 'CHECKPOINT_SCOPE_VIOLATION'
  | 'CHECKPOINT_GIT_UNAVAILABLE'

export class ImplementationCheckpointError extends Error {
  constructor(message: string, readonly checkpointReason: ImplementationCheckpointReason) {
    super(message)
    this.name = 'ImplementationCheckpointError'
  }
}

/** The verified facts bound to one implementation commit.  Audit data, never authority. */
export interface ImplementationCheckpointFacts {
  sessionId: string
  taskId: string
  attemptId?: string
  action: ImplementationCheckpointAction
  commitSha: string
  parentSha: string
  treeHash: string
  changedFiles: readonly string[]
  before: RepositoryReality
  after: RepositoryReality
}

/**
 * Opaque process-local capability.  The declared shape is intentionally inert:
 * authority lives only in `issuedAuthorities`, keyed by object identity, so a
 * parsed, cloned, persisted, or fabricated value can never be an authority.
 */
export interface ImplementationCheckpointAuthority {
  readonly kind: 'NOVAWING_HOST_IMPLEMENTATION_CHECKPOINT'
}

const issuedAuthorities = new Map<ImplementationCheckpointAuthority, ImplementationCheckpointFacts>()
/** An unconsumed authority is only ever a lost opportunity, never a leak. */
const MAX_ISSUED_AUTHORITIES = 64

function issueImplementationCheckpoint(facts: ImplementationCheckpointFacts): ImplementationCheckpointAuthority {
  const authority: ImplementationCheckpointAuthority = Object.freeze({ kind: 'NOVAWING_HOST_IMPLEMENTATION_CHECKPOINT' as const })
  issuedAuthorities.set(authority, facts)
  while (issuedAuthorities.size > MAX_ISSUED_AUTHORITIES) {
    const oldest = issuedAuthorities.keys().next().value
    if (oldest === undefined) break
    issuedAuthorities.delete(oldest)
  }
  return authority
}

async function runGitString(
  runGit: GitCheckpointCommandRunner,
  args: readonly string[],
): Promise<string> {
  const result = await runGit(args)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`
    throw new ImplementationCheckpointError(`git ${args[0] ?? ''} failed: ${detail}`, 'CHECKPOINT_GIT_UNAVAILABLE')
  }
  return result.stdout.trimEnd()
}

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split('\0').map((value) => value.trim()).filter((value) => value.length > 0)
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const setLeft = [...new Set(left.map(normalizePath))].sort()
  const setRight = [...new Set(right.map(normalizePath))].sort()
  return setLeft.length === setRight.length && setLeft.every((value, index) => value === setRight[index])
}

function sameObservation(left: RepositoryReality, right: RepositoryReality): boolean {
  return left.repositoryIdentity === right.repositoryIdentity && left.branch === right.branch &&
    left.headSha === right.headSha && left.worktreeFingerprint === right.worktreeFingerprint &&
    samePathSet(left.changedFiles, right.changedFiles)
}

/** Reject absolute paths, `..`, empty segments and anything outside the repository. */
function assertSafeRepositoryPath(repoPath: string, path: string): string {
  const normalized = normalizePath(path)
  const segments = normalized.split('/')
  if (normalized.length === 0 || isAbsolute(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ImplementationCheckpointError(`checkpoint path is not repository-relative: ${path}`, 'CHECKPOINT_PATH_UNSAFE')
  }
  const root = resolve(repoPath)
  const absolute = resolve(root, normalized)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new ImplementationCheckpointError(`checkpoint path escapes the repository: ${path}`, 'CHECKPOINT_PATH_UNSAFE')
  }
  return normalized
}

/**
 * Every changed path must be a plain, in-scope, single-link repository file
 * (or a deletion).  Symlinks, hardlinks and out-of-scope paths are refused
 * before any commit is created.
 */
async function assertCheckpointPaths(options: {
  repoPath: string
  taskId: string
  allowedPaths: readonly string[]
  forbiddenPaths: readonly string[]
  expectedRepositoryIdentity: string
  changedFiles: readonly string[]
}): Promise<string[]> {
  const changed = [...new Set(options.changedFiles.map(normalizePath))].sort()
  if (changed.length === 0) {
    throw new ImplementationCheckpointError('implementation checkpoint has no changed files', 'CHECKPOINT_EMPTY_CHANGE_SET')
  }
  for (const path of changed) assertSafeRepositoryPath(options.repoPath, path)
  const scope = scopeBlockers({
    id: options.taskId, goal: '', state: 'EXECUTING', iteration: 0, maxIterations: 1,
    allowedPaths: [...options.allowedPaths], forbiddenPaths: [...options.forbiddenPaths],
  }, changed, options.expectedRepositoryIdentity)
  if (scope.length > 0) {
    throw new ImplementationCheckpointError(
      `implementation checkpoint changed files violate task scope: ${scope[0]}`, 'CHECKPOINT_SCOPE_VIOLATION')
  }
  for (const path of changed) {
    let info
    try { info = await lstat(resolve(options.repoPath, path)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // a deletion is a legitimate change
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new ImplementationCheckpointError(`checkpoint refuses a symbolic link: ${path}`, 'CHECKPOINT_SYMLINK_REJECTED')
    }
    if (!info.isFile()) {
      throw new ImplementationCheckpointError(`checkpoint refuses a non-regular file: ${path}`, 'CHECKPOINT_ENTRY_NOT_REGULAR')
    }
    if (info.nlink > 1) {
      throw new ImplementationCheckpointError(`checkpoint refuses a hard-linked file: ${path}`, 'CHECKPOINT_HARDLINK_REJECTED')
    }
  }
  return changed
}

interface TreeEntry { mode: string; type: string; sha: string }

async function readTreeEntries(
  runGit: GitCheckpointCommandRunner,
  commitSha: string,
): Promise<Map<string, TreeEntry>> {
  const stdout = await runGitString(runGit, ['ls-tree', '-r', '-z', commitSha])
  const entries = new Map<string, TreeEntry>()
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha] = record.slice(0, tab).split(' ')
    if (mode === undefined || type === undefined || sha === undefined) continue
    entries.set(record.slice(tab + 1), { mode, type, sha })
  }
  return entries
}

export interface CreateImplementationCheckpointOptions {
  repoPath: string
  sessionId: string
  taskId: string
  attemptId?: string
  action: ImplementationCheckpointAction
  allowedPaths: readonly string[]
  forbiddenPaths: readonly string[]
  expectedRepositoryIdentity: string
  expectedBranch: string
  baselineCommit: string
  /** The trusted repository observation the action was dispatched against. */
  before: RepositoryReality
  commandRunner?: GitCheckpointCommandRunner
}

export interface VerifyImplementationCheckpointOptions extends CreateImplementationCheckpointOptions {
  commitSha: string
}

function optionalRunner(commandRunner: GitCheckpointCommandRunner | undefined): { commandRunner?: GitCheckpointCommandRunner } {
  return commandRunner === undefined ? {} : { commandRunner }
}

/**
 * Read-only verification of one already-existing implementation commit.  Only
 * this path can mint the authority, and only after Git itself proves every
 * invariant: unchanged repository identity and branch, exact parent, clean
 * worktree, exact changed-file set, regular in-scope blobs whose content is
 * still identical to the worktree.
 */
export async function verifyImplementationCheckpointCommit(
  options: VerifyImplementationCheckpointOptions,
): Promise<ImplementationCheckpointAuthority> {
  const runGit = options.commandRunner ?? createDefaultCommandRunner(options.repoPath)
  const before = options.before
  if (!/^[a-f0-9]{40}$/u.test(before.headSha) || !/^[a-f0-9]{64}$/u.test(before.worktreeFingerprint) ||
    !/^[a-f0-9]{40}$/u.test(options.commitSha) || options.commitSha === before.headSha) {
    throw new ImplementationCheckpointError('implementation checkpoint identity is invalid', 'CHECKPOINT_HEAD_CHANGED')
  }
  const changedFiles = await assertCheckpointPaths({ ...options, changedFiles: before.changedFiles })
  if (await realpath(options.repoPath) !== options.expectedRepositoryIdentity) {
    throw new ImplementationCheckpointError('implementation checkpoint repository identity changed', 'CHECKPOINT_IDENTITY_CHANGED')
  }
  if (await runGitString(runGit, ['branch', '--show-current']) !== options.expectedBranch) {
    throw new ImplementationCheckpointError('implementation checkpoint branch changed', 'CHECKPOINT_BRANCH_CHANGED')
  }
  if (await runGitString(runGit, ['rev-parse', 'HEAD']) !== options.commitSha) {
    throw new ImplementationCheckpointError('implementation checkpoint HEAD changed', 'CHECKPOINT_HEAD_CHANGED')
  }
  const parentSha = await runGitString(runGit, ['rev-parse', `${options.commitSha}^`])
  if (parentSha !== before.headSha) {
    throw new ImplementationCheckpointError('implementation checkpoint parent is not the observed HEAD', 'CHECKPOINT_PARENT_MISMATCH')
  }
  if (await runGitString(runGit, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new ImplementationCheckpointError('implementation checkpoint left a dirty worktree', 'CHECKPOINT_WORKTREE_DIRTY')
  }
  const diffPaths = nulSeparatedPaths(await runGitString(runGit,
    ['diff', '--name-only', '-z', before.headSha, options.commitSha]))
  if (!samePathSet(diffPaths, changedFiles)) {
    throw new ImplementationCheckpointError('implementation commit tree does not match the inspected implementation files', 'CHECKPOINT_CONTENT_MISMATCH')
  }
  const treeHash = await runGitString(runGit, ['rev-parse', `${options.commitSha}^{tree}`])
  if (!/^[a-f0-9]{40}$/u.test(treeHash)) {
    throw new ImplementationCheckpointError('implementation checkpoint tree is unreadable', 'CHECKPOINT_CONTENT_MISMATCH')
  }
  const entries = await readTreeEntries(runGit, options.commitSha)
  for (const path of changedFiles) {
    const entry = entries.get(path)
    if (entry === undefined) continue // deleted in this commit
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      throw new ImplementationCheckpointError(`implementation commit contains a non-regular entry: ${path}`, 'CHECKPOINT_ENTRY_NOT_REGULAR')
    }
    const worktreeBlob = await runGitString(runGit, ['hash-object', '--', path])
    if (worktreeBlob !== entry.sha) {
      throw new ImplementationCheckpointError(`implementation commit content drifted for: ${path}`, 'CHECKPOINT_CONTENT_MISMATCH')
    }
  }
  const status = await runGitString(runGit, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const indexDiff = await runGitString(runGit, ['diff', '--cached', '--binary'])
  const after: RepositoryReality = {
    repositoryIdentity: options.expectedRepositoryIdentity,
    branch: options.expectedBranch,
    headSha: options.commitSha,
    changedFiles: [],
    worktreeFingerprint: createHash('sha256')
      .update(await computeWorktreeFingerprint(options.repoPath, parseGitStatus(status), { strict: true }))
      .update(indexDiff).digest('hex'),
  }
  return issueImplementationCheckpoint({
    sessionId: options.sessionId, taskId: options.taskId,
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
    action: options.action, commitSha: options.commitSha, parentSha, treeHash, changedFiles, before, after,
  })
}

/**
 * Create (when the inspected worktree is dirty) and host-verify the single
 * implementation commit for this dispatch.  Returns `undefined` when the task
 * is already satisfied: a no-op must never fabricate an ownership transition.
 */
export async function createImplementationCheckpointAuthority(
  options: CreateImplementationCheckpointOptions,
): Promise<ImplementationCheckpointAuthority | undefined> {
  if (options.before.changedFiles.length > 0) await assertCheckpointPaths({ ...options, changedFiles: options.before.changedFiles })
  const commitSha = await checkpointImplementationForVerification({
    repoPath: options.repoPath,
    expectedRepositoryIdentity: options.expectedRepositoryIdentity,
    expectedBranch: options.expectedBranch,
    baselineCommit: options.baselineCommit,
    expectedHeadSha: options.before.headSha,
    expectedChangedFiles: options.before.changedFiles,
    expectedWorktreeFingerprint: options.before.worktreeFingerprint,
    taskId: options.taskId,
    ...optionalRunner(options.commandRunner),
  })
  if (commitSha === options.before.headSha) return undefined
  return verifyImplementationCheckpointCommit({ ...options, commitSha })
}

export type ImplementationCheckpointConsumption =
  | { ok: true; facts: ImplementationCheckpointFacts }
  | { ok: false; reason: string }

/**
 * One-time consumption by the Controller.  Any lookup burns the authority,
 * even a mismatched one, so a stale or replayed handoff can never be retried.
 */
export function consumeImplementationCheckpoint(authority: unknown, expected: {
  sessionId: string
  taskId: string
  attemptId?: string
  action: string
  before: RepositoryReality
  observed: RepositoryReality
}): ImplementationCheckpointConsumption {
  if (typeof authority !== 'object' || authority === null) {
    return { ok: false, reason: 'dispatch returned no host-owned implementation checkpoint' }
  }
  const facts = issuedAuthorities.get(authority as ImplementationCheckpointAuthority)
  if (facts === undefined) {
    return { ok: false, reason: 'implementation checkpoint authority was not issued by this host process' }
  }
  issuedAuthorities.delete(authority as ImplementationCheckpointAuthority)
  if (facts.sessionId !== expected.sessionId || facts.taskId !== expected.taskId ||
    facts.attemptId !== expected.attemptId || facts.action !== expected.action) {
    return { ok: false, reason: 'implementation checkpoint belongs to a different session, task, attempt, or action' }
  }
  if (facts.parentSha !== facts.before.headSha || facts.commitSha === facts.before.headSha) {
    return { ok: false, reason: 'implementation checkpoint does not establish a new commit' }
  }
  if (!sameObservation(facts.before, expected.before)) {
    return { ok: false, reason: 'implementation checkpoint does not match the dispatched repository observation' }
  }
  if (!sameObservation(facts.after, expected.observed)) {
    return { ok: false, reason: 'repository changed after the verified implementation checkpoint' }
  }
  if (expected.observed.headSha !== facts.commitSha || expected.observed.changedFiles.length !== 0) {
    return { ok: false, reason: 'observed repository is not the verified clean implementation checkpoint' }
  }
  return { ok: true, facts }
}
