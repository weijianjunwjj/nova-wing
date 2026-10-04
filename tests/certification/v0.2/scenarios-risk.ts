import { startOperator, sessionFetch } from '../../operator-session.js'
/**
 * NovaWing v0.2 certification — configuration, DSL and risk scenarios.
 * S04 missing binding · S05 verifier DSL robustness · S06 verifier approval boundary ·
 * S11 HIGH independent review · S12 CRITICAL approval · S15 Quick Fill stale fields
 */
import { mkdtemp, rm } from 'node:fs/promises'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CertificationScenario, ScenarioContext } from './scenario.js'
import { implementerAgent, reviewerAgent, fileContentCmd as contentCmd } from './scenario.js'
import { buildTrustedConfig, createCertProductionApp } from './harness.js'
import { initFixtureRepo, repoWrite, inspectRepo, resetFixtureRepoToHead } from './util.js'
import { successResult, blockedResult, verifyByCommand, reviewEvidence } from './provider.js'
import type { DispatchCtx } from './provider.js'
import { analyzeTaskBrief } from '../../../packages/development-guardian/work-session/launchpad/task-brief.js'
import { VERIFICATION_APPROVAL_BLOCKER } from '../../../packages/development-guardian/work-session/verification-approval.js'
import { createNovaWingLaunchpad } from '../../../packages/development-guardian/work-session/launchpad/server.js'
import type { AgentCapabilityProfile } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'

async function configRequiredSession(ctx: ScenarioContext, opts: { bindings?: boolean }): Promise<{ category: string | undefined; dispatched: number; state: string }> {
  const repo = ctx.dirs.repo
  const task: { id: string; goal: string; acceptanceCriteria: readonly string[]; allowedPaths: readonly string[]; bindings?: readonly { criterion: string; requiredEvidence: readonly string[] }[] } = { id: 'T1', goal: 'configure acceptance evidence', acceptanceCriteria: ['must be verified'], allowedPaths: ['src/**'] }
  if (opts.bindings === true) task.bindings = [{ criterion: 'must be verified', requiredEvidence: ['ev'] }]
  const config = await buildTrustedConfig({ sessionId: `s04-${ctx.dirs.runId}`, repo, tasks: [task] })
  const agents = [implementerAgent()]
  const provider = async ({ action }: DispatchCtx) => { return blockedResult([`unexpected dispatch ${action}`]) }
  const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
  try {
    const durable = await runtime.start()
    const log = durable.taskEventLogs?.T1 ?? []
    return { category: durable.humanRequired?.category, dispatched: log.filter((event) => event.type === 'AGENT_DISPATCHED').length, state: durable.state }
  } finally {
    await app.close().catch(() => undefined)
  }
}

export const s04: CertificationScenario = {
  id: 'S04',
  title: 'Acceptance criterion with no evidence binding → CONFIGURATION_REQUIRED, zero dispatches',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(ctx.dirs.repo, { 'src/a.ts': 'export const a = 1\n' })
    const outcome = await configRequiredSession(ctx, { bindings: false })
    h.check(outcome.category === 'CONFIGURATION_REQUIRED', `missing binding surfaces CONFIGURATION_REQUIRED (got ${outcome.category})`)
    h.check(outcome.state !== 'COMPLETED', 'task does not complete without an evidence contract')
    h.check(outcome.dispatched === 0, 'zero executor dispatches when the evidence contract is missing')
  },
}

