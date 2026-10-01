import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ReviewerRuntimeRegistry,
  createDeepSeekReviewerRuntime,
  createReviewDispatcher,
  implementerProvidersOf,
  isIndependentReviewerCandidate,
  parseReviewVerdict,
  validateReviewerIndependence,
  type ReviewerOutcome,
  type ReviewerRuntime,
  type ReviewProviderFailure,
} from '../packages/development-guardian/work-session/index.js'
import { hasDeepSeekRoute } from '../packages/development-guardian/deepseek-executor.js'
import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import type { AgentCapabilityProfile } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { RepositoryReality } from '../packages/development-guardian/work-session/reconciliation.js'
import type { TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { reviewSatisfied } from '../packages/development-guardian/work-session/risk-evidence.js'
import { buildReviewPrompt } from '../packages/development-guardian/work-session/reviewer-adapters.js'

const runGit = promisify(execFile)

const REALITY: RepositoryReality = {
  repositoryIdentity: 'repo', branch: 'main', headSha: 'h1', changedFiles: ['src/a.ts'], worktreeFingerprint: 'w1',
}

test('submitted review spans every Task commit but excludes the previous Task', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'nw-review-scope-'))
  const git = async (...args: string[]) => (await runGit('git', args, { cwd: repo })).stdout.trim()
  await git('init', '-q'); await git('checkout', '-qb', 'codex/review-scope')
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'baseline.txt'), 'baseline\n'); await git('add', '.'); await git('commit', '-qm', 'baseline')
  const deliveryBase = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'previous-task.txt'), 'prior\n'); await git('add', '.'); await git('commit', '-qm', 'T0')
  const taskBase = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'first.txt'), 'first\n'); await git('add', '.'); await git('commit', '-qm', 'T1 first checkpoint')
  const firstHead = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'second.txt'), 'second\n'); await git('add', '.'); await git('commit', '-qm', 'T1 revision checkpoint')
  const head = await git('rev-parse', 'HEAD')
  assert.notEqual(firstHead, head)
  const reality = { repositoryIdentity: repo, branch: 'codex/review-scope', headSha: head,
    changedFiles: [] as string[], worktreeFingerprint: 'clean-worktree' }
  const task: TaskStateV2 = { ...reviewedTask({
    reviewer: { agent: 'independent', provider: 'acme', runtimeIdentity: 'reviewer' },
    implementer: { agent: 'executor', provider: 'other', runtimeIdentity: 'executor' },
  }), taskBaseCommit: taskBase, gitState: reality, completion: {
    ...reviewedTask({ reviewer: { agent: 'independent', provider: 'acme', runtimeIdentity: 'reviewer' },
      implementer: { agent: 'executor', provider: 'other', runtimeIdentity: 'executor' } }).completion,
    review: undefined } }
  let calls = 0
  const dispatcher = createReviewDispatcher({ inspectRepository: async () => reality,
    registry: new ReviewerRuntimeRegistry([{ provider: 'acme', async review({ task: context }) {
      calls++
      assert.equal(context.reviewBaseCommit, taskBase)
      assert.equal(context.reviewHeadCommit, head)
      assert.deepEqual(context.reviewChangedFiles, ['first.txt', 'second.txt'])
      assert.deepEqual(context.changedFiles, [])
      assert.match(buildReviewPrompt(context), new RegExp(`git diff ${taskBase} ${head} --`, 'u'))
      return { kind: 'VERDICT' as const, passed: true, findings: [], blockingFindings: [],
        summary: 'Both Task checkpoints reviewed.', provider: 'acme' }
    } }]) })
  const result = await dispatcher.dispatch({ agent: profile({ id: 'independent', provider: 'acme',
    runtimeIdentity: 'reviewer', review: true }), task })
  assert.equal(calls, 1)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.review?.reviewBaseCommit, taskBase)
  assert.equal(result.review?.reviewHeadCommit, head)
  assert.deepEqual(result.review?.reviewedFiles, ['first.txt', 'second.txt'])
  assert.equal(reviewSatisfied({ ...task, completion: { ...task.completion, review: result.review } }), true)
  assert.equal((await git('diff', '--name-only', deliveryBase, head)).split('\n').filter(Boolean).length, 3)
  assert.equal(await git('diff', '--name-only'), '')

  const deferredCriterion = 'AcceptanceAssertion A2: customer view → visible order | Expected evidence: browser screenshot | VerificationReadiness: EXTERNAL_DEFERRED | CapabilityContract: browser_ui/browser-harness-pending@1'
  const noOp: TaskStateV2 = { ...task, taskBaseCommit: head, identity: { ...task.identity, taskId: 'T2' },
    acceptanceCriteria: [deferredCriterion], completion: { evidence: [],
      bindings: [{ criterion: deferredCriterion, requiredEvidence: [] }] },
    verificationState: { results: [{ name: 'NOVAWING_DEFERRED:A2:EXTERNAL_DEFERRED',
      stepId: 'NOVAWING_DEFERRED:A2:EXTERNAL_DEFERRED', status: 'skipped' }] } }
  const noOpDispatcher = createReviewDispatcher({ inspectRepository: async () => reality,
    registry: new ReviewerRuntimeRegistry([{ provider: 'acme', async review({ task: context }) {
      assert.equal(context.reviewBaseCommit, head)
      assert.equal(context.reviewHeadCommit, head)
      assert.deepEqual(context.reviewChangedFiles, [])
      assert.ok(context.verificationEvidence.some(item => item.stepId === 'NOVAWING_DEFERRED:A2:EXTERNAL_DEFERRED'))
      return { kind: 'VERDICT' as const, passed: true, findings: [], blockingFindings: [],
        summary: 'No new diff; external evidence remains open.', provider: 'acme',
        assertionVerdicts: [{ assertionId: 'A2', verdict: 'DEFERRED' as const,
          evidence: 'Customer browser screenshot is pending.' }] }
    } }]) })
  const noOpResult = await noOpDispatcher.dispatch({ agent: profile({ id: 'independent', provider: 'acme',
    runtimeIdentity: 'reviewer', review: true }), task: noOp })
  assert.equal(noOpResult.review?.passed, true)
  assert.deepEqual(noOpResult.review?.reviewedFiles, [])
  assert.equal(reviewSatisfied({ ...noOp, completion: { ...noOp.completion, review: noOpResult.review } }), true)
})

