import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assessRisk } from '../packages/development-guardian/work-session/risk-evidence.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { V2ControllerTaskRunner, type V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { assessDirectPathEligibility, phaseForAction, resumeTargetForFailure, resumeTargetForRuntimeFailure } from '../packages/development-guardian/work-session/direct-path.js'
import { planVerification, validateVerificationPlanAfterExecution, verificationPlanFingerprintValid } from '../packages/development-guardian/work-session/verification-planner.js'
import { preflightTaskContract } from '../packages/development-guardian/work-session/launchpad/contract-preflight.js'
import type { WorkSessionTask } from '../packages/development-guardian/work-session/model.js'

async function fixture(kind: 'web' | 'empty' = 'web'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-v028-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node unavailable-postgres-test.js' } }), 'utf8')
  if (kind === 'web') {
    await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true })
    await mkdir(join(root, 'apps', 'web', 'tests'), { recursive: true })
    await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:ticket': 'node --test tests/ticket-filter.test.js', typecheck: 'tsc --noEmit' } }), 'utf8')
    await writeFile(join(root, 'apps', 'web', 'tests', 'ticket-filter.test.js'), 'export {}\n', 'utf8')
    await writeFile(join(root, 'apps', 'web', 'src', 'ticket-filter.ts'), 'export {}\n', 'utf8')
  }
  return root
}

const task = (overrides: Partial<WorkSessionTask> = {}): WorkSessionTask => ({
  id: 'T-v028', goal: 'Show X / Y ticket filter count', constraints: [],
  acceptanceCriteria: ['ticket filter count is correct'], allowedPaths: ['apps/web'], forbiddenPaths: ['.env'], ...overrides,
})

