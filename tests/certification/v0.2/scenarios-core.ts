/**
 * NovaWing v0.2 certification — core control-plane scenarios.
 * S02 complete task · S03 verify-fail → fix · S07 forbidden path · S08 repo drift · S13 no-progress
 */
import type { TaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import type { WorkSessionDurableState } from '../../../packages/development-guardian/work-session/model.js'
import type { CertificationScenario } from './scenario.js'
import { implementerAgent, fileContentCmd as contentCmd } from './scenario.js'
import { buildTrustedConfig, createCertProductionApp } from './harness.js'
import { initFixtureRepo, repoRead, repoWrite, fixtureCommit, inspectRepo, headSha } from './util.js'
import { successResult, blockedResult, verifyByCommand } from './provider.js'
import type { DispatchCtx } from './provider.js'

function taskState(durable: WorkSessionDurableState): TaskStateV2 | undefined {
  return durable.taskStatesV2?.T1
}

function allEvidencePassed(t1: TaskStateV2 | undefined): boolean {
  return (t1?.completion.evidence.every((item) => item.status === 'PASSED') && t1.completion.evidence.length > 0) ?? false
}

export const s02: CertificationScenario = {
  id: 'S02',
  title: 'Simple complete task: EXECUTE → VERIFY → COMPLETE with passed evidence',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/task.txt': 'init\n' })
    const EXPECTED = 'certification says v0.2 is usable\n'
    const binding = { criterion: 'task updated', requiredEvidence: [contentCmd(repo, 'src/task.txt', EXPECTED)] }
    const agents = [implementerAgent()]
    const provider = (async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'src/task.txt', EXPECTED)
        return successResult()
      }
      if (action === 'VERIFY') {
        return successResult({ verificationResults: await verifyByCommand(task, repo) })
      }
      return blockedResult([`unexpected action ${action}`])
    })
    const config = await buildTrustedConfig({ sessionId: `cert-s02-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'update the task file to the expected line', acceptanceCriteria: ['task updated'], allowedPaths: ['src/**'], bindings: [binding] }] })
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.state === 'COMPLETED', `session completed (got ${durable.state})`)
      const t1 = taskState(durable)
      h.check(t1?.status === 'COMPLETED', 'TaskStateV2.status === COMPLETED')
      h.check(allEvidencePassed(t1), 'all acceptance evidence PASSED')
      h.check((await repoRead(repo, 'src/task.txt')) === EXPECTED, 'executor modified the fixture file')
      h.check((durable.taskEventLogs?.T1 ?? []).some((event) => event.type === 'TASK_COMPLETED'), 'event log recorded TASK_COMPLETED')
      h.check(durable.completedTaskIds.includes('T1'), 'completedTaskIds includes T1')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s03: CertificationScenario = {
  id: 'S03',
  title: 'EXECUTE → VERIFY FAILED → EXECUTE fix → VERIFY PASSED → COMPLETE without human override',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/calc.ts': 'export const fix = false\n' })
    const GOOD = 'export const fix = true\n'
    const binding = { criterion: 'fix applied', requiredEvidence: [contentCmd(repo, 'src/calc.ts', GOOD)] }
    const agents = [implementerAgent()]
    let executes = 0
    const provider = (async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        executes++
        await repoWrite(repo, 'src/calc.ts', executes === 1 ? 'export const fix = false // partial\n' : GOOD)
        return successResult()
      }
      if (action === 'VERIFY') {
        return successResult({ verificationResults: await verifyByCommand(task, repo) })
      }
      return blockedResult([`unexpected action ${action}`])
    })
    const config = await buildTrustedConfig({ sessionId: `cert-s03-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'flip the fix constant and satisfy its verifier', acceptanceCriteria: ['fix applied'], allowedPaths: ['src/**'], bindings: [binding] }] })
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.state === 'COMPLETED', `session completed after fix (got ${durable.state})`)
      const t1 = taskState(durable)
      h.check(t1?.status === 'COMPLETED', 'TaskStateV2 COMPLETED only after the fix')
      h.check(allEvidencePassed(t1), 'final evidence PASSED')
      h.check(executes === 2, `executor ran twice (first attempt failed verification): ${executes}`)
      const log = durable.taskEventLogs?.T1 ?? []
      h.check(log.some((event) => event.type === 'VERIFICATION_FAILED'), 'event log recorded a failed verification')
      h.check(log.some((event) => event.type === 'VERIFICATION_PASSED'), 'event log recorded a later passed verification')
      h.check(log.some((event) => event.type === 'CONTROLLER_DECIDED' && event.reasonCode === 'VERIFICATION_FAILED' && event.action === 'EXECUTE'), 'controller re-decided EXECUTE after failed verification')
      h.check((await repoRead(repo, 'src/calc.ts')) === GOOD, 'repo holds the corrected content')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s07: CertificationScenario = {
  id: 'S07',
  title: 'Agent attempts a forbidden path — task cannot COMPLETE',
  group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/a.ts': 'export const ok = true\n', 'secrets/prod.txt': 'baseline\n' })
    const agents = [implementerAgent()]
    const provider = (async ({ action }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'src/a.ts', 'export const ok = true // touched\n')
        await repoWrite(repo, 'secrets/leak.txt', 'compromised\n')
        return successResult()
      }
      return blockedResult([`unexpected action ${action}`])
    })
    const config = await buildTrustedConfig({ sessionId: `cert-s07-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'touch allowed code only', acceptanceCriteria: ['safe'], allowedPaths: ['src/**'], forbiddenPaths: ['secrets/**'], bindings: [{ criterion: 'safe', requiredEvidence: ['safe-change'] }] }] })
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.state !== 'COMPLETED', 'session must not COMPLETE when a forbidden path changed')
      const t1 = taskState(durable)
      h.check(t1?.status !== 'COMPLETED', 'TaskStateV2 not COMPLETED')
      h.check((t1?.blockers ?? []).some((blocker) => blocker.includes('inside forbidden scope')), 'blocker records the forbidden scope violation')
      h.check((t1?.blockers ?? []).some((blocker) => blocker.includes('secrets/leak.txt')), 'blocker names the forbidden file')
      const log = durable.taskEventLogs?.T1 ?? []
      h.check(!log.some((event) => event.type === 'TASK_COMPLETED'), 'no TASK_COMPLETED event despite attempted change')
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}

export const s08: CertificationScenario = {
  id: 'S08',
  title: 'Repository drift between runs suspends; stale evidence cannot complete',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/feature.ts': 'export const feature = false\n' })
    const GOOD = 'export const feature = true\n'
    const binding = { criterion: 'feature ready', requiredEvidence: [contentCmd(repo, 'src/feature.ts', GOOD)], requiresApproval: true }
    const agents = [implementerAgent()]
    const provider = (async ({ action, task }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'src/feature.ts', GOOD)
        return successResult()
      }
      if (action === 'VERIFY') {
        return successResult({ verificationResults: await verifyByCommand(task, repo) })
      }
      return blockedResult([`unexpected action ${action}`])
    })
    const config = await buildTrustedConfig({ sessionId: `cert-s08-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'enable feature and await approval', acceptanceCriteria: ['feature ready'], allowedPaths: ['src/**'], bindings: [binding] }] })

    const first = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await first.runtime.start()
      h.check(durable.state === 'SUSPENDED', `run1 suspends awaiting explicit approval (got ${durable.state})`)
      h.check(durable.taskStatesV2?.T1?.currentAction === 'REQUEST_APPROVAL', 'approval requested before completion')
      h.check((durable.taskStatesV2?.T1?.completion.evidence ?? []).every((item) => item.status === 'PASSED'), 'evidence passed against the pre-drift repository')
    } finally {
      await first.app.close().catch(() => undefined)
    }

    const beforeDrift = await headSha(repo)
    await fixtureCommit(repo, { 'drift/unrelated.txt': 'externally introduced\n' }, 'external repo drift while suspended')
    const afterDrift = await headSha(repo)
    h.check(beforeDrift !== afterDrift, 'an external commit advanced the repository HEAD')

    const second = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const resumed = await second.runtime.resume({ approval: true })
      h.check(resumed.state !== 'COMPLETED', 'drift must prevent approval-driven completion')
      const t1 = resumed.taskStatesV2?.T1
      h.check(t1?.status !== 'COMPLETED', 'TaskStateV2 not COMPLETED after drift')
      h.check(t1?.currentAction === 'RECONCILE', 'controller re-decided RECONCILE after drift')
      const reality = await inspectRepo(repo)
      h.check(t1?.gitState.headSha === reality.headSha, 'persisted git state reconciled to real HEAD')
      const log = resumed.taskEventLogs?.T1 ?? []
      h.check(log.some((event) => event.type === 'RECONCILIATION_REQUIRED'), 'event log recorded RECONCILIATION_REQUIRED')
      h.check(resumed.humanRequired?.category === 'REPO_DRIFT', 'human required category is REPO_DRIFT')
      const evidenceBoundToNewHead = (t1?.completion.evidence ?? []).some((item) => item.headSha === reality.headSha)
      h.check(!evidenceBoundToNewHead, 'no evidence is presented as bound to the drifted HEAD (no stale evidence reuse)')
    } finally {
      await second.app.close().catch(() => undefined)
    }
  },
}