test('incomplete external-deferred reviewer verdict retries once without sending implementation back', async () => {
  const criterion = 'AcceptanceAssertion AS2: create task | Expected evidence: browser trace | VerificationReadiness: EXTERNAL_DEFERRED | CapabilityContract: browser_ui/browser-harness-pending@1'
  const base = reviewedTask({ reviewer: { agent: 'independent', provider: 'acme', runtimeIdentity: 'reviewer' },
    implementer: { agent: 'executor', provider: 'other', runtimeIdentity: 'executor' } })
  const task: TaskStateV2 = { ...base, acceptanceCriteria: [criterion],
    completion: { ...base.completion, review: undefined, bindings: [{ criterion, requiredEvidence: [] }] },
    verificationState: { results: [{ name: 'NOVAWING_DEFERRED:AS2:EXTERNAL_DEFERRED',
      stepId: 'NOVAWING_DEFERRED:AS2:EXTERNAL_DEFERRED', status: 'skipped' }] } }
  let calls = 0
  const reviewer: ReviewerRuntime = { provider: 'acme', async review({ task: context }) {
    calls++
    if (calls === 1) return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [],
      summary: 'implementation reviewed', provider: 'acme', assertionVerdicts: [] }
    assert.match(context.reviewProtocolFeedback ?? '', /AS2/u)
    return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [],
      summary: 'implementation reviewed; customer browser evidence remains pending', provider: 'acme',
      assertionVerdicts: [{ assertionId: 'AS2', verdict: 'DEFERRED', evidence: 'Browser trace remains pending.' }] }
  } }
  const result = await createReviewDispatcher({ registry: new ReviewerRuntimeRegistry([reviewer]),
    inspectRepository: async () => REALITY }).dispatch({
    agent: profile({ id: 'independent', provider: 'acme', runtimeIdentity: 'reviewer', review: true }), task })
  assert.equal(calls, 2)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.review?.passed, true)
  assert.deepEqual(result.review?.assertionVerdicts?.map((item) => item.assertionId), ['AS2'])
})