test('v0.2.8 planner: REAL-002/003 package-local evidence beats root PostgreSQL suite', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task() })
    assert.equal(plan.confidence, 'HIGH')
    assert.equal(plan.steps[0]?.command, 'npm run test:ticket')
    assert.equal(plan.steps[0]?.cwd, 'apps/web')
    assert.ok(plan.steps.some((step) => step.command === 'npm run typecheck' && step.cwd === 'apps/web'))
    assert.ok(plan.steps.some((step) => step.command === 'git diff --check'))
    assert.equal(plan.steps.some((step) => step.command === 'npm test' && step.cwd === '.'), false)
    assert.equal(verificationPlanFingerprintValid(plan), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 planner: explicit evidence binding has precedence', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task({ acceptanceEvidenceBindings: [{ criterion: 'ticket filter count is correct', requiredEvidence: ['git diff --check'] }] }) })
    assert.equal(plan.explicitBindings, true)
    assert.deepEqual(plan.mappings[0]?.evidence, ['git diff --check'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 planner: insufficient evidence stops before execution and never guesses root test', async () => {
  const root = await fixture('empty')
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task({ allowedPaths: ['src'] }) })
    assert.equal(plan.confidence, 'INSUFFICIENT')
    assert.equal(plan.steps.some((step) => step.command === 'npm test'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 planner: a known unavailable prerequisite fails before execution', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task(), environment: { node: false } })
    assert.equal(plan.confidence, 'INSUFFICIENT')
    assert.ok(plan.rationale.some((reason) => reason.includes('node')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 preflight: missing natural-language binding becomes planning-required only when enabled', async () => {
  const root = await fixture()
  try {
    const planned = await preflightTaskContract({ targetRepo: root, acceptanceCriteria: ['ticket count is correct'], acceptanceEvidenceBindings: [], verificationPlannerEnabled: true })
    assert.equal(planned.ok, true)
    if (planned.ok) assert.equal(planned.planningRequired, true)
    const legacy = await preflightTaskContract({ targetRepo: root, acceptanceCriteria: ['ticket count is correct'], acceptanceEvidenceBindings: [] })
    assert.equal(legacy.ok, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

interface ScriptOptions { verify?: 'pass' | 'code' | 'environment'; noChange?: boolean; fixAfterFailure?: boolean }

async function directRun(root: string, options: ScriptOptions = {}) {
  const events = new TaskEventLogV2()
  const actions: string[] = []
  let inspections = 0
  let executeCount = 0
  let verificationCount = 0
  let changed = false
  let fixed = false
  const reality = () => ({ repositoryIdentity: root, branch: 'main', headSha: 'head-1', changedFiles: changed ? ['apps/web/src/ticket-filter.ts'] : [], worktreeFingerprint: changed ? 'changed' : 'clean' })
  const dispatcher: V2ActionDispatcher = {
    async inspectRepository() { inspections += 1; return reality() },
    async dispatch({ action, task: state, agent }) {
      actions.push(action)
      if (action === 'EXECUTE') {
        executeCount += 1
        if (!options.noChange) changed = true
        if (executeCount > 1) fixed = true
        return { status: 'SUCCESS' as const, changedFiles: reality().changedFiles, providerHistory: ['codex'], ...(executeCount > 1 ? { implementationEvidenceAdded: true } : {}) }
      }
      if (action === 'VERIFY') {
        verificationCount += 1
        const fail = options.verify !== undefined && options.verify !== 'pass' && !(options.fixAfterFailure && fixed)
        return { status: 'SUCCESS' as const, verificationResults: state.verificationPlan!.steps.map((step) => ({ name: step.command, status: fail ? 'failed' as const : 'passed' as const,
          ...(fail ? { classification: options.verify === 'environment' ? 'ENVIRONMENT_FAILURE' as const : 'CODE_FAILURE' as const } : {}) })) }
      }
      if (action === 'REVIEW') {
        const identity = agent.identity!
        return { status: 'SUCCESS' as const, review: { passed: true, findings: [], blockingFindings: [], severity: 'HIGH' as const, reviewer: identity,
          implementer: state.implementer!, reviewedRepository: state.gitState.repositoryIdentity!, reviewedBranch: state.gitState.branch!, reviewedCommit: state.gitState.headSha!,
          reviewedWorkspace: state.gitState.worktreeFingerprint!, reviewedFiles: state.gitState.changedFiles, timestamp: new Date().toISOString() } }
      }
      return { status: 'SUCCESS' as const }
    },
  }
  const runner = new V2ControllerTaskRunner({ sessionId: 'S-v028', branch: 'main', directPath: { enabled: true, repositoryRoot: root }, dispatcher,
    agents: [
      { id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'router-1' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } },
      { id: 'reviewer', identity: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'reviewer-1' }, available: true, quotaExhausted: false, degraded: false, capabilities: { review: true } },
    ] })
  const result = await runner.run(task(), undefined, undefined, { taskEventLog: events })
  return { result, events: events.events, actions, inspections, executeCount, verificationCount }
}

test('v0.2.8 direct: happy path is one execute, one verify, zero Controller decisions, two inspections', async () => {
  const root = await fixture()
  try {
    const run = await directRun(root)
    assert.equal(run.result.status, 'COMPLETED')
    assert.equal(run.executeCount, 1)
    assert.equal(run.verificationCount, 1)
    assert.equal(run.inspections, 2)
    assert.equal(run.events.filter((event) => event.type === 'CONTROLLER_DECIDED').length, 0)
    assert.equal(run.events.filter((event) => event.type === 'REVIEW_STARTED').length, 0)
    assert.equal(run.result.taskStateV2?.execution?.path, 'DIRECT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 direct: actual provider is projected, route profile is debug metadata only', async () => {
  const root = await fixture()
  try {
    const run = await directRun(root)
    assert.equal(run.result.taskStateV2?.implementer?.provider, 'codex')
    assert.equal(run.events.some((event) => event.provider === 'codex-or-deepseek'), false)
    assert.equal(run.events.find((event) => event.type === 'AGENT_COMPLETED' && event.action === 'EXECUTE')?.provider, 'codex')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 direct: no-change verification completes as already satisfied evidence', async () => {
  const root = await fixture()
  try {
    const run = await directRun(root, { noChange: true })
    assert.equal(run.result.status, 'COMPLETED')
    assert.deepEqual(run.result.completionEvidence?.changedFiles, [])
    assert.equal(run.events.find((event) => event.type === 'TASK_COMPLETED')?.metadata?.outcome, 'ALREADY_SATISFIED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 escalation: CODE_FAILURE retains plan and state, Controller fixes then verifies', async () => {
  const root = await fixture()
  try {
    const run = await directRun(root, { verify: 'code', fixAfterFailure: true })
    assert.equal(run.result.status, 'COMPLETED')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verificationCount, 2)
    assert.ok(run.events.some((event) => event.type === 'DIRECT_PATH_ESCALATED'))
    assert.ok(run.events.some((event) => event.type === 'CONTROLLER_DECIDED'))
    assert.ok(run.result.taskStateV2?.verificationPlan)
    assert.equal(run.result.taskStateV2?.execution?.escalated, true)
    assert.equal(run.result.taskStateV2?.execution?.startCheckpoint?.worktreeFingerprint, 'clean')
    assert.ok(run.result.taskStateV2?.providerHistory.includes('codex'))
    assert.ok((run.result.taskStateV2?.completion.evidence.length ?? 0) > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 escalation: ENVIRONMENT_FAILURE resumes at verification boundary and never re-executes', async () => {
  const root = await fixture()
  try {
    const run = await directRun(root, { verify: 'environment' })
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'ENVIRONMENT_REQUIRED')
    assert.equal(run.executeCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 direct: insufficient plan is fail-safe before executor dispatch', async () => {
  const root = await fixture('empty')
  try {
    let dispatches = 0
    const runner = new V2ControllerTaskRunner({ sessionId: 'S-plan', branch: 'main', directPath: { enabled: true, repositoryRoot: root },
      agents: [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }],
      dispatcher: { inspectRepository: async () => ({ repositoryIdentity: root, branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }), dispatch: async () => { dispatches += 1; return { status: 'SUCCESS' } } } })
    const result = await runner.run(task({ allowedPaths: ['src'] }))
    assert.equal(result.humanRequired?.category, 'PLANNING_REQUIRED')
    assert.equal(dispatches, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 policy: sensitive-looking path alone is not HIGH', () => {
  const state = createTaskStateV2({ id: 'S', branch: 'main' }, task({ allowedPaths: ['src/api'] }))
  const assessed = assessRisk({ ...state, execution: { path: 'DIRECT', escalated: false }, gitState: { ...state.gitState, changedFiles: ['src/api/label.ts'] } })
  assert.equal(assessed.level, 'MEDIUM')
  const high = createTaskStateV2({ id: 'S', branch: 'main' }, task({ risk: 'HIGH', goal: 'Change public API contract' }))
  assert.equal(assessRisk(high).level, 'HIGH')
})

test('v0.2.8 resume matrix and durable VERIFY ONLY constraint are explicit', () => {
  assert.equal(resumeTargetForFailure('CODE_FAILURE'), 'EXECUTE')
  assert.equal(resumeTargetForFailure('ENVIRONMENT_FAILURE'), 'VERIFY')
  assert.equal(resumeTargetForFailure('VERIFIER_CONFIGURATION_FAILURE'), 'VERIFY')
  assert.equal(resumeTargetForFailure('UNRELATED_TEST_FAILURE'), 'COMPLETE_OR_VERIFY')
  assert.equal(resumeTargetForRuntimeFailure('EXECUTE'), 'EXECUTE')
  assert.equal(resumeTargetForRuntimeFailure('VERIFY'), 'VERIFY')
  const initial = createTaskStateV2({ id: 'S', branch: 'main' }, task({ acceptanceEvidenceBindings: [{ criterion: 'ticket filter count is correct', requiredEvidence: ['test'] }] }))
  const constrained = { ...initial, status: 'ACTIVE' as const, humanConstraints: { verifyOnly: true }, verificationState: { results: [{ name: 'test', status: 'failed' as const, classification: 'CODE_FAILURE' as const }] } }
  assert.equal(new TaskController().decide(constrained).action, 'SUSPEND')
})

test('v0.2.8 Direct eligibility fails closed on dirty, destructive, or unavailable work', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task() })
    const initial = createTaskStateV2({ id: 'S', branch: 'main' }, task())
    const state = { ...initial, verificationPlan: plan, completion: { ...initial.completion, bindings: plan.mappings.map((mapping) => ({ criterion: mapping.criterion, requiredEvidence: mapping.evidence })) }, execution: { path: 'DIRECT' as const, escalated: false } }
    const agent = { id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }
    assert.equal(assessDirectPathEligibility({ task: state, plan, agents: [agent], repositoryConsistent: true }).eligible, true)
    assert.equal(assessDirectPathEligibility({ task: state, plan, agents: [agent], repositoryConsistent: true, unownedDirtyChanges: true }).eligible, false)
    assert.equal(assessDirectPathEligibility({ task: state, plan, agents: [agent], repositoryConsistent: true, destructiveAction: true }).eligible, false)
    assert.equal(assessDirectPathEligibility({ task: state, plan, agents: [agent], repositoryConsistent: true, knownEnvironmentBlocker: true }).eligible, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.2.8 phase projection never aliases unknown or pending review to REVIEWING', () => {
  assert.equal(phaseForAction('EXECUTE'), 'EXECUTING')
  assert.equal(phaseForAction('VERIFY'), 'VERIFYING')
  assert.equal(phaseForAction('REVIEW', false), 'WAITING')
  assert.equal(phaseForAction('REVIEW', true), 'REVIEWING')
  assert.equal(phaseForAction('COMPLETE'), 'FINALIZING')
  assert.equal(phaseForAction('REQUEST_APPROVAL'), 'WAITING_FOR_APPROVAL')
  assert.equal(phaseForAction('not-real'), 'UNKNOWN')
})

test('v0.2.8 plan invalidation detects package-boundary expansion', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task() })
    const validation = validateVerificationPlanAfterExecution({ plan, changedFiles: ['packages/api/index.ts'], allowedPaths: ['apps/web'], forbiddenPaths: [], riskBefore: 'LOW', riskAfter: 'LOW' })
    assert.equal(validation.valid, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
