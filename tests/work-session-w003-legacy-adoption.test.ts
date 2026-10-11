/**
 * W003 Legacy Recovery Adoption Test
 *
 * Legacy Adoption 解决：W003 之前某个真实 Task 已在 repository 产生 dirty worktree，
 * 但没有 WorkSession checkpoint / ChatGPT conversation URL / Claude session ID。
 * 用户显式调用 adoptLegacyRecoveryCheckpoint，把当前工作现场认领为该 Task 的恢复基线。
 *
 * 证明项：
 * - CASE A: dirty repo 未 adoption 仍 fail closed（Claude invocation = 0），
 *   Legacy Adoption 没有把默认安全策略改成"所有 dirty repo 都可恢复"；
 * - CASE B: 显式 adoption → checkpoint provider sessions 均为 undefined，
 *   branch/HEAD/changedFiles/fingerprint 正确，且只读（git status 前后一致、文件内容一致、无破坏性 git 命令）；
 * - CASE C: adoption checkpoint 注入现有 Recovery Resume path → Task COMPLETED，
 *   ChatGPT --new、Claude 无 --resume + continuation prompt、既有 dirty files 保留；
 * - CASE D: adoption 后再修改文件 → REPO_DRIFT，AskBridge/Claude 调用均为 0
 *   （Adoption 是"在某个确定时刻认可现场"，不是"永久信任 dirty repo"）；
 * - Task Identity: T1 的 checkpoint 拿去 resume T2 → fail closed（SAFETY_BLOCKED）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCodeExecutor, type GuardianCommandRequest, type GuardianCommandResult, type GuardianTask, type DelegationPacket } from 'nova-wing/development-guardian'
import { adoptLegacyRecoveryCheckpoint } from '../packages/development-guardian/work-session/legacy-recovery.js'
import {
  guardianShellPayload,
  guardianShellTestCommand,
  isClaudeShellRequest,
} from './guardian-shell-fixture.js'

// ============ Git Test Helper ============

type GitRunResult = {
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function setupLegacyRepo(baseDir: string): Promise<{
  repoPath: string
  gitRunner: (cmd: string) => Promise<GitRunResult>
}> {
  const repoPath = join(baseDir, 'test-repo')
  await mkdir(repoPath, { recursive: true })

  const gitRunner = async (cmd: string) => {
    const { spawn } = await import('node:child_process')
    return new Promise<GitRunResult>((resolve) => {
      const shell = guardianShellTestCommand(cmd)
      const child = spawn(shell.executable, shell.args, {
        cwd: repoPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('exit', (exitCode, signal) => {
        resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr })
      })
    })
  }

  await gitRunner('git init')
  await gitRunner('git config user.email "test@example.com"')
  await gitRunner('git config user.name "Test User"')
  await writeFile(join(repoPath, 'README.md'), '# Legacy Test Repo')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m "Initial commit"')
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1\n')
  await gitRunner('git add src/feature.ts')
  await gitRunner('git commit -m "add feature baseline"')
  await gitRunner('git checkout -b feat/test')

  return { repoPath, gitRunner }
}

/** 记录所有 git 命令（用于断言无破坏性操作） */
function createRecordingGitRunner(
  gitRunner: (cmd: string) => Promise<GitRunResult>,
): { run: (cmd: string) => Promise<GitRunResult>; commands: string[] } {
  const commands: string[] = []
  const run = async (cmd: string) => {
    commands.push(cmd)
    return gitRunner(cmd)
  }
  return { run, commands }
}

// ============ Task / Packet Fixtures ============

/** 只读探测命令（adoption 允许的全部命令） */
const READ_ONLY_ADOPTION_COMMANDS = [
  'git branch --show-current',
  'git rev-parse HEAD',
  'git status --porcelain --untracked-files=all',
]

/** 破坏性 git 命令模式（adoption 必须绝无） */
const DESTRUCTIVE_GIT_PATTERN = /\bgit (add|commit|reset|clean|restore|checkout|stash|rm|mv)\b/

const legacyTaskFacts = {
  id: 'T1',
  goal: 'Legacy 恢复实现 feature',
  constraints: ['保持 src 内部一致性'],
  acceptanceCriteria: ['npm run typecheck 通过'],
  doNotDo: ['不要删除现有文件'],
  allowedPaths: ['src/**'],
  forbiddenPaths: ['docs/**'],
}

function claudeCountingCommandRunner(
  gitRunner: (cmd: string) => Promise<GitRunResult>,
  counters: { claudeCalls: number },
): (req: GuardianCommandRequest) => Promise<GuardianCommandResult> {
  return async (req) => {
    if (isClaudeShellRequest(req)) {
      counters.claudeCalls++
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ type: 'success', result: 'should not run' }),
        stderr: '',
      }
    }
    const command = guardianShellPayload(req)
    if (command !== undefined) {
      return gitRunner(command)
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
  }
}

