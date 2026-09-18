import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  GoldenPathTaskRunner,
  TaskEventLogV2,
  computeWorktreeFingerprint,
  finalizeCompletedTask,
  parseGitStatus,
} from '../dist/packages/development-guardian/work-session/index.js'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactPath = join(projectRoot, 'artifacts', 'v0.3.0-golden-path-reliability.json')
const RUNS = 10

async function processRun(command, args, cwd, shell = false) {
  try {
    const result = await execFileAsync(command, args, { cwd, shell, windowsHide: true, encoding: 'utf8' })
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }
  }
}

async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'novawing-v030-reliability-'))
  await mkdir(join(repo, 'apps', 'web', 'src'), { recursive: true })
  await mkdir(join(repo, 'apps', 'web', 'tests'), { recursive: true })
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "console.error(\\"PostgreSQL unavailable\\");process.exit(73)"' } }, null, 2))
  await writeFile(join(repo, 'apps', 'web', 'package.json'), JSON.stringify({ private: true, scripts: { 'test:counter': 'node --test tests/counter.test.js', typecheck: 'node -e "process.exit(0)"' } }, null, 2))
  // Broken first; the Golden Path EXECUTE rewrites it to the passing value.
  await writeFile(join(repo, 'apps', 'web', 'src', 'counter.js'), 'export const count = () => "X / ?"\n')
  const counterImportSpecifier = '../src/counter.js'
  await writeFile(join(repo, 'apps', 'web', 'tests', 'counter.test.js'), `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { count } from "${counterImportSpecifier}"\ntest("counter", () => assert.equal(count(), "X / Y"))\n`)
  const git = async (args) => processRun('git', args, repo)
  await git(['init', '-q', '-b', 'feat/golden'])
  await git(['config', 'user.email', 'golden@novawing.local'])
  await git(['config', 'user.name', 'NovaWing Golden'])
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'fixture: golden path reliability'])
  return { repo, git }
}

async function inspectRepository(repo, git) {
  const [branch, head, status, indexDiff] = await Promise.all([
    git(['branch', '--show-current']), git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain', '-z', '--untracked-files=all']), git(['diff', '--cached', '--binary']),
  ])
  if ([branch, head, status, indexDiff].some((result) => result.exitCode !== 0)) throw new Error('repository inspection failed')
  const entries = parseGitStatus(status.stdout)
  const worktree = await computeWorktreeFingerprint(repo, entries, { strict: true })
  return {
    repositoryIdentity: await realpath(repo),
    branch: branch.stdout.trim(),
    headSha: head.stdout.trim(),
    changedFiles: entries.map((entry) => entry.path.replaceAll('\\', '/')),
    worktreeFingerprint: createHash('sha256').update(worktree).update(indexDiff.stdout).digest('hex'),
  }
}

async function runOnce() {
  const { repo, git } = await fixtureRepo()
  const counters = { execute: 0, verify: 0 }
  const started = Date.now()
  try {
    const start = await inspectRepository(repo, git)
    const eventLog = new TaskEventLogV2()
    const runner = new GoldenPathTaskRunner({
      sessionId: 'reliability-v030', branch: 'feat/golden', repositoryRoot: repo,
      agents: [{ id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'reliability-router' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }],
      dispatcher: {
        inspectRepository: () => inspectRepository(repo, git),
        async dispatch({ action, task }) {
          if (action === 'EXECUTE') {
            counters.execute += 1
            await writeFile(join(repo, 'apps', 'web', 'src', 'counter.js'), 'export const count = () => "X / Y"\n')
            return { status: 'SUCCESS', providerHistory: ['codex'], changedFiles: ['apps/web/src/counter.js'], implementationEvidenceAdded: true }
          }
          if (action === 'VERIFY') {
            counters.verify += 1
            const results = []
            for (const step of task.verificationPlan.steps) {
              const cwd = step.cwd === '.' ? repo : join(repo, step.cwd)
              const result = await processRun(step.command, [], cwd, true)
              results.push({
                stepId: step.id, name: step.command, command: step.command, cwd: step.cwd,
                exitCode: result.exitCode, status: result.exitCode === 0 ? 'passed' : 'failed',
                ...(result.exitCode === 0 ? {} : { classification: 'CODE_FAILURE' }),
              })
            }
            return { status: 'SUCCESS', verificationResults: results }
          }
          return { status: 'FAILED', summary: `unexpected action ${action}` }
        },
      },
      // A HIGH/CRITICAL fallback would land here; the happy fixture never needs it.
      fallbackRunner: { run: async () => ({ status: 'FAILED', error: 'fallback invoked on a golden-eligible task' }) },
    })
    const task = { id: 'GOLDEN-001', goal: 'Implement the X / Y counter', constraints: [], acceptanceCriteria: ['counter shows X / Y'], allowedPaths: ['apps/web'], forbiddenPaths: ['.env'] }
    const result = await runner.run(task, undefined, undefined, { taskEventLog: eventLog })
    if (result.status !== 'COMPLETED' || result.completionEvidence === undefined) {
      return { status: result.status, execute: counters.execute, verify: counters.verify, wallClockMs: Date.now() - started, failureReason: result.humanRequired?.category ?? result.error ?? 'not completed' }
    }
    const checkpoint = await finalizeCompletedTask({
      repoPath: repo, expectedBranch: 'feat/golden', expectedBaseHeadSha: start.headSha, task,
      completionEvidence: result.completionEvidence, policy: { autoCommit: true, autoPush: false },
      commandRunner: (args) => git(args),
    })
    return { status: result.status, execute: counters.execute, verify: counters.verify, wallClockMs: Date.now() - started, commitDisposition: checkpoint.disposition, commitSha: checkpoint.commitSha }
  } catch (error) {
    return { status: 'FAILED', execute: counters.execute, verify: counters.verify, wallClockMs: Date.now() - started, failureReason: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

const runs = []
for (let i = 0; i < RUNS; i++) {
  const run = await runOnce()
  runs.push(run)
  process.stdout.write(`[reliability] run ${i + 1}/${RUNS}: ${run.status} (execute=${run.execute}, verify=${run.verify}, ${run.wallClockMs}ms)${run.failureReason ? ` — ${run.failureReason}` : ''}\n`)
}

const completed = runs.filter((run) => run.status === 'COMPLETED').length
const humanRequired = runs.filter((run) => run.status === 'HUMAN_REQUIRED').length
const failed = runs.filter((run) => run.status === 'FAILED').length
const avg = (pick) => runs.reduce((sum, run) => sum + (pick(run) ?? 0), 0) / runs.length
const report = {
  version: '0.3.0', scenario: 'Golden Path reliability (single deterministic fixture, 10 runs)', verdict: completed >= 9 ? 'PASS' : 'FAIL',
  truthfulScope: 'Real git repository, real deterministic verifier subprocesses, real Golden Path runner and real Git finalizer; implementer model response is deterministically scripted.',
  completionRate: `${completed}/${RUNS}`,
  humanRequiredRate: `${humanRequired}/${RUNS}`,
  failedRate: `${failed}/${RUNS}`,
  averageExecuteCount: Number(avg((run) => run.execute).toFixed(2)),
  averageVerifyCount: Number(avg((run) => run.verify).toFixed(2)),
  averageWallClockMs: Number(avg((run) => run.wallClockMs).toFixed(1)),
  runs,
  failureReasons: runs.filter((run) => run.status !== 'COMPLETED').map((run) => ({ status: run.status, reason: run.failureReason })),
  generatedAt: new Date().toISOString(),
}
await mkdir(dirname(artifactPath), { recursive: true })
await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)
process.exitCode = completed >= 9 ? 0 : 1