test('repeated incomplete reviewer verdict is a provider protocol failure, not an implementation finding', async () => {
  const criterion = 'AcceptanceAssertion AS2: create task | Expected evidence: browser trace | VerificationReadiness: EXTERNAL_DEFERRED | CapabilityContract: browser_ui/browser-harness-pending@1'
  const base = reviewedTask({ reviewer: { agent: 'independent', provider: 'acme', runtimeIdentity: 'reviewer' },
    implementer: { agent: 'executor', provider: 'other', runtimeIdentity: 'executor' } })
  const task: TaskStateV2 = { ...base, acceptanceCriteria: [criterion],
    completion: { ...base.completion, review: undefined, bindings: [{ criterion, requiredEvidence: [] }] } }
  let calls = 0
  const reviewer: ReviewerRuntime = { provider: 'acme', async review() {
    calls++
    return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [],
      summary: 'implementation reviewed', provider: 'acme', assertionVerdicts: [] }
  } }
  const result = await createReviewDispatcher({ registry: new ReviewerRuntimeRegistry([reviewer]),
    inspectRepository: async () => REALITY }).dispatch({
    agent: profile({ id: 'independent', provider: 'acme', runtimeIdentity: 'reviewer', review: true }), task })
  assert.equal(calls, 2)
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.review, undefined)
  assert.equal(result.providerFailure?.status, 'DEGRADED')
  assert.match(result.providerFailure?.reason ?? '', /AS2/u)
})

function profile(input: {
  id: string
  provider: string
  runtimeIdentity: string
  review?: boolean
  coding?: boolean
}): AgentCapabilityProfile {
  return {
    id: input.id,
    identity: { agent: input.id, provider: input.provider, runtimeIdentity: input.runtimeIdentity },
    available: true, quotaExhausted: false, degraded: false,
    capabilities: { review: input.review ?? false, coding: input.coding ?? false, reasoning: true },
  }
}

function reviewedTask(input: {
  reviewer: { agent: string; provider: string; runtimeIdentity: string }
  implementer: { agent: string; provider: string; runtimeIdentity: string }
}): TaskStateV2 {
  return {
    version: 2,
    identity: { taskId: 'T1', sessionId: 's' },
    goal: 'ship the guard',
    constraints: [],
    acceptanceCriteria: ['guard enabled'],
    permissions: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    progress: { completedWork: [], pendingWork: [] },
    decisions: [], assumptions: [], openQuestions: [], artifacts: [],
    gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'h1', changedFiles: ['src/auth/guard.ts'], worktreeFingerprint: 'w1' },
    verificationState: { results: [{ name: 'test', status: 'passed' }] },
    completion: {
      evidence: [{
        type: 'test', status: 'PASSED', source: 'deterministic',
        repositoryIdentity: 'repo', branch: 'main', headSha: 'h1', workspaceIdentity: 'w1', timestamp: 'now',
      }],
      bindings: [{ criterion: 'guard enabled', requiredEvidence: ['test'] }],
      review: {
        passed: true, findings: [], severity: 'LOW', blockingFindings: [],
        reviewer: input.reviewer, implementer: input.implementer,
        reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h1',
        reviewedWorkspace: 'w1', reviewedFiles: ['src/auth/guard.ts'], timestamp: 'now',
      },
    },
    providerHistory: [input.implementer.provider],
    implementer: input.implementer,
    risk: 'NORMAL', status: 'ACTIVE', blockers: [], updatedAt: 'now',
  }
}

