/**
 * W004-B Safe Auto Push — 单元 + 集成测试
 *
 * 覆盖 push gate 的每一条安全不变量、远端 SHA 验证、partial success 可见性，
 * 以及 forbidden 命令证明。正例用真实 temp git repo + 本地 bare remote，绝无 GitHub 访问。
 *
 * CASE R  push happy path
 * CASE S  autoPush=false
 * CASE T  autoPush=true 但 remote policy 缺失
 * CASE U  remote URL mismatch
 * CASE V  remote non-fast-forward（runtime 级）
 * CASE W  HEAD changes after commit before push
 * CASE X  remote SHA verification mismatch
 * 另含：remote mutation safety test（forbidden 命令集合）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  finalizeCompletedTask,
  pushCheckpointCommit,
  GitCheckpointError,
  GitPushError,
  WorkSessionRuntime,
  type TaskCompletionEvidence,
  type WorkSessionDefinition,
} from 'nova-wing/development-guardian'

type CmdResult = { exitCode: number; stdout: string; stderr: string }
type GitRunner = (args: readonly string[]) => Promise<CmdResult>

const TASK = { id: 'T1', goal: '实现 feature A' }

function evidence(overrides: Partial<TaskCompletionEvidence> = {}): TaskCompletionEvidence {
  return {
    changedFiles: ['src/keep.ts'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['git diff --check'],
    ...overrides,
  }
}

function completedEvidence(changedFiles: readonly string[]): TaskCompletionEvidence {
  return {
    changedFiles,
    verificationResults: [{ name: 'git diff --check', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['git diff --check'],
  }
}

/** 记录所有命令；任何调用都视为失败（用于断言"零 git 调用"的负例） */
function zeroCallRunner(): { run: GitRunner; commands: string[][] } {
  const commands: string[][] = []
  const run: GitRunner = async (args) => {
    commands.push([...args])
    throw new Error(`git must not be invoked: ${args.join(' ')}`)
  }
  return { run, commands }
}

/** 记录所有命令，按 subcommand 分发脚本化结果 */
function scriptedRunner(
  handlers: Record<string, (args: readonly string[]) => CmdResult>,
): { run: GitRunner; commands: string[][] } {
  const commands: string[][] = []
  const run: GitRunner = async (args) => {
    commands.push([...args])
    const handler = handlers[args[0] ?? '']
    if (handler === undefined) {
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    }
    return handler(args)
  }
  return { run, commands }
}

async function runGit(repoPath: string, args: readonly string[]): Promise<CmdResult> {
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
  await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "old"\n')
  await gitOk(repoPath, ['add', 'README.md', 'src/keep.ts'])
  await gitOk(repoPath, ['commit', '-m', 'Initial commit'])
  await gitOk(repoPath, ['checkout', '-b', 'feat/test'])
  return { repoPath }
}

