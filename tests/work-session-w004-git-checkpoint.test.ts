/**
 * W004-A Safe Git Checkpoint — finalizeCompletedTask 单元测试
 *
 * 覆盖 commit gate 的每一条安全不变量，以及精确 staging 与 forbidden 命令证明。
 * 负例用 scripted runner（不落盘真实 git），正例用真实 temp git repo。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  finalizeCompletedTask,
  GitCheckpointError,
  type TaskCompletionEvidence,
} from 'nova-wing/development-guardian'

type CmdResult = { exitCode: number; stdout: string; stderr: string }
type GitRunner = (args: readonly string[]) => Promise<CmdResult>

const TASK = { id: 'T1', goal: '实现 feature A' }

function evidence(overrides: Partial<TaskCompletionEvidence> = {}): TaskCompletionEvidence {
  return {
    changedFiles: ['src/a.ts'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }],
    blockers: [],
    finalReviewerVerdict: 'done',
    requiredVerification: ['git diff --check'],
    ...overrides,
  }
}

function autoCommitPolicy(): { autoCommit: boolean; autoPush: boolean } {
  return { autoCommit: true, autoPush: false }
}

/** 记录所有命令，并按 subcommand 分发脚本化结果；未预期的命令直接抛错 */
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

/** 记录所有命令；任何调用都视为失败（用于断言"零 git 调用"的负例） */
function zeroCallRunner(): { run: GitRunner; commands: string[][] } {
  const commands: string[][] = []
  const run: GitRunner = async (args) => {
    commands.push([...args])
    throw new Error(`git must not be invoked: ${args.join(' ')}`)
  }
  return { run, commands }
}

// ============ 真实 git helper（正例用） ============

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

async function setupRealRepo(baseDir: string): Promise<{ repoPath: string }> {
  const repoPath = join(baseDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await gitOk(repoPath, ['init'])
  await gitOk(repoPath, ['config', 'user.email', 'test@example.com'])
  await gitOk(repoPath, ['config', 'user.name', 'Test User'])
  await gitOk(repoPath, ['config', 'core.autocrlf', 'false'])
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'README.md'), '# Baseline\n')
  await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "old"\n')
  await writeFile(join(repoPath, 'src/del.ts'), 'export const del = "gone"\n')
  await gitOk(repoPath, ['add', 'README.md', 'src/keep.ts', 'src/del.ts'])
  await gitOk(repoPath, ['commit', '-m', 'Initial commit'])
  await gitOk(repoPath, ['checkout', '-b', 'feat/test'])
  return { repoPath }
}

// ============ CASE E: Reviewer not done ============

await test('W004 git-checkpoint: reviewer verdict != done -> no commit, zero git calls', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ finalReviewerVerdict: 'revise' }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0, 'no git command may run before evidence gate')
})

// ============ CASE D: Verification not passed ============

await test('W004 git-checkpoint: failed verification -> no commit', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({
        verificationResults: [{ name: 'npm test', status: 'failed' }],
      }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

await test('W004 git-checkpoint: skipped verification -> no commit', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({
        verificationResults: [{ name: 'npm test', status: 'skipped' }],
      }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

// ============ blockers 非空 ============

await test('W004 git-checkpoint: non-empty blockers -> no commit', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ blockers: ['scope violation'] }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

// ============ CASE M: Incomplete report ============

await test('W004 git-checkpoint CASE M: incompleteReason non-empty -> no commit', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ incompleteReason: 'implementation is still incomplete' }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0, 'incompleteReason must fail closed before any git command')
})

// ============ CASE N: Missing required verification ============

await test('W004 git-checkpoint CASE N: missing required verification -> no commit', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({
        requiredVerification: ['git diff --check', 'npm test'],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }],
      }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0, 'missing required verification must fail closed')
})

