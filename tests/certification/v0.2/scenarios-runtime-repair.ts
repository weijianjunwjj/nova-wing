/**
 * NovaWing v0.2.4 certification — Runtime AI Repair & Resume scenarios.
 * S31 no reviewer → alternate reviewer discovered → resume ·
 * S32 implementer cannot self-review · S33 all reviewers unavailable → human remains ·
 * S34 provider health refresh restores reviewer · S35 resume REVIEW without re-EXECUTE ·
 * S36 unsafe review bypass proposal rejected · S37 repair audit/events correct ·
 * S38 notification emitted
 */
import type { CertificationScenario } from './scenario.js'
import { implementerAgent, reviewerAgent, fileContentCmd as contentCmd } from './scenario.js'
import { buildTrustedConfig, createCertProductionApp } from './harness.js'
import { initFixtureRepo, repoWrite } from './util.js'
import { successResult, blockedResult, verifyByCommand, reviewEvidence, providerHealth } from './provider.js'
import type { DispatchCtx } from './provider.js'
import type { AgentCapabilityProfile } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { validateRuntimeRepairProposal, type RuntimeRepairContext } from '../../../packages/development-guardian/work-session/runtime-repair.js'
import { createRecordingRuntimeRepairAuditSink } from '../../../packages/development-guardian/work-session/runtime-repair-audit.js'
import { createRecordingRuntimeRepairNotifier } from '../../../packages/development-guardian/work-session/runtime-repair-notifier.js'

const GOOD = 'export const guard = true\n'

/** A DeepSeek independent reviewer, initially unavailable so REVIEW cannot proceed. */
function deepseekReviewer(available: boolean): AgentCapabilityProfile {
  return reviewerAgent({ provider: 'deepseek', runtimeIdentity: 'cert:deepseek-reviewer', available })
}

/** A HIGH-risk auth task + scripted provider that completes EXECUTE/VERIFY/REVIEW. */
async function buildHighRiskApp(
  ctx: { dirs: { repo: string; data: string; runId: string } },
  reviewer: AgentCapabilityProfile,
  opts: {
    refresh?: () => Promise<{ providerHealth: ReturnType<typeof providerHealth>[]; agents: AgentCapabilityProfile[] }>
    auditSink?: ReturnType<typeof createRecordingRuntimeRepairAuditSink>['sink']
    notifier?: ReturnType<typeof createRecordingRuntimeRepairNotifier>['notifier']
    onDispatch?: (action: string, agent: string) => void
  } = {},
) {
  const repo = ctx.dirs.repo
  await initFixtureRepo(repo, { 'src/auth/guard.ts': 'export const guard = false\n' })
  const binding = { criterion: 'guard enabled', requiredEvidence: [contentCmd(repo, 'src/auth/guard.ts', GOOD)] }
  const config = await buildTrustedConfig({ sessionId: `runtime-repair-${ctx.dirs.runId}-${Math.random().toString(36).slice(2, 8)}`, repo, tasks: [{ id: 'T1', goal: 'enable the auth guard', acceptanceCriteria: ['guard enabled'], allowedPaths: ['src/**'], bindings: [binding] }] })
  const agents = [implementerAgent(), reviewer]
  const provider = async ({ action, agent, task }: DispatchCtx) => {
    opts.onDispatch?.(action, agent.id)
    if (action === 'EXECUTE') { await repoWrite(repo, 'src/auth/guard.ts', GOOD); return successResult() }
    if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
    if (action === 'REVIEW') {
      return successResult({
        status: 'SUCCESS',
        review: reviewEvidence({ reviewer: agent, implementer: task.implementer, passed: true, findings: [], blockingFindings: [], files: task.gitState.changedFiles, task }),
      })
    }
    return blockedResult([`unexpected action ${action}`])
  }
  const app = await createCertProductionApp({
    config, dataDir: ctx.dirs.data, agents, provider,
    ...(opts.refresh === undefined && opts.auditSink === undefined && opts.notifier === undefined
      ? {}
      : { runtimeRepair: {
          ...(opts.refresh === undefined ? {} : { refreshProviderHealth: opts.refresh }),
          ...(opts.auditSink === undefined ? {} : { auditSink: opts.auditSink }),
          ...(opts.notifier === undefined ? {} : { notifier: opts.notifier }),
        } }),
  })
  return app
}