/** 创建本地 bare remote 并 add 为 origin；返回实际 remote URL（供精确匹配） */
async function setupBareRemote(baseDir: string, repoPath: string): Promise<{ remoteUrl: string }> {
  const remotePath = join(baseDir, 'remote.git')
  const initResult = await runGit(baseDir, ['init', '--bare', remotePath])
  assert.equal(initResult.exitCode, 0, `git init --bare failed: ${initResult.stderr}`)
  await gitOk(repoPath, ['remote', 'add', 'origin', remotePath])
  const remoteUrl = (await gitOk(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim()
  return { remoteUrl }
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

async function cleanupTemp(tempBase: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200))
  let retries = 3
  while (retries > 0) {
    try {
      await rm(tempBase, { recursive: true, force: true })
      break
    } catch {
      retries--
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

// ============ CASE R: push happy path（finalizer 级） ============

await test('W004-B CASE R: push happy path — commit + push + remote SHA verified', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-r-'))
  const { repoPath } = await setupRepo(tempBase)
  try {
    const { remoteUrl } = await setupBareRemote(tempBase, repoPath)
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')

    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: { autoCommit: true, autoPush: true, pushRemote: { name: 'origin', expectedUrl: remoteUrl } },
    })

    assert.equal(result.commitSha.length, 40, 'commit SHA must be 40 chars')
    assert.equal(result.pushSha, result.commitSha, 'pushSha must equal commitSha')

    const remoteHead = (await gitOk(repoPath, ['ls-remote', '--heads', 'origin', 'refs/heads/feat/test'])).stdout.trim()
    const remoteSha = remoteHead.split(/\s+/u)[0]
    assert.equal(remoteSha, result.commitSha, 'remote branch SHA must equal commit SHA')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE S: autoPush=false ============

await test('W004-B CASE S: autoPush=false — commit only, zero push', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-s-'))
  const { repoPath } = await setupRepo(tempBase)
  try {
    const commands: string[][] = []
    const recordingRunner: GitRunner = async (args) => {
      commands.push([...args])
      return runGit(repoPath, args)
    }

    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')
    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: { autoCommit: true, autoPush: false },
      commandRunner: recordingRunner,
    })

    assert.equal(result.commitSha.length, 40, 'commit must happen')
    assert.equal(result.pushSha, undefined, 'no pushSha when autoPush=false')
    assert.ok(!commands.some((c) => c[0] === 'push'), 'zero push commands')
    assert.ok(!commands.some((c) => c[0] === 'ls-remote'), 'zero ls-remote commands')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE T: autoPush=true but remote policy missing ============

await test('W004-B CASE T: autoPush=true but remote policy missing → fail closed, zero git calls', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: { autoCommit: true, autoPush: true },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0, 'no git mutation when remote policy missing')
})

// ============ CASE U: remote URL mismatch ============

await test('W004-B CASE U: remote URL mismatch → NO push, local commit preserved', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-u-'))
  const { repoPath } = await setupRepo(tempBase)
  try {
    await setupBareRemote(tempBase, repoPath)
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')

    let caught: unknown
    try {
      await finalizeCompletedTask({
        repoPath,
        expectedBranch: 'feat/test',
        task: TASK,
        completionEvidence: evidence(),
        policy: {
          autoCommit: true,
          autoPush: true,
          pushRemote: { name: 'origin', expectedUrl: 'file:///C:/definitely/not/the/right/url.git' },
        },
      })
      assert.fail('must reject on URL mismatch')
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof GitPushError, 'must be GitPushError (local commit succeeded)')
    assert.equal((caught as GitPushError).commitSha.length, 40, 'local commit SHA preserved')

    // 远端分支不得存在（no push）
    const remoteHead = (await gitOk(repoPath, ['ls-remote', '--heads', 'origin', 'refs/heads/feat/test'])).stdout.trim()
    assert.equal(remoteHead, '', 'remote branch must NOT exist (no push)')
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE W: HEAD changes after commit before push ============

await test('W004-B CASE W: HEAD changed after commit before push → NO push', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    'rev-parse': () => ({ exitCode: 0, stdout: 'DIFFERENT-SHA\n', stderr: '' }),
    remote: () => ({ exitCode: 0, stdout: 'https://example.com/origin.git\n', stderr: '' }),
  })
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'COMMITTED-SHA',
      remote: { name: 'origin', expectedUrl: 'https://example.com/origin.git' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.ok(!commands.some((c) => c[0] === 'push'), 'no push on HEAD mismatch')
})

// ============ CASE X: remote SHA verification mismatch ============

await test('W004-B CASE X: ls-remote mismatch → fail closed, no force retry', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    'rev-parse': () => ({ exitCode: 0, stdout: 'COMMITTED-SHA\n', stderr: '' }),
    remote: () => ({ exitCode: 0, stdout: 'https://example.com/origin.git\n', stderr: '' }),
    push: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    'ls-remote': () => ({ exitCode: 0, stdout: 'DIFFERENT-SHA\trefs/heads/feat/test\n', stderr: '' }),
  })
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'COMMITTED-SHA',
      remote: { name: 'origin', expectedUrl: 'https://example.com/origin.git' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  const pushCmds = commands.filter((c) => c[0] === 'push')
  assert.equal(pushCmds.length, 1, 'exactly one push, no retry')
  assert.deepEqual(pushCmds[0], ['push', '--porcelain', 'origin', 'COMMITTED-SHA:refs/heads/feat/test'])
  assert.ok(!(pushCmds[0] ?? []).includes('--force'), 'no force flag')
})

// ============ fetch url trusted + pushurl evil → NO PUSH ============

await test('W004-B push: trusted fetch URL + evil pushurl → NO PUSH', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    'rev-parse': () => ({ exitCode: 0, stdout: 'COMMITTED-SHA\n', stderr: '' }),
    remote: () => ({ exitCode: 0, stdout: 'https://evil.example.com/malicious.git\n', stderr: '' }),
  })
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'COMMITTED-SHA',
      remote: { name: 'origin', expectedUrl: 'https://trusted.example.com/real.git' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.ok(
    !commands.some((c) => c[0] === 'push'),
    'no push when pushurl differs from trusted expectedUrl',
  )
})

// ============ multiple pushurl → NO PUSH ============

await test('W004-B push: multiple pushurls → NO PUSH', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    'rev-parse': () => ({ exitCode: 0, stdout: 'COMMITTED-SHA\n', stderr: '' }),
    remote: () => ({
      exitCode: 0,
      stdout: 'https://one.example.com/a.git\nhttps://two.example.com/b.git\n',
      stderr: '',
    }),
  })
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'COMMITTED-SHA',
      remote: { name: 'origin', expectedUrl: 'https://one.example.com/a.git' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.ok(!commands.some((c) => c[0] === 'push'), 'no push with multiple pushurls')
})

