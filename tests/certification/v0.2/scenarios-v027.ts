import { buildVerificationResult } from '../../../packages/development-guardian/verification-evidence.js'
import { WorkSessionControlController } from '../../../packages/development-guardian/work-session/control-ui/controller.js'
import type { WorkSessionControlRuntime } from '../../../packages/development-guardian/work-session/control-ui/events.js'
import {
  TaskController, TaskEventLogV2, V2ControllerTaskRunner, createTaskStateV2, detectCyclicNoProgress,
  type TaskStateV2, type WorkSessionDefinition, type WorkSessionDurableState,
} from '../../../packages/development-guardian/work-session/index.js'
import type { GuardianProgressObserver } from '../../../packages/development-guardian/progress.js'
import type { CertificationScenario } from './scenario.js'
import { implementerAgent } from './scenario.js'

const definition: WorkSessionDefinition = { id: 'cert-v027', targetRepo: 'repo', branch: 'main', tasks: [], limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 }, controlPlane: 'v2' }
const work = { id: 'T1', goal: 'filter tickets', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['npm test'] }] }
const repo = (fingerprint = 'w', changedFiles: readonly string[] = []) => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: fingerprint })
const failed = (classification: NonNullable<import('../../../packages/development-guardian/model.js').VerificationResult['classification']>) => ({ name: 'npm test', status: 'failed' as const, classification })
function activeFailure(classification: Parameters<typeof failed>[0]): TaskStateV2 {
  const initial = createTaskStateV2({ id: definition.id, branch: 'main' }, work)
  return { ...initial, status: 'ACTIVE', gitState: repo(), verificationState: { results: [failed(classification)] } }
}
function completeableBudgetState(overrides: Partial<NonNullable<TaskStateV2['actionBudget']>>): TaskStateV2 {
  const initial = createTaskStateV2({ id: definition.id, branch: 'main' }, work)
  return { ...initial, status: 'SUSPENDED', currentAction: 'SUSPEND', gitState: repo(),
    verificationState: { results: [{ name: 'npm test', status: 'passed' }] },
    completion: { ...initial.completion, evidence: [{ type: 'npm test', status: 'PASSED', source: 'deterministic', repositoryIdentity: 'repo', branch: 'main', headSha: 'h', workspaceIdentity: 'w', timestamp: 'now' }] },
    actionBudget: { ...initial.actionBudget!, originalConsumed: 20, originalExhausted: true, ...overrides } }
}

