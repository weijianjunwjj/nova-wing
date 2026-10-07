import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gitExecutable } from '../platform/windows-git.js'
import { scopeBlockers } from '../claude-code-executor.js'
import { checkpointImplementationForVerification, GitCheckpointError, validateImplementationPaths } from './git-checkpoint.js'
import { computeWorktreeFingerprint, parseGitStatus } from './worktree-fingerprint.js'
import type { RepositoryReality } from './reconciliation.js'
import type { TaskStateV2 } from './task-state-v2.js'

export interface ImplementationCheckpointAudit {
  sessionId: string
  taskId: string
  attemptId?: string
  dispatchId: string
  action: 'VERIFY'
  before: RepositoryReality
  after: RepositoryReality
  gitDirectory: string
  parent: string
  tree: string
  changedFiles: readonly string[]
}

export interface ImplementationCheckpointDispatch { dispatchId: string; action: 'VERIFY' }

// Neither JSON nor an object with identical properties can recreate this authority.
// No injected Git runner participates in issuance or consumption.
const issued = new WeakMap<object, { audit: ImplementationCheckpointAudit; permissions: TaskStateV2['permissions'] }>()
const exec = promisify(execFile)
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec(gitExecutable(), args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout
}
const value = async (repo: string, ...args: string[]) => (await git(repo, ...args)).trimEnd()

export async function inspectImplementationRepository(repo: string): Promise<RepositoryReality> {
  const repositoryIdentity = await realpath(repo)
  if (await realpath(await value(repo, 'rev-parse', '--show-toplevel')) !== repositoryIdentity)
    throw new GitCheckpointError('implementation repository root mismatch')
  const entries = parseGitStatus(await git(repo, 'status', '--porcelain', '-z', '--untracked-files=all'))
  return { repositoryIdentity, branch: await value(repo, 'branch', '--show-current'),
    headSha: await value(repo, 'rev-parse', 'HEAD'), changedFiles: entries.map((entry) => entry.path),
    worktreeFingerprint: createHash('sha256').update(await computeWorktreeFingerprint(repo, entries, { strict: true }))
      .update(await git(repo, 'diff', '--cached', '--binary')).digest('hex') }
}

function sameObservation(task: TaskStateV2, observation: RepositoryReality): boolean {
  const state = task.gitState
  return state.repositoryIdentity === observation.repositoryIdentity && state.branch === observation.branch &&
    state.headSha === observation.headSha && state.worktreeFingerprint === observation.worktreeFingerprint &&
    JSON.stringify([...state.changedFiles].sort()) === JSON.stringify([...observation.changedFiles].sort())
}

function checkScope(task: TaskStateV2, paths: readonly string[], repo: string): void {
  const blockers = scopeBlockers({ id: task.identity.taskId, state: 'EXECUTING', iteration: 0, maxIterations: 1,
    goal: task.goal, constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria, doNotDo: [], ...task.permissions }, paths, repo)
  if (blockers.length) throw new GitCheckpointError(blockers.join('; '))
}

async function verifyAudit(audit: ImplementationCheckpointAudit, task: TaskStateV2): Promise<void> {
  const repo = audit.before.repositoryIdentity
  const current = await inspectImplementationRepository(repo)
  if (JSON.stringify(current) !== JSON.stringify(audit.after) || current.changedFiles.length ||
    current.repositoryIdentity !== audit.before.repositoryIdentity || current.branch !== audit.before.branch ||
    await value(repo, 'rev-parse', '--absolute-git-dir') !== audit.gitDirectory ||
    await value(repo, 'show', '-s', '--format=%P', current.headSha) !== audit.parent ||
    await value(repo, 'rev-parse', `${current.headSha}^{tree}`) !== audit.tree)
    throw new GitCheckpointError('owned implementation checkpoint repository, parent, branch or tree mismatch')
  const paths = (await git(repo, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z',
    audit.parent, current.headSha)).split('\0').filter(Boolean)
  if (JSON.stringify([...paths].sort()) !== JSON.stringify([...audit.changedFiles].sort()))
    throw new GitCheckpointError('owned implementation checkpoint changed-file mismatch')
  checkScope(task, paths, repo)
  await validateImplementationPaths(repo, paths)
  // Inspect the committed modes too: a hook must not insert a symlink or submodule.
  for (const entry of (await git(repo, '--literal-pathspecs', 'ls-tree', '-r', '-z', current.headSha, '--', ...paths)).split('\0')) {
    if (entry && !/^(100644|100755) blob /u.test(entry))
      throw new GitCheckpointError('owned implementation checkpoint contains a non-regular file')
  }
}

