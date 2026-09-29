import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { gitExecutable } from '../platform/windows-git.js'
import { workspacePathKey } from '../platform/paths.js'
import { scopeBlockers } from '../claude-code-executor.js'
import { relativeTaskWorkspaceScope } from '../workspace-scope.js'
import type { GuardianTask } from '../model.js'
import { checkpointImplementationForVerification } from './git-checkpoint.js'
import type { RepositoryReality } from './reconciliation.js'
import type { TaskStateV2 } from './task-state-v2.js'

const reality = z.object({ repositoryIdentity: z.string(), branch: z.string(), headSha: z.string(),
  changedFiles: z.array(z.string()), worktreeFingerprint: z.string() })
export const ownedCheckpointRecordSchema = z.object({
  sessionId: z.string(), taskId: z.string(), attemptId: z.string().optional(), dispatchId: z.string().uuid(),
  action: z.literal('VERIFY'), result: z.literal('COMMITTED'), baselineCommit: z.string(), before: reality, after: reality,
  tree: z.string(), contentDigest: z.string(), timestamp: z.iso.datetime(),
})
export type OwnedCheckpointRecord = z.infer<typeof ownedCheckpointRecordSchema>
/** An in-process capability, never deserialized from an agent result or persisted JSON. */
export interface OwnedCheckpointProof { readonly kind: 'runtime-implementation-checkpoint' }
export interface CheckpointHandoff {
  dispatchId: string
  accept(proof: OwnedCheckpointProof): Promise<TaskStateV2>
}
const issued = new WeakMap<OwnedCheckpointProof, OwnedCheckpointRecord>()
const run = promisify(execFile)
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run(gitExecutable(), args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
}
async function treeEntries(repo: string, tree: string): Promise<Map<string, string>> {
  const entries = (await git(repo, 'ls-tree', '-rz', tree)).split('\0').filter(Boolean)
  return new Map(entries.map(entry => { const tab = entry.indexOf('\t'); return [entry.slice(tab + 1), entry.slice(0, tab)] }))
}
function digest(entries: Map<string, string>): string {
  return createHash('sha256').update(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
}
async function assertScope(task: TaskStateV2, repo: string): Promise<void> {
  const scope = relativeTaskWorkspaceScope(repo, { ...task.permissions } as GuardianTask)
  const scoped = { ...scope, allowedPaths: (scope.allowedPaths ?? []).map(p => workspacePathKey(p)), forbiddenPaths: (scope.forbiddenPaths ?? []).map(p => workspacePathKey(p)) }
  if (!scope.allowedPaths?.length || scopeBlockers(scoped, task.gitState.changedFiles.map(p => workspacePathKey(p))).length)
    throw new Error('OWNED_CHECKPOINT_SCOPE_REJECTED')
  for (const path of task.gitState.changedFiles) {
    const parts = path.replaceAll('\\', '/').split('/')
    if (/[:\x00-\x1f]/u.test(path) || parts.some(p => !p || p === '.' || p === '..' ||
      ['.git', '.codex', '.claude', '.openai', 'node_modules', '.venv'].includes(p.toLowerCase())))
      throw new Error('OWNED_CHECKPOINT_PATH_REJECTED')
    let current = repo
    for (const part of parts) {
      current = join(current, part)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (info?.isSymbolicLink() || (info?.isFile() && info.nlink > 1)) throw new Error('OWNED_CHECKPOINT_LINK_REJECTED')
    }
  }
}

/** Capture exact expected blobs/modes before staging. A hook cannot smuggle a path, byte, or parent. */
export async function checkpointOwnedImplementation(options: {
  task: TaskStateV2; baselineCommit: string; inspect: () => Promise<RepositoryReality>; handoff: CheckpointHandoff
}): Promise<TaskStateV2> {
  const { task, baselineCommit, handoff } = options
  const before = reality.parse(task.gitState), repo = before.repositoryIdentity
  await assertScope(task, repo)
  const expected = await treeEntries(repo, before.headSha)
  const fileMode = await git(repo, 'config', '--get', 'core.filemode').catch(() => 'true')
  for (const path of before.changedFiles) {
    const info = await lstat(join(repo, path)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (!info) { expected.delete(path); continue }
    if (!info.isFile()) throw new Error('OWNED_CHECKPOINT_NON_FILE')
    const mode = fileMode === 'false' && expected.has(path) ? expected.get(path)!.split(' ')[0]
      : info.mode & 0o111 ? '100755' : '100644'
    const blob = await git(repo, 'hash-object', '--no-filters', '--', path)
    expected.set(path, `${mode} blob ${blob}`)
  }
  const contentDigest = digest(expected)
  const commit = await checkpointImplementationForVerification({ repoPath: repo, expectedRepositoryIdentity: repo,
    expectedBranch: before.branch, baselineCommit, expectedHeadSha: before.headSha,
    expectedChangedFiles: before.changedFiles, expectedWorktreeFingerprint: before.worktreeFingerprint,
    taskId: task.identity.taskId,
    validateStagedTree: async tree => {
      if (digest(await treeEntries(repo, tree)) !== contentDigest) throw new Error('OWNED_CHECKPOINT_CONTENT_MISMATCH')
    } })
  if (commit === before.headSha) return task // Genuine no-op: no commit and no transition to authorize.
  const after = await options.inspect()
  const record = ownedCheckpointRecordSchema.parse({ ...task.identity, ...(task.attemptId ? { attemptId: task.attemptId } : {}),
    dispatchId: handoff.dispatchId, action: 'VERIFY', result: 'COMMITTED', baselineCommit, before, after,
    tree: await git(repo, 'rev-parse', `${commit}^{tree}`), contentDigest, timestamp: new Date().toISOString() })
  if (after.headSha !== commit) throw new Error('OWNED_CHECKPOINT_ENDPOINT_MISMATCH')
  const proof: OwnedCheckpointProof = Object.freeze({ kind: 'runtime-implementation-checkpoint' })
  issued.set(proof, record)
  return handoff.accept(proof)
}

export async function acceptOwnedCheckpoint(proof: OwnedCheckpointProof, task: TaskStateV2,
  dispatchId: string, observed: RepositoryReality): Promise<OwnedCheckpointRecord> {
  const record = issued.get(proof)
  if (!record || record.dispatchId !== dispatchId || record.sessionId !== task.identity.sessionId ||
    record.taskId !== task.identity.taskId || record.attemptId !== task.attemptId ||
    JSON.stringify(record.before) !== JSON.stringify(reality.parse(task.gitState)) ||
    JSON.stringify(record.after) !== JSON.stringify(reality.parse(observed))) throw new Error('OWNED_CHECKPOINT_HANDOFF_REJECTED')
  const repo = record.before.repositoryIdentity
  await assertScope(task, repo)
  if (await realpath(repo) !== repo || observed.repositoryIdentity !== repo || observed.branch !== record.before.branch ||
    observed.changedFiles.length || await git(repo, 'rev-parse', 'HEAD') !== observed.headSha ||
    await git(repo, 'branch', '--show-current') !== observed.branch || await git(repo, 'status', '--porcelain', '--untracked-files=all') !== '' ||
    await git(repo, 'rev-list', '--parents', '-n', '1', observed.headSha) !== `${observed.headSha} ${record.before.headSha}` ||
    await git(repo, 'rev-parse', `${observed.headSha}^{tree}`) !== record.tree ||
    digest(await treeEntries(repo, observed.headSha)) !== record.contentDigest)
    throw new Error('OWNED_CHECKPOINT_COMMIT_REJECTED')
  issued.delete(proof)
  return structuredClone(record)
}
