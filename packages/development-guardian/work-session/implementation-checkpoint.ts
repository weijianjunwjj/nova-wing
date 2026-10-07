/**
 * Host-owned implementation checkpoint handoff.
 *
 * Delivery VERIFY legitimately rewrites the repository HEAD: before the exact
 * verifier runs, the runtime commits precisely the implementation files it
 * inspected, so the revision that gets verified is immutable.  That commit is
 * not authority by itself.  A SHA handed back by a model, a copied JSON record,
 * and a commit that merely descends from the previously observed HEAD must never
 * become the Controller's repository truth.
 *
 * Only the runtime component that actually created and verified the commit can
 * mint the capability below.  The capability is a process-local object that is
 * registered in a module-private WeakSet and consumed exactly once, so anything
 * reconstructed from persisted JSON fails the membership test.  Acceptance
 * re-proves identity, branch, exact parent, tree, clean worktree, task scope and
 * repository containment against live git.  Nothing here resets, adopts a
 * descendant, or invents ownership: an unproven commit stays a drift that a
 * human must resolve.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { scopeViolations } from '../workspace-scope.js'
import { normalizePath } from './worktree-fingerprint.js'
import type { TaskStateV2 } from './task-state-v2.js'
import type { GitCheckpointCommandRunner } from './git-checkpoint.js'

const CHECKPOINT_KIND = 'NOVAWING_IMPLEMENTATION_CHECKPOINT_V1'
const PROTECTED_BRANCHES = new Set(['main', 'master'])

export class ImplementationCheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImplementationCheckpointError'
  }
}

/** A complete, comparable repository observation; the Controller's only git truth. */
export interface RepositoryObservation {
  repositoryIdentity: string
  branch: string
  headSha: string
  changedFiles: readonly string[]
  worktreeFingerprint: string
}

/**
 * Persisted audit facts.  Holding a copy of these - including one that round
 * tripped through durable JSON - is explicitly *not* authority.
 */
export interface ImplementationCheckpointAudit {
  sessionId: string
  taskId: string
  attemptId?: string
  /** The dispatch action that owned the commit. */
  action: string
  baselineCommit: string
  /** Repository observation the commit was created against. */
  before: RepositoryObservation
  /** Repository observation the host proved after the commit. */
  after: RepositoryObservation
  implementationCommit: string
  parentCommit: string
  commitTreeSha: string
  capturedAt: string
}

export interface ImplementationCheckpointAuthority {
  readonly kind: typeof CHECKPOINT_KIND
  /** Audit projection only. A structurally identical copy is not authority. */
  readonly facts: ImplementationCheckpointAudit
}

interface MintedCheckpointAuthority extends ImplementationCheckpointAuthority {
  runGit: GitCheckpointCommandRunner
}

/** Process-local issuance register. Membership, not shape, is the authority. */
const issued = new WeakSet<object>()
/** Process-local spent register; an authority is burned at most once. */
const consumedAuthorities = new WeakSet<object>()

export function mintImplementationCheckpoint(
  facts: ImplementationCheckpointAudit,
  runGit: GitCheckpointCommandRunner,
): ImplementationCheckpointAuthority {
  const authority: MintedCheckpointAuthority = Object.freeze({
    kind: CHECKPOINT_KIND,
    facts: Object.freeze({ ...facts, before: Object.freeze(facts.before), after: Object.freeze(facts.after) }),
    runGit,
  })
  issued.add(authority)
  return authority
}

export interface ConsumeImplementationCheckpointOptions {
  sessionId: string
  taskId: string
  attemptId?: string
  action: string
  /** The Controller's own last authoritative observation, taken before the dispatch. */
  before: RepositoryObservation
  /** Live repository inspection performed after the dispatch returned. */
  observed: RepositoryObservation
  allowedPaths: readonly string[]
  forbiddenPaths: readonly string[]
}

