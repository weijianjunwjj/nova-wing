/**
 * NovaWing v0.2 certification — recovery scenarios.
 * S09 restart recovery · S10 provider failover · S14 event-log authority safety
 */
import type { CertificationScenario } from './scenario.js'
import { implementerAgent, fileContentCmd as contentCmd } from './scenario.js'
import { buildTrustedConfig, createCertProductionApp } from './harness.js'
import { initFixtureRepo, repoWrite, headSha } from './util.js'
import { successResult, blockedResult, verifyByCommand } from './provider.js'
import type { DispatchCtx } from './provider.js'
import type { WorkSessionDurableState } from '../../../packages/development-guardian/work-session/model.js'
import { createTaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import type { TaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import { V2ControllerTaskRunner } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { WorkSessionRuntimeConfig } from '../../../packages/development-guardian/work-session/runtime.js'
import { TaskEventLogV2 } from '../../../packages/development-guardian/work-session/task-observability.js'
import { classifyCodexError } from '../../../packages/development-guardian/codex-error.js'
import { createProductionWorkSessionUi } from '../../../packages/development-guardian/work-session/production.js'
import { FakeRuntime } from '../../work-session-w005-a-helpers.js'

export const s09: CertificationScenario = {
  id: 'S09',
  title: 'Restart recovery: load TaskStateV2, inspect/reconcile the repo, re-decide and continue to completion',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/restart.ts': 'export const ready = false\n' })
    const GOOD = 'export const ready = true\n'
    const binding = { criterion: 'ready', requiredEvidence: [contentCmd(repo, 'src/restart.ts', GOOD)], requiresApproval: true }
    const agents = [implementerAgent()]
    let executes = 0
    const provider = async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') { executes++; await repoWrite(repo, 'src/restart.ts', GOOD); return successResult() }
      if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
      return blockedResult([`unexpected action ${action}`])
    }
    const config = await buildTrustedConfig({ sessionId: `s09-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'enable restart flag and await approval', acceptanceCriteria: ['ready'], allowedPaths: ['src/**'], bindings: [binding] }] })

    const first = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    let firstState: WorkSessionDurableState
    try {
      firstState = await first.runtime.start()
      h.check(firstState.state === 'SUSPENDED', 'first run stops at an approval boundary after repository work')
      h.check(firstState.taskStatesV2?.T1?.status === 'SUSPENDED', 'TaskStateV2 SUSPENDED persisted mid-task')
      h.check(firstState.taskStatesV2?.T1?.gitState.headSha === await headSha(repo), 'repo reality reconciled before suspension')
    } finally {
      await first.app.close().catch(() => undefined)
    }

    // Recreate the runtime from persisted durable state (process restart).
    const second = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const resumed = await second.runtime.resume({ approval: true })
      h.check(resumed.state === 'COMPLETED', 'restarted runtime continued to completion after approval')
      const t1 = resumed.taskStatesV2?.T1
      h.check(t1?.status === 'COMPLETED', 'reloaded TaskStateV2 re-decided to COMPLETED')
      h.check(executes === 1, 'restart did not replay the EXECUTE action (no reset to PENDING)')
      h.check((resumed.taskEventLogs?.T1 ?? []).some((event) => event.type === 'TASK_RESUMED'), 'event log recorded TASK_RESUMED on restart')
      const executedDispatches = (resumed.taskEventLogs?.T1 ?? []).filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE').length
      h.check(executedDispatches === 1, `EXECUTE dispatched exactly once across restart (${executedDispatches})`)
    } finally {
      await second.app.close().catch(() => undefined)
    }
  },
}

export const s10: CertificationScenario = {
  id: 'S10',
  title: 'Provider failover: Codex quota → DeepSeek continues the same TaskStateV2; event log records the switch',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/a.ts': 'export const value = 1\n' })
    let runtime: WorkSessionRuntimeConfig | undefined
    let deepSeekCalls = 0
    let codexCalls = 0
    const config = await buildTrustedConfig({
      sessionId: `s10-${ctx.dirs.runId}`, repo,
      tasks: [{ id: 'T1', goal: 'route through the production router', acceptanceCriteria: ['verified'], allowedPaths: ['src/**'], bindings: [{ criterion: 'verified', requiredEvidence: ['test'] }] }],
    })
    config.tasks[0]!.executorMode = 'auto'
    const codex = async () => {
      codexCalls++
      await repoWrite(repo, 'src/a.ts', 'export const value = 2 // partial\n')
      const error = classifyCodexError({ code: 'quota_exhausted' })
      return { summary: 'partial', changedFiles: ['src/a.ts'], commandsRun: [], verificationResults: [], blockers: [error.message] }
    }
    const deepseekExecute = async () => {
      deepSeekCalls++
      await repoWrite(repo, 'src/a.ts', 'export const value = 2\n')
      return { summary: 'continued', changedFiles: ['src/a.ts'], commandsRun: [], verificationResults: [{ name: 'test', status: 'passed' as const }], blockers: [] }
    }
    const app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: ctx.dirs.data },
      createRuntime(value) { runtime = value; return new FakeRuntime(value.definition) },
      createCodexExecutor: () => ({ async execute() { return codex() }, lastError: classifyCodexError({ code: 'quota_exhausted' }) }),
      createExecutor: () => ({
        async execute() { return deepseekExecute() },
        async retryVerification({ report }) { return { ...report, verificationResults: report.verificationResults.map((r) => ({ ...r, status: 'passed' as const })) } },
      }),
    })
    try {
      const log = new TaskEventLogV2()
      const states: unknown[] = []
      const runner = runtime!.taskRunner
      const result = await runner.run(runtime!.definition.tasks[0]!, undefined, undefined, {
        taskEventLog: log,
        persistTaskStateV2: async (state) => { states.push(structuredClone(state)) },
      })
      h.check(result.status === 'COMPLETED', `codex→deepseek task completed (got ${result.status})`)
      h.check(result.taskStateV2?.identity.taskId === 'T1', 'same Task id continued after the provider switch')
      h.check(JSON.stringify(result.taskStateV2?.providerHistory) === JSON.stringify(['codex', 'deepseek']), 'provider history records codex then deepseek')
      h.check(deepSeekCalls === 1, `deepseek executed exactly once (${deepSeekCalls})`)
      h.check(codexCalls === 1, `codex attempted once before failover (${codexCalls})`)
      h.check(log.events.some((event) => event.type === 'PROVIDER_SWITCHED' && event.reasonCode === 'PROVIDER_QUOTA_EXHAUSTED'), 'event log recorded the codex→deepseek provider switch with quota reason')
      const allSameTask = states.every((snapshot) => (snapshot as { identity?: { taskId?: string } }).identity?.taskId === 'T1')
      h.check(allSameTask, 'every persisted snapshot belongs to the same TaskStateV2')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s14: CertificationScenario = {
  id: 'S14',
  title: 'Event log authority: a stale TASK_COMPLETED event never overrides a BLOCKED TaskStateV2',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/x.ts': 'export const x = 1\n' })
    const definition = { id: `s14-${ctx.dirs.runId}`, targetRepo: repo, branch: 'main' as const, controlPlane: 'v2' as const,
      tasks: [{ id: 'T1', goal: 'repair', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }],
      limits: { softMinutes: 5, hardMinutes: 10, maxTasks: 1 } }

    // Event log history is deliberately seeded with an old TASK_COMPLETED claim.
    const log = new TaskEventLogV2([
      { eventId: '1', taskId: 'T1', sessionId: definition.id, type: 'TASK_COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', metadata: { stale: true } },
    ])
    let dispatchCalls = 0
    const runner = new V2ControllerTaskRunner({
      sessionId: definition.id, branch: 'main',
      agents: [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }],
      dispatcher: {
        inspectRepository: async () => ({ repositoryIdentity: repo, branch: 'main', headSha: await headSha(repo), changedFiles: [], worktreeFingerprint: 'w' }),
        dispatch: async ({ action }) => {
          dispatchCalls++
          if (action === 'EXECUTE') return { status: 'BLOCKED' as const, blockers: ['external-blocker'], providerHistory: ['codex', 'deepseek'] }
          return { status: 'SUCCESS' as const, verificationResults: [{ name: 'test', status: 'passed' as const }] }
        },
      },
    })
    const initial = createTaskStateV2(definition, definition.tasks[0]!)
    // The authoritative TaskStateV2 is BLOCKED/SUSPENDED — Event Log must not recover it.
    const blocked: TaskStateV2 = { ...initial, status: 'SUSPENDED', blockers: ['external-blocker'], currentAction: 'SUSPEND' }
    const result = await runner.run(definition.tasks[0]!, undefined, undefined, { taskStateV2: blocked, taskEventLog: log })
    h.check(result.status !== 'COMPLETED', 'stale TASK_COMPLETED event must not produce a completion')
    h.check(result.taskStateV2?.status !== 'COMPLETED', 'BLOCKED TaskStateV2 wins over the stale event')
    h.check(dispatchCalls === 0, 'no action is dispatched from a BLOCKED task')
    h.check((result.taskStateV2?.blockers ?? []).includes('external-blocker'), 'the blocker still governs the decision')
    h.check(result.humanRequired?.category === 'DECISION_REQUIRED', 'controller re-decided a suspension for the blocked task')
    h.check(log.events.some((event) => event.type === 'TASK_COMPLETED' && event.eventId === '1'), 'the stale event remains in history (audit only)')
    h.check(!log.events.some((event) => event.type === 'TASK_COMPLETED' && event.reasonCode === 'COMPLETION_CRITERIA_SATISFIED'), 'no new completion was minted from the stale event')
  },
}