await test('W004 git-checkpoint CASE N positive: all required verifications passed -> commit', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-n-pos-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')

    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({
        changedFiles: ['src/keep.ts'],
        requiredVerification: ['git diff --check', 'npm test'],
        verificationResults: [
          { name: 'git diff --check', status: 'passed' },
          { name: 'npm test', status: 'passed' },
        ],
      }),
      policy: autoCommitPolicy(),
    })

    assert.equal(result.commitSha.length, 40, 'all required verifications passed must commit')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 git-checkpoint: clean verified Task is already satisfied, not a commit failure', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-no-changes-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    const before = (await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()
    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ changedFiles: [] }),
      policy: autoCommitPolicy(),
    })

    assert.equal(result.disposition, 'ALREADY_SATISFIED')
    assert.equal(result.commitSha, before)
    assert.deepEqual(result.committedFiles, [])
    assert.equal((await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim(), before)
    assert.equal((await gitOk(repoPath, ['status', '--porcelain'])).stdout, '')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ autoPush / autoCommit ============

await test('W004 git-checkpoint: autoPush=true -> fail closed (not implemented)', async () => {
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
  assert.equal(commands.length, 0)
})

await test('W004 git-checkpoint: autoCommit=false -> fail closed', async () => {
  const { run, commands } = zeroCallRunner()
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: { autoCommit: false, autoPush: false },
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.equal(commands.length, 0)
})

// ============ CASE F: Protected branch ============

await test('W004 git-checkpoint CASE F: protected branch main/master -> fail closed', async () => {
  for (const branch of ['main', 'master']) {
    const { run, commands } = zeroCallRunner()
    await assert.rejects(
      finalizeCompletedTask({
        repoPath: '/tmp/repo',
        expectedBranch: branch,
        task: TASK,
        completionEvidence: evidence(),
        policy: autoCommitPolicy(),
        commandRunner: run,
      }),
      GitCheckpointError,
      `branch ${branch} must fail closed`,
    )
    assert.equal(commands.length, 0, `branch ${branch} must not touch git`)
  }
})

// ============ CASE G: Branch drift ============

await test('W004 git-checkpoint CASE G: actual branch != definition branch -> no commit', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/other\n', stderr: '' }),
  })
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  assert.deepEqual(commands, [['branch', '--show-current']], 'must stop at branch check, never commit')
})

// ============ CASE H: Pre-staged file ============

await test('W004 git-checkpoint CASE H: pre-staged index -> fail closed, never commit', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    status: () => ({ exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }),
    diff: () => ({ exitCode: 0, stdout: 'README.md\n', stderr: '' }),
  })
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence(),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  const subcommands = commands.map((c) => c[0])
  assert.ok(!subcommands.includes('commit'), 'must not commit with pre-staged index')
  assert.ok(!subcommands.includes('add'), 'must not add with pre-staged index')
})

// ============ CASE I: Unrelated dirty file appears ============

await test('W004 git-checkpoint CASE I: unrelated dirty file -> fail closed, no destructive git', async () => {
  const { run, commands } = scriptedRunner({
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    status: () => ({ exitCode: 0, stdout: ' M src/a.ts\n M README.md\n', stderr: '' }),
  })
  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo',
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ changedFiles: ['src/a.ts'] }),
      policy: autoCommitPolicy(),
      commandRunner: run,
    }),
    GitCheckpointError,
  )
  const subcommands = commands.map((c) => c[0])
  assert.ok(!subcommands.includes('commit'), 'must not commit')
  assert.ok(!subcommands.includes('add'), 'must not stage')
  const destructive = ['reset', 'clean', 'restore', 'checkout', 'rm', 'stash']
  for (const cmd of destructive) {
    assert.ok(!subcommands.includes(cmd), `must not run destructive ${cmd}`)
  }
})

// ============ CASE J: Runtime artifact semantics（真实 git） ============

