import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'

import { readWorkspaceGit } from '../codex-workspace-tools.js'
import { CodingExecutionStore, type ControlledQuotaInjection } from './coding-execution-store.js'
import type { WorkSessionDurableState, WorkSessionDefinition } from './model.js'
import { computeWorktreeFingerprint, parseGitStatus } from './worktree-fingerprint.js'

export const CONTROLLED_QUOTA_INJECTION_FLAG = 'NOVAWING_ENABLE_CONTROLLED_QUOTA_INJECTION'

export interface ControlledQuotaInjectionRequest {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState | undefined
  taskId: string
  confirmation: string
  env?: NodeJS.ProcessEnv
  clock?: () => number
  store?: CodingExecutionStore
}

/** Development/test operator control plane. Executors never receive this capability. */
export async function requestControlledCodexQuotaExhaustion(
  request: ControlledQuotaInjectionRequest,
): Promise<ControlledQuotaInjection> {
  const env = request.env ?? process.env
  if (env[CONTROLLED_QUOTA_INJECTION_FLAG] !== '1' || env.NODE_ENV === 'production') {
    throw new Error('controlled quota injection is disabled outside an explicitly enabled development/test runtime')
  }
  if (request.confirmation !== `INJECT ${request.taskId} codex_quota_exhausted`) {
    throw new Error('controlled quota injection requires exact Task-scoped confirmation')
  }
  const configuredTask = request.definition.tasks.find((task) => task.id === request.taskId)
  const state = request.state
  if (configuredTask === undefined || state === undefined || state.sessionId !== request.definition.id ||
      state.state !== 'SUSPENDED' || state.currentTaskId !== request.taskId ||
      state.currentTaskCheckpoint?.task.id !== request.taskId) {
    throw new Error('controlled quota injection requires the exact suspended non-terminal Task checkpoint')
  }
  const checkpoint = state.currentTaskCheckpoint
  const report = checkpoint.task.lastReport
  if (report === undefined || report.changedFiles.length === 0 ||
      !report.commandsRun.some((command) => /(?:git status|list_files|read_file)/u.test(command))) {
    throw new Error('controlled quota injection requires Codex workspace inspection and changed files evidence')
  }
  const store = request.store ?? new CodingExecutionStore(join(
    env.LOCALAPPDATA?.trim() || join(homedir(), '.novawing'), 'NovaWing', 'coding-executors.sqlite',
  ))
  const key = JSON.stringify([request.definition.id, request.taskId])
  const metadata = store.read(key)
  if (metadata?.mode !== 'auto' || metadata.activeExecutor !== 'codex' ||
      metadata.history.length !== 1 || metadata.history[0] !== 'codex') {
    throw new Error('controlled quota injection requires activeExecutor=codex and history=[codex]')
  }
  const workspace = await realpath(request.definition.targetRepo)
  const workspaceKey = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  if (store.hasWorkspaceLease(workspaceKey)) {
    throw new Error('controlled quota injection rejected while an active writer lease exists')
  }
  const events = store.events(key)
  const lastTurn = [...events].reverse().find((event) => event.executor === 'codex')
  if (lastTurn?.type !== 'executor_completed') {
    throw new Error('controlled quota injection requires a completed Codex turn boundary')
  }
  const workingTree = await readWorkspaceGit(workspace, 'status')
  const entries = parseGitStatus(workingTree)
  const currentFiles = entries.map((entry) => entry.path).sort()
  const expectedFiles = [...checkpoint.repo.changedFiles].sort()
  const diff = await readWorkspaceGit(workspace, 'diff')
  const diffBytes = Buffer.byteLength(diff.length > 0 ? diff : workingTree, 'utf8')
  const fingerprint = await computeWorktreeFingerprint(workspace, entries)
  if (diffBytes <= 0 || fingerprint !== checkpoint.repo.worktreeFingerprint ||
      JSON.stringify(currentFiles) !== JSON.stringify(expectedFiles) ||
      JSON.stringify([...report.changedFiles].sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error('controlled quota injection requires a non-empty workspace diff matching the durable checkpoint')
  }
  const injection: ControlledQuotaInjection = {
    injectionId: randomUUID(), kind: 'codex_quota_exhausted', taskId: request.taskId,
    requestedAt: new Date(request.clock?.() ?? Date.now()).toISOString(),
    expectedWorktreeFingerprint: fingerprint, expectedChangedFiles: expectedFiles,
    expectedDiffBytes: diffBytes, status: 'pending',
  }
  store.requestControlledQuotaInjection(key, injection)
  return injection
}
