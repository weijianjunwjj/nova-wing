import { gitExecutable } from '../platform/windows-git.js'
/**
 * W003 Legacy Recovery Adoption
 *
 * 在 W003 出现之前，某个真实 Task 已经在 repository 中产生了 dirty worktree，
 * 但没有 WorkSession checkpoint / ChatGPT conversation URL / Claude session ID。
 *
 * Legacy Adoption 由用户显式调用，把"当前工作现场"认领为该 Task 的恢复基线：
 * read-only inspect repo → capture RepositoryCheckpoint → bind explicit GuardianTask facts
 * → provider state empty → create GuardianTaskRecoveryCheckpoint。
 *
 * 关键性质：
 * - 显式：绝不自动认领 dirty repo（dirty repo 未 adoption 仍 fail closed）；
 * - 只读：只有 git branch --show-current / git rev-parse HEAD / git status --porcelain，
 *   以及读取 meaningful changed/untracked 文件内容计算 fingerprint，没有任何破坏性 git 操作；
 * - 无 provider invocation：AskBridge / Claude 调用均为 0；
 * - 无 AI discovery：Task facts 必须由调用方明确传入，不从 dirty code 猜测；
 * - 无 secret：checkpoint 不含 token / cookie / credential / raw provider stdout。
 */

import { spawn } from 'node:child_process'
import type { GuardianTask } from '../model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import { parseGitStatus, computeWorktreeFingerprint } from './worktree-fingerprint.js'

export const LEGACY_PRE_EXISTING_DIRTY_REASON =
  'target repository has pre-existing changes; MVP requires a clean worktree before autonomous execution'

export interface LegacyRecoveryGitResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type LegacyRecoveryGitRunner = (
  command: string,
) => Promise<LegacyRecoveryGitResult>

/**
 * 显式 Task facts，Legacy Adoption 的输入。
 * 必须由调用方明确给出，不从 dirty code 猜测，不由 LLM 反推。
 */
export interface LegacyRecoveryTaskFacts {
  id: string
  goal: string
  constraints?: readonly string[]
  acceptanceCriteria?: readonly string[]
  doNotDo?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
}

export interface AdoptLegacyRecoveryCheckpointOptions {
  /** 显式 Task facts */
  task: LegacyRecoveryTaskFacts
  /** 目标 repository 路径 */
  repoPath: string
  /** git 命令运行器；缺省使用只允许 git 命令的真实运行器 */
  gitRunner?: LegacyRecoveryGitRunner
}

/** 缺省运行器：只放行 git 命令，杜绝任意命令执行 */
function createDefaultGitRunner(repoPath: string): LegacyRecoveryGitRunner {
  return async (command: string): Promise<LegacyRecoveryGitResult> => {
    const parts = command.trim().split(/\s+/u)
    if (parts.length === 0 || parts[0] !== 'git') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `unsupported legacy adoption command: ${parts[0] ?? ''}`,
      }
    }
    const args = parts.slice(1)
    return new Promise<LegacyRecoveryGitResult>((resolve) => {
      const child = spawn(gitExecutable(), args, {
        cwd: repoPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', () => {
        resolve({ exitCode: 1, stdout, stderr })
      })
      child.once('exit', (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr })
      })
    })
  }
}

/** 归一化为可恢复的 Guardian Task（HUMAN_REQUIRED 恢复基线的语义状态） */
function toRecoveryGuardianTask(facts: LegacyRecoveryTaskFacts): GuardianTask {
  return {
    id: facts.id,
    goal: facts.goal,
    state: 'HUMAN_REQUIRED',
    iteration: 0,
    maxIterations: 10,
    ...(facts.constraints !== undefined ? { constraints: facts.constraints } : {}),
    ...(facts.acceptanceCriteria !== undefined ? { acceptanceCriteria: facts.acceptanceCriteria } : {}),
    ...(facts.doNotDo !== undefined ? { doNotDo: facts.doNotDo } : {}),
    ...(facts.allowedPaths !== undefined ? { allowedPaths: facts.allowedPaths } : {}),
    ...(facts.forbiddenPaths !== undefined ? { forbiddenPaths: facts.forbiddenPaths } : {}),
  }
}

/**
 * 显式 Adoption：把当前 repository 状态认领为指定 Task 的可信恢复基线。
 *
 * 只读探测 repository（branch / HEAD / status + fingerprint），绑定显式 Task facts，
 * provider sessions 一律为空，无任何 provider invocation。
 */
export async function adoptLegacyRecoveryCheckpoint(
  options: AdoptLegacyRecoveryCheckpointOptions,
): Promise<GuardianTaskRecoveryCheckpoint> {
  const repoPath = options.repoPath

  if (typeof options.task.id !== 'string' || options.task.id.trim().length === 0) {
    throw new Error('Legacy adoption requires a non-empty task id')
  }
  if (typeof options.task.goal !== 'string' || options.task.goal.trim().length === 0) {
    throw new Error('Legacy adoption requires a non-empty task goal')
  }

  const gitRunner = options.gitRunner ?? createDefaultGitRunner(repoPath)

  // === 只读 git 探测（无 add/commit/reset/clean/restore/checkout/stash） ===
  const branchResult = await gitRunner('git branch --show-current')
  if (branchResult.exitCode !== 0) {
    throw new Error(
      `Legacy adoption failed: cannot read current branch: ${branchResult.stderr.trim() || `exit=${branchResult.exitCode}`}`,
    )
  }
  const branch = branchResult.stdout.trim()
  if (branch.length === 0) {
    throw new Error(
      'Legacy adoption failed: repository is in detached HEAD state; adoption requires a branch',
    )
  }

  const headResult = await gitRunner('git rev-parse HEAD')
  if (headResult.exitCode !== 0) {
    throw new Error(
      `Legacy adoption failed: cannot read HEAD: ${headResult.stderr.trim() || `exit=${headResult.exitCode}`}`,
    )
  }
  const headSha = headResult.stdout.trim()

  const statusResult = await gitRunner('git status --porcelain --untracked-files=all')
  if (statusResult.exitCode !== 0) {
    throw new Error(
      `Legacy adoption failed: cannot read git status: ${statusResult.stderr.trim() || `exit=${statusResult.exitCode}`}`,
    )
  }
  const entries = parseGitStatus(statusResult.stdout)
  const changedFiles = entries.map((entry) => entry.path)

  // 读取 meaningful changed/untracked 文件内容并计算指纹（SHA-256）
  const worktreeFingerprint = await computeWorktreeFingerprint(repoPath, entries)

  return {
    version: 1,
    task: toRecoveryGuardianTask(options.task),
    provider: {},
    repo: {
      repoPath,
      branch,
      headSha,
      changedFiles,
      worktreeFingerprint,
    },
    capturedAt: new Date().toISOString(),
  }
}