await test('W004 git-checkpoint CASE J1: untracked runtime artifacts excluded from commit', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-j1-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    // 制造 Task 变更 + untracked runtime artifacts
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')
    await mkdir(join(repoPath, '.venv'), { recursive: true })
    await mkdir(join(repoPath, 'node_modules'), { recursive: true })
    await mkdir(join(repoPath, 'dist'), { recursive: true })
    await writeFile(join(repoPath, '.venv/lib.py'), 'import os\n')
    await writeFile(join(repoPath, 'node_modules/x.js'), 'module.exports = 1\n')
    await writeFile(join(repoPath, 'dist/out.js'), 'console.log(1)\n')

    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
      policy: autoCommitPolicy(),
    })

    assert.equal(result.commitSha.length, 40, 'commit SHA must be 40 chars')
    assert.deepEqual(result.committedFiles, ['src/keep.ts'], 'only task file committed')

    // runtime artifacts 仍保持 untracked，未被 commit
    const status = (await gitOk(repoPath, ['status', '--porcelain', '--untracked-files=all'])).stdout
    assert.ok(status.includes('.venv/lib.py'), '.venv artifact must remain untracked')
    assert.ok(status.includes('node_modules/x.js'), 'node_modules artifact must remain untracked')
    assert.ok(status.includes('dist/out.js'), 'dist artifact must remain untracked')

    // 最后一次 commit 只含 src/keep.ts
    const committed = (await gitOk(repoPath, ['show', '--name-only', '--pretty=format:', 'HEAD'])).stdout
      .split(/\r?\n/u).filter(Boolean)
    assert.deepEqual(committed, ['src/keep.ts'], 'commit must contain only the task file')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 git-checkpoint CASE J2: tracked dist change is meaningful (must be in evidence)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-j2-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    // 先把 dist/tracked.js 纳入 tracked
    await mkdir(join(repoPath, 'dist'), { recursive: true })
    await writeFile(join(repoPath, 'dist/tracked.js'), 'export const v = 1\n')
    await gitOk(repoPath, ['add', 'dist/tracked.js'])
    await gitOk(repoPath, ['commit', '-m', 'add tracked dist'])
    // 修改 tracked dist 文件（meaningful tracked change）
    await writeFile(join(repoPath, 'dist/tracked.js'), 'export const v = 2\n')

    // 负例：evidence 不含 tracked dist 变更 → 该变更视为 meaningful → set mismatch → fail closed
    await assert.rejects(
      finalizeCompletedTask({
        repoPath,
        expectedBranch: 'feat/test',
        task: TASK,
        completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
        policy: autoCommitPolicy(),
      }),
      GitCheckpointError,
      'tracked dist change missing from evidence must fail closed',
    )

    // 正例：evidence 包含 tracked dist 变更 → 正常 commit
    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ changedFiles: ['dist/tracked.js'] }),
      policy: autoCommitPolicy(),
    })
    assert.equal(result.commitSha.length, 40)
    assert.deepEqual(result.committedFiles, ['dist/tracked.js'])
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Happy path：modified + new + deleted ============

await test('W004 git-checkpoint happy path: modified + new + deleted committed exactly once', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-happy-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "new"\n')
    await writeFile(join(repoPath, 'src/new.ts'), 'export const added = true\n')
    await rm(join(repoPath, 'src/del.ts'))

    const changedFiles = ['src/keep.ts', 'src/new.ts', 'src/del.ts']
    const result = await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: TASK,
      completionEvidence: evidence({ changedFiles }),
      policy: autoCommitPolicy(),
    })

    assert.equal(result.commitSha.length, 40)
    assert.deepEqual([...result.committedFiles].sort(), [...changedFiles].sort())

    // 提交后 worktree 干净
    const status = (await gitOk(repoPath, ['status', '--porcelain', '--untracked-files=all'])).stdout
    assert.equal(status.trim(), '', 'worktree must be clean after commit')

    // deterministic commit message
    const subject = (await gitOk(repoPath, ['log', '-1', '--format=%s'])).stdout.trim()
    assert.equal(subject, `${TASK.id}: ${TASK.goal}`)

    // 共 2 个 commit（baseline + task commit）
    const count = (await gitOk(repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim()
    assert.equal(count, '2', 'exactly one task commit')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 checkpoint subject uses only a concise first meaningful goal line', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-subject-'))
  const { repoPath } = await setupRealRepo(tempBase)
  const normalizedFirstLine = `Build concise checkpoint ${'x'.repeat(100)}`
  const task = {
    id: 'TASK-123',
    goal: `\n  \n  Build   concise\tcheckpoint ${'x'.repeat(100)}  \nAcceptance criteria must not appear`,
  }
  try {
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "subject"\n')
    await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task,
      completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
      policy: autoCommitPolicy(),
    })
    const subject = (await gitOk(repoPath, ['log', '-1', '--format=%s'])).stdout.trim()
    assert.equal(subject, `TASK-123: ${normalizedFirstLine.slice(0, 79)}…`)
    assert.equal(subject.includes('\n'), false)
    assert.equal(subject.includes('\r'), false)
    assert.equal(subject.includes('Acceptance criteria'), false)
    assert.equal(subject.startsWith('TASK-123: '), true)
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 checkpoint subject removes a leading repeated Task ID token', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-subject-id-leading-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "leading id"\n')
    await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: { id: 'T012', goal: 'T012: Implement baseline policy lookup' },
      completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
      policy: autoCommitPolicy(),
    })
    const subject = (await gitOk(repoPath, ['log', '-1', '--format=%s'])).stdout.trim()
    assert.equal(subject, 'T012: Implement baseline policy lookup')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 checkpoint subject removes an embedded repeated Task ID token', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-subject-id-embedded-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    await writeFile(join(repoPath, 'src/keep.ts'), 'export const keep = "embedded id"\n')
    await finalizeCompletedTask({
      repoPath,
      expectedBranch: 'feat/test',
      task: { id: 'T012', goal: '实现 Fly-Weave T012：baseline policy lookup。' },
      completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
      policy: autoCommitPolicy(),
    })
    const subject = (await gitOk(repoPath, ['log', '-1', '--format=%s'])).stdout.trim()
    assert.equal(subject, 'T012: 实现 Fly-Weave：baseline policy lookup。')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