// §16 A — the Controller understands REVIEW from capability facts, not provider names.
test('TaskController does not depend on provider names to understand REVIEW', () => {
  const source = readFileSync(join(process.cwd(), 'packages', 'development-guardian', 'work-session', 'task-controller.ts'), 'utf8')
  assert.doesNotMatch(source, /deepseek|codex|openai|anthropic/iu)

  // Any provider pairing completes as long as the independence facts hold.
  const exotic = reviewedTask({
    reviewer: { agent: 'zeta', provider: 'acme-provider', runtimeIdentity: 'R9' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
  })
  assert.equal(new TaskController().decide(exotic).action, 'COMPLETE')

  // Self-review is not satisfied no matter what the provider is called.
  const selfReview = reviewedTask({
    reviewer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
  })
  assert.notEqual(new TaskController().decide(selfReview).action, 'COMPLETE')
})

// §16 B — a second, non-DeepSeek adapter satisfies the same Reviewer contract.
test('a second provider adapter replaces DeepSeek under the same reviewer contract', async () => {
  const calls: string[] = []
  const acme: ReviewerRuntime = {
    provider: 'acme',
    async review(input): Promise<ReviewerOutcome> {
      calls.push(input.agent.id)
      return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'acme approved', provider: 'acme' }
    },
  }
  const dispatcher = createReviewDispatcher({
    registry: new ReviewerRuntimeRegistry([acme]),
    inspectRepository: async () => REALITY,
  })
  const task = reviewedTask({
    reviewer: { agent: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
  })
  const result = await dispatcher.dispatch({
    agent: profile({ id: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9', review: true }),
    task: { ...task, completion: { ...task.completion, review: undefined } },
  })
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.review?.reviewer.provider, 'acme')
  assert.deepEqual(calls, ['acme-reviewer'])

  // A provider with no registered runtime fails closed instead of picking another.
  const missing = await createReviewDispatcher({
    registry: new ReviewerRuntimeRegistry([]),
    inspectRepository: async () => REALITY,
  }).dispatch({
    agent: profile({ id: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9', review: true }),
    task: { ...task, completion: { ...task.completion, review: undefined } },
  })
  assert.equal(missing.status, 'BLOCKED')
  assert.equal(missing.providerFailure?.status, 'OFFLINE')
})

// §16 C — implementer/reviewer roles can be reversed without touching TaskStateV2.
test('roles can be reversed (DeepSeek implements, Codex reviews) with no schema change', async () => {
  const codex: ReviewerRuntime = {
    provider: 'codex',
    async review(): Promise<ReviewerOutcome> {
      return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'codex approved', provider: 'codex' }
    },
  }
  const task = reviewedTask({
    reviewer: { agent: 'codex-reviewer', provider: 'codex', runtimeIdentity: 'R2' },
    implementer: { agent: 'deepseek-executor', provider: 'deepseek', runtimeIdentity: 'R1' },
  })
  const pending: TaskStateV2 = { ...task, completion: { ...task.completion, review: undefined } }
  const result = await createReviewDispatcher({
    registry: new ReviewerRuntimeRegistry([codex]),
    inspectRepository: async () => REALITY,
  }).dispatch({
    agent: profile({ id: 'codex-reviewer', provider: 'codex', runtimeIdentity: 'R2', review: true }),
    task: pending,
  })
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.review?.reviewer.runtimeIdentity, 'R2')
  // The controller then completes from the evidence — the adapter itself owns nothing.
  assert.equal(new TaskController().decide({ ...pending, completion: { ...pending.completion, review: result.review } }).action, 'COMPLETE')
})

// §16 D — a review PASS returns to the Controller; the adapter cannot complete a task.
test('a reviewer adapter returns evidence only and cannot complete a task', async () => {
  const passthrough: ReviewerRuntime = {
    provider: 'acme',
    async review(): Promise<ReviewerOutcome> {
      return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'ok', provider: 'acme' }
    },
  }
  const task = reviewedTask({
    reviewer: { agent: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
  })
  const pending: TaskStateV2 = { ...task, completion: { ...task.completion, review: undefined } }
  const result = await createReviewDispatcher({
    registry: new ReviewerRuntimeRegistry([passthrough]),
    inspectRepository: async () => REALITY,
  }).dispatch({ agent: profile({ id: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9', review: true }), task: pending })
  assert.deepEqual(
    Object.keys(result).filter((key) => !['status', 'review', 'blockers', 'providerHealth', 'providerFailure'].includes(key)),
    [],
  )
  // Without the Controller applying the evidence, the task is still awaiting REVIEW.
  assert.equal(new TaskController().decide(pending).action, 'REVIEW')
})

test('parseReviewVerdict is fail-closed', () => {
  assert.equal(parseReviewVerdict('').ok, false)
  assert.equal(parseReviewVerdict('not json').ok, false)
  assert.equal(parseReviewVerdict('{"verdict":"MAYBE"}').ok, false)
  // A PASS carrying blocking findings is contradictory.
  assert.equal(parseReviewVerdict('{"verdict":"PASS","blockingFindings":["x"],"summary":"s"}').ok, false)
  // A FAIL must state what blocks completion.
  assert.equal(parseReviewVerdict('{"verdict":"FAIL","blockingFindings":[],"summary":"s"}').ok, false)
  const pass = parseReviewVerdict('```json\n{"verdict":"PASS","findings":["ok"],"blockingFindings":[],"summary":"fine"}\n```')
  assert.equal(pass.ok, true)
  assert.equal(pass.ok && pass.verdict.passed, true)
})

test('delivery review PASS requires a verdict with evidence for every AcceptanceAssertion ID', async () => {
  const criterion = 'AcceptanceAssertion A1: customer cart quantity and exact total remain correct'
  const task = reviewedTask({
    reviewer: { agent: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' },
  })
  const pending: TaskStateV2 = { ...task, acceptanceCriteria: [criterion], completion: {
    ...task.completion, bindings: [{ criterion, requiredEvidence: ['test'] }], review: undefined,
  } }
  let includeAssertion = false
  const runtime: ReviewerRuntime = { provider: 'acme', async review(): Promise<ReviewerOutcome> {
    return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'reviewed', provider: 'acme',
      ...(includeAssertion ? { assertionVerdicts: [{ assertionId: 'A1', verdict: 'PASS', evidence: 'Observed quantity mutation and exact persisted total.' }] } : {}) }
  } }
  const dispatcher = createReviewDispatcher({ registry: new ReviewerRuntimeRegistry([runtime]), inspectRepository: async () => REALITY })
  const agent = profile({ id: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9', review: true })
  const missing = await dispatcher.dispatch({ agent, task: pending })
  assert.equal(missing.status, 'BLOCKED')
  assert.equal(missing.review, undefined)
  assert.equal(missing.providerFailure?.status, 'DEGRADED')
  assert.equal(reviewSatisfied({ ...pending, completion: { ...pending.completion, review: missing.review } }), false)
  includeAssertion = true
  const explicit = await dispatcher.dispatch({ agent, task: pending })
  assert.equal(explicit.review?.passed, true)
  assert.deepEqual(explicit.review?.assertionVerdicts?.map((item) => item.assertionId), ['A1'])
  assert.equal(reviewSatisfied({ ...pending, completion: { ...pending.completion, review: explicit.review } }), true)
  assert.equal(parseReviewVerdict('{"verdict":"PASS","summary":"ok","assertionVerdicts":[{"assertionId":"A1","verdict":"PASS","evidence":"observed"}]}').ok, true)
})

test('Phase 4 Reviewer verdict is bound to provider, collector and actual passed step ID', async () => {
  const criterion = 'AcceptanceAssertion A1: total is exact | CapabilityContract: command/existing-guarded-verifier@1'
  const source = reviewedTask({ reviewer: { agent: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9' },
    implementer: { agent: 'alpha', provider: 'other-provider', runtimeIdentity: 'R1' } })
  const task: TaskStateV2 = { ...source, acceptanceCriteria: [criterion],
    verificationState: { results: [{ name: 'cart assertion', command: 'node --test tests/cart.test.js',
      stepId: 'step-1', status: 'passed' }] },
    completion: { ...source.completion, bindings: [{ criterion, requiredEvidence: ['node --test tests/cart.test.js'] }], review: undefined } }
  let evidenceId = 'missing'
  const runtime: ReviewerRuntime = { provider: 'acme', async review(): Promise<ReviewerOutcome> {
    return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'reviewed', provider: 'acme',
      assertionVerdicts: [{ assertionId: 'A1', verdict: 'PASS', evidence: 'Observed the exact cart totals.',
        capabilityEvidence: { family: 'command', providerId: 'existing-guarded-verifier', providerVersion: '1',
          collector: 'existing-guarded-verifier', evidenceIds: [evidenceId], verificationResult: 'OBSERVED' } }] }
  } }
  const dispatcher = createReviewDispatcher({ registry: new ReviewerRuntimeRegistry([runtime]), inspectRepository: async () => REALITY })
  const agent = profile({ id: 'acme-reviewer', provider: 'acme', runtimeIdentity: 'R9', review: true })
  const unbound = await dispatcher.dispatch({ agent, task })
  assert.equal(unbound.review?.passed, false)
  evidenceId = 'step-1'
  const bound = await dispatcher.dispatch({ agent, task })
  assert.equal(bound.review?.passed, true)
  assert.equal(reviewSatisfied({ ...task, completion: { ...task.completion, review: bound.review } }), true)
  assert.equal(parseReviewVerdict('{"verdict":"PASS","summary":"ok","assertionVerdicts":[{"assertionId":"A1","verdict":"PASS","evidence":"observed","capabilityEvidence":{"family":"command","providerId":"p","providerVersion":"1","collector":"p","evidenceIds":["step-1"],"verificationResult":"OBSERVED"}}]}').ok, true)
})

test('reviewer independence requires a distinct runtime identity and a distinct provider', () => {
  const reviewer = profile({ id: 'r', provider: 'deepseek', runtimeIdentity: 'R2', review: true })
  const implementer = { agent: 'i', provider: 'codex', runtimeIdentity: 'R1' }
  assert.equal(validateReviewerIndependence({ reviewer, implementer, implementerProviders: ['codex'], requireIndependentReviewer: true }).independent, true)
  // Same provider as the real implementation, even with a different runtime identity.
  assert.equal(validateReviewerIndependence({ reviewer, implementer, implementerProviders: ['codex', 'deepseek'], requireIndependentReviewer: true }).independent, false)
  // Same runtime identity as the implementer.
  assert.equal(
    validateReviewerIndependence({
      reviewer: profile({ id: 'r', provider: 'deepseek', runtimeIdentity: 'R1', review: true }),
      implementer, implementerProviders: ['codex'], requireIndependentReviewer: true,
    }).independent,
    false,
  )
  // Not review-capable.
  assert.equal(validateReviewerIndependence({ reviewer: profile({ id: 'r', provider: 'deepseek', runtimeIdentity: 'R2' }), implementer, implementerProviders: ['codex'], requireIndependentReviewer: true }).independent, false)
})

test('reviewer eligibility uses real runtime provider facts', () => {
  const task = { implementer: { agent: 'i', provider: 'codex', runtimeIdentity: 'R1' }, providerHistory: ['codex', 'deepseek'] }
  assert.deepEqual(implementerProvidersOf(task), ['codex', 'deepseek'])
  assert.equal(isIndependentReviewerCandidate(profile({ id: 'codex-r', provider: 'codex', runtimeIdentity: 'R2', review: true }), task), false)
  assert.equal(isIndependentReviewerCandidate(profile({ id: 'ds-r', provider: 'deepseek', runtimeIdentity: 'R3', review: true }), task), false)
  assert.equal(isIndependentReviewerCandidate(profile({ id: 'other-r', provider: 'other', runtimeIdentity: 'R4', review: true }), task), true)
})

test('the DeepSeek reviewer receives the local provider route and fails closed without one', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nw-reviewer-route-'))
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-token-value' },
  }), 'utf8')
  let capturedEnv: NodeJS.ProcessEnv | undefined
  let capturedArgs: readonly string[] | undefined
  const adapter = createDeepSeekReviewerRuntime({
    cwd,
    model: 'sonnet',
    platform: 'linux',
    routeAvailable: () => hasDeepSeekRoute(cwd, { CLAUDE_CONFIG_DIR: join(cwd, '.claude') }),
    commandRunner: async (request) => {
      capturedEnv = request.env
      capturedArgs = request.args
      return {
        exitCode: 0, signal: null, stderr: '',
        stdout: JSON.stringify({ result: JSON.stringify({ verdict: 'PASS', findings: [], blockingFindings: [], summary: 'ok' }) }),
      }
    },
  })
  const outcome = await adapter.review({
    agent: profile({ id: 'ds-r', provider: 'deepseek', runtimeIdentity: 'R2', review: true }),
    task: { taskId: 'T1', goal: 'g', constraints: [], acceptanceCriteria: ['c'], implementerProviders: ['codex'], changedFiles: [], verificationEvidence: [], evidence: [], blockers: [], risk: 'HIGH' },
  })
  assert.equal(outcome.kind, 'VERDICT')
  // The CLI needs the route on its own process environment; NovaWing may not have it.
  assert.equal(capturedEnv?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
  assert.equal(capturedEnv?.ANTHROPIC_AUTH_TOKEN, 'test-token-value')
  assert.ok(capturedArgs?.some((value, index) => value === '--model' && capturedArgs?.[index + 1] === 'sonnet'))

  // Without a configured route the adapter refuses instead of using another provider.
  const unavailable = await createDeepSeekReviewerRuntime({ cwd, platform: 'linux', routeAvailable: async () => false })
    .review({
      agent: profile({ id: 'ds-r', provider: 'deepseek', runtimeIdentity: 'R2', review: true }),
      task: { taskId: 'T1', goal: 'g', constraints: [], acceptanceCriteria: ['c'], implementerProviders: ['codex'], changedFiles: [], verificationEvidence: [], evidence: [], blockers: [], risk: 'HIGH' },
    })
  assert.deepEqual([unavailable.kind, unavailable.kind === 'RUNTIME_FAILURE' ? unavailable.status : ''], ['RUNTIME_FAILURE', 'OFFLINE'])
})

test('the review dispatcher rejects a reviewer that mutates the repository', async () => {  let mutated = false
  const rogue: ReviewerRuntime = {
    provider: 'deepseek',
    async review(): Promise<ReviewerOutcome> {
      mutated = true
      return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary: 'ok', provider: 'deepseek' }
    },
  }
  const task = reviewedTask({
    reviewer: { agent: 'ds-r', provider: 'deepseek', runtimeIdentity: 'R2' },
    implementer: { agent: 'i', provider: 'codex', runtimeIdentity: 'R1' },
  })
  const result = await createReviewDispatcher({
    registry: new ReviewerRuntimeRegistry([rogue]),
    // The repository fingerprint changes while the reviewer is running.
    inspectRepository: async () => (mutated ? { ...REALITY, worktreeFingerprint: 'w2' } : REALITY),
  }).dispatch({
    agent: profile({ id: 'ds-r', provider: 'deepseek', runtimeIdentity: 'R2', review: true }),
    task: { ...task, completion: { ...task.completion, review: undefined } },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.review, undefined)
  const failure: ReviewProviderFailure | undefined = result.providerFailure
  assert.match(failure?.reason ?? '', /repository changed during review/u)
})


test('reviewer route and child process use the same explicitly supplied provider environment', async () => {
  const root=await mkdtemp(join(tmpdir(),'nw-reviewer-env-'))
  try {
    const env={CLAUDE_CONFIG_DIR:root,ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN:'fixture-not-a-secret',ANTHROPIC_DEFAULT_SONNET_MODEL:'deepseek-flash'}
    let calls=0
    const runtime=createDeepSeekReviewerRuntime({cwd:root,env,model:'sonnet',commandRunner:async request=>{
      calls++
      assert.equal(request.env?.CLAUDE_CONFIG_DIR,root)
      assert.equal(request.env?.ANTHROPIC_BASE_URL,env.ANTHROPIC_BASE_URL)
      assert.equal(request.env?.ANTHROPIC_AUTH_TOKEN,env.ANTHROPIC_AUTH_TOKEN)
      assert.equal(request.args[request.args.indexOf('--model')+1],'sonnet')
      return {exitCode:0,signal:null,stderr:'',stdout:JSON.stringify({result:JSON.stringify({verdict:'PASS',summary:'fixture',findings:[],blockingFindings:[]})})}
    }})
    const outcome=await runtime.review({agent:profile({id:'reviewer',provider:'deepseek',runtimeIdentity:'fixture',review:true}),
      task:{taskId:'health',goal:'fixture',constraints:[],acceptanceCriteria:[],implementerProviders:[],changedFiles:[],verificationEvidence:[],evidence:[],blockers:[],risk:'LOW'}})
    assert.equal(outcome.kind,'VERDICT');assert.equal(calls,1)
  } finally { await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true})) }
})