export const s05: CertificationScenario = {
  id: 'S05',
  title: 'Verifier command DSL preserves =>, shell operators and quotes after the first delimiter',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/v.ts': 'const f = (x) => x; // && "dq" \'sq\'' })

    // A: brief DSL preserves a command that itself contains arrows/operators/quotes.
    const targetContent = 'const f = (x) => x; // && "dq" \'sq\''
    const command = contentCmd(repo, 'src/v.ts', targetContent)
    const brief = [
      'Task: verify v.ts content exactly',
      'project: ' + repo,
      'allowed paths: src/**',
      'acceptance criteria: v.ts exact',
      'required evidence:',
      `v.ts exact => ${command}`,
    ].join('\n')
    const analysis = analyzeTaskBrief(brief)
    const binding = analysis.fields.acceptanceEvidenceBindings?.find((entry) => entry.criterion === 'v.ts exact')
    h.check(binding !== undefined, 'brief parser produced an evidence binding for the criterion')
    h.check(binding?.requiredEvidence[0] === command, 'binding command survives => / quotes / operators without corruption')

    // A2: only the first delimiter is structural; a later arrow belongs to the verifier.
    const delimiterRich = analyzeTaskBrief([
      'Task: preserve verifier arrow content',
      'allowed paths: src/**',
      'acceptance criteria: content mapping is exact',
      'required evidence:',
      'content mapping is exact => node -e "console.log(\'x => y\')"',
    ].join('\n'))
    const delimiterBinding = delimiterRich.fields.acceptanceEvidenceBindings?.find((entry) => entry.criterion === 'content mapping is exact')
    h.check(delimiterBinding?.requiredEvidence[0] === 'node -e "console.log(\'x => y\')"', 'only the first delimiter is structural')

    // B: the exact command string, executed through the safe node verifier, drives a complete task.
    const config = await buildTrustedConfig({ sessionId: `s05-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'make v.ts content exact', acceptanceCriteria: ['v.ts exact'], allowedPaths: ['src/**'], bindings: [{ criterion: 'v.ts exact', requiredEvidence: [command] }] }] })
    const agents = [implementerAgent()]
    const provider = async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') { await repoWrite(repo, 'src/v.ts', targetContent); return successResult() }
      if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
      return blockedResult([`unexpected action ${action}`])
    }
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.state === 'COMPLETED', 'task completed through the delimiter-rich verifier command')
      const evidence = durable.taskStatesV2?.T1?.completion.evidence ?? []
      h.check(evidence.some((item) => item.type === command && item.status === 'PASSED'), 'evidence bound to the exact (untruncated) verifier command name')
      h.check(!evidence.some((item) => item.type !== command && command.includes(item.type) && item.type.length < command.length), 'no half-parsed evidence name leaked into completion')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s06: CertificationScenario = {
  id: 'S06',
  title: 'Verifier approval is a dedicated boundary: approval surfaces without a coding turn and is bound to the exact command',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/migrate.txt': 'pre\n' })
    const scopedCommand = 'npm run db:migrate --check'
    const config = await buildTrustedConfig({ sessionId: `s06-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'apply a scoped migration', acceptanceCriteria: ['migrated'], allowedPaths: ['src/**'], bindings: [{ criterion: 'migrated', requiredEvidence: [scopedCommand] }] }] })
    const agents = [implementerAgent()]
    let executes = 0
    const verifies = { coding: 0, approvals: 0 }
    const provider = async ({ action }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        executes++
        await repoWrite(repo, 'src/migrate.txt', 'post\n')
        return successResult()
      }
      if (action === 'VERIFY') {
        // The scoped command is not approved: the dispatcher requests it at the
        // verify boundary and must not start another coding turn.
        verifies.approvals++
        return blockedResult([`${VERIFICATION_APPROVAL_BLOCKER}${scopedCommand}`], { status: 'BLOCKED' })
      }
      return blockedResult([`unexpected action ${action}`])
    }
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.humanRequired?.category === 'DECISION_REQUIRED', 'approval surfaces as a human decision')
      h.check(durable.state !== 'COMPLETED', 'unapproved task does not complete')
      h.check(executes === 1, `exactly one coding turn ran before the approval boundary (${executes})`)
      h.check(verifies.approvals === 1, 'approval was requested at a single verify boundary')
      h.check((durable.humanRequired?.reason ?? '').includes(VERIFICATION_APPROVAL_BLOCKER.trimEnd().slice(0, -1)) || (durable.humanRequired?.reason ?? '').includes('verification command requires human approval'), 'approval reason names the unapproved verifier command')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s11: CertificationScenario = {
  id: 'S11',
  title: 'HIGH-risk work requires an independent reviewer; self/fake reviewer identity is rejected',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/auth/guard.ts': 'export const guard = false\n' })
    const GOOD = 'export const guard = true\n'

    // Genuine independent review → complete.
    const goodBinding = { criterion: 'guard enabled', requiredEvidence: [contentCmd(repo, 'src/auth/guard.ts', GOOD)] }
    const goodConfig = await buildTrustedConfig({ sessionId: `s11a-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'enable the auth guard', acceptanceCriteria: ['guard enabled'], allowedPaths: ['src/**'], bindings: [goodBinding] }] })
    const goodAgents: AgentCapabilityProfile[] = [implementerAgent(), reviewerAgent()]
    let reviewerId = ''
    let implementerId = ''
    const genuine = async ({ action, agent, task }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'src/auth/guard.ts', GOOD)
        return successResult()
      }
      if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
      if (action === 'REVIEW') {
        reviewerId = agent.id
        implementerId = task.implementer?.agent ?? ''
        return successResult({
          status: 'SUCCESS',
          review: reviewEvidence({
            reviewer: agent, implementer: task.implementer, passed: true, findings: [], blockingFindings: [],
            files: task.gitState.changedFiles, task,
          }),
        })
      }
      return blockedResult([`unexpected action ${action}`])
    }
    const { app: appA, runtime: runtimeA } = await createCertProductionApp({ config: goodConfig, dataDir: ctx.dirs.data, agents: goodAgents, provider: genuine })
    try {
      const durableA = await runtimeA.start()
      h.check(durableA.state === 'COMPLETED', 'HIGH-risk task completed through an independent reviewer')
      h.check(reviewerId === 'reviewer', `reviewer is the independent agent (got ${reviewerId})`)
      h.check(implementerId === 'coder', 'implementer is the coder agent')
      h.check(reviewerId !== implementerId, 'implementer never self-reviews')
      const review = durableA.taskStatesV2?.T1?.completion.review
      h.check(review?.reviewer.runtimeIdentity !== review?.implementer.runtimeIdentity, 'reviewer and implementer runtime identities differ')
    } finally {
      await appA.close().catch(() => undefined)
    }
    // Start the spoof run from the committed baseline so the repository is clean.
    await resetFixtureRepoToHead(repo)

    // Spoofed identity → rejected, never trusted as completion.
    const spoofConfig = await buildTrustedConfig({ sessionId: `s11b-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'enable the auth guard', acceptanceCriteria: ['guard enabled'], allowedPaths: ['src/**'], bindings: [goodBinding] }] })
    const spoof = async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') { await repoWrite(repo, 'src/auth/guard.ts', GOOD); return successResult() }
      if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
      if (action === 'REVIEW') {
        // Spoof: the selected reviewer claims to be the implementer.
        return successResult({
          status: 'SUCCESS',
          review: reviewEvidence({
            reviewer: implementerAgent(), implementer: task.implementer, passed: true, findings: [], blockingFindings: [],
            files: task.gitState.changedFiles, task,
          }),
        })
      }
      return blockedResult([`unexpected action ${action}`])
    }
    const { app: appB, runtime: runtimeB } = await createCertProductionApp({ config: spoofConfig, dataDir: ctx.dirs.data, agents: goodAgents, provider: spoof })
    try {
      const durableB = await runtimeB.start()
      h.check(durableB.state !== 'COMPLETED', 'task must not complete when review identity is spoofed')
      const log = durableB.taskEventLogs?.T1 ?? []
      h.check(log.some((event) => event.type === 'REVIEW_FAILED'), 'rejected review is recorded as REVIEW_FAILED')
      const review = durableB.taskStatesV2?.T1?.completion.review
      h.check(review === undefined, 'spoofed review evidence is never stored on the task')
    } finally {
      await appB.close().catch(() => undefined)
    }
  },
}