// ============ TOCTOU regression：push source 绑定 immutable commitSha ============

await test('W004-B TOCTOU: push source is immutable commitSha, not HEAD', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    'rev-parse': () => ({ exitCode: 0, stdout: 'COMMITTED-SHA\n', stderr: '' }),
    remote: () => ({ exitCode: 0, stdout: 'https://trusted.example.com/real.git\n', stderr: '' }),
    push: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    'ls-remote': () => ({ exitCode: 0, stdout: 'COMMITTED-SHA\trefs/heads/feat/test\n', stderr: '' }),
  })
  const result = await pushCheckpointCommit({
    repoPath: '/tmp/repo',
    expectedBranch: 'feat/test',
    commitSha: 'COMMITTED-SHA',
    remote: { name: 'origin', expectedUrl: 'https://trusted.example.com/real.git' },
    commandRunner: run,
  })
  assert.equal(result.pushSha, 'COMMITTED-SHA')

  const pushCmd = commands.find((c) => c[0] === 'push')
  assert.deepEqual(pushCmd, ['push', '--porcelain', 'origin', 'COMMITTED-SHA:refs/heads/feat/test'])
  assert.ok(!(pushCmd ?? []).includes('HEAD'), 'push refspec must NOT use HEAD (TOCTOU-safe)')
})

// ============ push gate 负例 ============

await test('W004-B push: missing remote name → fail closed, zero git calls', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'SHA',
      remote: { name: '', expectedUrl: 'https://x' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

await test('W004-B push: missing remote expectedUrl → fail closed, zero git calls', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    pushCheckpointCommit({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      commitSha: 'SHA',
      remote: { name: 'origin', expectedUrl: '' },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

await test('W004-B push: protected branch → fail closed, zero git calls', async () => {
  for (const branch of ['main', 'master']) {
    const { run, commands } = zeroCallRunner()
    await assert.rejects(
      pushCheckpointCommit({
        repoPath: '/tmp/repo',
        expectedBranch: branch,
        commitSha: 'SHA',
        remote: { name: 'origin', expectedUrl: 'https://x' },
        commandRunner: run,
      }),
      GitCheckpointError,
      `branch ${branch} must fail closed`,
    )
    assert.equal(commands.length, 0)
  }
})

// ============ Remote mutation safety test（section 24） ============

await test('W004-B safety: push uses only allowed git commands, no forbidden flags', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-safety-'))
  const { repoPath } = await setupRepo(tempBase)
  try {
    const { remoteUrl } = await setupBareRemote(tempBase, repoPath)
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')

    const commands: string[][] = []
    const recordingRunner: GitRunner = async (args) => {
      commands.push([...args])
      return runGit(repoPath, args)
    }

    await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: { autoCommit: true, autoPush: true, pushRemote: { name: 'origin', expectedUrl: remoteUrl } },
      commandRunner: recordingRunner,
    })

    const forbiddenSubcommands = new Set([
      'reset', 'clean', 'restore', 'checkout', 'rebase', 'merge', 'tag', 'rm', 'mv', 'stash',
    ])
    // 全局 destructive flags（任何 git 命令都不得出现）
    const forbiddenGlobalFlags = new Set(['-A', '--force', '-f', '-D', '--force-with-lease'])
    // push 专属 forbidden flags（--all / --tags / --delete 只在 push 语境危险；
    // remote get-url --push --all 的 --all 是合法只读标志）
    const forbiddenPushFlags = new Set(['--all', '--tags', '--delete'])
    const allowedSubcommands = new Set([
      'branch', 'status', 'diff', 'add', 'commit', 'rev-parse', 'remote', 'push', 'ls-remote',
    ])

    for (const args of commands) {
      const sub = args[0] ?? ''
      assert.ok(allowedSubcommands.has(sub), `unexpected subcommand: ${args.join(' ')}`)
      assert.ok(!forbiddenSubcommands.has(sub), `forbidden subcommand ${sub}`)
      for (const token of args) {
        assert.ok(!forbiddenGlobalFlags.has(token), `forbidden flag ${token} in: ${args.join(' ')}`)
        if (sub === 'push') {
          assert.ok(!forbiddenPushFlags.has(token), `forbidden push flag ${token} in: ${args.join(' ')}`)
        }
      }
    }

    const pushCmd = commands.find((c) => c[0] === 'push')
    assert.deepEqual(pushCmd?.slice(0, 3), ['push', '--porcelain', 'origin'])
    const refspec = pushCmd?.[3] ?? ''
    assert.ok(
      /^[0-9a-f]{40}:refs\/heads\/feat\/test$/.test(refspec),
      `push refspec must be <commitSha>:refs/heads/feat/test, got ${refspec}`,
    )
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE R runtime: durable checkpointPushes ============

await test('W004-B CASE R runtime: checkpointCommits.T1 = checkpointPushes.T1 = remote SHA', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-r-rt-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const { remoteUrl } = await setupBareRemote(tempBase, repoPath)

    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }) {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
        return { status: 'COMPLETED' as const, summary: 'T1 done', completionEvidence: completedEvidence(['src/t1.ts']) }
      },
    }

    const definition = makeDefinition('w004b-r-rt', repoPath, [{ id: 'T1', goal: '实现任务 1' }])
    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: { autoCommit: true, autoPush: true, pushRemote: { name: 'origin', expectedUrl: remoteUrl } },
      },
    })

    const state = await runtime.start()
    await runtime.close()

    assert.equal(state.state, 'COMPLETED', 'session must complete')
    assert.deepEqual(state.completedTaskIds, ['T1'])

    const commits = state.checkpointCommits ?? {}
    const pushes = state.checkpointPushes ?? {}
    const sha = commits['T1']
    assert.ok(sha && sha.length === 40, 'checkpointCommits.T1 must be a 40-char SHA')
    assert.equal(pushes['T1'], sha, 'checkpointPushes.T1 must equal commit SHA')

    const remoteHead = (await gitOk(repoPath, ['ls-remote', '--heads', 'origin', 'refs/heads/feat/test'])).stdout.trim()
    const remoteSha = remoteHead.split(/\s+/u)[0]
    assert.equal(remoteSha, sha, 'remote branch SHA must equal checkpointed SHA')
    assert.equal(executionCounts.get('T1'), 1)
  } finally {
    await cleanupTemp(tempBase)
  }
})