/** Mint only after a real Host commit and all post-commit proofs succeed. */
export async function createOwnedImplementationCheckpoint(task: TaskStateV2,
  dispatch: ImplementationCheckpointDispatch, baselineCommit: string): Promise<object | undefined> {
  task = structuredClone(task)
  dispatch = { ...dispatch }
  if (dispatch.action !== 'VERIFY' || !dispatch.dispatchId || !task.identity.sessionId || !task.identity.taskId)
    throw new GitCheckpointError('invalid implementation checkpoint dispatch')
  const repo = task.gitState.repositoryIdentity ?? ''
  const before = await inspectImplementationRepository(repo)
  if (!sameObservation(task, before)) throw new GitCheckpointError('implementation checkpoint before observation mismatch')
  const permissions = structuredClone(task.permissions)
  checkScope(task, before.changedFiles, repo)
  await validateImplementationPaths(repo, before.changedFiles)
  const gitDirectory = await value(repo, 'rev-parse', '--absolute-git-dir')
  const commit = await checkpointImplementationForVerification({ repoPath: repo,
    expectedRepositoryIdentity: before.repositoryIdentity, expectedBranch: before.branch,
    baselineCommit, expectedHeadSha: before.headSha, expectedChangedFiles: before.changedFiles,
    expectedWorktreeFingerprint: before.worktreeFingerprint, taskId: task.identity.taskId })
  if (commit === before.headSha) return undefined // no ownership transition for an already clean HEAD
  const after = await inspectImplementationRepository(repo)
  if (after.headSha !== commit) throw new GitCheckpointError('implementation checkpoint HEAD changed after commit')
  const audit: ImplementationCheckpointAudit = { ...task.identity, dispatchId: dispatch.dispatchId, action: 'VERIFY',
    ...(task.attemptId === undefined ? {} : { attemptId: task.attemptId }), before, after, gitDirectory,
    parent: before.headSha, tree: await value(repo, 'rev-parse', `${commit}^{tree}`), changedFiles: before.changedFiles }
  await verifyAudit(audit, task)
  const authority = Object.freeze({})
  issued.set(authority, { audit: structuredClone(audit), permissions })
  return authority
}

/** Spend before any await, including rejected attempts. Persisted audit facts are never authority. */
export async function consumeOwnedImplementationCheckpoint(authority: unknown, task: TaskStateV2,
  dispatch: ImplementationCheckpointDispatch): Promise<TaskStateV2> {
  const proof = typeof authority === 'object' && authority !== null ? issued.get(authority) : undefined
  if (!proof) throw new GitCheckpointError('implementation checkpoint authority is absent or consumed')
  issued.delete(authority as object)
  task = structuredClone(task)
  dispatch = { ...dispatch }
  const { audit } = proof
  if (audit.sessionId !== task.identity.sessionId || audit.taskId !== task.identity.taskId ||
    audit.attemptId !== task.attemptId || audit.dispatchId !== dispatch.dispatchId || audit.action !== dispatch.action ||
    !sameObservation(task, audit.before) || JSON.stringify(proof.permissions) !== JSON.stringify(task.permissions))
    throw new GitCheckpointError('implementation checkpoint binding mismatch')
  await verifyAudit(audit, task)
  return { ...task, gitState: structuredClone(audit.after), verificationState: { results: [] },
    completion: { bindings: task.completion.bindings, evidence: [] },
    implementationCheckpoints: [...(task.implementationCheckpoints ?? []), structuredClone(audit)],
    updatedAt: new Date().toISOString() }
}

/** A dispatch-local Host callback: commit, accept, and persist before any verifier runs. */
export function implementationCheckpointHandoff(options: {
  getState(): TaskStateV2; setState(task: TaskStateV2): void; persist?(task: TaskStateV2): Promise<void>
}): { checkpoint(baselineCommit: string): Promise<TaskStateV2>; close(): void } {
  const dispatch: ImplementationCheckpointDispatch = { dispatchId: randomUUID(), action: 'VERIFY' }
  let active = true
  let called = false
  return {
    close() { active = false },
    async checkpoint(baselineCommit) {
      if (!active || called) throw new GitCheckpointError('implementation checkpoint dispatch is closed or consumed')
      called = true
      const before = structuredClone(options.getState())
      const authority = await createOwnedImplementationCheckpoint(before, dispatch, baselineCommit)
      if (!active) throw new GitCheckpointError('implementation checkpoint dispatch expired')
      if (!authority) return structuredClone(before)
      const accepted = await consumeOwnedImplementationCheckpoint(authority, options.getState(), dispatch)
      await options.persist?.(accepted)
      options.setState(accepted)
      return structuredClone(accepted)
    },
  }
}
