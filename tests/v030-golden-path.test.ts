import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { VerificationResult } from '../packages/development-guardian/model.js'
import { TaskEventLogV2, type TaskEventV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { assessRisk } from '../packages/development-guardian/work-session/risk-evidence.js'
import { planVerification } from '../packages/development-guardian/work-session/verification-planner.js'
import {
  assessGoldenPathEligibility,
  GoldenPathTaskRunner,
} from '../packages/development-guardian/work-session/golden-path.js'
import type { WorkSessionTask } from '../packages/development-guardian/work-session/model.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunner } from '../packages/development-guardian/work-session/task-runner.js'
import type { AgentCapabilityProfile, V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-v030-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node unavailable-postgres-test.js' } }), 'utf8')
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true })
  await mkdir(join(root, 'apps', 'web', 'tests'), { recursive: true })
  await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:ticket': 'node --test tests/counter.test.js', typecheck: 'node -e "process.exit(0)"' } }), 'utf8')
  await writeFile(join(root, 'apps', 'web', 'tests', 'counter.test.js'), 'export {}\n', 'utf8')
  await writeFile(join(root, 'apps', 'web', 'src', 'counter.js'), 'export const count = () => "X / ?"\n', 'utf8')
  return root
}

const task = (overrides: Partial<WorkSessionTask> = {}): WorkSessionTask => ({
  id: 'T-v030', goal: 'Implement the X / Y counter', constraints: [],
  acceptanceCriteria: ['counter shows X / Y'], allowedPaths: ['apps/web'], forbiddenPaths: ['.env'], ...overrides,
})

const agents: readonly AgentCapabilityProfile[] = [
  { id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'router-1' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } },
]

const CHANGED = ['apps/web/src/counter.js']

interface ScriptOptions {
  noOpAttempts?: number
  verify?: 'pass' | 'code' | 'environment' | 'config' | 'unrelated'
  /** When true, the CODE_FAILURE fix (EXECUTE #2) leaves no repo change and no evidence. */
  fixNoProgress?: boolean
  /** When true, EXECUTE never changes the repo. */
  noChange?: boolean
  /** When true, every VERIFY returns CODE_FAILURE (exercises the two-verify cap). */
  alwaysCodeFailure?: boolean
  /** When true, the task is ineligible (HIGH risk) and the fallback is exercised. */
  highRisk?: boolean
}

interface RunResult {
  result: WorkSessionTaskResult
  events: readonly TaskEventV2[]
  executeCount: number
  verifyCount: number
  fallbackCalled: boolean
}

async function goldenRun(root: string, options: ScriptOptions = {}): Promise<RunResult> {
  const repo = { changed: false, revision: 0 }
  let executeCount = 0
  let verifyCount = 0
  let fallbackCalled = false
  const events = new TaskEventLogV2()
  const reality = () => ({
    repositoryIdentity: root, branch: 'main', headSha: 'head-1',
    changedFiles: repo.changed ? [...CHANGED] : [],
    worktreeFingerprint: repo.changed ? `fingerprint-${repo.revision}` : 'clean',
  })
  const dispatcher: V2ActionDispatcher = {
    async inspectRepository() { return reality() },
    async dispatch({ action, task: state }) {
      if (action === 'EXECUTE') {
        executeCount += 1
        if (executeCount <= (options.noOpAttempts ?? 0)) {
          return { status: 'BLOCKED' as const, changedFiles: [], providerHistory: ['codex'],
            blockers: ['NO_OP_EXECUTION: Codex completed without workspace inspection'] }
        }
        // The CODE_FAILURE fix that makes no progress (REAL-005 regression).
        if (options.fixNoProgress === true && executeCount === 2 && repo.changed) {
          return { status: 'SUCCESS' as const, changedFiles: [], providerHistory: ['codex'] }
        }
        if (!options.noChange) { repo.changed = true; repo.revision += 1 }
        return { status: 'SUCCESS' as const, changedFiles: [...CHANGED], providerHistory: ['codex'], ...(executeCount > 1 ? { implementationEvidenceAdded: true } : {}) }
      }
      if (action === 'VERIFY') {
        verifyCount += 1
        const steps = state.verificationPlan?.steps.map((step) => step.command) ?? []
        const fail = options.alwaysCodeFailure === true
          ? true
          : options.verify !== undefined && options.verify !== 'pass' && !(options.verify === 'code' && executeCount >= 2 && !options.fixNoProgress)
        const classification = options.verify === 'environment' ? 'ENVIRONMENT_FAILURE' as const
          : options.verify === 'config' ? 'VERIFIER_CONFIGURATION_FAILURE' as const
            : options.verify === 'unrelated' ? 'UNRELATED_TEST_FAILURE' as const
              : 'CODE_FAILURE' as const
        const results: VerificationResult[] = steps.map((name) => ({ name, status: fail ? 'failed' as const : 'passed' as const, ...(fail ? { classification } : {}) }))
        return { status: 'SUCCESS' as const, verificationResults: results }
      }
      return { status: 'FAILED' as const, summary: `unexpected action ${action}` }
    },
  }
  const fallback: WorkSessionTaskRunner = {
    async run(): Promise<WorkSessionTaskResult> {
      fallbackCalled = true
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: 'legacy controller path invoked' } }
    },
  }
  const runner = new GoldenPathTaskRunner({
    sessionId: 'S-v030', branch: 'main', agents, dispatcher, repositoryRoot: root, fallbackRunner: fallback,
  })
  const result = await runner.run(task(options.highRisk ? { risk: 'HIGH' } : {}), undefined, undefined, { taskEventLog: events })
  return { result, events: events.events, executeCount, verifyCount, fallbackCalled }
}