// ============ CASE A: Dirty Repo Without Adoption ============

await test('W003 Legacy Adoption CASE A: dirty repo WITHOUT adoption still fails closed (no default adoption)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-a-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    // dirty worktree，但从未调用 adoptLegacyRecoveryCheckpoint
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // dirty without adoption\n')

    const counters = { claudeCalls: 0 }
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: claudeCountingCommandRunner(gitRunner, counters),
    })

    const task: GuardianTask = { id: 'T1', goal: 'CASE A', iteration: 1, state: 'READY', maxIterations: 3 }
    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'CASE A',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report = await executor.execute({ task, packet })

    // 默认安全策略未被 Legacy Adoption 削弱：未 adoption 的 dirty repo 必须 fail closed
    assert.ok(report.blockers.length >= 1, 'must be blocked on dirty worktree without adoption')
    assert.ok(
      report.blockers.some((blocker) => blocker.includes('pre-existing')),
      `must be the dirty-worktree blocker, got: ${report.blockers.join(', ')}`,
    )
    assert.strictEqual(counters.claudeCalls, 0, 'Claude invocation must be 0 (fail closed)')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ CASE B: Explicit Adoption ============

await test('W003 Legacy Adoption CASE B: explicit adoption binds task facts to current repo state (read-only)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-b-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    // 制造 legacy dirty worktree：tracked 修改（部分实现）+ 合法 untracked 文件
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // partial legacy implementation\n')
    await writeFile(join(repoPath, 'src/untracked-notes.md'), '# manual notes\n')

    const beforeStatus = (await gitRunner('git status --porcelain --untracked-files=all')).stdout
    const beforeHead = (await gitRunner('git rev-parse HEAD')).stdout.trim()

    // 记录 adoption 期间执行的 git 命令
    const recording = createRecordingGitRunner(gitRunner)

    const checkpoint = await adoptLegacyRecoveryCheckpoint({
      task: legacyTaskFacts,
      repoPath,
      gitRunner: recording.run,
    })

    // ===== checkpoint 结构 =====
    assert.strictEqual(checkpoint.version, 1)
    assert.ok(checkpoint.capturedAt.length > 0, 'capturedAt must exist')

    // provider sessions 一律 undefined
    assert.strictEqual(checkpoint.provider.chatgptConversationUrl, undefined, 'ChatGPT URL must be undefined')
    assert.strictEqual(checkpoint.provider.claudeSessionId, undefined, 'Claude session must be undefined')
    assert.strictEqual(Object.keys(checkpoint.provider).length, 0, 'provider must be empty')

    // task facts 被明确绑定，不从 dirty code 猜测
    assert.strictEqual(checkpoint.task.id, 'T1')
    assert.strictEqual(checkpoint.task.goal, 'Legacy 恢复实现 feature')
    assert.deepEqual(checkpoint.task.constraints, ['保持 src 内部一致性'])
    assert.deepEqual(checkpoint.task.acceptanceCriteria, ['npm run typecheck 通过'])
    assert.deepEqual(checkpoint.task.doNotDo, ['不要删除现有文件'])
    assert.deepEqual(checkpoint.task.allowedPaths, ['src/**'])
    assert.deepEqual(checkpoint.task.forbiddenPaths, ['docs/**'])

    // repo checkpoint
    assert.strictEqual(checkpoint.repo.repoPath, repoPath)
    assert.strictEqual(checkpoint.repo.branch, 'feat/test', 'branch must be feat/test')
    assert.strictEqual(checkpoint.repo.headSha, beforeHead, 'HEAD must match')
    assert.strictEqual(checkpoint.repo.headSha.length, 40, 'HEAD SHA must be 40 chars')
    assert.ok(checkpoint.repo.changedFiles.includes('src/feature.ts'), 'tracked modified must be captured')
    assert.ok(checkpoint.repo.changedFiles.includes('src/untracked-notes.md'), 'untracked file must be captured')
    assert.strictEqual(checkpoint.repo.worktreeFingerprint.length, 64, 'fingerprint must be SHA-256 hex')

    // ===== 只读证明 =====
    assert.deepEqual(
      recording.commands,
      READ_ONLY_ADOPTION_COMMANDS,
      'adoption must issue exactly the 3 read-only git commands',
    )
    const destructive = recording.commands.filter((cmd) => DESTRUCTIVE_GIT_PATTERN.test(cmd))
    assert.deepEqual(destructive, [], 'adoption must issue NO destructive git commands')

    const afterStatus = (await gitRunner('git status --porcelain --untracked-files=all')).stdout
    assert.strictEqual(afterStatus, beforeStatus, 'git status must be identical before/after adoption')

    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('partial legacy implementation'), 'tracked file content must be unchanged')
    const notesContent = await readFile(join(repoPath, 'src/untracked-notes.md'), 'utf8')
    assert.ok(notesContent.includes('manual notes'), 'untracked file content must be unchanged')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