export const s70: CertificationScenario = { id: 'S70', title: 'Environment verifier failure does not redispatch implementation', group: 'control', run({ h }) {
  const evidence = buildVerificationResult({ command: 'npm test', result: { exitCode: 1, signal: null, stdout: '', stderr: 'psycopg OperationalError: connection to 127.0.0.1:5432 failed: connection refused' }, durationMs: 1 })
  h.check(evidence.classification === 'ENVIRONMENT_FAILURE', 'PostgreSQL refusal is environment failure')
  h.check(new TaskController().decide({ ...activeFailure('ENVIRONMENT_FAILURE'), verificationState: { results: [evidence] } }).action === 'SUSPEND', 'environment failure never selects EXECUTE')
} }
export const s71: CertificationScenario = { id: 'S71', title: 'A deterministic code failure still retries EXECUTE', group: 'control', run({ h }) { h.check(new TaskController().decide(activeFailure('CODE_FAILURE')).action === 'EXECUTE', 'code failure selects EXECUTE') } }
export const s72: CertificationScenario = { id: 'S72', title: 'Verifier configuration failure uses configuration path', group: 'control', run({ h }) { const d = new TaskController().decide(activeFailure('VERIFIER_CONFIGURATION_FAILURE')); h.check(d.action === 'SUSPEND' && d.reasonCode === 'VERIFIER_CONFIGURATION_FAILURE', 'configuration failure suspends safely') } }
export const s73: CertificationScenario = { id: 'S73', title: 'Unrelated suite failure is not attributed to implementation', group: 'control', run({ h }) { const d = new TaskController().decide(activeFailure('UNRELATED_TEST_FAILURE')); h.check(d.action === 'SUSPEND' && d.reasonCode === 'UNRELATED_TEST_FAILURE', 'unrelated failure never selects EXECUTE') } }
export const s74: CertificationScenario = { id: 'S74', title: 'No-change EXECUTE preserves original failure context', group: 'control', run({ h }) { const state = activeFailure('CODE_FAILURE'); const next = new TaskController().applyResult(state, 'EXECUTE', { status: 'SUCCESS', repositoryChanged: false, implementationEvidenceAdded: false }); h.check(next.verificationState.results[0]?.classification === 'CODE_FAILURE', 'original verification failure remains') } }
export const s75: CertificationScenario = { id: 'S75', title: 'A-B-A-B unchanged reality is cyclic no-progress', group: 'control', run({ h }) { const cycle = detectCyclicNoProgress(['VERIFY:EVIDENCE_MISSING', 'EXECUTE:VERIFICATION_FAILED', 'VERIFY:EVIDENCE_MISSING', 'EXECUTE:VERIFICATION_FAILED'].map((decisionKey) => ({ decisionKey, realityKey: 'unchanged' }))); h.check(cycle?.cycles === 2 && cycle.pattern.length === 2, 'two complete cycles are detected') } }
export const s76: CertificationScenario = { id: 'S76', title: 'Repository/evidence progress prevents cyclic false positives', group: 'control', run({ h }) { const cycle = detectCyclicNoProgress([{ decisionKey: 'A', realityKey: 'w1' }, { decisionKey: 'B', realityKey: 'w1' }, { decisionKey: 'A', realityKey: 'w2' }, { decisionKey: 'B', realityKey: 'w2' }]); h.check(cycle === undefined, 'changed reality resets cycle detection') } }
export const s77: CertificationScenario = { id: 'S77', title: 'Action-budget recovery grants four actions and continues', group: 'recovery', async run({ h }) {
  const log = new TaskEventLogV2(); const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: 'main', agents: [implementerAgent()], dispatcher: { inspectRepository: async () => repo(), dispatch: async () => ({ status: 'SUCCESS' }) } })
  const result = await runner.run(work, { decision: 'continue once' }, undefined, { taskStateV2: completeableBudgetState({}), taskEventLog: log })
  h.check(result.status === 'COMPLETED' && result.taskStateV2?.actionBudget?.recoveryLimit === 4, 'bounded recovery genuinely continues')
  h.check(log.count('RECOVERY_BUDGET_GRANTED') === 1, 'grant is durable audit')
} }
export const s78: CertificationScenario = { id: 'S78', title: 'Recovery action budget has a one-grant hard limit', group: 'recovery', async run({ h }) {
  const log = new TaskEventLogV2(); const runner = new V2ControllerTaskRunner({ sessionId: definition.id, branch: 'main', agents: [implementerAgent()], dispatcher: { inspectRepository: async () => repo(), dispatch: async () => ({ status: 'SUCCESS' }) } })
  const result = await runner.run(work, { decision: 'grant again' }, undefined, { taskStateV2: completeableBudgetState({ recoveryGranted: true, recoveryConsumed: 4, recoveryExhausted: true }), taskEventLog: log })
  h.check(result.humanRequired?.category === 'ACTION_BUDGET_EXHAUSTED', 'second grant is terminal')
  h.check(log.count('RECOVERY_BUDGET_GRANTED') === 0, 'no second grant is recorded')
} }

async function real002Run() {
  let fingerprint = 'w0'; let executes = 0; let verifies = 0; const log = new TaskEventLogV2()
  const runner = new V2ControllerTaskRunner({ sessionId: 'cert-real002', branch: 'main', agents: [implementerAgent()], dispatcher: {
    inspectRepository: async () => repo(fingerprint, fingerprint === 'w0' ? [] : ['ticket.ts']),
    dispatch: async ({ action }) => { if (action === 'EXECUTE') { executes++; fingerprint = 'w1'; return { status: 'SUCCESS' } } verifies++; return { status: 'FAILED', verificationResults: [failed('ENVIRONMENT_FAILURE')] } },
  } })
  const result = await runner.run(work, undefined, undefined, { taskEventLog: log })
  return { result, executes, verifies, actions: log.count('AGENT_DISPATCHED'), log }
}
export const s79: CertificationScenario = { id: 'S79', title: 'REAL-002 canonical regression converges below 20 actions', group: 'control', async run({ h }) { const run = await real002Run(); h.check(run.executes === 1 && run.verifies === 1 && run.actions === 2, 'one EXECUTE plus one VERIFY'); h.check(run.result.humanRequired?.category === 'ENVIRONMENT_REQUIRED', 'final state requests environment recovery') } }

