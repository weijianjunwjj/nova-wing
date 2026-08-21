/**
 * W004-A Safe Git Checkpoint
 *
 * 只做一件事：在 Guardian 真 COMPLETED 后，把该 Task 的 changed files 精确
 * 提交为一个 deterministic commit，并返回 commit SHA。
 *
 * 安全不变量（必须全部满足才 commit，任一不满足 fail closed）：
 * - completion evidence 完整：finalReviewerVerdict=done、blockers=0、
 *   所有 deterministic verification 均 passed；
 * - 目标 branch 非 protected（main/master）；
 * - 实际 branch === WorkSessionDefinition.branch；
 * - worktree meaningful changed files === completion evidence changed files；
 * - git index 在开始时无预先 staged change；
 * - 精确 staging（绝不 `git add -A` / `git add .` / `git add --all`）；
 * - `git diff --cached --check` 通过；
 * - staged 集合 === 允许提交的 Task changed files 集合。
 *
 * Git finalization 归 WorkSession Runtime / 本组件所有。这里只通过
 * `spawn('git', args, ...)` 直接调用 git executable + argv，绝不给 Claude
 * generic Git Bash 权限，也不使用 shell 拼接命令。
 */

import { spawn } from 'node:child_process'
import type { WorkSessionTask } from './model.js'
import type { TaskCompletionEvidence } from './task-runner.js'
import { normalizePath, parseGitStatus } from './worktree-fingerprint.js'

export interface GitCheckpointPolicy {
  autoCommit: boolean
  autoPush: boolean
}

export interface GitCheckpointResult {
  commitSha: string
  committedFiles: readonly string[]
}

export interface GitCheckpointCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * 以 argv 运行 git 命令；缺省实现直接 spawn git executable。
 * 供测试注入 recording/scripted runner，不引入 shell。
 */
export type GitCheckpointCommandRunner = (
  args: readonly string[],
) => Promise<GitCheckpointCommandResult>

export interface FinalizeCompletedTaskOptions {
  repoPath: string
  expectedBranch: string
  task: WorkSessionTask
  completionEvidence: TaskCompletionEvidence
  policy: GitCheckpointPolicy
  /** 测试/替换用；缺省直接 spawn git executable + argv */
  commandRunner?: GitCheckpointCommandRunner
  /** W004-A FINAL: Task 开始时的 base HEAD；提供则 commit 前必须与之相等，否则 fail closed */
  expectedBaseHeadSha?: string
}

export type GitCheckpointFinalizer = (
  options: FinalizeCompletedTaskOptions,
) => Promise<GitCheckpointResult>

export class GitCheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCheckpointError'
  }
}

const PROTECTED_BRANCHES = new Set(['main', 'master'])

/** untracked 且位于依赖/产物目录时视为 runtime artifact，不进入 Task commit */
const RUNTIME_ARTIFACT_DIR_SEGMENTS = new Set(['node_modules', '.venv', 'dist'])

function isUntrackedRuntimeArtifact(status: string, path: string): boolean {
  return (
    status.startsWith('??') &&
    normalizePath(path)
      .split('/')
      .some((segment) => RUNTIME_ARTIFACT_DIR_SEGMENTS.has(segment))
  )
}

function createDefaultCommandRunner(repoPath: string): GitCheckpointCommandRunner {
  return (args: readonly string[]): Promise<GitCheckpointCommandResult> => {
    return new Promise<GitCheckpointCommandResult>((resolve) => {
      const child = spawn('git', [...args], {
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
      child.once('error', (error) => {
        resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
      })
      child.once('exit', (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr })
      })
    })
  }
}

async function runGitChecked(
  runGit: GitCheckpointCommandRunner,
  args: readonly string[],
): Promise<void> {
  const result = await runGit(args)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`
    throw new GitCheckpointError(`git ${args[0] ?? ''} failed: ${detail}`)
  }
}

async function runGitString(
  runGit: GitCheckpointCommandRunner,
  args: readonly string[],
): Promise<string> {
  const result = await runGit(args)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`
    throw new GitCheckpointError(`git ${args[0] ?? ''} failed: ${detail}`)
  }
  // 只裁剪尾部换行/空白，保留前导空格：`git status --porcelain` 的首行状态字段
  // 以空格开头（如 ` D path`），用 .trim() 会把首字符状态裁掉，破坏 parseGitStatus。
  return result.stdout.trimEnd()
}

/**
 * W004-A FINAL: 读取当前 HEAD SHA。
 * 供 WorkSession Runtime 在 Task 开始前捕获 base HEAD（autoCommit=true）。
 * 只读 git rev-parse HEAD，无任何破坏性操作。
 */
export async function readCurrentHeadSha(
  repoPath: string,
  commandRunner?: GitCheckpointCommandRunner,
): Promise<string> {
  const runGit = commandRunner ?? createDefaultCommandRunner(repoPath)
  const head = await runGitString(runGit, ['rev-parse', 'HEAD'])
  if (head.length === 0) {
    throw new GitCheckpointError('cannot read current HEAD')
  }
  return head
}