export const s12: CertificationScenario = {
  id: 'S12',
  title: 'CRITICAL risk approval binds repository/HEAD/fingerprint; approval cannot outlive a code change',
  group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'auth/security.ts': 'export const secure = false\n', 'database/schema.ts': 'export const schema = 1\n' })
    const GOOD = 'export const secure = true\n'
    const binding = { criterion: 'secure', requiredEvidence: [contentCmd(repo, 'auth/security.ts', GOOD)] }
    const agents = [implementerAgent()]
    const provider = async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'auth/security.ts', GOOD)
        await repoWrite(repo, 'database/schema.ts', 'export const schema = 2 // hardened\n')
        return successResult()
      }
      if (action === 'VERIFY') return successResult({ verificationResults: await verifyByCommand(task, repo) })
      return blockedResult([`unexpected action ${action}`])
    }
    const config = await buildTrustedConfig({ sessionId: `s12-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'harden security touchpoints', acceptanceCriteria: ['secure'], allowedPaths: ['auth/**', 'database/**'], bindings: [binding] }] })

    const first = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await first.runtime.start()
      h.check(durable.state === 'SUSPENDED', 'CRITICAL risk suspends for explicit human approval')
      h.check(durable.taskStatesV2?.T1?.currentAction === 'REQUEST_APPROVAL', 'controller decided REQUEST_APPROVAL for CRITICAL risk')
      h.check(durable.taskStatesV2?.T1?.completion.approval === undefined, 'no approval evidence before the human grants it')
    } finally {
      await first.app.close().catch(() => undefined)
    }

    // Code changes while the approval is pending make the old request unusable.
    await repoWrite(repo, 'database/schema.ts', 'export const schema = 2 // changed after approval request\n')

    const second = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const resumed = await second.runtime.resume({ approval: true })
      h.check(resumed.state !== 'COMPLETED', 'a stale approval request must not complete the task after code changed')
      const t1 = resumed.taskStatesV2?.T1
      h.check(t1?.status !== 'COMPLETED', 'TaskStateV2 not COMPLETED')
      const reality = await inspectRepo(repo)
      const approval = t1?.completion.approval
      h.check(!(approval?.approved === true && approval.workspaceIdentity === reality.worktreeFingerprint), 'any recorded approval is not bound to the changed repository fingerprint')
    } finally {
      await second.app.close().catch(() => undefined)
    }
  },
}

export const s15: CertificationScenario = {
  id: 'S15',
  title: 'Quick Fill preserves unrecognized fields and requires confirmation of retained permissions',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const directory = await mkdtemp(join(tmpdir(), 'cert-s15-'))
    const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
    try {
      const address = await startOperator(launchpad)
      const script = await (await sessionFetch(`${address.url}/app.js`)).text()
      const start = script.indexOf('const applyBriefAnalysis =')
      const end = script.indexOf('briefFill.addEventListener', start)
      h.check(start >= 0 && end > start, 'launchpad serves the Quick Fill apply function')
      const targetRepo = { value: 'old-repo' }
      const branch = { value: 'old-branch' }
      const taskId = { value: 'OLD', removeAttribute() {} }
      const elements = Object.fromEntries(['allowedPaths', 'forbiddenPaths', 'constraints', 'acceptanceCriteria', 'acceptanceEvidenceBindings', 'doNotDo'].map((key) => [key, { value: 'old', removeAttribute() {}, setAttribute() {}, hasAttribute() { return true } }]))
      const briefResult = { textContent: '' }
      const context = vm.createContext({ targetRepo, branch, form: { elements }, briefResult,
        taskRows: () => [{ querySelector: () => taskId }], discoverTargetRepo() {}, updatePushRemote() {}, updateSchedule() {},
      })
      vm.runInContext(script.slice(start, end) + ';globalThis.apply = applyBriefAnalysis', context)
      vm.runInContext("apply({ fields: { targetRepo: 'new-repo', taskId: 'D01', allowedPaths: ['src/**'] } }, true)", context)
      h.check(targetRepo.value === 'new-repo', 'recognized target repo replaces the old value')
      h.check(taskId.value === 'D01', 'recognized task id replaces the old value')
      h.check(elements.allowedPaths!.value === 'src/**', 'recognized allowed paths replace old Task A permissions')
      h.check(branch.value === 'old-branch', 'partial recognition preserves the existing branch')

      // Failed analysis preserves policy values but requires renewed confirmation.
      vm.runInContext('apply({ fields: {} }, false)', context)
      h.check(targetRepo.value === 'new-repo', 'model-only advice does not alter form fields')
      vm.runInContext('apply({ fields: {} }, true)', context)
      h.check(targetRepo.value === 'new-repo', 'existing target repo preserved on failed analysis')
      h.check(taskId.value === 'D01', 'existing task id preserved on failed analysis')
      h.check(elements.allowedPaths!.value === 'src/**', 'existing permissions preserved for manual confirmation')
      for (const [name, field] of Object.entries(elements)) if (name !== 'allowedPaths') h.check(field.value === 'old', 'unrecognized policy values preserved')
      h.check(/需要人工确认/u.test(briefResult.textContent), 'manual permission confirmation is explicit')
      h.check(/保留原值/u.test(briefResult.textContent), 'preserved fields are explained to the user')
    } finally {
      await launchpad.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}
