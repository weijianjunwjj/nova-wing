/**
 * NovaWing v0.2.4 certification — production review runtime scenarios.
 *
 * S39 production EXECUTE → independent REVIEW → COMPLETE ·
 * S40 reviewer identity is truly independent + routing is by provider, not role ·
 * S41 reviewer is read-only (rogue write detected; write tool denied) ·
 * S42 review FAIL → Controller decides EXECUTE (not COMPLETE) ·
 * S43 reviewer OFFLINE → Runtime Repair refuses Codex self-review ·
 * S44 reviewer TIMEOUT → Runtime Repair retries REVIEW without re-running EXECUTE ·
 * S45 ReviewEvidence binds real repository facts and expires when they change ·
 * S46 restart keeps reviewer identity / provider history / evidence consistent
 */
import type { CertificationScenario, ScenarioContext } from './scenario.js'
import { fileContentCmd as contentCmd } from './scenario.js'
import { buildTrustedConfig, createCertProductionApp, type TrustedAgentSpec } from './harness.js'
import { initFixtureRepo, repoWrite, inspectRepo } from './util.js'
import { successResult, blockedResult, verifyByCommand, agentProfile } from './provider.js'
import type { DispatchCtx } from './provider.js'
import { ReviewerRuntimeRegistry } from '../../../packages/development-guardian/work-session/reviewer-runtime.js'
import type { AgentCapabilityProfile } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { TaskController } from '../../../packages/development-guardian/work-session/task-controller.js'
import { createDeepSeekReviewerRuntime } from '../../../packages/development-guardian/work-session/reviewer-adapters.js'
import { passVerdict, failVerdict, reviewerProviderFailure, scriptedReviewerRuntime } from './reviewer.js'

const GOOD = 'export const guard = true\n'
const BAD = 'export const guard = false\n'

const CODEX_IMPLEMENTER: TrustedAgentSpec = {
  id: 'codex-executor',
  provider: 'codex',
  capabilities: { coding: true, reasoning: true, verification: true },
}
const DEEPSEEK_REVIEWER: TrustedAgentSpec = {
  id: 'deepseek-reviewer',
  provider: 'deepseek',
  capabilities: { review: true, reasoning: true },
}

/** Profiles passed through the v2Agents test seam (same capability facts as the config). */
function certAgents(): readonly AgentCapabilityProfile[] {
  return [
    agentProfile({ id: 'codex-executor', provider: 'codex', runtimeIdentity: 'cert:codex-executor', capabilities: { coding: true, reasoning: true, verification: true } }),
    agentProfile({ id: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: 'cert:deepseek-reviewer', capabilities: { review: true, reasoning: true } }),
  ]
}

interface SetupOptions {
  sessionId: string
  agents?: readonly TrustedAgentSpec[]
  useConfigAgents?: boolean
  /** Capability profiles for the runner; defaults to codex implementer + deepseek reviewer. */
  profiles?: readonly AgentCapabilityProfile[]
  reviewerRegistry: ReviewerRuntimeRegistry
  runtimeRepair?: import('../../../packages/development-guardian/work-session/production.js').ProductionWorkSessionDependencies['runtimeRepair']
  onDispatch?: (action: string, agent: string) => void
  /** Skip fixture re-initialization when reopening an existing session after restart. */
  initRepo?: boolean
}

/** HIGH-risk auth task: a security-sensitive path forces an independent REVIEW. */
async function setupHighRisk(ctx: ScenarioContext, options: SetupOptions) {
  const repo = ctx.dirs.repo
  if (options.initRepo !== false) await initFixtureRepo(repo, { 'src/auth/guard.ts': BAD })
  const config = await buildTrustedConfig({
    sessionId: options.sessionId,
    repo,
    tasks: [{
      id: 'T1',
      goal: 'enable the auth guard',
      acceptanceCriteria: ['guard enabled'],
      allowedPaths: ['src/**'],
      bindings: [{ criterion: 'guard enabled', requiredEvidence: [contentCmd(repo, 'src/auth/guard.ts', GOOD)] }],
    }],
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  })
  const provider = async ({ action, task }: DispatchCtx) => {
    if (action === 'EXECUTE') { await repoWrite(repo, 'src/auth/guard.ts', GOOD); return successResult() }
    if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
    return blockedResult([`unexpected action ${action}`])
  }
  return createCertProductionApp({
    config,
    dataDir: ctx.dirs.data,
    agents: options.profiles ?? certAgents(),
    provider,
    productionReview: true,
    reviewerRegistry: options.reviewerRegistry,
    ...(options.useConfigAgents === true ? { useConfigAgents: true } : {}),
    ...(options.runtimeRepair === undefined ? {} : { runtimeRepair: options.runtimeRepair }),
    ...(options.onDispatch === undefined ? {} : { dispatcherExtras: { onDispatch: (record) => options.onDispatch!(record.action, record.agent) } }),
  })
}