await test('W004 git-checkpoint rollback: cached whitespace failure restores only the index', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-rollback-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
    const changed = 'export const keep = "broken"\n\n'
    await writeFile(join(repoPath, 'src/keep.ts'), changed)
    const beforeHead = (await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()

    await assert.rejects(
      finalizeCompletedTask({
        repoPath,
        expectedBranch: 'feat/test',
        task: TASK,
        completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
        policy: autoCommitPolicy(),
      }),
      /restored index to pre-checkpoint HEAD/,
    )

    assert.equal((await gitOk(repoPath, ['rev-parse', 'HEAD'])).stdout.trim(), beforeHead)
    assert.equal((await gitOk(repoPath, ['diff', '--cached', '--name-only'])).stdout.trim(), '')
    assert.equal(await (await import('node:fs/promises')).readFile(join(repoPath, 'src/keep.ts'), 'utf8'), changed)
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Finding #7 scripted rollback closure ============

const ROLLBACK_BASE_HEAD = '1111111111111111111111111111111111111111'
const CHANGED_AFTER_FAILED_COMMIT = '2222222222222222222222222222222222222222'

function rollbackGateHandlers(diff: (args: readonly string[]) => CmdResult): Record<string, (args: readonly string[]) => CmdResult> {
  return {
    branch: () => ({ exitCode: 0, stdout: 'feat/test\n', stderr: '' }),
    status: () => ({ exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }),
    add: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    diff,
    'rev-parse': () => ({ exitCode: 0, stdout: `${ROLLBACK_BASE_HEAD}\n`, stderr: '' }),
    'read-tree': () => ({ exitCode: 0, stdout: '', stderr: '' }),
  }
}

await test('W004 git-checkpoint R1: staged-set mismatch restores index before commit', async () => {
  let cachedNameCalls = 0
  const { run, commands } = scriptedRunner(rollbackGateHandlers((args) => {
    if (args.includes('--check')) return { exitCode: 0, stdout: '', stderr: '' }
    cachedNameCalls += 1
    return {
      exitCode: 0,
      stdout: cachedNameCalls === 1 ? '' : 'src/other.ts\n',
      stderr: '',
    }
  }))

  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo', expectedBranch: 'feat/test', task: TASK,
      completionEvidence: evidence(), policy: autoCommitPolicy(), commandRunner: run,
      expectedBaseHeadSha: ROLLBACK_BASE_HEAD,
    }),
    (error: unknown) => error instanceof GitCheckpointError
      && /staged files do not match/.test(error.message)
      && /restored index to pre-checkpoint HEAD/.test(error.message),
  )
  assert.ok(commands.some((args) => args.join(' ') === 'rev-parse HEAD'))
  assert.ok(commands.some((args) => args.join(' ') === 'read-tree HEAD'))
  assert.ok(!commands.some((args) => args[0] === 'commit'))
})

await test('W004 git-checkpoint R2: failed commit with unchanged HEAD restores index', async () => {
  let cachedNameCalls = 0
  const handlers = rollbackGateHandlers((args) => {
    if (args.includes('--check')) return { exitCode: 0, stdout: '', stderr: '' }
    cachedNameCalls += 1
    return { exitCode: 0, stdout: cachedNameCalls === 1 ? '' : 'src/a.ts\n', stderr: '' }
  })
  handlers.commit = () => ({ exitCode: 1, stdout: '', stderr: 'commit hook rejected' })
  const { run, commands } = scriptedRunner(handlers)

  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo', expectedBranch: 'feat/test', task: TASK,
      completionEvidence: evidence(), policy: autoCommitPolicy(), commandRunner: run,
      expectedBaseHeadSha: ROLLBACK_BASE_HEAD,
    }),
    (error: unknown) => error instanceof GitCheckpointError
      && /git commit failed: commit hook rejected/.test(error.message)
      && /restored index to pre-checkpoint HEAD/.test(error.message),
  )
  assert.ok(commands.some((args) => args.join(' ') === 'read-tree HEAD'))
  assert.ok(!commands.some((args) => args[0] === 'push'))
})

