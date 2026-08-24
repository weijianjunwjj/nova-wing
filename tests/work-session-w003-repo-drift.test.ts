/**
 * W003 Repository Drift Guard Test
 *
 * 证明：持久化 RepositoryCheckpoint 后，若工作区被用户/外部进程修改，
 * NovaWing 必须拒绝恢复旧 Task（fail closed）。
 * - CASE A: 同路径内容变化（content drift）→ fingerprint 必须检测
 * - CASE B: branch drift → fail closed
 * - CASE C: HEAD drift → fail closed
 * - Adapter: stopReason 'REPO_DRIFT: ...' → humanRequired.category === 'REPO_DRIFT'
 */

import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeCodeExecutor,
  type GuardianTask,
  type DelegationPacket,
} from 'nova-wing/development-guardian'
import {
  parseGitStatus,
  normalizePath,
  computeWorktreeFingerprint,
  verifyWorktreeCheckpoint,
  type GitStatusEntry,
} from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import { classifyHumanRequired } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import type { RepositoryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'
import {
  guardianShellPayload,
  guardianShellTestCommand,
  isClaudeShellRequest,
} from './guardian-shell-fixture.js'

// ============ Git Test Helper ============

/**
 * 测试专用：仅 hash status/path 的弱 fingerprint。
 * 证明 canonical computeWorktreeFingerprint 纳入内容 digest 的必要性，
 * 不暴露为 public/production API。
 */
function computeLegacyStatusOnlyFingerprintForTest(entries: GitStatusEntry[]): string {
  const normalized = entries
    .map((entry) => ({
      status: entry.status,
      path: normalizePath(entry.path),
    }))
    .sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path)
      if (pathCmp !== 0) return pathCmp
      return a.status.localeCompare(b.status)
    })

  const content = normalized
    .map((entry) => `${entry.status}|${entry.path}`)
    .join('\n')

  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function setupTestGitRepo(baseDir: string): Promise<{
  repoPath: string
  gitRunner: (cmd: string) => Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
}> {
  const repoPath = join(baseDir, 'test-repo')
  await mkdir(repoPath, { recursive: true })

  const gitRunner = async (cmd: string) => {
    const { spawn } = await import('node:child_process')
    return new Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
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
  await writeFile(join(repoPath, 'README.md'), '# Test Repo')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m "Initial commit"')

  return { repoPath, gitRunner }
}

async function captureCheckpoint(
  repoPath: string,
  gitRunner: (cmd: string) => Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>,
): Promise<RepositoryCheckpoint> {
  const branchResult = await gitRunner('git branch --show-current')
  const headResult = await gitRunner('git rev-parse HEAD')
  const statusResult = await gitRunner('git status --porcelain --untracked-files=all')

  const entries = parseGitStatus(statusResult.stdout)

  return {
    repoPath,
    branch: branchResult.stdout.trim(),
    headSha: headResult.stdout.trim(),
    changedFiles: entries.map((e) => e.path),
    worktreeFingerprint: await computeWorktreeFingerprint(repoPath, entries),
  }
}

// ============ 第 1 层：Fingerprint Unit Test ============

await test('W003 Repo Drift Unit: fingerprint must change when content changes at same path (CASE A)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-drift-unit-'))
  try {
    const repoPath = join(tempBase, 'repo')
    await mkdir(join(repoPath, 'src'), { recursive: true })
    const entries = [{ status: ' M', path: 'src/feature.ts' }]

    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1')
    const fingerprintA = await computeWorktreeFingerprint(repoPath, entries)

    // 稳定：相同内容重复计算 → 相同 fingerprint
    const fingerprintA2 = await computeWorktreeFingerprint(repoPath, entries)
    assert.strictEqual(fingerprintA, fingerprintA2, 'Same content must be stable')

    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2\n// changed')
    const fingerprintB = await computeWorktreeFingerprint(repoPath, entries)

    assert.notStrictEqual(fingerprintA, fingerprintB, 'Content change at same path must produce a different fingerprint')
    assert.strictEqual(fingerprintA.length, 64, 'Must be SHA-256 hex (64 chars)')
    assert.strictEqual(fingerprintB.length, 64, 'Must be SHA-256 hex (64 chars)')

    // 证明必要性：弱指纹（仅 status/path）无法检测内容变化
    const fileOnlyA = computeLegacyStatusOnlyFingerprintForTest(entries)
    const fileOnlyB = computeLegacyStatusOnlyFingerprintForTest(entries)
    assert.strictEqual(fileOnlyA, fileOnlyB, 'Weak status/path-only fingerprint must NOT detect content change (why content digest is required)')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W003 Repo Drift Unit: untracked dependency dirs skipped, tracked changes always counted', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-drift-skip-'))
  try {
    const repoPath = join(tempBase, 'repo')
    await mkdir(join(repoPath, 'node_modules', 'lib'), { recursive: true })
    await mkdir(join(repoPath, 'src'), { recursive: true })

    // untracked node_modules 内容变化不改变 fingerprint（避免扫描依赖树）
    const untrackedEntries = [{ status: '??', path: 'node_modules/lib/x.js' }]
    await writeFile(join(repoPath, 'node_modules/lib/x.js'), 'v1')
    const fp1 = await computeWorktreeFingerprint(repoPath, untrackedEntries)
    await writeFile(join(repoPath, 'node_modules/lib/x.js'), 'v2 changed')
    const fp2 = await computeWorktreeFingerprint(repoPath, untrackedEntries)
    assert.strictEqual(fp1, fp2, 'Untracked dependency dir content must not change fingerprint')

    // tracked 修改必须纳入内容 digest
    const trackedEntries = [{ status: ' M', path: 'src/feature.ts' }]
    await writeFile(join(repoPath, 'src/feature.ts'), 'tracked v1')
    const t1 = await computeWorktreeFingerprint(repoPath, trackedEntries)
    await writeFile(join(repoPath, 'src/feature.ts'), 'tracked v2')
    const t2 = await computeWorktreeFingerprint(repoPath, trackedEntries)
    assert.notStrictEqual(t1, t2, 'Tracked content change must change fingerprint')

    // deleted 文件使用占位，稳定且区别于存在的内容
    const deletedEntries = [{ status: ' D', path: 'src/feature.ts' }]
    const d1 = await computeWorktreeFingerprint(repoPath, deletedEntries)
    const d2 = await computeWorktreeFingerprint(repoPath, deletedEntries)
    assert.strictEqual(d1, d2, 'Deleted placeholder must be stable')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ 第 2 层：CASE A / B / C Verify Integration ============

await test('W003 Repo Drift: verifyWorktreeCheckpoint fails closed on content/branch/HEAD drift', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-drift-verify-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // 初始 commit src/feature.ts，作为内容 drift 的基准
    await mkdir(join(repoPath, 'src'), { recursive: true })
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1')
    await gitRunner('git add src/feature.ts && git commit -m "add feature"')

    // ===== CASE A: content drift（同路径内容变化）=====
    const checkpointA = await captureCheckpoint(repoPath, gitRunner)
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 999 // external edit')
    const statusA = await gitRunner('git status --porcelain --untracked-files=all')
    const resultA = await verifyWorktreeCheckpoint(
      checkpointA,
      checkpointA.branch,
      checkpointA.headSha,
      repoPath,
      parseGitStatus(statusA.stdout),
    )
    assert.strictEqual(resultA.matches, false, 'Content drift must fail closed')
    assert.ok(resultA.reason?.includes('worktree files changed'), `Expected worktree drift reason, got: ${resultA.reason}`)

    // 恢复 clean，为后续 CASE 准备
    await gitRunner('git checkout -- src/feature.ts')

    // ===== CASE B: branch drift（feat/test → feat/other）=====
    const checkpointB = await captureCheckpoint(repoPath, gitRunner)
    await gitRunner('git switch -c feat/other')
    const statusB = await gitRunner('git status --porcelain --untracked-files=all')
    const resultB = await verifyWorktreeCheckpoint(
      checkpointB,
      'feat/other',
      checkpointB.headSha,
      repoPath,
      parseGitStatus(statusB.stdout),
    )
    assert.strictEqual(resultB.matches, false, 'Branch drift must fail closed')
    assert.ok(resultB.reason?.includes('branch mismatch'), `Expected branch mismatch reason, got: ${resultB.reason}`)
    await gitRunner('git switch main')

    // ===== CASE C: HEAD drift（额外 commit）=====
    const checkpointC = await captureCheckpoint(repoPath, gitRunner)
    await writeFile(join(repoPath, 'new-file.txt'), 'extra commit content')
    await gitRunner('git add new-file.txt && git commit -m "extra commit"')
    const headAfter = (await gitRunner('git rev-parse HEAD')).stdout.trim()
    assert.notStrictEqual(checkpointC.headSha, headAfter, 'HEAD must have moved')
    const statusC = await gitRunner('git status --porcelain --untracked-files=all')
    const resultC = await verifyWorktreeCheckpoint(
      checkpointC,
      checkpointC.branch,
      headAfter,
      repoPath,
      parseGitStatus(statusC.stdout),
    )
    assert.strictEqual(resultC.matches, false, 'HEAD drift must fail closed')
    assert.ok(resultC.reason?.includes('HEAD mismatch'), `Expected HEAD mismatch reason, got: ${resultC.reason}`)

    // 未 drift 时验证必须通过
    const checkpointOk = await captureCheckpoint(repoPath, gitRunner)
    const statusOk = await gitRunner('git status --porcelain --untracked-files=all')
    const resultOk = await verifyWorktreeCheckpoint(
      checkpointOk,
      checkpointOk.branch,
      checkpointOk.headSha,
      repoPath,
      parseGitStatus(statusOk.stdout),
    )
    assert.strictEqual(resultOk.matches, true, 'Identical state must verify clean')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ 第 3 层：Executor Fail-Closed Integration ============

await test('W003 Repo Drift: executor rejects content drift after checkpoint, zero Claude invocation', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-drift-executor-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    await mkdir(join(repoPath, 'src'), { recursive: true })
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1')
    await gitRunner('git add src/feature.ts && git commit -m "add feature"')

    // 捕获 checkpoint（clean 状态）
    const checkpoint = await captureCheckpoint(repoPath, gitRunner)

    // checkpoint 之后，用户/外部进程修改工作区
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // edited after checkpoint')

    let claudeInvocationCount = 0
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        if (isClaudeShellRequest(req)) {
          claudeInvocationCount++
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ type: 'success', result: 'Should not execute' }),
            stderr: '',
          }
        }
        const command = guardianShellPayload(req)
        if (command !== undefined) {
          return gitRunner(command)
        }
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    executor.setRecoveryCheckpoint(checkpoint)

    const task: GuardianTask = {
      id: 'T1',
      goal: 'Test content drift',
      iteration: 1,
      state: 'READY',
      maxIterations: 3,
    }
    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'Test task',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report = await executor.execute({ task, packet })

    // fail closed：必须阻塞，不恢复旧 Task
    assert.ok(report.blockers.length >= 1, 'Must have at least one blocker')
    assert.ok(
      report.blockers.some((b) => b.includes('REPO_DRIFT')),
      `Must have REPO_DRIFT blocker, got: ${report.blockers.join(', ')}`,
    )
    assert.strictEqual(claudeInvocationCount, 0, 'Claude invocation must be 0 (fail closed before any recovery)')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Adapter Mapping ============

await test('W003 Repo Drift Adapter: REPO_DRIFT stopReason maps to humanRequired.category', async () => {
  const baseTask = {
    goal: 'Test drift',
    iteration: 1,
    state: 'READY' as const,
    maxIterations: 3,
  }

  const driftReasons = [
    'REPO_DRIFT: branch changed from main to feat/other',
    'REPO_DRIFT: HEAD changed from abc123 to def456',
    'REPO_DRIFT: worktree files changed since checkpoint',
  ]

  for (const reason of driftReasons) {
    const task: GuardianTask = { ...baseTask, id: `drift-${driftReasons.indexOf(reason)}`, stopReason: reason }
    const humanRequired = classifyHumanRequired(task)
    assert.strictEqual(
      humanRequired.category,
      'REPO_DRIFT',
      `stopReason "${reason}" must map to REPO_DRIFT, got ${humanRequired.category}`,
    )
  }
})
