/**
 * E0-H1 Host-owned implementation checkpoint handoff.
 *
 * A delivery VERIFY phase may legitimately create a new implementation commit.
 * That commit moves repository HEAD, and the Controller must neither report it as
 * repository drift nor accept it on trust. The handoff below is the only way a
 * new commit may enter the Controller's authoritative repository state.
 *
 * Authority is deliberately an in-process object identity, never data:
 * - a SHA, a plain object, a copied record, or a re-hydrated persisted JSON can
 *   never be found in the private registry, so it is always rejected;
 * - a handoff is issued only after this Runtime itself created the commit and
 *   re-read every proven fact from the real repository;
 * - a handoff is consumed at most once and is never rebuilt from persistence, so
 *   a crash between "commit happened" and "Controller accepted ownership" stays
 *   fail closed (the observed descendant is drift, never an adopted checkpoint).
 *
 * The persisted audit facts below are history for humans and audits only. They
 * are never read back as authority.
 */

import { GitCheckpointError, checkpointImplementationForVerification, inspectImplementationCommit,
  type GitCheckpointCommandRunner, type ImplementationCommitProof } from './git-checkpoint.js'
import { scopeBlockers } from '../claude-code-executor.js'
import type { RepositoryReality } from './reconciliation.js'
import type { ImplementationCheckpointAuditFact, TaskGitStateV2, TaskStateV2 } from './task-state-v2.js'
import { normalizePath } from './worktree-fingerprint.js'

/** The complete repository observation a handoff is bound to. */
export interface ImplementationCheckpointObservation {
  repositoryIdentity: string
  branch: string
  headSha: string
  changedFiles: readonly string[]
  worktreeFingerprint: string
}

const HANDOFF_BRAND: unique symbol = Symbol('novawing.host-implementation-checkpoint')

/**
 * Opaque, one-time authority. Only {@link commitImplementationCheckpoint} can
 * produce one, and only object identity is trusted — the brand is not proof.
 */
export interface ImplementationCheckpointHandoff {
  readonly [HANDOFF_BRAND]: true
}

/** Proven facts of one Host-created implementation commit (never authority by itself). */
export interface ImplementationCheckpointRecord {
  action: 'VERIFY'
  sessionId: string
  taskId: string
  attemptId?: string
  baselineCommit: string
  before: ImplementationCheckpointObservation
  after: ImplementationCheckpointObservation
  commitSha: string
  parentCommit: string
  treeSha: string
  changedFiles: readonly string[]
  createdAt: string
}

/** Private authority registry: identity-keyed, in-memory, never serialized. */
const issuedHandoffs = new WeakMap<object, ImplementationCheckpointRecord>()

const MAX_AUDIT_FACTS = 8

function observationOf(gitState: TaskGitStateV2): ImplementationCheckpointObservation | undefined {
  const { repositoryIdentity, branch, headSha, worktreeFingerprint } = gitState
  if (repositoryIdentity === undefined || repositoryIdentity.length === 0 ||
    branch === undefined || branch.length === 0 ||
    headSha === undefined || !/^[a-f0-9]{40}$/u.test(headSha) ||
    worktreeFingerprint === undefined || worktreeFingerprint.length === 0) return undefined
  return { repositoryIdentity, branch, headSha, changedFiles: [...gitState.changedFiles], worktreeFingerprint }
}