await test('W004 git-checkpoint R3: failed commit with changed HEAD is ambiguous and never restores index', async () => {
  let cachedNameCalls = 0
  const handlers = rollbackGateHandlers((args) => {
    if (args.includes('--check')) return { exitCode: 0, stdout: '', stderr: '' }
    cachedNameCalls += 1
    return { exitCode: 0, stdout: cachedNameCalls === 1 ? '' : 'src/a.ts\n', stderr: '' }
  })
  handlers.commit = () => ({ exitCode: 1, stdout: '', stderr: 'commit transport failed' })
  let revParseCalls = 0
  handlers['rev-parse'] = () => {
    revParseCalls += 1
    return {
      exitCode: 0,
      stdout: `${revParseCalls === 1 ? ROLLBACK_BASE_HEAD : CHANGED_AFTER_FAILED_COMMIT}\n`,
      stderr: '',
    }
  }
  const { run, commands } = scriptedRunner(handlers)

  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo', expectedBranch: 'feat/test', task: TASK,
      completionEvidence: evidence(), policy: autoCommitPolicy(), commandRunner: run,
      expectedBaseHeadSha: ROLLBACK_BASE_HEAD,
    }),
    /ambiguous partial commit state/,
  )
  assert.ok(!commands.some((args) => args[0] === 'read-tree'))
  assert.ok(!commands.some((args) => args[0] === 'push'))
})

await test('W004 git-checkpoint R4: rollback failure retains original failure without claiming recovery', async () => {
  let cachedNameCalls = 0
  const handlers = rollbackGateHandlers((args) => {
    if (args.includes('--check')) return { exitCode: 0, stdout: '', stderr: '' }
    cachedNameCalls += 1
    return { exitCode: 0, stdout: cachedNameCalls === 1 ? '' : 'src/a.ts\n', stderr: '' }
  })
  handlers.commit = () => ({ exitCode: 1, stdout: '', stderr: 'commit hook rejected' })
  handlers['read-tree'] = () => ({ exitCode: 1, stdout: '', stderr: 'index lock unavailable' })
  const { run, commands } = scriptedRunner(handlers)

  await assert.rejects(
    finalizeCompletedTask({
      repoPath: '/tmp/repo', expectedBranch: 'feat/test', task: TASK,
      completionEvidence: evidence(), policy: autoCommitPolicy(), commandRunner: run,
      expectedBaseHeadSha: ROLLBACK_BASE_HEAD,
    }),
    (error: unknown) => error instanceof GitCheckpointError
      && /git commit failed: commit hook rejected/.test(error.message)
      && /index rollback failed/.test(error.message)
      && !/restored index to pre-checkpoint HEAD/.test(error.message),
  )
  assert.ok(commands.some((args) => args.join(' ') === 'read-tree HEAD'))
})

// ============ 安全：git writer 命令集合（forbidden 命令证明） ============

await test('W004 git-checkpoint safety: no forbidden git writer commands', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w004-safety-'))
  const { repoPath } = await setupRealRepo(tempBase)
  try {
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
      completionEvidence: evidence({ changedFiles: ['src/keep.ts'] }),
      policy: autoCommitPolicy(),
      commandRunner: recordingRunner,
    })

    const forbiddenSubcommands = new Set([
      'push', 'reset', 'clean', 'restore', 'checkout', 'rebase', 'merge', 'tag', 'rm', 'mv', 'stash',
    ])
    const forbiddenFlags = new Set(['-A', '--all', '--force', '-f', '-D', '--force-with-lease'])
    const allowedSubcommands = new Set(['branch', 'status', 'diff', 'add', 'commit', 'rev-parse'])

    assert.ok(commands.length >= 6, 'checkpoint must issue the expected git sequence')

    for (const args of commands) {
      const subcommand = args[0] ?? ''
      assert.ok(allowedSubcommands.has(subcommand), `unexpected subcommand: ${args.join(' ')}`)
      assert.ok(!forbiddenSubcommands.has(subcommand), `forbidden subcommand ${subcommand}`)
      for (const token of args) {
        assert.ok(!forbiddenFlags.has(token), `forbidden flag ${token} in: ${args.join(' ')}`)
      }
    }

    // 精确 staging：add 命令必须是 ['add', '--', ...files]，绝无 -A / . / --all
    const addCommands = commands.filter((args) => args[0] === 'add')
    assert.equal(addCommands.length, 1, 'exactly one add')
    const addArgs = addCommands[0]!
    assert.equal(addArgs[1], '--', 'add must use -- separator')
    assert.ok(!addArgs.includes('.') && !addArgs.includes('-A') && !addArgs.includes('--all'),
      'add must not use -A / . / --all')
    assert.deepEqual(addArgs.slice(2).sort(), ['src/keep.ts'], 'add stages exactly the task file')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