export const s13: CertificationScenario = {
  id: 'S13',
  title: 'No-progress detection suspends a verifier that cannot converge',
  group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = ctx.dirs.repo
    await initFixtureRepo(repo, { 'src/work.txt': 'init\n' })
    const agents = [implementerAgent()]
    const good = contentCmd(repo, 'src/work.txt', 'progress\n')
    const provider = (async ({ action }: DispatchCtx) => {
      if (action === 'EXECUTE') {
        await repoWrite(repo, 'src/work.txt', 'progress\n')
        return successResult()
      }
      if (action === 'VERIFY') {
        // Only the first evidence can ever pass; the second criterion never converges.
        return successResult({ verificationResults: [{ name: good, status: 'passed' }] })
      }
      return blockedResult([`unexpected action ${action}`])
    })
    const config = await buildTrustedConfig({ sessionId: `cert-s13-${ctx.dirs.runId}`, repo, tasks: [{ id: 'T1', goal: 'produce both pieces of evidence', acceptanceCriteria: ['a', 'b'], allowedPaths: ['src/**'], bindings: [{ criterion: 'a', requiredEvidence: [good] }, { criterion: 'b', requiredEvidence: ['second-evidence'] }] }] })
    const { app, runtime } = await createCertProductionApp({ config, dataDir: ctx.dirs.data, agents, provider })
    try {
      const durable = await runtime.start()
      h.check(durable.state !== 'COMPLETED', 'unconverged task must not complete')
      h.check(durable.humanRequired?.category === 'STALLED_NO_PROGRESS', `suspended with STALLED_NO_PROGRESS (got ${durable.humanRequired?.category})`)
      const log = durable.taskEventLogs?.T1 ?? []
      h.check(log.some((event) => event.type === 'TASK_SUSPENDED' && event.reasonCode === 'STALLED_NO_PROGRESS'), 'event log recorded STALLED_NO_PROGRESS suspension')
      const verifies = log.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'VERIFY').length
      h.check(verifies <= 4, `verifier stopped after a small number of repeats (${verifies}) instead of exhausting the action budget`)
    } finally {
      await app.close().catch(() => undefined)
    }
  },
}