function sameFileSet(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (values: readonly string[]) => [...new Set(values.map(normalizePath))].sort()
  const a = normalized(left)
  const b = normalized(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameObservation(
  expected: ImplementationCheckpointObservation,
  actual: ImplementationCheckpointObservation | undefined,
): boolean {
  return actual !== undefined && expected.repositoryIdentity === actual.repositoryIdentity &&
    expected.branch === actual.branch && expected.headSha === actual.headSha &&
    expected.worktreeFingerprint === actual.worktreeFingerprint &&
    sameFileSet(expected.changedFiles, actual.changedFiles)
}

function auditFactOf(record: ImplementationCheckpointRecord, acceptedAt: string): ImplementationCheckpointAuditFact {
  return {
    action: record.action, sessionId: record.sessionId, taskId: record.taskId,
    ...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
    repositoryIdentity: record.after.repositoryIdentity, branch: record.after.branch,
    baselineCommit: record.baselineCommit, parentCommit: record.parentCommit, commitSha: record.commitSha,
    treeSha: record.treeSha, changedFiles: [...record.changedFiles], acceptedAt,
  }
}

export interface CommitImplementationCheckpointOptions {
  repoPath: string
  repositoryIdentity: string
  branch: string
  baselineCommit: string
  sessionId: string
  taskId: string
  attemptId?: string
  /** The Controller's authoritative observation of the state being dispatched. */
  before: TaskGitStateV2
  expectedChangedFiles: readonly string[]
  /** Task scope the committed files must remain inside. */
  allowedPaths: readonly string[]
  forbiddenPaths: readonly string[]
  commandRunner?: GitCheckpointCommandRunner
}

export type CommitImplementationCheckpointResult =
  | { disposition: 'COMMITTED'; commitSha: string; handoff: ImplementationCheckpointHandoff }
  | { disposition: 'ALREADY_SATISFIED'; commitSha: string }

/**
 * Create and prove the delivery implementation commit, then issue the one-time
 * handoff the Controller may consume. A no-op task issues no handoff at all:
 * nothing was created, so no ownership transition may be fabricated.
 */
export async function commitImplementationCheckpoint(
  options: CommitImplementationCheckpointOptions,
): Promise<CommitImplementationCheckpointResult> {
  const before = observationOf(options.before)
  if (before === undefined)
    throw new GitCheckpointError('implementation checkpoint requires a complete before-repository observation')
  if (options.sessionId.length === 0 || options.taskId.length === 0)
    throw new GitCheckpointError('implementation checkpoint requires session and task identity')
  if (options.repositoryIdentity.length === 0 || options.branch.length === 0 ||
    before.repositoryIdentity !== options.repositoryIdentity || before.branch !== options.branch)
    throw new GitCheckpointError('implementation checkpoint before-observation does not match the target repository')
  if (!sameFileSet(before.changedFiles, options.expectedChangedFiles))
    throw new GitCheckpointError('implementation checkpoint changed files drifted from the dispatched observation')

  const scopeBlockersFor = (changedFiles: readonly string[]) => scopeBlockers({
    id: options.taskId, goal: '', state: 'EXECUTING', iteration: 0, maxIterations: 1,
    allowedPaths: [...options.allowedPaths], forbiddenPaths: [...options.forbiddenPaths],
  }, changedFiles, options.repositoryIdentity)

  const scopeViolations = scopeBlockersFor(before.changedFiles)
  if (scopeViolations.length > 0)
    throw new GitCheckpointError(`implementation is outside the task scope: ${scopeViolations.join('; ')}`)

  const commitSha = await checkpointImplementationForVerification({
    repoPath: options.repoPath,
    expectedRepositoryIdentity: options.repositoryIdentity,
    expectedBranch: options.branch,
    baselineCommit: options.baselineCommit,
    expectedHeadSha: before.headSha,
    expectedChangedFiles: options.expectedChangedFiles,
    expectedWorktreeFingerprint: before.worktreeFingerprint,
    taskId: options.taskId,
    ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
  })
  if (commitSha === before.headSha)
    return { disposition: 'ALREADY_SATISFIED', commitSha }

  const proof: ImplementationCommitProof = await inspectImplementationCommit({
    repoPath: options.repoPath,
    expectedRepositoryIdentity: options.repositoryIdentity,
    expectedBranch: options.branch,
    parentCommit: before.headSha,
    commitSha,
    expectedChangedFiles: options.expectedChangedFiles,
    ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
  })
  const inScope = scopeBlockersFor(proof.changedFiles).length === 0
  if (!inScope)
    throw new GitCheckpointError('implementation checkpoint commit is outside the task scope')

  const record: ImplementationCheckpointRecord = {
    action: 'VERIFY', sessionId: options.sessionId, taskId: options.taskId,
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
    baselineCommit: options.baselineCommit,
    before,
    after: {
      repositoryIdentity: proof.repositoryIdentity, branch: proof.branch, headSha: proof.commitSha,
      changedFiles: [], worktreeFingerprint: proof.worktreeFingerprint,
    },
    commitSha: proof.commitSha, parentCommit: proof.parentCommit, treeSha: proof.treeSha,
    changedFiles: proof.changedFiles, createdAt: new Date().toISOString(),
  }
  const handoff = Object.freeze({ [HANDOFF_BRAND]: true as const })
  issuedHandoffs.set(handoff, record)
  return { disposition: 'COMMITTED', commitSha: proof.commitSha, handoff }
}

export interface ConsumeImplementationCheckpointInput {
  /** Untrusted dispatch output; only a Host-issued object identity is accepted. */
  handoff: unknown
  sessionId: string
  taskId: string
  attemptId?: string
  action: string
  before: TaskGitStateV2
  after: RepositoryReality
}

export type ImplementationCheckpointConsumption =
  | { accepted: true; record: ImplementationCheckpointRecord }
  | { accepted: false; reason: string }

/**
 * Consume a handoff against the Controller's own binding facts. Consumption is
 * one-time: any attempt (matching or not) invalidates the authority, so an
 * ambiguous or mismatched state can never be retried into acceptance.
 */
export function consumeImplementationCheckpoint(
  input: ConsumeImplementationCheckpointInput,
): ImplementationCheckpointConsumption {
  if (typeof input.handoff !== 'object' || input.handoff === null)
    return { accepted: false, reason: 'implementation checkpoint handoff was not issued by this runtime' }
  const record = issuedHandoffs.get(input.handoff as object)
  if (record === undefined)
    return { accepted: false, reason: 'implementation checkpoint handoff was not issued by this runtime' }
  // Authority is spent here, before any validation: unknown or ambiguous states fail closed.
  issuedHandoffs.delete(input.handoff as object)
  if (input.action !== 'VERIFY' || record.action !== 'VERIFY')
    return { accepted: false, reason: 'implementation checkpoint is only valid for the VERIFY action' }
  if (record.sessionId !== input.sessionId || record.taskId !== input.taskId)
    return { accepted: false, reason: 'implementation checkpoint identity does not match this session/task' }
  if ((record.attemptId ?? null) !== (input.attemptId ?? null))
    return { accepted: false, reason: 'implementation checkpoint attempt does not match this attempt' }
  if (!sameObservation(record.before, observationOf(input.before)))
    return { accepted: false, reason: 'implementation checkpoint before-observation does not match this dispatch' }
  if (!sameObservation(record.after, observationOf(input.after)) ||
    record.parentCommit !== record.before.headSha || record.after.headSha !== record.commitSha)
    return { accepted: false, reason: 'implementation checkpoint after-observation does not match repository reality' }
  return { accepted: true, record }
}

/**
 * Adopt an accepted checkpoint: the new observation becomes the authoritative
 * repository state, every piece of evidence bound to the previous commit is
 * invalidated (so the next VERIFY/REVIEW binds the new commit), and the audit
 * fact is retained — never as authority.
 */
export function applyImplementationCheckpoint(state: TaskStateV2, record: ImplementationCheckpointRecord): TaskStateV2 {
  const acceptedAt = new Date().toISOString()
  return {
    ...state,
    gitState: {
      repositoryIdentity: record.after.repositoryIdentity, branch: record.after.branch,
      headSha: record.after.headSha, changedFiles: [...record.after.changedFiles],
      worktreeFingerprint: record.after.worktreeFingerprint,
    },
    // Evidence produced against the previous HEAD/workspace no longer describes
    // this implementation; a stale review/approval is a verdict on other code.
    verificationState: { results: [] },
    completion: { ...state.completion, evidence: [], review: undefined, approval: undefined },
    implementationCheckpointAudit: [
      ...(state.implementationCheckpointAudit ?? []), auditFactOf(record, acceptedAt),
    ].slice(-MAX_AUDIT_FACTS),
    updatedAt: acceptedAt,
  }
}