test('v0.3.0 golden: happy path is one execute, one verify, zero Controller decisions', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root)
    assert.equal(run.result.status, 'COMPLETED')
    assert.equal(run.executeCount, 1)
    assert.equal(run.verifyCount, 1)
    assert.equal(run.result.taskStateV2?.execution?.path, 'GOLDEN')
    assert.equal(new TaskController().decide(run.result.taskStateV2!).action, 'COMPLETE')
    assert.equal(run.events.filter((event) => event.type === 'CONTROLLER_DECIDED').length, 0)
    assert.equal(run.events.filter((event) => event.type === 'REVIEW_STARTED').length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: first Executor no-op retries once then verifies and completes', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { noOpAttempts: 1 })
    assert.equal(run.result.status, 'COMPLETED')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: second no-op stops with EXECUTOR_NO_PROGRESS_AFTER_RETRY and never a third execute', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { noOpAttempts: 10 })
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'EXECUTOR_NO_PROGRESS_AFTER_RETRY')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 0)
    assert.match(run.result.humanRequired?.reason ?? '', /executeCount=2/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: CODE_FAILURE runs one fix then verifies once and completes', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'code' })
    assert.equal(run.result.status, 'COMPLETED')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: persistent CODE_FAILURE stops after one fix with CODE_FAILURE_AFTER_SINGLE_FIX', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'code', fixNoProgress: true })
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'CODE_FAILURE_AFTER_SINGLE_FIX')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 1)
    assert.match(run.result.humanRequired?.reason ?? '', /executeCount=2/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: REAL-005 regression — fix with no implementation progress never reaches a third EXECUTE', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'code', fixNoProgress: true })
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 1)
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'CODE_FAILURE_AFTER_SINGLE_FIX')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: a progressing fix whose second VERIFY still fails stops at two verifies', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { alwaysCodeFailure: true })
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'CODE_FAILURE_AFTER_SINGLE_FIX')
    assert.equal(run.executeCount, 2)
    assert.equal(run.verifyCount, 2)
    assert.match(run.result.humanRequired?.reason ?? '', /verifyCount=2/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: ENVIRONMENT_FAILURE stops with ENVIRONMENT_REQUIRED and never re-executes', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'environment' })
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
    assert.equal(run.result.humanRequired?.category, 'ENVIRONMENT_REQUIRED')
    assert.equal(run.executeCount, 1)
    assert.equal(run.verifyCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: VERIFIER_CONFIGURATION_FAILURE stops with VERIFIER_CONFIGURATION_REQUIRED', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'config' })
    assert.equal(run.result.humanRequired?.category, 'VERIFIER_CONFIGURATION_REQUIRED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: UNRELATED_TEST_FAILURE stops with UNRELATED_TEST_FAILURE', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { verify: 'unrelated' })
    assert.equal(run.result.humanRequired?.category, 'UNRELATED_TEST_FAILURE')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: HIGH risk falls back to the legacy advanced path without dispatching EXECUTE', async () => {
  const root = await fixture()
  try {
    const run = await goldenRun(root, { highRisk: true })
    assert.equal(run.fallbackCalled, true)
    assert.equal(run.executeCount, 0)
    assert.equal(run.result.status, 'HUMAN_REQUIRED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: eligibility fails closed on destructive, migration, security, and public-API contracts', async () => {
  const root = await fixture()
  try {
    const plan = await planVerification({ repositoryRoot: root, task: task() })
    const initial = createTaskStateV2({ id: 'S', branch: 'main' }, task())
    const state = { ...initial, verificationPlan: plan, completion: { ...initial.completion, bindings: plan.mappings.map((mapping) => ({ criterion: mapping.criterion, requiredEvidence: mapping.evidence })) }, execution: { path: 'GOLDEN' as const, escalated: false } }
    const eligible = () => assessGoldenPathEligibility({ task: state, plan, agents, repositoryConsistent: true })
    assert.equal(eligible().eligible, true)
    assert.equal(assessGoldenPathEligibility({ task: state, plan, agents, repositoryConsistent: true, destructiveAction: true }).eligible, false)
    const migration = { ...state, goal: 'Add a database migration for user roles' }
    assert.equal(assessGoldenPathEligibility({ task: migration, plan, agents, repositoryConsistent: true }).eligible, false)
    const security = { ...state, goal: 'Change the authentication boundary' }
    assert.equal(assessGoldenPathEligibility({ task: security, plan, agents, repositoryConsistent: true }).eligible, false)
    const publicApi = { ...state, goal: 'Change the public API contract' }
    assert.equal(assessGoldenPathEligibility({ task: publicApi, plan, agents, repositoryConsistent: true }).eligible, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v0.3.0 golden: sensitive-looking path is a signal, not a HIGH-risk disqualifier', () => {
  const initial = createTaskStateV2({ id: 'S', branch: 'main' }, task({ allowedPaths: ['apps/web/src/api'] }))
  const assessed = assessRisk({ ...initial, execution: { path: 'GOLDEN', escalated: false }, gitState: { ...initial.gitState, changedFiles: ['apps/web/src/api/counter.js'] } })
  assert.equal(assessed.level, 'MEDIUM')
})