class ActivityRuntime implements WorkSessionControlRuntime {
  state: WorkSessionDurableState = { sessionId: definition.id, state: 'RUNNING', currentTaskIndex: 0, currentTaskId: 'T1', completedTaskIds: [], createdAt: new Date(0), updatedAt: new Date(0), activeElapsedMs: 0, activeSegmentStartedAt: 1_000 }
  async loadPersistedState() { return this.state } async start() { return this.state } async resume() { return this.state }
  requestPause() { return { accepted: false } } requestStopAfterTask() { return { accepted: false } } getControlIntents() { return { pauseRequested: false, stopAfterTaskRequested: false } }
  getDurableState() { return this.state } getDefinition() { return definition } hasActiveExecution() { return true }
}
function activityFixture() {
  const runtime = new ActivityRuntime(); let sink: GuardianProgressObserver | undefined; let now = 1_000
  const controller = new WorkSessionControlController({ createRuntime: (eventSink) => { sink = eventSink; return runtime }, clock: { now: () => now }, pollIntervalMs: 60_000 })
  return { runtime, controller, emit: (event: Parameters<GuardianProgressObserver>[0]) => sink!(event), advance: (ms: number) => { now += ms } }
}
export const s80: CertificationScenario = { id: 'S80', title: 'Executor produces a structured Activity Feed', group: 'control', run({ h }) { const f = activityFixture(); try { f.emit({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'PROVIDER_DISPATCHED', provider: 'codex' } }); h.check(f.controller.getSnapshot().executionActivity?.items.length === 1, 'structured activity is visible') } finally { f.controller.close() } } }
export const s81: CertificationScenario = { id: 'S81', title: 'Heartbeat updates elapsed and idle status without durable writes', group: 'control', run({ h }) { const f = activityFixture(); try { f.emit({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'PROVIDER_DISPATCHED' } }); const before = f.controller.getSnapshot().executionActivity!; f.advance(180_000); const after = f.controller.getSnapshot().executionActivity!; h.check(after.elapsedMs > before.elapsedMs && after.idleStatus === 'QUIET', 'heartbeat advances presentation') } finally { f.controller.close() } } }
export const s82: CertificationScenario = { id: 'S82', title: 'Activity Feed rejects hidden reasoning and secrets', group: 'risk', run({ h }) { const f = activityFixture(); try { f.emit({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, detail: 'chain of thought password=hunter2', activity: { kind: 'PROVIDER_DISPATCHED', provider: 'codex;token=secret' } }); const json = JSON.stringify(f.controller.getSnapshot().executionActivity); h.check(!/hunter2|chain of thought|secret/iu.test(json), 'only allowlisted facts cross the UI boundary') } finally { f.controller.close() } } }
export const s83: CertificationScenario = { id: 'S83', title: 'Heartbeat changes neither Task State nor Controller decision', group: 'risk', run({ h }) { const f = activityFixture(); try { const before = JSON.stringify(f.runtime.state); f.advance(360_000); f.controller.getSnapshot(); h.check(JSON.stringify(f.runtime.state) === before, 'heartbeat is ephemeral') } finally { f.controller.close() } } }
export const s84: CertificationScenario = { id: 'S84', title: 'EXECUTE to VERIFY phase switch is visible immediately', group: 'control', run({ h }) { const f = activityFixture(); try { f.emit({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'CONTROLLER_PHASE_CHANGED' } }); f.emit({ phase: 'VERIFYING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'CONTROLLER_PHASE_CHANGED' } }); const activity = f.controller.getSnapshot().executionActivity!; h.check(activity.currentPhase === 'VERIFYING' && activity.items.length === 2, 'phase transition is live') } finally { f.controller.close() } } }
export const s85: CertificationScenario = { id: 'S85', title: 'Long-running Executor UI is never completely silent', group: 'control', run({ h }) { const f = activityFixture(); try { f.emit({ phase: 'EXECUTING', status: 'active', iteration: 1, elapsedMs: 0, activity: { kind: 'PROVIDER_DISPATCHED' } }); f.advance(360_000); const activity = f.controller.getSnapshot().executionActivity!; h.check(activity.running && activity.items.length > 0 && activity.idleStatus === 'LONG_QUIET', 'status, feed and long-idle heartbeat remain visible') } finally { f.controller.close() } } }
