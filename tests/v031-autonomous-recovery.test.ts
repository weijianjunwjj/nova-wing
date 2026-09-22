import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAutonomousDiagnosisRunner, validateAutonomousDiagnosis, type AutonomousDiagnosisDecision, type AutonomousDiagnosisEvidence, type AutonomousRecoveryOptions } from '../packages/development-guardian/work-session/autonomous-diagnosis.js'
import { GoldenPathTaskRunner } from '../packages/development-guardian/work-session/golden-path.js'
import { V2ControllerTaskRunner, type V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { loadTaskStateV2, type TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import type { AnsweredHumanAction, WorkSessionTask } from '../packages/development-guardian/work-session/model.js'
import type { WorkSessionTaskRunContext } from '../packages/development-guardian/work-session/task-runner.js'

const safeDecision = (overrides: Partial<AutonomousDiagnosisDecision> = {}): AutonomousDiagnosisDecision => ({
  recoverable: true, diagnosis: 'The counter has the wrong fallback value.', strategy: 'FIX_IMPLEMENTATION',
  instructions: 'Inspect the failing counter assertion and fix the fallback in src/counter.js.', requiresHuman: false,
  humanReason: null, requiredAuthority: [], paths: ['src/counter.js'], commands: [], ...overrides,
})

/** A diagnosis that stops on the operator's business decision instead of proposing work. */
const asksForBusinessDecision = (humanReason = 'Which release channel?') => safeDecision({
  recoverable: false, strategy: 'NONE', requiresHuman: true, humanReason, paths: [], commands: [],
  requiredAuthority: ['BUSINESS_DECISION'],
})

const answeredStaging = (taskId: string, generation: number, decision = 'staging'): AnsweredHumanAction =>
  ({ type: 'BUSINESS_DECISION', sessionId: 'S-auto', taskId, generation, decision })

/** The resume that answers the pending business decision exactly like the runtime path does. */
const answerWith = (f: Awaited<ReturnType<typeof fixture>>, answered: AnsweredHumanAction) => f.runner.run(
  f.task, { decision: answered.decision, taskId: answered.taskId, generation: answered.generation }, undefined,
  { ...f.context, taskStateV2: f.snapshot(), recoveryInstructions: [...(f.context.recoveryInstructions ?? []), answered.decision], answeredHumanAction: answered })

async function fixture(options: { failRecovery?: boolean; invalidEvidence?: boolean; wrongCwd?: boolean; noPlan?: boolean; decision?: AutonomousDiagnosisDecision; decisionSequence?: readonly AutonomousDiagnosisDecision[]; failDiagnosis?: boolean; failFirstDiagnosis?: boolean; goldenFixMakesProgress?: boolean; noOpAttempts?: number; taskOverrides?: Partial<WorkSessionTask> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'novawing-autonomy-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'node -e "process.exit(0)"', 'custom-check': 'node --test tests/counter.test.js' } }))
  await writeFile(join(root, 'src/counter.js'), 'export const count = () => "?"\n')
  if (!options.noPlan) await writeFile(join(root, 'tests/counter.test.js'), 'export {}\n')
  const task: WorkSessionTask = { id: 'T-auto', goal: 'Fix the counter label', constraints: ['Keep tests unchanged'], acceptanceCriteria: ['counter shows X / Y'],
    allowedPaths: ['src/**'], forbiddenPaths: ['tests/**'], ...options.taskOverrides }
  const agents = [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }]
  let revision = 0
  const actions: { action: string; path: string | undefined; instructions: readonly string[] }[] = []
  const diagnosed: AutonomousDiagnosisEvidence[] = []
  const events = new TaskEventLogV2()
  let persisted: TaskStateV2 | undefined
  let pauseOnAdvanced = false
  const dispatcher: V2ActionDispatcher = {
    async inspectRepository() { return { repositoryIdentity: root, branch: 'main', headSha: 'head-1', changedFiles: revision === 0 ? [] : ['src/counter.js'], worktreeFingerprint: `fp-${revision}` } },
    async dispatch(input) {
      actions.push({ action: input.action, path: input.task.execution?.path, instructions: input.recoveryInstructions ?? [] })
      if (input.action === 'EXECUTE') {
        const count = actions.filter((item) => item.action === 'EXECUTE').length
        if (count <= (options.noOpAttempts ?? 0)) return { status: 'BLOCKED', summary: 'No workspace inspection.', blockers: ['NO_OP_EXECUTION: no inspection'] }
        if (count !== 2 || options.goldenFixMakesProgress) revision += 1
        return { status: 'SUCCESS', summary: count === 2 ? 'The second attempt produced no changes.' : `Executor output ${count}`, changedFiles: ['src/counter.js'] }
      }
      const failed = input.task.execution?.path === 'GOLDEN' || options.failRecovery
      return { status: 'SUCCESS', verificationResults: input.task.verificationPlan!.steps.map((step) => ({
        name: step.command, command: step.command, stepId: options.invalidEvidence && !failed ? `wrong-${step.id}` : step.id, cwd: options.wrongCwd && !failed ? 'foreign' : step.cwd,
        status: failed ? 'failed' : 'passed', ...(failed ? { classification: 'CODE_FAILURE' as const, details: 'counter expected X / Y', exitCode: 1, rawOutputRef: 'output.txt' } : { exitCode: 0 }),
      })) }
    },
  }
  const recovery: AutonomousRecoveryOptions = {
    inspectDiff: async () => 'diff --git a/src/counter.js b/src/counter.js\n-?\n+X / ?',
    readVerificationOutput: async () => '[stdout]\nrun counter test\n[stderr]\nassertion failed: X / Y',
    diagnose: async (evidence) => { diagnosed.push(evidence); if (options.failDiagnosis || (options.failFirstDiagnosis && diagnosed.length === 1)) throw new Error('offline')
      return options.decisionSequence?.[Math.min(diagnosed.length - 1, options.decisionSequence.length - 1)] ?? options.decision ?? safeDecision() },
  }
  const runner = new GoldenPathTaskRunner({ sessionId: 'S-auto', branch: 'main', agents, dispatcher, repositoryRoot: root, autonomousRecovery: recovery,
    fallbackRunner: new V2ControllerTaskRunner({ sessionId: 'S-auto', branch: 'main', agents, dispatcher }) })
  const context: WorkSessionTaskRunContext = { taskEventLog: events, recoveryInstructions: ['只修改 src，不修改 tests'],
    persistTaskStateV2: async (state) => { persisted = loadTaskStateV2(JSON.parse(JSON.stringify(state))) },
    shouldPauseAutonomousWork: () => pauseOnAdvanced && persisted?.autonomousRecovery?.phase === 'ADVANCED' }
  return { root, task, runner, context, events, actions, diagnosed, snapshot: () => persisted!, pause: () => { pauseOnAdvanced = true }, unpause: () => { pauseOnAdvanced = false } }
}

test('v0.3.1 Golden no-progress diagnoses with both outputs and verifier evidence, then reuses bounded Controller', async () => {
  const f = await fixture()
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'COMPLETED', JSON.stringify(result))
    assert.deepEqual(f.actions.map(({ action, path }) => `${path}:${action}`), ['GOLDEN:EXECUTE', 'GOLDEN:VERIFY', 'GOLDEN:EXECUTE', 'CONTROLLER:EXECUTE', 'CONTROLLER:VERIFY'])
    assert.deepEqual(f.events.events.filter((event) => ['GOLDEN_EXHAUSTED', 'AUTONOMOUS_DIAGNOSIS', 'ADVANCED_RECOVERY'].includes(event.type)).map((event) => event.type), ['GOLDEN_EXHAUSTED', 'AUTONOMOUS_DIAGNOSIS', 'ADVANCED_RECOVERY'])
    assert.equal(f.diagnosed.length, 1)
    const evidence = f.diagnosed[0]!
    assert.equal(evidence.task.autonomousRecovery?.goldenExecuteCount, 2)
    assert.equal(evidence.task.autonomousRecovery?.goldenVerifyCount, 1)
    assert.deepEqual(evidence.task.autonomousRecovery?.executorHistory.map((item) => item.summary), ['Executor output 1', 'The second attempt produced no changes.'])
    assert.equal(evidence.task.autonomousRecovery?.verificationHistory[0]?.[0]?.exitCode, 1)
    assert.match(evidence.verifierOutputs[0]!.output, /\[stderr\]/u)
    assert.match(evidence.diff, /src\/counter.js/u)
    assert.equal(evidence.task.gitState.headSha, 'head-1')
    assert.equal(evidence.task.execution?.startCheckpoint?.worktreeFingerprint, 'fp-0')
    assert.deepEqual(evidence.recoveryInstructions, ['只修改 src，不修改 tests'])
    assert.equal(result.taskStateV2?.actionBudget?.recoveryConsumed, 3)
    assert.equal(result.taskStateV2?.autonomousRecovery?.phase, 'COMPLETED')
    assert.ok(f.actions.at(-2)!.instructions.includes(safeDecision().instructions))
    assert.deepEqual(result.taskStateV2?.permissions, { allowedPaths: ['src/**'], forbiddenPaths: ['tests/**'] })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const [label, decision] of [
  ['expanded allowed paths', safeDecision({ requiredAuthority: ['EXPAND_ALLOWED_PATHS'], paths: ['docs/counter.md'] })],
  ['forbidden tests', safeDecision({ paths: ['tests/counter.test.js'] })],
  ['unapproved command', safeDecision({ commands: ['npm install'] })],
  ['destructive action', safeDecision({ requiredAuthority: ['DESTRUCTIVE_ACTION'] })],
  ['remote history', safeDecision({ requiredAuthority: ['REMOTE_HISTORY'] })],
  ['credential', safeDecision({ requiredAuthority: ['CREDENTIALS'] })],
  ['business choice', safeDecision({ requiredAuthority: ['BUSINESS_DECISION'] })],
] as const) {
  test(`v0.3.1 diagnosis refuses ${label} without advanced dispatch`, async () => {
    const f = await fixture({ decision })
    try {
      const result = await f.runner.run(f.task, undefined, undefined, f.context)
      assert.equal(result.status, 'HUMAN_REQUIRED')
      assert.equal(result.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
      assert.equal(f.diagnosed.length, 1)
      assert.equal(f.actions.filter((item) => item.path === 'CONTROLLER').length, 0)
      assert.equal(result.taskStateV2?.actionBudget?.recoveryConsumed, 1)
      assert.deepEqual(result.taskStateV2?.permissions.allowedPaths, ['src/**'])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('v0.3.1 recovery shares the four-action budget and restart cannot grant more', async () => {
  const f = await fixture({ failRecovery: true })
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.humanRequired?.category, 'ACTION_BUDGET_EXHAUSTED')
    assert.equal(result.taskStateV2?.actionBudget?.recoveryConsumed, 4)
    const actionCount = f.actions.length
    const resumed = await f.runner.run(f.task, { decision: 'try again' }, undefined, { ...f.context, taskStateV2: f.snapshot() })
    assert.equal(resumed.status, 'HUMAN_REQUIRED')
    assert.equal(f.actions.length, actionCount)
    assert.equal(f.diagnosed.length, 1)
    assert.equal(resumed.taskStateV2?.actionBudget?.recoveryConsumed, 4)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 paused Advanced resumes existing recovery budget and never restarts Golden', async () => {
  const f = await fixture()
  try {
    f.pause()
    const paused = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(paused.status, 'PAUSED')
    assert.equal(f.snapshot().actionBudget?.recoveryConsumed, 1)
    assert.equal(f.snapshot().autonomousRecovery?.phase, 'ADVANCED')
    f.unpause()
    const resumed = await f.runner.run(f.task, undefined, undefined, { ...f.context, taskStateV2: f.snapshot() })
    assert.equal(resumed.status, 'COMPLETED')
    assert.equal(f.diagnosed.length, 1)
    assert.equal(f.actions.filter((item) => item.action === 'EXECUTE' && item.path === 'GOLDEN').length, 2)
    assert.equal(resumed.taskStateV2?.actionBudget?.recoveryConsumed, 3)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 failed diagnosis charges durably before each explicit retry', async () => {
  const f = await fixture({ failDiagnosis: true })
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    for (let attempt = 2; attempt <= 5; attempt++) {
      await f.runner.run(f.task, { recovery: 'diagnose' }, undefined, { ...f.context, taskStateV2: f.snapshot() })
      assert.equal(f.snapshot().actionBudget?.recoveryConsumed, Math.min(attempt, 4))
    }
    assert.equal(f.diagnosed.length, 4)
    assert.equal(f.snapshot().actionBudget?.recoveryExhausted, true)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 insufficient planning diagnoses before Human Required without widening scope', async () => {
  const f = await fixture({ noPlan: true, decision: safeDecision({ strategy: 'REPLAN_VERIFICATION' }) })
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(f.diagnosed.length, 1)
    assert.equal(f.diagnosed[0]!.category, 'PLANNING_REQUIRED')
    assert.equal(f.actions.length, 0)
    assert.equal(result.taskStateV2?.actionBudget?.recoveryConsumed, 2)
    assert.deepEqual(result.taskStateV2?.permissions.allowedPaths, ['src/**'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 structured diagnosis rejects prose or unsupported permission fields', async () => {
  const f = await fixture()
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(validateAutonomousDiagnosis({ ...safeDecision(), allowedPaths: ['**'] }, f.snapshot()).ok, false)
    const diagnose = createAutonomousDiagnosisRunner({ runner: async (request) => {
      assert.equal(request.targetRepo, f.root)
      assert.match(request.user, /Executor output 1/u)
      return { text: 'Looks safe, continue!' }
    } })
    await assert.rejects(diagnose(f.diagnosed[0]!))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 both Golden verification attempts remain bounded before Advanced', async () => {
  const f = await fixture({ goldenFixMakesProgress: true })
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'COMPLETED')
    assert.equal(f.actions.filter((item) => item.path === 'GOLDEN' && item.action === 'EXECUTE').length, 2)
    assert.equal(f.actions.filter((item) => item.path === 'GOLDEN' && item.action === 'VERIFY').length, 2)
    assert.equal(f.diagnosed[0]!.task.autonomousRecovery?.verificationHistory.length, 2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 two Golden NO_OP results diagnose before the first Human Required', async () => {
  const f = await fixture({ noOpAttempts: 2 })
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'COMPLETED')
    assert.equal(f.diagnosed[0]!.category, 'EXECUTOR_NO_PROGRESS_AFTER_RETRY')
    assert.equal(f.diagnosed[0]!.task.autonomousRecovery?.goldenExecuteCount, 2)
    assert.equal(f.diagnosed[0]!.task.autonomousRecovery?.goldenVerifyCount, 0)
    assert.equal(f.events.count('ADVANCED_RECOVERY'), 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 user instruction retry after failed diagnosis keeps the already-used budget', async () => {
  const f = await fixture({ failFirstDiagnosis: true })
  try {
    const first = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(first.status, 'HUMAN_REQUIRED')
    assert.equal(f.snapshot().actionBudget?.recoveryConsumed, 1)
    const instruction = 'Inspect stderr and only fix src/counter.js.'
    const resumed = await f.runner.run(f.task, { decision: instruction }, undefined, { ...f.context, recoveryInstructions: [instruction], taskStateV2: f.snapshot() })
    assert.equal(resumed.status, 'COMPLETED', JSON.stringify(resumed.humanRequired))
    assert.deepEqual(f.diagnosed[1]!.recoveryInstructions, [instruction])
    assert.equal(resumed.taskStateV2?.actionBudget?.recoveryConsumed, 4)
    assert.equal(f.actions.filter((item) => item.path === 'GOLDEN' && item.action === 'EXECUTE').length, 2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const options of [{ invalidEvidence: true }, { wrongCwd: true }]) {
  test(`v0.3.1 Advanced preserves verifier identity/cwd contract: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options)
    try {
      const result = await f.runner.run(f.task, undefined, undefined, f.context)
      assert.equal(result.status, 'HUMAN_REQUIRED')
      assert.notEqual(result.taskStateV2?.status, 'COMPLETED')
      assert.equal(result.completionEvidence, undefined)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
}

test('v0.3.1 unsupported verifier plan diagnoses safely and never becomes an approval capability', async () => {
  const f = await fixture({ decision: safeDecision({ strategy: 'REPLAN_VERIFICATION' }), taskOverrides: {
    acceptanceEvidenceBindings: [{ criterion: 'counter shows X / Y', requiredEvidence: ['custom-verifier --counter'] }],
  } })
  try {
    const result = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(f.diagnosed.length, 1)
    assert.equal(result.pendingVerificationCommand, undefined)
    assert.equal(f.actions.length, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.3.1 exact verifier approval resumes a suspended pre-execution Golden boundary', async () => {
  const f = await fixture({ taskOverrides: { acceptanceEvidenceBindings: [{ criterion: 'counter shows X / Y', requiredEvidence: ['npm run custom-check'] }] } })
  try {
    const first = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(first.humanRequired?.category, 'APPROVAL_REQUIRED')
    assert.equal(f.actions.length, 0)
    assert.equal(f.diagnosed.length, 0)
    const resumed = await f.runner.run(f.task, { approval: true }, undefined, {
      ...f.context, taskStateV2: first.taskStateV2!, approvedVerificationCommand: 'npm run custom-check',
    })
    assert.equal(resumed.status, 'COMPLETED', JSON.stringify(resumed.humanRequired))
    assert.equal(f.actions.filter((item) => item.path === 'GOLDEN' && item.action === 'EXECUTE').length, 2)
    assert.equal(f.diagnosed.length, 1, 'the only diagnosis is after Golden exhaustion, never for the pending approval')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 a business decision yields a structured pending action while authority requests stay manual', async () => {
  const business = await fixture({ decision: safeDecision({ requiredAuthority: ['BUSINESS_DECISION'] }) })
  try {
    const result = await business.runner.run(business.task, undefined, undefined, business.context)
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
    assert.deepEqual(result.pendingHumanAction, { type: 'BUSINESS_DECISION', prompt: safeDecision().diagnosis })
    assert.equal(business.actions.filter((item) => item.path === 'CONTROLLER').length, 0)
  } finally { await rm(business.root, { recursive: true, force: true }) }
  for (const decision of [
    safeDecision({ requiredAuthority: ['EXPAND_ALLOWED_PATHS'], paths: ['docs/counter.md'] }),
    safeDecision({ requiredAuthority: ['COMMAND_APPROVAL'], commands: ['npm install'] }),
  ]) {
    const scoped = await fixture({ decision })
    try {
      const result = await scoped.runner.run(scoped.task, undefined, undefined, scoped.context)
      assert.equal(result.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
      assert.equal(result.pendingHumanAction, undefined)
    } finally { await rm(scoped.root, { recursive: true, force: true }) }
  }
})

test('v0.4.0 an answered business decision is consumed by diagnosis and reaches the executor', async () => {
  const f = await fixture({ decisionSequence: [asksForBusinessDecision(), safeDecision()] })
  try {
    const first = await f.runner.run(f.task, undefined, undefined, f.context)
    assert.equal(first.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
    assert.equal(first.pendingHumanAction?.type, 'BUSINESS_DECISION')
    assert.equal(f.diagnosed[0]!.answeredHumanAction, undefined, 'nothing was answered yet')

    const answered = answeredStaging(f.task.id, 1)
    const resumed = await answerWith(f, answered)

    // A: the answer is asked again? No — it becomes typed, identity-bound evidence
    // before the diagnosis runs, and the diagnosis is expected to act on it.
    assert.deepEqual(f.diagnosed[1]!.answeredHumanAction, answered)
    assert.equal(f.diagnosed[1]!.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
    // A: the recovery is consumed instead of minting a second identical page.
    assert.equal(resumed.status, 'COMPLETED', JSON.stringify(resumed.humanRequired))
    assert.equal(resumed.pendingHumanAction, undefined)
    assert.equal(resumed.taskStateV2?.autonomousRecovery?.phase, 'COMPLETED')

    // B: the Executor really ran again, and it really received the operator's answer.
    const advanced = f.actions.filter((item) => item.path === 'CONTROLLER' && item.action === 'EXECUTE')
    assert.equal(advanced.length, 1)
    assert.ok(advanced[0]!.instructions.includes('staging'), JSON.stringify(advanced[0]!.instructions))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 a repeated BUSINESS_DECISION after the operator answered fails closed instead of looping', async () => {
  const f = await fixture({ decisionSequence: [asksForBusinessDecision(), asksForBusinessDecision()] })
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    const resumed = await answerWith(f, answeredStaging(f.task.id, 1))

    assert.equal(resumed.status, 'HUMAN_REQUIRED')
    assert.equal(resumed.humanRequired?.category, 'RECOVERY_BLOCKED')
    assert.match(resumed.humanRequired!.reason, /diagnosis requested an already answered BUSINESS_DECISION/u)
    // No same-type pending action, so the Runtime never renders the decision page again.
    assert.equal(resumed.pendingHumanAction, undefined)
    assert.equal(f.actions.filter((item) => item.path === 'CONTROLLER').length, 0)

    // The blocked state cannot be walked back into diagnosis by answering again.
    const again = await answerWith(f, answeredStaging(f.task.id, 1, 'production'))
    assert.equal(f.diagnosed.length, 2)
    assert.equal(again.humanRequired?.category, 'RECOVERY_BLOCKED')
    assert.equal(again.pendingHumanAction, undefined)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 an answered business decision never re-opens itself while other authorities still block', async () => {
  const f = await fixture({ decisionSequence: [
    asksForBusinessDecision(),
    safeDecision({ requiredAuthority: ['BUSINESS_DECISION', 'EXPAND_ALLOWED_PATHS'], paths: ['docs/counter.md'] }),
  ] })
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    const answered = answeredStaging(f.task.id, 1)
    const resumed = await answerWith(f, answered)

    // The already answered decision is not asked again ...
    assert.equal(resumed.pendingHumanAction, undefined)
    assert.equal(resumed.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
    assert.doesNotMatch(resumed.humanRequired!.reason, /BUSINESS_DECISION/u)
    // ... but EXPAND_ALLOWED_PATHS is still an independent authority blocker.
    assert.match(resumed.humanRequired!.reason, /EXPAND_ALLOWED_PATHS/u)
    // Answering the business decision never hands over the other permission.
    assert.equal(f.actions.filter((item) => item.path === 'CONTROLLER').length, 0)
    assert.deepEqual(resumed.taskStateV2?.permissions.allowedPaths, ['src/**'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 an unrelated authority failure after an answered decision keeps its own reason', async () => {
  const f = await fixture({ decisionSequence: [asksForBusinessDecision(), safeDecision({ paths: ['tests/counter.test.js'] })] })
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    const resumed = await answerWith(f, answeredStaging(f.task.id, 1))

    // The diagnosis never re-asked the business decision, so the guard must not claim it did.
    assert.equal(resumed.humanRequired?.category, 'RECOVERY_REQUIRES_AUTHORIZATION')
    assert.match(resumed.humanRequired!.reason, /超出当前路径授权/u)
    assert.doesNotMatch(resumed.humanRequired!.reason, /already answered/u)
    assert.equal(resumed.pendingHumanAction, undefined)
    assert.deepEqual(resumed.taskStateV2?.permissions.allowedPaths, ['src/**'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 the diagnosis request carries the typed answered business decision as settled fact', async () => {
  const f = await fixture()
  try {
    await f.runner.run(f.task, undefined, undefined, f.context)
    const requests: { system: string; user: string }[] = []
    const diagnose = createAutonomousDiagnosisRunner({ runner: async (request) => {
      requests.push({ system: request.system, user: request.user })
      return { text: JSON.stringify(safeDecision()) }
    } })
    await diagnose({ ...f.diagnosed[0]!, answeredHumanAction: answeredStaging(f.task.id, 1) })

    assert.match(requests[0]!.user, /"answeredHumanAction":\{"type":"BUSINESS_DECISION"/u)
    assert.match(requests[0]!.user, /"decision":"staging"/u)
    assert.match(requests[0]!.system, /never put BUSINESS_DECISION into requiredAuthority again/u)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