export const s31: CertificationScenario = {
  id: 'S31',
  title: 'Runtime Repair discovers an alternate reviewer and resumes to completion',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'AVAILABLE')], agents: [implementerAgent(), deepseekReviewer(true)] }),
    })
    try {
      const suspended = await app.runtime.start()
      h.check(suspended.state === 'SUSPENDED', 'session suspends when no reviewer is available')
      h.check(suspended.humanRequired?.category === 'ENVIRONMENT_REQUIRED', 'suspension is an environment issue')
      h.check(/no available agent for REVIEW/u.test(suspended.humanRequired?.reason ?? ''), 'reason names the missing REVIEW agent')

      const resumed = await app.runtime.repairRuntimeAndResume()
      h.check(resumed.state === 'COMPLETED', 'runtime repair resumes the session to completion')
      const review = resumed.taskStatesV2?.T1?.completion.review
      h.check(review?.reviewer.provider === 'deepseek', 'the discovered DeepSeek reviewer produced the review')
      h.check(review?.reviewer.runtimeIdentity !== review?.implementer.runtimeIdentity, 'reviewer is independent of the implementer')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s32: CertificationScenario = {
  id: 'S32',
  title: 'Implementer cannot self-review; Runtime Repair refuses',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    // Only the implementer exists; it carries review capability but the same runtime identity.
    const app = await buildHighRiskApp(ctx, reviewerAgent({ available: true, provider: 'codex', runtimeIdentity: 'cert:coder', capabilities: { review: true, reasoning: true, coding: true, verification: true } }))
    try {
      const suspended = await app.runtime.start()
      h.check(suspended.state === 'SUSPENDED', 'session suspends when only the implementer exists')

      const resumed = await app.runtime.repairRuntimeAndResume()
      h.check(resumed.state === 'SUSPENDED', 'session remains suspended after a refused repair')
      const outcome = app.runtime.getRuntimeRepairOutcome()
      h.check(outcome?.classification === 'RUNTIME_REPAIR_REQUIRES_HUMAN', 'repair requires a human')
      h.check(/NO_AVAILABLE_AGENT_FOR_REVIEW|no independent reviewer/iu.test(outcome?.reason ?? ''), 'refusal names the missing independent reviewer')
      h.check((resumed.taskStatesV2?.T1?.completion.review ?? undefined) === undefined, 'no self-review evidence is stored')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s33: CertificationScenario = {
  id: 'S33',
  title: 'All reviewers unavailable → human required remains',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'OFFLINE', 'provider offline')], agents: [implementerAgent(), deepseekReviewer(false)] }),
    })
    try {
      const suspended = await app.runtime.start()
      h.check(suspended.state === 'SUSPENDED', 'session suspends')

      const resumed = await app.runtime.repairRuntimeAndResume()
      h.check(resumed.state === 'SUSPENDED', 'session remains suspended when no reviewer is available')
      h.check(resumed.humanRequired?.category === 'ENVIRONMENT_REQUIRED', 'human required remains an environment issue')
      h.check(app.runtime.getRuntimeRepairOutcome()?.classification === 'RUNTIME_REPAIR_REQUIRES_HUMAN', 'repair requires a human')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s34: CertificationScenario = {
  id: 'S34',
  title: 'Provider health refresh restores the reviewer',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'AVAILABLE', 'restored')], agents: [implementerAgent(), deepseekReviewer(true)] }),
    })
    try {
      await app.runtime.start()
      const resumed = await app.runtime.repairRuntimeAndResume()
      h.check(resumed.state === 'COMPLETED', 'refresh restored the reviewer and the session completed')
      h.check(app.runtime.getRuntimeRepairOutcome()?.classification === 'REPAIRED', 'repair was applied')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s35: CertificationScenario = {
  id: 'S35',
  title: 'Runtime repair resumes REVIEW without re-running the Executor',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const actions: string[] = []
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'AVAILABLE')], agents: [implementerAgent(), deepseekReviewer(true)] }),
      onDispatch: (action) => { actions.push(action) },
    })
    try {
      await app.runtime.start()
      await app.runtime.repairRuntimeAndResume()
      h.check(actions.filter((action) => action === 'EXECUTE').length === 1, 'the Executor ran exactly once')
      h.check(actions.filter((action) => action === 'REVIEW').length === 1, 'REVIEW ran exactly once after repair')
      h.check(actions.indexOf('REVIEW') > actions.lastIndexOf('EXECUTE'), 'REVIEW follows the single EXECUTE')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s36: CertificationScenario = {
  id: 'S36',
  title: 'Unsafe review bypass proposal is rejected by the deterministic validator',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/auth/guard.ts': 'export const guard = false\n' })
    const implementer = implementerAgent()
    const context: RuntimeRepairContext = {
      sessionId: 's', taskId: 'T1',
      task: {
        version: 2, identity: { taskId: 'T1', sessionId: 's' }, goal: 'enable guard',
        constraints: [], acceptanceCriteria: ['guard enabled'],
        permissions: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        progress: { completedWork: [], pendingWork: [] }, decisions: [], assumptions: [], openQuestions: [], artifacts: [],
        gitState: { branch: 'main', changedFiles: ['src/auth/guard.ts'] }, verificationState: { results: [] },
        completion: { evidence: [], bindings: [] }, providerHistory: [], risk: 'NORMAL', status: 'SUSPENDED', blockers: [], updatedAt: new Date().toISOString(),
      },
      reasonCode: 'NO_AVAILABLE_AGENT_FOR_REVIEW',
      humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: 'no available agent for REVIEW' },
      implementer: implementer.identity!,
      requiredReviewerConstraints: { requireIndependentReviewer: true, excludeRuntimeIdentities: [implementer.identity!.runtimeIdentity] },
      agents: [implementer],
      providerHealth: [],
      evidence: [], blockers: [], recentEvents: [],
    }
    // Self-review (reviewer runtime identity === implementer) must be rejected.
    const selfReview = validateRuntimeRepairProposal(context, {
      reasonCode: 'NO_AVAILABLE_AGENT_FOR_REVIEW',
      mechanism: 'SELECT_INDEPENDENT_REVIEWER',
      chosenReviewer: implementer.identity!,
      refreshedProviderHealth: [],
      repairs: ['self-review'],
    })
    h.check(selfReview.ok === false, 'self-review proposal is rejected')
    const selfReviewReasons = selfReview.ok ? [] : selfReview.reasons
    h.check(selfReviewReasons.some((reason) => /self-review|independent review policy/iu.test(reason)), 'rejection names the self-review violation')

    // A reviewer named for a non-review reason code is also rejected.
    const misplaced = validateRuntimeRepairProposal({ ...context, reasonCode: 'PROVIDER_UNAVAILABLE' }, {
      reasonCode: 'PROVIDER_UNAVAILABLE',
      mechanism: 'SELECT_INDEPENDENT_REVIEWER',
      chosenReviewer: reviewerAgent().identity!,
      refreshedProviderHealth: [],
      repairs: ['reviewer for non-review issue'],
    })
    h.check(misplaced.ok === false, 'a reviewer may only be selected for a review-availability issue')
  },
}