export const s39: CertificationScenario = {
  id: 'S39',
  title: 'Production composition: capability profiles → EXECUTE → independent REVIEW → COMPLETE',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const reviewer = scriptedReviewerRuntime('deepseek', () => passVerdict('deepseek'))
    // Capability profiles come from the trusted config, not from a hardcoded role.
    const app = await setupHighRisk(ctx, {
      sessionId: `s39-${ctx.dirs.runId}`,
      agents: [CODEX_IMPLEMENTER, DEEPSEEK_REVIEWER],
      useConfigAgents: true,
      reviewerRegistry: new ReviewerRuntimeRegistry([reviewer.runtime]),
    })
    try {
      const durable = await app.runtime.start()
      h.check(durable.state === 'COMPLETED', `session completed through the production review path (got ${durable.state})`)
      h.check(reviewer.calls.length === 1, 'exactly one REVIEW was dispatched to the provider-agnostic reviewer runtime')
      const review = durable.taskStatesV2?.T1?.completion.review
      h.check(review?.passed === true, 'the independent review passed')
      h.check(review?.reviewer.provider === 'deepseek', 'the reviewer is the deepseek-capability profile')
      h.check(review?.implementer.agent === 'codex-executor', 'the implementer is the codex-capability profile')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s40: CertificationScenario = {
  id: 'S40',
  title: 'Reviewer runtime identity is truly independent; REVIEW routes by provider, not by role',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const reviewer = scriptedReviewerRuntime('deepseek', () => passVerdict('deepseek'))
    const sessionId = `s40-${ctx.dirs.runId}`
    const app = await setupHighRisk(ctx, {
      sessionId,
      reviewerRegistry: new ReviewerRuntimeRegistry([reviewer.runtime]),
    })
    try {
      const durable = await app.runtime.start()
      h.check(durable.state === 'COMPLETED', 'session completed')
      const review = durable.taskStatesV2?.T1?.completion.review
      const implementer = durable.taskStatesV2?.T1?.implementer
      h.check(review !== undefined && implementer !== undefined, 'both reviewer and implementer identities are recorded')
      h.check(review!.reviewer.runtimeIdentity !== implementer!.runtimeIdentity, 'reviewer runtime identity differs from the implementer')
      h.check(review!.reviewer.provider !== implementer!.provider, 'reviewer provider differs from the implementer provider')
      h.check(reviewer.calls[0]?.agentProvider === 'deepseek', 'the runtime was reached through the selected profile provider')
      h.check(reviewer.calls[0]?.implementerProviders.includes('codex'), 'the implementer provider is a real runtime fact, not a name assumption')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s41: CertificationScenario = {
  id: 'S41',
  title: 'Reviewer is read-only: a rogue write is detected and a denied write tool becomes a blocking finding',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    // (a) A reviewer that mutates the repository must be rejected by the dispatcher.
    const rogue = scriptedReviewerRuntime('deepseek', async () => {
      await repoWrite(repo, 'src/rogue.ts', 'export const rogue = true\n')
      return passVerdict('deepseek')
    })
    const rogueApp = await setupHighRisk(ctx, {
      sessionId: `s41a-${ctx.dirs.runId}`,
      reviewerRegistry: new ReviewerRuntimeRegistry([rogue.runtime]),
    })
    try {
      const durable = await rogueApp.runtime.start()
      h.check(durable.state !== 'COMPLETED', 'a reviewer that wrote to the repository cannot complete the task')
      h.check(durable.taskStatesV2?.T1?.completion.review === undefined, 'no review evidence is stored when the read-only guarantee is violated')
      h.check(
        ['REPO_DRIFT', 'ENVIRONMENT_REQUIRED'].includes(durable.humanRequired?.category ?? ''),
        `a reviewer write is rejected before completion (category ${durable.humanRequired?.category ?? 'none'})`,
      )
      const outcome = rogueApp.runtime.getRuntimeRepairOutcome()
      h.check(outcome === undefined || outcome.classification !== 'REPAIRED', 'the violation is never reported as a successful repair')
    } finally {
      await rogueApp.app.close().catch(() => undefined)
    }

    // (b) The DeepSeek adapter grants no write tool and turns a denial into a blocking finding.
    let capturedArgs: readonly string[] = []
    const adapter = createDeepSeekReviewerRuntime({
      cwd: repo,
      platform: 'linux',
      routeAvailable: async () => true,
      commandRunner: async (request) => {
        capturedArgs = request.args
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            result: JSON.stringify({ verdict: 'PASS', findings: [], blockingFindings: [], summary: 'looks fine' }),
            permission_denials: [{ tool: 'Write', reason: 'not allowed' }],
          }),
          stderr: '',
        }
      },
    })
    const verdict = await adapter.review({
      agent: certAgents()[1]!,
      task: {
        taskId: 'T1', goal: 'g', constraints: [], acceptanceCriteria: ['c'],
        implementerProviders: ['codex'], changedFiles: [], verificationEvidence: [], evidence: [], blockers: [], risk: 'HIGH',
      },
    })
    h.check(verdict.kind === 'VERDICT', 'the adapter returned a verdict')
    h.check(verdict.kind === 'VERDICT' && verdict.passed === false, 'a denied write attempt forces a non-passing verdict')
    h.check(
      verdict.kind === 'VERDICT' && verdict.blockingFindings.some((finding) => /write operation/u.test(finding)),
      'the denied write is reported as a blocking finding',
    )
    const toolFlag = capturedArgs.indexOf('--allowedTools')
    const allowed = toolFlag === -1 ? [] : capturedArgs.slice(toolFlag + 1)
    h.check(allowed.length > 0, 'the reviewer CLI received an explicit tool allowlist')
    h.check(!allowed.some((tool) => /^(Edit|Write|NotebookEdit|MultiEdit)$/u.test(tool)), 'no write tool is granted to the reviewer')
    h.check(!capturedArgs.includes('acceptEdits'), 'the reviewer is never started in an edit-accepting permission mode')
  },
}