/** The only successful outcome of acceptance: the proven new repository truth. */
export interface ConsumedImplementationCheckpoint {
  facts: ImplementationCheckpointAudit
  observation: RepositoryObservation
}

/**
 * Validate one minted checkpoint against the Controller's binding and against
 * live git, then burn it.  Every rejection is fail closed; the authority is only
 * consumed when the whole proof holds.
 */
export async function consumeImplementationCheckpoint(
  authority: ImplementationCheckpointAuthority | undefined,
  options: ConsumeImplementationCheckpointOptions,
): Promise<ConsumedImplementationCheckpoint> {
  if (typeof authority !== 'object' || authority === null || authority.kind !== CHECKPOINT_KIND || !issued.has(authority)) {
    throw new ImplementationCheckpointError('implementation checkpoint authority was not issued by this runtime')
  }
  const minted = authority as MintedCheckpointAuthority
  if (consumedAuthorities.has(minted)) {
    throw new ImplementationCheckpointError('implementation checkpoint authority was already consumed')
  }
  const facts = minted.facts
  if (facts.sessionId !== options.sessionId || facts.taskId !== options.taskId ||
      facts.attemptId !== options.attemptId || facts.action !== options.action) {
    throw new ImplementationCheckpointError('implementation checkpoint does not belong to this session, task, attempt and action')
  }
  if (!sameObservation(facts.before, options.before)) {
    throw new ImplementationCheckpointError('implementation checkpoint was not created against the Controller observation')
  }
  if (!sameObservation(facts.after, options.observed)) {
    throw new ImplementationCheckpointError('repository no longer matches the accepted implementation checkpoint')
  }
  await assertLiveCheckpointCommit(facts, options, minted.runGit)
  consumedAuthorities.add(minted)
  return { facts, observation: options.observed }
}

/**
 * Install the accepted checkpoint as the Controller's authoritative repository
 * state and void every fact that described the superseded revision.  The
 * verification results of the dispatch that owns the checkpoint are re-bound to
 * the new HEAD by `TaskController.applyResult`; nothing recorded before it may
 * survive.
 */
export function adoptImplementationCheckpoint(state: TaskStateV2, facts: ImplementationCheckpointAudit): TaskStateV2 {
  return {
    ...state,
    gitState: {
      repositoryIdentity: facts.after.repositoryIdentity,
      branch: facts.after.branch,
      headSha: facts.after.headSha,
      changedFiles: [...facts.after.changedFiles],
      worktreeFingerprint: facts.after.worktreeFingerprint,
    },
    // Evidence recorded under the previous HEAD is void; reconciliation refuses
    // to let it outlive this revision.
    verificationState: {
      results: [],
      evidenceHeadSha: facts.after.headSha,
      evidenceWorktreeFingerprint: facts.after.worktreeFingerprint,
    },
    completion: { ...state.completion, evidence: [], review: undefined, approval: undefined },
    implementationCheckpoints: [...(state.implementationCheckpoints ?? []), facts],
    updatedAt: new Date().toISOString(),
  }
}

function sameObservation(left: RepositoryObservation, right: RepositoryObservation): boolean {
  return left.repositoryIdentity === right.repositoryIdentity && left.branch === right.branch &&
    left.headSha === right.headSha && left.worktreeFingerprint === right.worktreeFingerprint &&
    samePathSet(left.changedFiles, right.changedFiles)
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left.map(normalizePath))].sort()
  const b = [...new Set(right.map(normalizePath))].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function nameOnly(stdout: string): string[] {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
}

async function git(runGit: GitCheckpointCommandRunner, args: readonly string[]): Promise<string> {
  const result = await runGit(args)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`
    throw new ImplementationCheckpointError(`git ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trimEnd()
}

/**
 * Re-prove the commit itself.  Ancestry is not enough: the commit must be the
 * exact child of the observed HEAD, carry the recorded tree, contain exactly the
 * inspected files inside the task scope, and leave a clean worktree behind.
 */