export const s37: CertificationScenario = {
  id: 'S37',
  title: 'Runtime repair audit events are correct and never record an Executor rerun',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const recording = createRecordingRuntimeRepairAuditSink()
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'AVAILABLE')], agents: [implementerAgent(), deepseekReviewer(true)] }),
      auditSink: recording.sink,
    })
    try {
      await app.runtime.start()
      await app.runtime.repairRuntimeAndResume()
      const events = recording.entries.map((entry) => entry.event)
      const expectedEvents = ['RUNTIME_REPAIR_STARTED', 'RUNTIME_REPAIR_DIAGNOSED', 'RUNTIME_REPAIR_PROPOSED', 'RUNTIME_REPAIR_VALIDATED', 'RUNTIME_REPAIR_APPLIED', 'SESSION_RESUMED_AFTER_REPAIR'] as const
      for (const expected of expectedEvents) {
        h.check(events.includes(expected), `audit records ${expected}`)
      }
      h.check(recording.entries.every((entry) => entry.executorReran === false), 'no audit entry records an Executor rerun')
      const applied = recording.entries.find((entry) => entry.event === 'RUNTIME_REPAIR_APPLIED')
      h.check(applied?.chosenReviewer?.provider === 'deepseek', 'applied audit entry records the chosen DeepSeek reviewer')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s38: CertificationScenario = {
  id: 'S38',
  title: 'Runtime repair emits a success notification, then a completion notification',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const recording = createRecordingRuntimeRepairNotifier()
    const app = await buildHighRiskApp(ctx, deepseekReviewer(false), {
      refresh: async () => ({ providerHealth: [providerHealth('deepseek', 'AVAILABLE')], agents: [implementerAgent(), deepseekReviewer(true)] }),
      notifier: recording.notifier,
    })
    try {
      await app.runtime.start()
      await app.runtime.repairRuntimeAndResume()
      h.check(recording.notifications.length > 0, 'a runtime repair notification was emitted')
      h.check(recording.notifications[0]?.kind === 'SUCCESS', 'the first notification is a success')
      h.check(recording.notifications.some((notification) => notification.kind === 'COMPLETED'), 'a completion notification follows')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}
