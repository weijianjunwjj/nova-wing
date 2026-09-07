// Explicit, opt-in local ChatGPT allowance smoke. Never runs in npm test.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CodexExecutor } from '../dist/packages/development-guardian/codex-executor.js'
import { readWorkspaceGit } from '../dist/packages/development-guardian/codex-workspace-tools.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../dist/packages/development-guardian/work-session/worktree-fingerprint.js'

if (process.env.NOVAWING_CODEX_SMOKE !== '1') throw new Error('Set NOVAWING_CODEX_SMOKE=1 to use local ChatGPT allowance for this smoke')
const root = await mkdtemp(join(tmpdir(), 'novawing-codex-live-smoke-'))
try {
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const value = 1\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true })
  execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=NovaWing smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true })
  const executor = new CodexExecutor({ cwd: root, timeoutMs: 120_000 })
  const task = { id: 'CODEX_SMOKE', goal: 'Change src/a.ts value from 1 to 2. Do nothing else.',
    state: 'READY', iteration: 0, maxIterations: 1, allowedPaths: ['src/a.ts'], forbiddenPaths: [],
    constraints: ['Do not run shell or network tools. Use only novawing_workspace tools.'],
    acceptanceCriteria: ['src/a.ts exports value = 2'], doNotDo: ['No dependencies', 'No other files'] }
  const report = await executor.execute({ task, packet: { verdict: 'proceed', goal: task.goal,
    instructions: ['Inspect current file first, then edit it using the scoped workspace tools.'],
    constraints: task.constraints, doNotDo: task.doNotDo, verification: ['git diff --check'] } })
  const content = await readFile(join(root, 'src/a.ts'), 'utf8')
  const provider = executor.captureProviderState()
  const restarted = new CodexExecutor({ cwd: root, timeoutMs: 120_000 })
  restarted.restoreProviderState(provider)
  restarted.setRecoveryCheckpoint({ repoPath: root, branch: 'main', headSha: (await readWorkspaceGit(root, 'head')).trim(),
    changedFiles: report.changedFiles,
    worktreeFingerprint: await computeWorktreeFingerprint(root, parseGitStatus(await readWorkspaceGit(root, 'status'))) })
  const continued = report.blockers.length ? undefined : await restarted.execute({ task: { ...task, iteration: 1, lastReport: report },
    packet: { verdict: 'revise', goal: task.goal, instructions: ['Inspect current status and src/a.ts. If value is already 2, preserve it and report that no further edit is needed.'],
      constraints: task.constraints, doNotDo: task.doNotDo, verification: ['git diff --check'] } })
  const sameThread = Boolean(provider.codingExecution?.codexThreadId) &&
    restarted.captureProviderState().codingExecution?.codexThreadId === provider.codingExecution?.codexThreadId
  console.log(JSON.stringify({ summary: report.summary, commandsRun: report.commandsRun, changedFiles: report.changedFiles, blockers: report.blockers,
    errorKind: executor.lastError?.kind, verification: report.verificationResults.map(({ name, status }) => ({ name, status })),
    editVerified: /value = 2/.test(content), threadPersisted: Boolean(provider.codingExecution?.codexThreadId),
    restartSameThread: sameThread, continuationBlockers: continued?.blockers,
    continuationVerification: continued?.verificationResults.map(({ name, status }) => ({ name, status })) }, null, 2))
  if (report.blockers.length || !/value = 2/.test(content) || !sameThread || !continued || continued.blockers.length) process.exitCode = 1
} finally { await rm(root, { recursive: true, force: true }) }