async function assertLiveCheckpointCommit(
  facts: ImplementationCheckpointAudit,
  options: ConsumeImplementationCheckpointOptions,
  runGit: GitCheckpointCommandRunner,
): Promise<void> {
  const { implementationCommit, parentCommit, commitTreeSha } = facts
  if (!/^[a-f0-9]{40}$/u.test(implementationCommit) || !/^[a-f0-9]{40}$/u.test(parentCommit) ||
      !/^[a-f0-9]{40}$/u.test(commitTreeSha)) {
    throw new ImplementationCheckpointError('implementation checkpoint commit identity is invalid')
  }
  const repositoryRoot = await realpath(facts.after.repositoryIdentity)
  if (repositoryRoot !== facts.after.repositoryIdentity ||
      await git(runGit, ['rev-parse', '--show-toplevel']) !== repositoryRoot) {
    throw new ImplementationCheckpointError('implementation checkpoint repository identity changed')
  }
  if (PROTECTED_BRANCHES.has(facts.after.branch)) {
    throw new ImplementationCheckpointError(`implementation checkpoint branch is protected: ${facts.after.branch}`)
  }
  if (await git(runGit, ['branch', '--show-current']) !== facts.after.branch) {
    throw new ImplementationCheckpointError('implementation checkpoint branch drifted')
  }
  if (await git(runGit, ['rev-parse', 'HEAD']) !== implementationCommit) {
    throw new ImplementationCheckpointError('implementation checkpoint is not the current HEAD')
  }
  const lineage = (await git(runGit, ['rev-list', '--parents', '-n', '1', implementationCommit])).split(/\s+/u)
  if (lineage.length !== 2 || lineage[0] !== implementationCommit || lineage[1] !== facts.before.headSha) {
    throw new ImplementationCheckpointError('implementation checkpoint parent is not the observed HEAD')
  }
  if (await git(runGit, ['rev-parse', `${implementationCommit}^{tree}`]) !== commitTreeSha) {
    throw new ImplementationCheckpointError('implementation checkpoint tree does not match the committed content')
  }
  if (await git(runGit, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new ImplementationCheckpointError('implementation checkpoint did not leave a clean worktree')
  }
  await git(runGit, ['merge-base', '--is-ancestor', facts.baselineCommit, implementationCommit])
  const committedFiles = nameOnly(await git(runGit, ['diff', '--name-only', parentCommit, implementationCommit]))
  if (!samePathSet(committedFiles, facts.before.changedFiles)) {
    throw new ImplementationCheckpointError('implementation checkpoint content differs from the inspected implementation')
  }
  const violations = scopeViolations({ changedFiles: facts.before.changedFiles,
    allowedPaths: options.allowedPaths, forbiddenPaths: options.forbiddenPaths })
  if (violations.length > 0) {
    throw new ImplementationCheckpointError(`implementation checkpoint is outside the task scope: ${violations[0]}`)
  }
  for (const path of facts.before.changedFiles) await assertContainedPath(repositoryRoot, path)
}

/**
 * A committed path must stay repository-relative and resolve inside the
 * repository, so a symlink cannot smuggle an outside target into the checkpoint.
 */
async function assertContainedPath(repositoryRoot: string, path: string): Promise<void> {
  const normalized = normalizePath(path)
  if (normalized.length === 0 || normalized === '.' || isAbsolute(normalized) ||
      normalized.includes('\0') || normalized.split('/').includes('..')) {
    throw new ImplementationCheckpointError(`implementation checkpoint path is not repository-relative: ${path}`)
  }
  let resolved: string
  try {
    resolved = await realpath(resolve(repositoryRoot, normalized))
  } catch (error) {
    // A committed deletion has no live path; anything else is a real failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ImplementationCheckpointError(`implementation checkpoint path cannot be inspected: ${path}`)
  }
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`)) {
    throw new ImplementationCheckpointError(`implementation checkpoint path escapes the repository: ${path}`)
  }
}