// ============ CASE V runtime: non-fast-forward → FAILED, local commit preserved ============

await test('W004-B CASE V: non-fast-forward push → Session FAILED, local commit preserved, T2=0', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004b-v-'))
  const { repoPath } = await setupRepo(tempBase)
  const storageUrl = `file:${join(tempBase, 'session.db')}`
  try {
    const { remoteUrl } = await setupBareRemote(tempBase, repoPath)
    // push baseline 到 remote，然后改写本地 baseline 制造 divergent history。
    // 用 -m 强制改 message（而非 --no-edit），确保 SHA 必然变化：
    // 同一秒内 amend 若仅靠 committer timestamp，可能 no-op 使 divergence 消失。
    await gitOk(repoPath, ['push', 'origin', 'feat/test'])
    await gitOk(repoPath, ['commit', '--amend', '-m', 'amended baseline'])

    const executionCounts = new Map<string, number>()
    const taskRunner = {
      async run(task: { id: string; goal: string }) {
        executionCounts.set(task.id, (executionCounts.get(task.id) ?? 0) + 1)
        if (task.id === 'T1') {
          await writeFile(join(repoPath, 'src/t1.ts'), 'export const t1 = 1\n')
          return { status: 'COMPLETED' as const, completionEvidence: completedEvidence(['src/t1.ts']) }
        }
        await writeFile(join(repoPath, 'src/t2.ts'), 'export const t2 = 2\n')
        return { status: 'COMPLETED' as const, completionEvidence: completedEvidence(['src/t2.ts']) }
      },
    }

    const definition = makeDefinition('w004b-v', repoPath, [
      { id: 'T1', goal: '任务 1' },
      { id: 'T2', goal: '任务 2' },
    ])

    const runtime = new WorkSessionRuntime({
      definition,
      taskRunner,
      storageUrl,
      gitCheckpoint: {
        policy: { autoCommit: true, autoPush: true, pushRemote: { name: 'origin', expectedUrl: remoteUrl } },
      },
    })

    await assert.rejects(runtime.start(), /Git checkpoint failed/, 'non-fast-forward push must fail the session')

    const durable = runtime.getDurableState()
    await runtime.close()

    assert.equal(durable?.state, 'FAILED', 'session must be FAILED')
    assert.ok(!(durable?.completedTaskIds ?? []).includes('T1'), 'T1 must not be completed')

    const commits = durable?.checkpointCommits ?? {}
    const pushes = durable?.checkpointPushes ?? {}
    const sha = commits['T1']
    assert.ok(sha && sha.length === 40, 'local commit SHA must be preserved on push failure')
    assert.equal(pushes['T1'], undefined, 'checkpointPushes.T1 must be undefined')
    assert.equal(executionCounts.get('T2') ?? 0, 0, 'T2 must not execute')

    // local commit 未被 reset/revert：baseline(amended) + T1 = 2
    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '2', 'local commit preserved (not reset)')
  } finally {
    await cleanupTemp(tempBase)
  }
})
