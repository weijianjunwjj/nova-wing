// Opt-in provider smoke on a disposable repository. Never points at a customer repository.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasClaudeRoute } from '../dist/packages/development-guardian/deepseek-executor.js'
import { createClaudeReviewerRuntime } from '../dist/packages/development-guardian/work-session/reviewer-adapters.js'
import { validateReviewerIndependence } from '../dist/packages/development-guardian/work-session/reviewer-runtime.js'

if (process.env.NOVAWING_REVIEWER_SMOKE !== '1') throw new Error('Set NOVAWING_REVIEWER_SMOKE=1 for the live provider smoke')
const root = await mkdtemp(join(tmpdir(), 'novawing-reviewer-live-smoke-'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
try {
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const value = 1\n')
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=NovaWing smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture')
  await writeFile(join(root, 'src/a.ts'), 'export const value = 2\n')
  assert.equal(await hasClaudeRoute(root), true, 'Claude model route is unavailable')
  const agent = { id: 'claude-reviewer', identity: { agent: 'claude-reviewer', provider: 'claude', runtimeIdentity: 'fixture:claude-reviewer' },
    available: true, quotaExhausted: false, degraded: false, capabilities: { review: true, reasoning: true } }
  const implementer = { agent: 'codex-executor', provider: 'codex', runtimeIdentity: 'fixture:codex-executor' }
  const independence = validateReviewerIndependence({ reviewer: agent, implementer, implementerProviders: ['codex'], requireIndependentReviewer: true })
  assert.equal(independence.independent, true)
  const initialContent = await readFile(join(root, 'src/a.ts'))
  const initialHash = createHash('sha256').update(initialContent).digest('hex')
  const initialStatus = git('status', '--porcelain', '--untracked-files=all')
  const runtime = createClaudeReviewerRuntime({ cwd: root, timeoutMs: 120_000, maxTurns: 8 })
  const task = (expected) => ({ taskId: 'REVIEWER_SMOKE', goal: 'Review the one-file implementation.',
    constraints: ['Read only; do not modify files.'],
    acceptanceCriteria: [`AcceptanceAssertion SMOKE_VALUE: src/a.ts exports value = ${expected}.`],
    implementer, implementerProviders: ['codex'], repositoryIdentity: root, branch: 'main', headSha: git('rev-parse', 'HEAD'),
    changedFiles: ['src/a.ts'], verificationEvidence: [{ name: 'git diff --check', status: 'passed' }],
    evidence: [], blockers: [], risk: 'LOW' })
  const outcomes = []
  for (const [expected, passed] of [[2, true], [3, false]]) {
    const outcome = await runtime.review({ agent, task: task(expected) })
    assert.equal(outcome.kind, 'VERDICT', JSON.stringify(outcome))
    assert.equal(outcome.passed, passed, JSON.stringify(outcome))
    assert.equal(outcome.assertionVerdicts?.find((item) => item.assertionId === 'SMOKE_VALUE')?.verdict,
      passed ? 'PASS' : 'FAIL', JSON.stringify(outcome))
    const currentHash = createHash('sha256').update(await readFile(join(root, 'src/a.ts'))).digest('hex')
    assert.equal(currentHash, initialHash, 'reviewer changed fixture content')
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), initialStatus, 'reviewer changed fixture status')
    outcomes.push({ expected, verdict: passed ? 'PASS' : 'FAIL', assertionId: 'SMOKE_VALUE' })
  }
  console.log(JSON.stringify({ provider: runtime.provider, route: 'Claude CLI configured model', independence, outcomes,
    fixtureUnchanged: true }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
