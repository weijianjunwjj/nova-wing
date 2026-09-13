import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  TaskEventLogV2,
  V2ControllerTaskRunner,
  computeWorktreeFingerprint,
  finalizeCompletedTask,
  parseGitStatus,
} from '../dist/packages/development-guardian/work-session/index.js'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactPath = join(projectRoot, 'artifacts', 'v0.2.8-direct-dogfood.json')
const repo = await mkdtemp(join(tmpdir(), 'novawing-v028-dogfood-'))
const counters = { controllerDecisions: 0, agentDispatches: 0, executeCount: 0, verifyCount: 0, reviewCount: 0, repositoryInspections: 0, directPathBoundaryInspections: 0, gitProcesses: 0, verifierProcesses: 0, modelCalls: 0, humanInterventions: 0 }

async function processRun(command, args, cwd, shell = false) {
  try {
    const result = await execFileAsync(command, args, { cwd, shell, windowsHide: true, encoding: 'utf8' })
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return { exitCode: error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }
  }
}

async function git(args, count = false) {
  if (count) counters.gitProcesses += 1
  return processRun('git', args, repo)
}

async function inspectRepository() {
  counters.repositoryInspections += 1
  const [branch, head, status, indexDiff] = await Promise.all([
    git(['branch', '--show-current'], true), git(['rev-parse', 'HEAD'], true),
    git(['status', '--porcelain', '-z', '--untracked-files=all'], true), git(['diff', '--cached', '--binary'], true),
  ])
  if ([branch, head, status, indexDiff].some((result) => result.exitCode !== 0)) throw new Error('repository inspection failed')
  const entries = parseGitStatus(status.stdout)
  const worktree = await computeWorktreeFingerprint(repo, entries, { strict: true })
  return {
    repositoryIdentity: await realpath(repo), branch: branch.stdout.trim(), headSha: head.stdout.trim(),
    changedFiles: entries.map((entry) => entry.path.replaceAll('\\', '/')),
    worktreeFingerprint: createHash('sha256').update(worktree).update(indexDiff.stdout).digest('hex'),
  }
}

try {
  await mkdir(join(repo, 'apps', 'web', 'src'), { recursive: true })
  await mkdir(join(repo, 'apps', 'web', 'tests'), { recursive: true })
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "console.error(\\"PostgreSQL unavailable\\");process.exit(73)"' } }, null, 2))
  await writeFile(join(repo, 'apps', 'web', 'package.json'), JSON.stringify({ private: true, scripts: { 'test:counter': 'node --test tests/counter.test.js', typecheck: 'node -e "process.exit(0)"' } }, null, 2))
  await writeFile(join(repo, 'apps', 'web', 'src', 'counter.js'), 'export const count = () => "X / ?"\n')
  // The fixture source is built from a variable so the boundary check does not
  // mistake the inlined deep-source import specifier for a real import.
  const counterImportSpecifier = '../src/counter.js'
  await writeFile(join(repo, 'apps', 'web', 'tests', 'counter.test.js'), `import test from "node:test"\nimport assert from "node:assert/strict"\nimport { count } from "${counterImportSpecifier}"\ntest("counter",()=>assert.equal(count(),"X / Y"))\n`)
  await git(['init', '-b', 'feat/dogfood'])
  await git(['config', 'user.email', 'dogfood@novawing.local'])
  await git(['config', 'user.name', 'NovaWing Dogfood'])
  await git(['add', '.'])
  await git(['commit', '-m', 'fixture: initialize direct-path dogfood'])
  const start = await inspectRepository()
  const inspectionsBeforeDirectPath = counters.repositoryInspections
  const eventLog = new TaskEventLogV2()
  const phases = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 'dogfood-v028', branch: 'feat/dogfood', directPath: { enabled: true, repositoryRoot: repo },
    agents: [{ id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'dogfood-router' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }],
    dispatcher: {
      inspectRepository,
      async dispatch({ action, task }) {
        counters.agentDispatches += action === 'EXECUTE' ? 1 : 0
        if (action === 'EXECUTE') {
          counters.executeCount += 1; counters.modelCalls += 1
          await writeFile(join(repo, 'apps', 'web', 'src', 'counter.js'), 'export const count = () => "X / Y"\n')
          return { status: 'SUCCESS', providerHistory: ['codex'], changedFiles: ['apps/web/src/counter.js'], implementationEvidenceAdded: true }
        }
        if (action === 'VERIFY') {
          counters.verifyCount += 1
          const results = []
          for (const step of task.verificationPlan.steps) {
            counters.verifierProcesses += 1
            const cwd = step.cwd === '.' ? repo : join(repo, step.cwd)
            const result = await processRun(step.command, [], cwd, true)
            results.push({ name: step.command, status: result.exitCode === 0 ? 'passed' : 'failed', ...(result.exitCode === 0 ? {} : { classification: 'CODE_FAILURE' }) })
          }
          return { status: 'SUCCESS', verificationResults: results }
        }
        counters.reviewCount += 1
        return { status: 'FAILED', summary: `unexpected ${action}` }
      },
    },
  })
  const task = { id: 'REAL-003', goal: 'Implement the task-local X / Y counter', constraints: [], acceptanceCriteria: ['counter shows X / Y'], allowedPaths: ['apps/web'], forbiddenPaths: ['.env'] }
  const result = await runner.run(task, undefined, undefined, { taskEventLog: eventLog, onProgress: (event) => { if (phases.at(-1) !== event.phase) phases.push(event.phase) } })
  counters.controllerDecisions = eventLog.count('CONTROLLER_DECIDED')
  counters.directPathBoundaryInspections = counters.repositoryInspections - inspectionsBeforeDirectPath
  if (result.status !== 'COMPLETED' || result.completionEvidence === undefined) throw new Error(`direct path did not complete: ${result.status}`)
  const checkpoint = await finalizeCompletedTask({
    repoPath: repo, expectedBranch: 'feat/dogfood', expectedBaseHeadSha: start.headSha, task,
    completionEvidence: result.completionEvidence, policy: { autoCommit: true, autoPush: false },
    commandRunner: (args) => git(args, true),
  })
  const rootSuite = await processRun('npm test', [], repo, true)
  const report = {
    version: '0.2.8', scenario: 'REAL-003-style isolated production-path dogfood', verdict: 'PASS',
    truthfulScope: 'Real git repository, real verifier subprocesses, real Direct Path runner and real git finalizer; implementer model response is deterministically scripted.',
    rootSuiteTrap: { executedByPlanner: false, manualExitCode: rootSuite.exitCode, expectedEnvironmentFailure: rootSuite.exitCode !== 0 },
    verificationPlan: result.taskStateV2.verificationPlan,
    executionPath: result.taskStateV2.execution?.path, phases: [...phases, 'COMMIT'], counters,
    outcome: { status: result.status, disposition: checkpoint.disposition, commitSha: checkpoint.commitSha, committedFiles: checkpoint.committedFiles, provider: result.taskStateV2.implementer?.provider },
    safety: { pushed: false, reviewCount: counters.reviewCount, humanInterventions: counters.humanInterventions },
    generatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await rm(repo, { recursive: true, force: true })
}
