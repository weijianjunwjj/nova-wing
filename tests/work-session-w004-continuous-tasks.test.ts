/**
 * W004-A Continuous Tasks — WorkSessionRuntime 集成测试
 *
 * 用真实 temp git repo + 真实 finalizeCompletedTask（内置 default runner）
 * 验证：真 COMPLETED → safe commit → SHA 持久化 → 下一 Task 才启动。
 *
 * CASE A: Happy path continuous tasks（T1→SHA1→T2→SHA2）
 * CASE B: HUMAN_REQUIRED（0 commit，T2 不执行）
 * CASE C: FAILED（0 commit，T2 不执行）
 * CASE K: Durable restart retains SHA（T1 不重跑，SHA1 保留，T2 正常执行）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
  type WorkSessionTaskResult,
  type TaskCompletionEvidence,
} from '../packages/development-guardian/work-session/index.js'

type CmdResult = { exitCode: number; stdout: string; stderr: string }

function completedEvidence(changedFiles: readonly string[]): TaskCompletionEvidence {
  return {
    changedFiles,
    verificationResults: [{ name: 'git diff --check', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['git diff --check'],
  }
}

async function runGit(repoPath: string, args: readonly string[]): Promise<CmdResult> {
  const { spawn } = await import('node:child_process')
  return new Promise<CmdResult>((resolve) => {
    const child = spawn('git', [...args], {
      cwd: repoPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }))
  })
}

async function gitOk(repoPath: string, args: readonly string[]): Promise<CmdResult> {
  const result = await runGit(repoPath, args)
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

async function setupRepo(baseDir: string): Promise<{ repoPath: string }> {
  const repoPath = join(baseDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await gitOk(repoPath, ['init'])
  await gitOk(repoPath, ['config', 'user.email', 'test@example.com'])
  await gitOk(repoPath, ['config', 'user.name', 'Test User'])
  await gitOk(repoPath, ['config', 'core.autocrlf', 'false'])
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'README.md'), '# Baseline\n')
  await gitOk(repoPath, ['add', 'README.md'])
  await gitOk(repoPath, ['commit', '-m', 'Initial commit'])
  await gitOk(repoPath, ['checkout', '-b', 'feat/test'])
  return { repoPath }
}

async function cleanupTemp(tempBase: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
  let retries = 3
  while (retries > 0) {
    try {
      await rm(tempBase, { recursive: true, force: true })
      break
    } catch (error) {
      if (retries === 1) {
        console.warn(`failed to cleanup ${tempBase}:`, error)
      }
      retries--
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

function makeDefinition(id: string, repoPath: string, tasks: WorkSessionDefinition['tasks']): WorkSessionDefinition {
  return {
    id,
    targetRepo: repoPath,
    branch: 'feat/test',
    tasks,
    limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
  }
}

// ============ CASE A: Happy path continuous tasks ============

await test('W004 CASE A: T1→commit SHA1→T2→commit SHA2, serial boundaries', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-a-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          return { status: 'COMPLETED', summary: 'T1 done', completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        if (task.id === 'T2') {
          await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
          return { status: 'COMPLETED', summary: 'T2 done', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-a', repoPath, [
      { id: 'T1', goal: '实现任务 1' },
      { id: 'T2', goal: '实现任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })

    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED', 'session must complete')
    assert.deepEqual(state.completedTaskIds, ['T1', 'T2'], 'both tasks completed')
    assert.equal(executionCounts.get('T1'), 1, 'T1 runs once')
    assert.equal(executionCounts.get('T2'), 1, 'T2 runs once')

    // checkpointCommits 持久化两个 SHA，且互不相同
    const commits = state.checkpointCommits ?? {}
    const sha1 = commits['T1']
    const sha2 = commits['T2']
    assert.ok(sha1 && sha1.length === 40, 'T1 SHA must be persisted')
    assert.ok(sha2 && sha2.length === 40, 'T2 SHA must be persisted')
    assert.notEqual(sha1, sha2, 'T1 and T2 must have distinct SHAs')

    // git log 顺序正确：baseline → T1 → T2
    const log = (await gitOk(repoPath, ['log', '--format=%s'])).stdout
      .split(/\r?\n/u).filter(Boolean)
    assert.deepEqual(log, ['完成 T2: 实现任务 2', '完成 T1: 实现任务 1', 'Initial commit'])

    // SHA 与 git 实际一致
    const headHashes = (await gitOk(repoPath, ['log', '--format=%H'])).stdout
      .split(/\r?\n/u).filter(Boolean)
    assert.equal(headHashes[0], sha2, 'latest commit must be T2 SHA')
    assert.equal(headHashes[1], sha1, 'previous commit must be T1 SHA')

    // 提交后 worktree 干净
    const status = (await gitOk(repoPath, ['status', '--porcelain', '--untracked-files=all'])).stdout
    assert.equal(status.trim(), '', 'worktree must be clean after both commits')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE B: HUMAN_REQUIRED ============

await test('W004 CASE B: T1 HUMAN_REQUIRED -> 0 commit, T2 never runs', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-b-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    let finalizerCalls = 0
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          return {
            status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose db mode' },
          }
        }
        if (task.id === 'T2') {
          await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-b', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: { autoCommit: true, autoPush: false },
        finalizer: async () => {
          finalizerCalls += 1
          return { commitSha: 'x'.repeat(40), committedFiles: [] }
        },
      },
    })

    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'SUSPENDED', 'session must suspend')
    assert.deepEqual(state.completedTaskIds, [], 'no task completed')
    assert.equal(state.currentTaskId, 'T1')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')
    assert.equal(finalizerCalls, 0, 'finalizer must not be called (no commit)')

    // 无 commit 发生
    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '1', 'no new commit on HUMAN_REQUIRED')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE C: FAILED ============

await test('W004 CASE C: T1 FAILED -> 0 commit, T2 never runs, session FAILED', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-c-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    let finalizerCalls = 0
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          return { status: 'FAILED', error: 'simulated failure' }
        }
        if (task.id === 'T2') {
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-c', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: { autoCommit: true, autoPush: false },
        finalizer: async () => {
          finalizerCalls += 1
          return { commitSha: 'x'.repeat(40), committedFiles: [] }
        },
      },
    })

    await assert.rejects(runtime.start(), /failed/, 'FAILED task must throw')
    await runtime.close()

    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')
    assert.equal(finalizerCalls, 0, 'finalizer must not be called (no commit)')

    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '1', 'no new commit on FAILED')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE L: Missing evidence with autoCommit=true ============

await test('W004 CASE L: autoCommit=true + missing evidence -> Session FAILED, 0 commit', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-l-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    let finalizerCalls = 0
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          // 真 COMPLETED 但缺失 completion evidence
          return { status: 'COMPLETED', summary: 'T1 done' }
        }
        if (task.id === 'T2') {
          await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-l', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: { autoCommit: true, autoPush: false },
        finalizer: async () => {
          finalizerCalls += 1
          return { commitSha: 'x'.repeat(40), committedFiles: [] }
        },
      },
    })

    await assert.rejects(runtime.start(), /missing completion evidence/, 'must fail closed on missing evidence')

    const snapshot = await runtime.verifySnapshot()
    assert.equal(snapshot.status, 'failed', 'session must be FAILED')
    await runtime.close()

    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')
    assert.equal(finalizerCalls, 0, 'finalizer must not be called (no commit)')

    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '1', 'no new commit on missing evidence')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE K: Durable restart retains SHA ============

await test('W004 CASE K: durable restart retains T1 SHA, T1 not rerun, T2 executes', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-k-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    let t2Mode: 'HUMAN_REQUIRED' | 'COMPLETED' = 'HUMAN_REQUIRED'

    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          return { status: 'COMPLETED', summary: 'T1 done', completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        if (task.id === 'T2') {
          if (t2Mode === 'HUMAN_REQUIRED') {
            return {
              status: 'HUMAN_REQUIRED',
              humanRequired: { category: 'DECISION_REQUIRED', reason: 'choose db mode' },
            }
          }
          await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
          return { status: 'COMPLETED', summary: 'T2 done', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-k', repoPath, [
      { id: 'T1', goal: '实现任务 1' },
      { id: 'T2', goal: '实现任务 2' },
    ])

    // ===== 第一段 runtime：T1 完成 + commit，T2 HUMAN_REQUIRED → suspend =====
    const runtime1 = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })
    const state1 = await runtime1.start()
    assert.equal(state1.state, 'SUSPENDED', 'first runtime must suspend at T2')
    assert.deepEqual(state1.completedTaskIds, ['T1'])
    const sha1 = (state1.checkpointCommits ?? {})['T1']
    assert.ok(sha1 && sha1.length === 40, 'T1 SHA must be persisted on suspend')
    await runtime1.close()

    // git 只有 baseline + T1 两个 commit
    const countAfterT1 = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(countAfterT1, '2', 'baseline + T1 commit')

    // ===== 第二段 runtime：同 DB，resume → T2 完成 =====
    t2Mode = 'COMPLETED'
    const runtime2 = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })
    const state2 = await runtime2.resume({ decision: 'docker' })
    await runtime2.close()

    assert.equal(state2.state, 'COMPLETED', 'resume must complete session')
    assert.deepEqual(state2.completedTaskIds, ['T1', 'T2'])

    const commits2 = state2.checkpointCommits ?? {}
    assert.equal(commits2['T1'], sha1, 'T1 SHA must be retained across restart')
    const sha2 = commits2['T2']
    assert.ok(sha2 && sha2.length === 40, 'T2 SHA must be persisted')
    assert.notEqual(sha1, sha2, 'T1 and T2 SHAs must differ')

    // T1 不重跑（共享 runner，跨两段 runtime 累计只执行 1 次）
    assert.equal(executionCounts.get('T1'), 1, 'T1 must not rerun after restart')

    // git log 顺序：baseline → T1 → T2
    const log = (await gitOk(repoPath, ['log', '--format=%s'])).stdout
      .split(/\r?\n/u).filter(Boolean)
    assert.deepEqual(log, ['完成 T2: 实现任务 2', '完成 T1: 实现任务 1', 'Initial commit'])
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE O: Checkpoint failure durable state ============

await test('W004 CASE O: missing evidence persists domain FAILED + failureReason', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-o-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          // 真 COMPLETED 但缺失 evidence
          return { status: 'COMPLETED', summary: 'T1 done' }
        }
        if (task.id === 'T2') {
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-o', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })

    await assert.rejects(runtime.start(), /missing completion evidence/, 'must fail closed on missing evidence')

    const snapshot = await runtime.verifySnapshot()
    const durable = runtime.getDurableState()
    await runtime.close()

    assert.equal(snapshot.status, 'failed', 'Mastra run status must be failed')
    assert.ok(durable, 'durable state must be readable')
    assert.equal(durable?.state, 'FAILED', 'domain state must be FAILED')
    assert.ok(
      (durable?.failureReason ?? '').includes('completed task T1 missing completion evidence'),
      'failureReason must name missing evidence',
    )
    assert.ok(!(durable?.completedTaskIds ?? []).includes('T1'), 'T1 must not be in completedTaskIds')
    assert.equal(durable?.checkpointCommits?.['T1'], undefined, 'checkpointCommits.T1 must be undefined')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')
  } finally {
    await cleanupTemp(tempBase)
  }
})

await test('W004 CASE O: GitCheckpointError (pre-staged) persists domain FAILED + failureReason', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-o-pre-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          // 预先 stage deliverable，触发 finalizer 的 pre-staged gate（真实 GitCheckpointError）
          await gitOk(repoPath, ['add', 'src/t1.ts'])
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        if (task.id === 'T2') {
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-o-pre', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })

    await assert.rejects(runtime.start(), /pre-staged/, 'must fail closed on pre-staged changes')

    const durable = runtime.getDurableState()
    await runtime.close()

    assert.equal(durable?.state, 'FAILED', 'domain state must be FAILED')
    assert.ok((durable?.failureReason ?? '').includes('pre-staged'), 'failureReason must name pre-staged')
    assert.ok(!(durable?.completedTaskIds ?? []).includes('T1'), 'T1 must not be completed')
    assert.equal(durable?.checkpointCommits?.['T1'], undefined, 'checkpointCommits.T1 must be undefined')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')

    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '1', 'no commit on pre-staged failure')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE P: HEAD drift during task ============

await test('W004 CASE P: HEAD drift during task -> fail closed, external commit preserved', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-p-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          // 模拟 task 期间外部 unrelated commit → HEAD 漂移
          await writeFile(join(repoPath, 'external.txt'), 'external mutation\n')
          await gitOk(repoPath, ['add', 'external.txt'])
          await gitOk(repoPath, ['commit', '-m', 'external unrelated commit'])
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        if (task.id === 'T2') {
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-p', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })

    await assert.rejects(runtime.start(), /HEAD changed/, 'must fail closed on HEAD drift')

    const durable = runtime.getDurableState()
    await runtime.close()

    assert.equal(durable?.state, 'FAILED', 'domain state must be FAILED')
    assert.ok((durable?.failureReason ?? '').includes('HEAD changed'), 'failureReason must name HEAD changed')
    assert.ok(!(durable?.completedTaskIds ?? []).includes('T1'), 'T1 must not be completed')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')

    // 外部 commit 被保留，未 reset/revert
    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '2', 'baseline + external commit preserved')
    const subject = (await gitOk(repoPath, ['log', '-1', '--format=%s'])).stdout.trim()
    assert.equal(subject, 'external unrelated commit', 'external commit must remain HEAD')
    const externalExists = await access(join(repoPath, 'external.txt')).then(() => true).catch(() => false)
    assert.equal(externalExists, true, 'external commit file must remain')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE Q: Continuous HEAD chain ============

await test('W004 CASE Q: continuous HEAD chain (T1 base=SHA0, T2 base=SHA1)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-case-q-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`

  try {
    const sha0 = (await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()

    const observedHeads: string[] = []
    const taskRunner = {
      async run(task: { id: string; goal: string }): Promise<WorkSessionTaskResult> {
        observedHeads.push((await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim())
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        if (task.id === 'T2') {
          await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
          return { status: 'COMPLETED', completionEvidence: completedEvidence(['src/t2.ts']) }
        }
        throw new Error(`no behavior for ${task.id}`)
      },
    }

    const definition = makeDefinition('w004-case-q', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: { policy: { autoCommit: true, autoPush: false } },
    })

    const state = await runtime.start()
    await runtime.close()

    const commits = state.checkpointCommits ?? {}
    const sha1 = commits['T1']
    const sha2 = commits['T2']
    assert.ok(sha1 && sha2, 'both SHAs must be persisted')

    assert.notEqual(sha0, sha1, 'T1 commit must differ from initial HEAD')
    assert.notEqual(sha1, sha2, 'T2 commit must differ from T1 commit')

    // T1 开始时 HEAD = base SHA0；T2 开始时 HEAD = base SHA1（T1 commit）
    assert.equal(observedHeads[0], sha0, 'T1 base must be initial HEAD')
    assert.equal(observedHeads[1], sha1, 'T2 base must equal T1 commit SHA')
  } finally {
    await cleanupTemp(tempBase)
  }
})