function validateCompletionEvidence(evidence: TaskCompletionEvidence): void {
  if (evidence.finalReviewerVerdict !== 'done') {
    throw new GitCheckpointError(
      `final reviewer verdict is ${evidence.finalReviewerVerdict}, not done; refusing to commit`,
    )
  }
  if (evidence.incompleteReason !== undefined && evidence.incompleteReason.trim().length > 0) {
    throw new GitCheckpointError('task has incompleteReason; refusing to commit')
  }
  if (evidence.blockers.length !== 0) {
    throw new GitCheckpointError(
      `task has ${evidence.blockers.length} blocker(s); refusing to commit`,
    )
  }
  if (evidence.verificationResults.length === 0) {
    throw new GitCheckpointError(
      'task has no deterministic verification results; refusing to commit',
    )
  }
  for (const verification of evidence.verificationResults) {
    if (verification.status !== 'passed') {
      throw new GitCheckpointError(
        `verification ${verification.name} status=${verification.status}; refusing to commit`,
      )
    }
  }
  // requiredVerification 中每个命令都必须有同名且 passed 的 verificationResults entry，
  // 不能只凭 verificationResults 全 passed 就放行（可能漏跑了 Reviewer 要求的 verification）。
  for (const required of evidence.requiredVerification) {
    const match = evidence.verificationResults.find((v) => v.name === required)
    if (match === undefined || match.status !== 'passed') {
      throw new GitCheckpointError(
        `required verification ${required} not passed; refusing to commit`,
      )
    }
  }
}

function samePathSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = [...new Set(a.map(normalizePath))].sort()
  const setB = [...new Set(b.map(normalizePath))].sort()
  if (setA.length !== setB.length) {
    return false
  }
  return setA.every((value, index) => value === setB[index])
}

function parseNameOnlyLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * W004-A: 在 Guardian 真 COMPLETED 后执行 safe git checkpoint。
 *
 * 返回 { commitSha, committedFiles }。任何 gate 不满足都 throw GitCheckpointError，
 * 绝不 commit、绝不 push、绝不 reset/clean/restore/checkout。
 */
export async function finalizeCompletedTask(
  options: FinalizeCompletedTaskOptions,
): Promise<GitCheckpointResult> {
  const { repoPath, expectedBranch, task, completionEvidence, policy } = options
  const runGit = options.commandRunner ?? createDefaultCommandRunner(repoPath)

  // gate: autoCommit 必须显式开启
  if (policy.autoCommit !== true) {
    throw new GitCheckpointError('autoCommit is disabled; refusing to commit')
  }
  // W004-A 不实现 push；policy 请求 push 一律 fail closed
  if (policy.autoPush === true) {
    throw new GitCheckpointError('autoPush is not implemented in W004-A; refusing to push')
  }

  // gate: completion evidence 完整且全 passed（含 finalReviewerVerdict=done、blockers=0）
  validateCompletionEvidence(completionEvidence)

  // gate: definition branch 不得是 protected branch
  if (PROTECTED_BRANCHES.has(expectedBranch)) {
    throw new GitCheckpointError(`refusing to commit on protected branch: ${expectedBranch}`)
  }

  // 只读 precondition: 实际 branch 必须等于 definition branch
  const actualBranch = await runGitString(runGit, ['branch', '--show-current'])
  if (actualBranch !== expectedBranch) {
    throw new GitCheckpointError(
      `branch drift: expected ${expectedBranch}, got ${actualBranch || '(detached)'}`,
    )
  }

  // W004-A FINAL: 绑定 Task 开始时的 base HEAD；任何 staging/commit 之前必须仍等于它。
  // 若任务期间 repository HEAD 被外部改动，fail closed，绝不 commit。
  if (options.expectedBaseHeadSha !== undefined) {
    const actualHead = await runGitString(runGit, ['rev-parse', 'HEAD'])
    if (actualHead !== options.expectedBaseHeadSha) {
      throw new GitCheckpointError(
        'repository HEAD changed during task; refusing to commit',
      )
    }
  }

  // 只读 precondition: worktree meaningful changed files === evidence changed files
  const statusStdout = await runGitString(runGit, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ])
  const entries = parseGitStatus(statusStdout)
  const meaningfulFiles = entries
    .filter((entry) => !isUntrackedRuntimeArtifact(entry.status, entry.path))
    .map((entry) => normalizePath(entry.path))
  const evidenceFiles = completionEvidence.changedFiles.map(normalizePath)
  if (!samePathSet(meaningfulFiles, evidenceFiles)) {
    throw new GitCheckpointError(
      'worktree changed files do not match completion evidence; refusing to commit',
    )
  }

  // precondition: git index 开始时必须为空（不得混入用户 staged change）
  const preStaged = parseNameOnlyLines(
    await runGitString(runGit, ['diff', '--cached', '--name-only']),
  )
  if (preStaged.length > 0) {
    throw new GitCheckpointError(
      'git index has pre-staged changes; refusing to mix them into task commit',
    )
  }

  if (evidenceFiles.length === 0) {
    throw new GitCheckpointError(`no meaningful files to commit for task ${task.id}`)
  }

  // 精确 staging：只 stage evidence 列出的文件，绝不 `git add -A` / `.` / `--all`
  await runGitChecked(runGit, ['add', '--', ...evidenceFiles])

  // whitespace/check 必须 PASS
  await runGitChecked(runGit, ['diff', '--cached', '--check'])

  // 确认 staged 集合 === evidence 集合；不一致则 fail closed
  const stagedFiles = parseNameOnlyLines(
    await runGitString(runGit, ['diff', '--cached', '--name-only']),
  )
  if (!samePathSet(stagedFiles, evidenceFiles)) {
    throw new GitCheckpointError(
      'staged files do not match task changed files; refusing to commit',
    )
  }

  // deterministic commit message（不让 LLM 生成）
  const message = `完成 ${task.id}: ${task.goal}`
  await runGitChecked(runGit, ['commit', '-m', message])

  // 记录 commit SHA
  const commitSha = await runGitString(runGit, ['rev-parse', 'HEAD'])
  if (commitSha.length === 0) {
    throw new GitCheckpointError('cannot read commit SHA after commit')
  }

  return { commitSha, committedFiles: evidenceFiles }
}