export const s42: CertificationScenario = {
  id: 'S42',
  title: 'Review FAIL returns to the Controller, which decides EXECUTE instead of COMPLETE',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const actions: string[] = []
    const reviewer = scriptedReviewerRuntime('deepseek', () => failVerdict('deepseek', 'guard is not actually enabled'))
    const app = await setupHighRisk(ctx, {
      sessionId: `s42-${ctx.dirs.runId}`,
      reviewerRegistry: new ReviewerRuntimeRegistry([reviewer.runtime]),
      onDispatch: (action) => { actions.push(action) },
    })
    try {
      const durable = await app.runtime.start()
      h.check(durable.state !== 'COMPLETED', 'a failing review does not complete the task')
      const log = durable.taskEventLogs?.T1 ?? []
      // REVIEW_FAILED is emitted only after the failing evidence was applied to the task.
      h.check(log.some((event) => event.type === 'REVIEW_FAILED'), 'the failing review reached the task state')
      const revision = log.filter((event) => event.type === 'CONTROLLER_DECIDED' && event.action === 'EXECUTE' && event.reasonCode === 'REVIEW_FAILED')
      h.check(revision.length > 0, 'the Controller decided EXECUTE with reasonCode REVIEW_FAILED')
      h.check(actions.filter((action) => action === 'EXECUTE').length >= 2, 'the implementation was sent back for revision')
      h.check(reviewer.calls.length >= 1, 'the reviewer produced a verdict')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s43: CertificationScenario = {
  id: 'S43',
  title: 'Reviewer OFFLINE → Runtime Repair refuses; the implementer never self-reviews',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const deepseek = scriptedReviewerRuntime('deepseek', () => reviewerProviderFailure('deepseek', 'OFFLINE', 'provider offline'))
    const codex = scriptedReviewerRuntime('codex', () => passVerdict('codex'))
    const app = await setupHighRisk(ctx, {
      sessionId: `s43-${ctx.dirs.runId}`,
      // The refresh reports the reviewer provider offline; only the implementer remains
      // healthy, and it is neither review-capable nor independent of itself.
      reviewerRegistry: new ReviewerRuntimeRegistry([deepseek.runtime, codex.runtime]),
      runtimeRepair: {
        refreshProviderHealth: async () => ({
          providerHealth: [{ provider: 'deepseek', status: 'OFFLINE', reason: 'route unavailable', observedAt: new Date().toISOString(), source: 'runtime' }],
          agents: [
            agentProfile({ id: 'codex-executor', provider: 'codex', runtimeIdentity: 'cert:codex-executor', capabilities: { coding: true, reasoning: true, verification: true } }),
            agentProfile({ id: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: 'cert:deepseek-reviewer', capabilities: { review: true, reasoning: true }, available: false }),
          ],
        }),
        auditSink: { record: async () => undefined },
        notifier: { notify: async () => undefined },
      },
    })
    try {
      const suspended = await app.runtime.start()
      h.check(suspended.state === 'SUSPENDED', 'the session suspends when the reviewer provider is offline')
      h.check(suspended.humanRequired?.category === 'ENVIRONMENT_REQUIRED', 'the reviewer failure is an environment issue')
      h.check(/PROVIDER_OFFLINE/u.test(suspended.humanRequired?.reason ?? ''), 'the reason names the provider failure')

      const resumed = await app.runtime.repairRuntimeAndResume()
      h.check(resumed.state === 'SUSPENDED', 'runtime repair keeps the session suspended')
      h.check(app.runtime.getRuntimeRepairOutcome()?.classification === 'RUNTIME_REPAIR_REQUIRES_HUMAN', 'repair requires a human')
      h.check(resumed.taskStatesV2?.T1?.completion.review === undefined, 'no review evidence exists after a refused repair')
      h.check(codex.calls.length === 0, 'the implementer provider was never used as a fallback reviewer')
      h.check(deepseek.calls.length === 1, 'only the original offline reviewer was ever dispatched')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s44: CertificationScenario = {
  id: 'S44',
  title: 'Reviewer TIMEOUT → Runtime Repair retries REVIEW without re-running the Executor',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const timeline: string[] = []
    const audit: string[] = []
    let reviewAttempts = 0
    const reviewer = scriptedReviewerRuntime('deepseek', () => {
      reviewAttempts += 1
      timeline.push(`REVIEW#${reviewAttempts}`)
      return reviewAttempts === 1
        ? reviewerProviderFailure('deepseek', 'TIMEOUT', 'reviewer timed out')
        : passVerdict('deepseek')
    })
    const app = await setupHighRisk(ctx, {
      sessionId: `s44-${ctx.dirs.runId}`,
      reviewerRegistry: new ReviewerRuntimeRegistry([reviewer.runtime]),
      onDispatch: (action) => { timeline.push(action) },
      runtimeRepair: {
        refreshProviderHealth: async () => ({
          providerHealth: [{ provider: 'deepseek', status: 'AVAILABLE', reason: 'restored', observedAt: new Date().toISOString(), source: 'runtime' }],
          agents: certAgents(),
        }),
        auditSink: { record: async (entry) => { audit.push(`${entry.event}:${entry.classification ?? entry.mechanism ?? ''}`) } },
        notifier: { notify: async () => undefined },
      },
    })
    try {
      const suspended = await app.runtime.start()
      h.check(suspended.state === 'SUSPENDED', 'the session suspends on the reviewer timeout')
      h.check(/PROVIDER_UNAVAILABLE/u.test(suspended.humanRequired?.reason ?? ''), 'the timeout is reported as an unavailable provider')

      const resumed = await app.runtime.repairRuntimeAndResume()
      const trace = `${audit.join(' | ')} || timeline=${timeline.join(',')} || reason=${resumed.humanRequired?.reason ?? 'none'}`
      h.check(resumed.state === 'COMPLETED', `the repaired session completes (got ${resumed.state}; ${trace})`)
      h.check(timeline.filter((entry) => entry === 'EXECUTE').length === 1, `the Executor ran exactly once (${trace})`)
      h.check(reviewAttempts === 2, `REVIEW was retried exactly once after the repair (${trace})`)
      h.check(
        timeline.indexOf('REVIEW#1') > timeline.lastIndexOf('EXECUTE'),
        `the first REVIEW followed the single EXECUTE (${trace})`,
      )
      h.check(
        timeline.indexOf('REVIEW#2') > timeline.indexOf('REVIEW#1'),
        `the retried REVIEW followed the failed one without another EXECUTE (${trace})`,
      )
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s45: CertificationScenario = {
  id: 'S45',
  title: 'ReviewEvidence binds real repository facts and stops being valid once they change',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const reviewer = scriptedReviewerRuntime('deepseek', () => passVerdict('deepseek'))
    const app = await setupHighRisk(ctx, {
      sessionId: `s45-${ctx.dirs.runId}`,
      reviewerRegistry: new ReviewerRuntimeRegistry([reviewer.runtime]),
    })
    try {
      const durable = await app.runtime.start()
      h.check(durable.state === 'COMPLETED', 'session completed')
      const task = durable.taskStatesV2?.T1
      const review = task?.completion.review
      const reality = await inspectRepo(ctx.dirs.repo)
      h.check(review !== undefined, 'review evidence exists')
      h.check(review!.reviewedRepository === reality.repositoryIdentity, 'review binds the repository identity')
      h.check(review!.reviewedBranch === reality.branch, 'review binds the branch')
      h.check(review!.reviewedCommit === reality.headSha, 'review binds the reviewed commit')
      h.check(review!.reviewedWorkspace === reality.worktreeFingerprint, 'review binds the workspace fingerprint')
      h.check(review!.implementer.runtimeIdentity === task!.implementer?.runtimeIdentity, 'review binds the implementer identity')
      h.check(review!.reviewer.runtimeIdentity !== review!.implementer.runtimeIdentity, 'review binds a distinct reviewer identity')

      // Changing the repository invalidates the stored review; the Controller must
      // not keep treating the task as complete.
      const controller = new TaskController()
      h.check(controller.decide(task!).action === 'COMPLETE', 'the recorded review satisfies the completion gate')
      const stale = {
        ...task!,
        gitState: { ...task!.gitState, headSha: 'moved-head', worktreeFingerprint: 'moved-workspace' },
      }
      h.check(controller.decide(stale).action !== 'COMPLETE', 'a review bound to an older revision no longer completes the task')
    } finally {
      await app.app.close().catch(() => undefined)
    }
  },
}

export const s46: CertificationScenario = {
  id: 'S46',
  title: 'Restart preserves reviewer identity, provider history and ReviewEvidence consistently',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const reviewer = scriptedReviewerRuntime('deepseek', () => passVerdict('deepseek'))
    const sessionId = `s46-${ctx.dirs.runId}`
    const registry = new ReviewerRuntimeRegistry([reviewer.runtime])
    const first = await setupHighRisk(ctx, { sessionId, reviewerRegistry: registry })
    let before: import('../../../packages/development-guardian/work-session/task-state-v2.js').TaskStateV2 | undefined
    try {
      const durable = await first.runtime.start()
      h.check(durable.state === 'COMPLETED', 'session completed')
      before = durable.taskStatesV2?.T1
      h.check(before?.completion.review !== undefined, 'review evidence recorded before restart')
    } finally {
      await first.app.close().catch(() => undefined)
    }

    const second = await setupHighRisk(ctx, { sessionId, reviewerRegistry: registry, initRepo: false })
    try {
      const hydrated = await second.runtime.loadPersistedState()
      h.check(hydrated?.state === 'COMPLETED', 'the completed session is restored')
      const after = hydrated?.taskStatesV2?.T1
      h.check(after !== undefined && before !== undefined, 'TaskStateV2 survives restart')
      h.check(after!.completion.review?.reviewer.runtimeIdentity === before!.completion.review?.reviewer.runtimeIdentity, 'reviewer identity survives restart')
      h.check(after!.completion.review?.passed === true, 'the review verdict survives restart')
      h.check(JSON.stringify(after!.providerHistory) === JSON.stringify(before!.providerHistory), 'provider history survives restart')
      h.check(after!.implementer?.runtimeIdentity === before!.implementer?.runtimeIdentity, 'implementer identity survives restart')
      h.check(
        JSON.stringify(after!.completion.evidence) === JSON.stringify(before!.completion.evidence),
        'deterministic acceptance evidence survives restart unchanged',
      )
      h.check(
        JSON.stringify(after!.verificationState.results) === JSON.stringify(before!.verificationState.results),
        'deterministic verification results survive restart unchanged',
      )
      h.check(
        JSON.stringify(after!.completion.bindings) === JSON.stringify(before!.completion.bindings),
        'the acceptance evidence contract survives restart unchanged',
      )
      h.check(after!.completion.review?.reviewedCommit === after!.gitState.headSha, 'the restored review still binds the restored HEAD')
      h.check(after!.identity.taskId === 'T1' && after!.acceptanceCriteria.join() === before!.acceptanceCriteria.join(), 'task identity and acceptance criteria are unchanged')
    } finally {
      await second.app.close().catch(() => undefined)
    }
  },
}
