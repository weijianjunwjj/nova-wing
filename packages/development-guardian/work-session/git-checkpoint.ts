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

export interface PushRemotePolicy {
  /** remote 名（如 origin） */
  name: string
  /** 显式信任的 remote URL；必须与实际 `git remote get-url <name>` 精确一致 */
  expectedUrl: string
}

export interface GitCheckpointPolicy {
  autoCommit: boolean
  autoPush: boolean
  /** W004-B: autoPush=true 时必须显式提供 remote identity；缺失 fail closed */
  pushRemote?: PushRemotePolicy
}

export interface GitCheckpointResult {
  commitSha: string
  committedFiles: readonly string[]
  /** W004-B: push 成功且远端 SHA 验证通过后的远端 SHA（仅 autoPush=true 时存在） */
  pushSha?: string
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

/**
 * W004-B: push 阶段失败。与 commit 失败区分：此时 local commit 已成功，
 * `commitSha` 携带已提交的 SHA，供 runtime 表达"local commit 已发生、push 未完成"的部分成功状态。
 */
export class GitPushError extends GitCheckpointError {
  constructor(
    message: string,
    public readonly commitSha: string,
  ) {
    super(message)
    this.name = 'GitPushError'
  }
}

const PROTECTED_BRANCHES = new Set(['main', 'master'])
const CHECKPOINT_SUMMARY_MAX_LENGTH = 80

/**
 * Deterministically render a concise, single-line checkpoint subject from the
 * first meaningful task-goal line.  Never delegate commit-message generation.
 */
function taskGoalSummary(goal: string): string {
  const firstLine = goal.split(/\r?\n/u).find((line) => line.trim().length > 0)
  const summary = firstLine?.trim().replace(/\s+/gu, ' ') ?? ''
  if (summary.length === 0) throw new GitCheckpointError('task goal summary is empty')
  return summary.length <= CHECKPOINT_SUMMARY_MAX_LENGTH
    ? summary
    : `${summary.slice(0, CHECKPOINT_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
}

function renderCheckpointCommitMessage(task: Pick<WorkSessionTask, 'id' | 'goal'>): string {
  const escapedTaskId = task.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const withoutRepeatedTaskId = taskGoalSummary(task.goal)
    .replace(new RegExp(`(^|[^A-Za-z0-9._-])${escapedTaskId}(?=$|[^A-Za-z0-9._-])`, 'gu'), '$1')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([:：-])/gu, '$1')
    .replace(/^[:：-]+\s*/u, '')
    .trim()
  return `${task.id}: ${withoutRepeatedTaskId}`
}

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

async function restoreIndexAfterFailedCheckpoint(
  runGit: GitCheckpointCommandRunner,
  preCommitHead: string,
): Promise<string | undefined> {
  try {
    // This is deliberately index-only: with the existing empty-index gate,
    // read-tree HEAD restores exactly the index state present at checkpoint
    // entry and never writes the worktree, branch, or HEAD.
    const currentHead = await runGitString(runGit, ['rev-parse', 'HEAD'])
    if (currentHead !== preCommitHead) {
      return 'index was not restored because HEAD changed during a failed commit (ambiguous partial commit state)'
    }
    await runGitChecked(runGit, ['read-tree', 'HEAD'])
    return undefined
  } catch (error) {
    return `index rollback failed: ${error instanceof Error ? error.message : String(error)}`
  }
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

export interface PushCheckpointCommitOptions {
  repoPath: string
  expectedBranch: string
  /** 本 Task 刚生成的 local commit SHA（push 前 HEAD 必须等于它） */
  commitSha: string
  /** 显式信任的 remote identity */
  remote: PushRemotePolicy
  /** 测试/替换用；缺省直接 spawn git executable + argv */
  commandRunner?: GitCheckpointCommandRunner
}

export interface PushCheckpointResult {
  pushSha: string
}

/**
 * W004-B: 窄 push 组件。只在 local commit 成功后调用。
 *
 * 任何 remote mutation 前必须通过全部 gate：
 * 1. remote identity 显式非空；
 * 2. expectedBranch 非 protected；
 * 3. actual branch === expectedBranch；
 * 4. actual HEAD === 本 Task 刚生成的 commitSha；
 * 5. remote name 存在（git remote get-url --push --all）；
 * 6. push URL 恰好一个，且 === explicitly trusted expectedUrl（精确一致）。
 *
 * 然后才 `git push --porcelain <remote> <commitSha>:refs/heads/<expectedBranch>`，
 * push source 用 immutable commit SHA（不是 HEAD），避免 HEAD gate 之后被移动的 TOCTOU。
 * push 成功后仍用 `git ls-remote --heads` 验证远端 SHA === commitSha，否则 fail closed。
 * 绝不使用 --force / -f / --force-with-lease / --delete / --all / --tags / tag / 任意 refspec。
 */
export async function pushCheckpointCommit(
  options: PushCheckpointCommitOptions,
): Promise<PushCheckpointResult> {
  const { repoPath, expectedBranch, commitSha, remote } = options
  const runGit = options.commandRunner ?? createDefaultCommandRunner(repoPath)

  // gate: remote identity 必须显式非空
  if (typeof remote.name !== 'string' || remote.name.trim().length === 0) {
    throw new GitCheckpointError('push remote name is missing; refusing to push')
  }
  if (typeof remote.expectedUrl !== 'string' || remote.expectedUrl.trim().length === 0) {
    throw new GitCheckpointError('push remote expectedUrl is missing; refusing to push')
  }

  // gate: 不得 push protected branch
  if (PROTECTED_BRANCHES.has(expectedBranch)) {
    throw new GitCheckpointError(`refusing to push to protected branch: ${expectedBranch}`)
  }

  // gate: actual branch === expectedBranch
  const actualBranch = await runGitString(runGit, ['branch', '--show-current'])
  if (actualBranch !== expectedBranch) {
    throw new GitCheckpointError(
      `branch drift before push: expected ${expectedBranch}, got ${actualBranch || '(detached)'}`,
    )
  }

  // gate: actual HEAD === 本 Task 刚生成的 commitSha（W004-B CASE W）
  const actualHead = await runGitString(runGit, ['rev-parse', 'HEAD'])
  if (actualHead !== commitSha) {
    throw new GitCheckpointError('HEAD changed after commit before push; refusing to push')
  }

  // gate: remote 的 push URL 必须恰好一个且精确一致（不因名叫 origin 就信任）。
  // 用 --push 读取实际 push URL：若配置了 pushurl（可能是 evil），会优先返回 pushurl，
  // 从而暴露 "fetch url trusted + pushurl evil" 的隐患；--all 暴露多个 pushurl。
  const pushUrlStdout = await runGitString(runGit, [
    'remote',
    'get-url',
    '--push',
    '--all',
    remote.name,
  ])
  const pushUrls = pushUrlStdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (pushUrls.length !== 1) {
    throw new GitCheckpointError(
      `remote ${remote.name} must have exactly one push URL, got ${pushUrls.length}; refusing to push`,
    )
  }
  const actualPushUrl = pushUrls[0]
  if (actualPushUrl !== remote.expectedUrl) {
    throw new GitCheckpointError(
      `remote ${remote.name} push URL mismatch; refusing to push`,
    )
  }

  // 精确 push：immutable commit SHA → refs/heads/<expectedBranch>。
  // 不用 HEAD refspec，避免 HEAD gate 之后 HEAD 被移动（TOCTOU）仍 push 错误对象。
  await runGitChecked(runGit, [
    'push',
    '--porcelain',
    remote.name,
    `${commitSha}:refs/heads/${expectedBranch}`,
  ])

  // push exitCode=0 仍不够：远端 SHA 必须 === commitSha，否则 fail closed
  const remoteHead = await runGitString(runGit, [
    'ls-remote',
    '--heads',
    remote.name,
    `refs/heads/${expectedBranch}`,
  ])
  const remoteSha = remoteHead.split(/\s+/u)[0] ?? ''
  if (remoteSha !== commitSha) {
    throw new GitCheckpointError(
      `remote checkpoint verification failed: expected ${commitSha}, got ${remoteSha || '(none)'}`,
    )
  }

  return { pushSha: remoteSha }
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
  // W004-B: autoPush=true 必须显式提供 remote identity，否则 fail closed（在 commit 前，零 mutation）
  const pushRequested = policy.autoPush === true
  if (pushRequested && policy.pushRemote === undefined) {
    throw new GitCheckpointError('autoPush requires explicit pushRemote; refusing to commit or push')
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

  // Capture the HEAD which authorizes rollback immediately before NovaWing
  // starts touching the real index.  expectedBaseHeadSha was already gated;
  // otherwise read it now to make a commit failure unambiguous.
  const preCommitHead = options.expectedBaseHeadSha
    ?? await runGitString(runGit, ['rev-parse', 'HEAD'])
  let stagingStarted = false
  let commitSucceeded = false

  try {
    // 精确 staging：只 stage evidence 列出的文件，绝不 `git add -A` / `.` / `--all`
    stagingStarted = true
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

    // Deterministic, concise subject; never let a pasted multi-line goal enter Git history verbatim.
    const message = renderCheckpointCommitMessage(task)
    await runGitChecked(runGit, ['commit', '-m', message])
    commitSucceeded = true
  } catch (error) {
    if (!stagingStarted || commitSucceeded) {
      throw error
    }
    const rollbackFailure = await restoreIndexAfterFailedCheckpoint(runGit, preCommitHead)
    const original = error instanceof Error ? error.message : String(error)
    throw new GitCheckpointError(
      rollbackFailure === undefined
        ? `${original}; restored index to pre-checkpoint HEAD`
        : `${original}; ${rollbackFailure}`,
    )
  }

  // 记录 commit SHA
  const commitSha = await runGitString(runGit, ['rev-parse', 'HEAD'])
  if (commitSha.length === 0) {
    throw new GitCheckpointError('cannot read commit SHA after commit')
  }

  // W004-B: autoPush=true 时在 local commit 成功后 push + 远端 SHA 验证
  let pushSha: string | undefined
  if (pushRequested) {
    const remote = policy.pushRemote
    if (remote === undefined) {
      // 理论上已被上方 gate 拦截；此处防御性 fail closed
      throw new GitPushError('autoPush requires explicit pushRemote', commitSha)
    }
    try {
      const pushResult = await pushCheckpointCommit({
        repoPath,
        expectedBranch,
        commitSha,
        remote,
        commandRunner: runGit,
      })
      pushSha = pushResult.pushSha
    } catch (error) {
      // local commit 已成功；push 失败必须携带 commitSha（partial success 可见）
      if (error instanceof GitCheckpointError) {
        throw new GitPushError(error.message, commitSha)
      }
      throw error
    }
  }

  return { commitSha, committedFiles: evidenceFiles, ...(pushSha !== undefined ? { pushSha } : {}) }
}
