import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { architectureBenchmarkTasks, runArchitectureBenchmark } from '../../benchmark/harness.js'
import { createTaskStateV2, TaskController } from '../../../packages/development-guardian/work-session/index.js'
import { concreteRuntimeProvider, phaseForAction, resumeTargetForFailure } from '../../../packages/development-guardian/work-session/direct-path.js'
import { planVerification } from '../../../packages/development-guardian/work-session/verification-planner.js'
import { createNovaWingLaunchpad, discoverTrustedWorkSessionConfigs } from '../../../packages/development-guardian/work-session/launchpad/server.js'
import { createProductionWorkSessionUi, type ProductionWorkSessionUi, type TrustedWorkSessionConfig } from '../../../packages/development-guardian/work-session/production.js'
import { WorkSessionRuntime } from '../../../packages/development-guardian/work-session/runtime.js'
import type { DependencyHealthReport } from '../../../packages/development-guardian/work-session/dependency-health.js'
import type { CertificationScenario, ScenarioContext } from './scenario.js'
import { initFixtureRepo, repoWrite } from './util.js'

const task = { id: 'S-v028', goal: 'Implement ticket X / Y counter', constraints: [] as string[], acceptanceCriteria: ['counter shows X / Y'], allowedPaths: ['apps/web'], forbiddenPaths: ['.env'] }

async function planned(ctx: ScenarioContext) {
  const root = ctx.dirs.repo
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true })
  await mkdir(join(root, 'apps', 'web', 'tests'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node postgres-required.js' } }))
  await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:ticket': 'node --test tests/ticket.test.js', typecheck: 'tsc --noEmit' } }))
  await writeFile(join(root, 'apps', 'web', 'tests', 'ticket.test.js'), 'export {}\n')
  await writeFile(join(root, 'apps', 'web', 'src', 'ticket.ts'), 'export {}\n')
  return planVerification({ repositoryRoot: root, task })
}

function benchmark(category: string, mode: 'CONTROLLER' | 'DIRECT') {
  return runArchitectureBenchmark(architectureBenchmarkTasks.find((item) => item.category === category)!, mode)
}

export const s86: CertificationScenario = { id: 'S86', title: 'Planner selects the closest named task test', group: 'control', async run(ctx) { const plan = await planned(ctx); ctx.h.check(plan.steps[0]?.command === 'node --test tests/ticket.test.js' && plan.steps[0]?.originalCommand === 'npm run test:ticket', 'targeted test selected first') } }
export const s87: CertificationScenario = { id: 'S87', title: 'Planner prefers package-local evidence over root suite', group: 'control', async run(ctx) { const plan = await planned(ctx); ctx.h.check(plan.steps.some((s) => s.command === 'npm run typecheck') && !plan.steps.some((s) => s.command === 'npm test' && s.cwd === '.'), 'package evidence wins over root') } }
export const s88: CertificationScenario = { id: 'S88', title: 'Planner fails safely before EXECUTE when evidence is insufficient', group: 'risk', async run(ctx) { const root = join(ctx.dirs.repo, 'empty'); await mkdir(root, { recursive: true }); await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node postgres-required.js' } })); const plan = await planVerification({ repositoryRoot: root, task: { ...task, allowedPaths: ['src'] } }); ctx.h.check(plan.confidence === 'INSUFFICIENT' && !plan.steps.some((s) => s.command === 'npm test'), 'insufficient plan does not guess root test') } }
export const s89: CertificationScenario = { id: 'S89', title: 'Explicit evidence has precedence over inferred evidence', group: 'control', async run(ctx) { await planned(ctx); const plan = await planVerification({ repositoryRoot: ctx.dirs.repo, task: { ...task, acceptanceEvidenceBindings: [{ criterion: task.acceptanceCriteria[0]!, requiredEvidence: ['git diff --check'] }] } }); ctx.h.check(plan.explicitBindings && plan.mappings[0]?.evidence[0] === 'git diff --check', 'explicit binding preserved') } }
export const s90: CertificationScenario = { id: 'S90', title: 'Direct LOW task does not call Controller', group: 'control', async run({ h }) { const run = await benchmark('A', 'DIRECT'); h.check(run.metrics.controllerDecisionCount === 0, 'zero Controller decisions') } }
export const s91: CertificationScenario = { id: 'S91', title: 'Direct completes with one EXECUTE and one VERIFY', group: 'control', async run({ h }) { const run = await benchmark('B', 'DIRECT'); h.check(run.metrics.completed && run.metrics.executeCount === 1 && run.metrics.verifyCount === 1, 'one execute and one verify') } }
export const s92: CertificationScenario = { id: 'S92', title: 'Direct uses at most two normal repository inspections', group: 'control', async run({ h }) { const run = await benchmark('C', 'DIRECT'); h.check(run.metrics.repoInspectionCount <= 2, 'two boundary inspections') } }
export const s93: CertificationScenario = { id: 'S93', title: 'Direct verification failure escalates correctly', group: 'recovery', async run({ h }) { const run = await benchmark('D', 'DIRECT'); h.check(run.metrics.escalated && run.metrics.executionPath === 'CONTROLLER', 'verification failure enters Controller') } }
export const s94: CertificationScenario = { id: 'S94', title: 'Escalation preserves state, evidence, and checkpoint', group: 'recovery', async run({ h }) { const run = await benchmark('D', 'DIRECT'); h.check(run.metrics.completed && run.metrics.executeCount === 2 && run.metrics.verifyCount === 2, 'continued state converges without restart') } }
export const s95: CertificationScenario = { id: 'S95', title: 'Environment failure never re-executes implementation', group: 'recovery', run({ h }) { h.check(resumeTargetForFailure('ENVIRONMENT_FAILURE') === 'VERIFY', 'environment resumes VERIFY') } }
export const s96: CertificationScenario = { id: 'S96', title: 'Verifier configuration repair resumes VERIFY', group: 'recovery', run({ h }) { h.check(resumeTargetForFailure('VERIFIER_CONFIGURATION_FAILURE') === 'VERIFY', 'configuration resumes VERIFY') } }
export const s97: CertificationScenario = { id: 'S97', title: 'Human VERIFY ONLY forbids re-execution', group: 'risk', run({ h }) { const initial = createTaskStateV2({ id: 'cert-v028', branch: 'main' }, { ...task, acceptanceEvidenceBindings: [{ criterion: task.acceptanceCriteria[0]!, requiredEvidence: ['npm test'] }] }); const constrained = { ...initial, status: 'ACTIVE' as const, humanConstraints: { verifyOnly: true }, verificationState: { results: [{ name: 'npm test', status: 'failed' as const, classification: 'CODE_FAILURE' as const }] } }; h.check(new TaskController().decide(constrained).action === 'SUSPEND', 'controller cannot violate verify-only') } }
export const s98: CertificationScenario = { id: 'S98', title: 'Already-satisfied work can complete without a commit', group: 'control', async run({ h }) { const run = await benchmark('A', 'DIRECT'); h.check(run.metrics.completed && run.metrics.firstPass, 'completion authority does not require review or human action') } }
export const s99: CertificationScenario = { id: 'S99', title: 'HIGH risk never remains on Direct Path', group: 'risk', async run({ h }) { const run = await benchmark('F', 'DIRECT'); h.check(run.metrics.executionPath === 'CONTROLLER' && run.metrics.reviewCount > 0, 'high risk escalates and reviews') } }
export const s100: CertificationScenario = { id: 'S100', title: 'Provider UI projects the actual selected provider', group: 'control', run({ h }) { h.check(concreteRuntimeProvider('codex') === 'codex', 'actual provider remains visible') } }
export const s101: CertificationScenario = { id: 'S101', title: 'Route profile is not projected as provider', group: 'risk', run({ h }) { h.check(concreteRuntimeProvider('codex-or-deepseek') === undefined && concreteRuntimeProvider('executor-router') === undefined, 'route stays debug-only') } }
export const s102: CertificationScenario = { id: 'S102', title: 'REVIEWING appears only after reviewer start', group: 'control', run({ h }) { h.check(phaseForAction('REVIEW', false) === 'WAITING' && phaseForAction('REVIEW', true) === 'REVIEWING', 'review timing is truthful') } }
export const s103: CertificationScenario = { id: 'S103', title: 'Complete, suspend, and approval never fall back to REVIEWING', group: 'risk', run({ h }) { h.check(phaseForAction('COMPLETE') === 'FINALIZING' && phaseForAction('SUSPEND') === 'WAITING' && phaseForAction('REQUEST_APPROVAL') === 'WAITING_FOR_APPROVAL', 'explicit phase map') } }
export const s104: CertificationScenario = { id: 'S104', title: 'REAL-002 planner avoids root PostgreSQL suite', group: 'risk', async run(ctx) { const plan = await planned(ctx); ctx.h.check(plan.steps[0]?.command === 'node --test tests/ticket.test.js' && plan.steps[0]?.originalCommand === 'npm run test:ticket' && !plan.steps.some((s) => s.command === 'npm test' && s.cwd === '.'), 'task-local plan avoids root') } }
export const s105: CertificationScenario = { id: 'S105', title: 'REAL-003-style simple task completes Direct', group: 'control', async run({ h }) { const run = await benchmark('H', 'DIRECT'); h.check(run.metrics.completed && run.metrics.executionPath === 'DIRECT' && run.metrics.controllerDecisionCount === 0, 'REAL-003 converges Direct') } }
export const s106: CertificationScenario = { id: 'S106', title: 'Controller-only legacy mode continues to work', group: 'compatibility', async run({ h }) { const run = await benchmark('A', 'CONTROLLER'); h.check(run.metrics.completed && run.metrics.executionPath === 'CONTROLLER', 'legacy path completes') } }
export const s107: CertificationScenario = { id: 'S107', title: 'Feature flag OFF returns to v0.2.7-style loop', group: 'compatibility', async run({ h }) { const run = await benchmark('B', 'CONTROLLER'); h.check(run.metrics.controllerDecisionCount === 3 && !run.metrics.escalated, 'kill switch selects Controller baseline') } }
export const s108: CertificationScenario = { id: 'S108', title: 'Direct versus Controller instrumentation is comparable', group: 'compatibility', async run({ h }) { const oldRun = await benchmark('C', 'CONTROLLER'); const direct = await benchmark('C', 'DIRECT'); h.check(oldRun.metrics.dispatchCount === 2 && direct.metrics.dispatchCount === 1 && oldRun.metrics.repoInspectionCount === 5 && direct.metrics.repoInspectionCount === 2, 'same counters expose both paths') } }
export const s109: CertificationScenario = { id: 'S109', title: 'Direct preserves zero-human and first-pass analytics semantics', group: 'compatibility', async run({ h }) { const run = await benchmark('H', 'DIRECT'); h.check(run.metrics.firstPass && run.metrics.humanActionCount === 0 && run.metrics.humanDecisionCount === 0, 'zero-human first-pass remains truthful') } }
export const s110: CertificationScenario = { id: 'S110', title: 'Direct escalation retains the Controller safety net', group: 'compatibility', async run({ h }) { const run = await benchmark('D', 'DIRECT'); h.check(run.metrics.escalated && run.metrics.completed && run.metrics.controllerDecisionCount > 0, 'fallback safety net converges') } }

function healthyReport(): DependencyHealthReport {
  return { overall: 'READY', canStart: true, checkedAt: new Date().toISOString(), dependencies: [] }
}

async function postCreate(launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(), Origin: address.url },
    body: JSON.stringify(body),
  })
}

export const s111: CertificationScenario = {
  id: 'S111',
  title: 'REAL-003-V028 Launchpad create plans unbound natural-language ACs before Direct execution',
  group: 'control',
  async run(ctx) {
    const repo = await initFixtureRepo(ctx.dirs.repo, {
      'package.json': JSON.stringify({ scripts: { test: 'node unavailable-postgres-test.js' } }),
      'apps/web/package.json': JSON.stringify({ scripts: { test: 'node --test overview.test.mjs ticketFilters.test.mjs', typecheck: 'node -e "process.exit(0)"' } }),
      'apps/web/overview.test.mjs': 'export {}\n',
      'apps/web/ticketFilters.test.mjs': 'export {}\n',
      'apps/web/src/tickets.ts': 'export const tickets = []\n',
    }, 'feat/real-003-v028-smoke')
    const configsDir = join(ctx.dirs.root, 'configs')
    await mkdir(configsDir, { recursive: true })
    let app: ProductionWorkSessionUi | undefined
    const actions: string[] = []
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configsDir, dependencies: {
      resolveEnvironment: async () => ({ ...process.env, LOCALAPPDATA: ctx.dirs.data }),
      preflight: async () => healthyReport(),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'feat/real-003-v028-smoke\n', stderr: '' }),
      createWorkSession: async (config, input) => {
        const created = await createProductionWorkSessionUi(config, {
          ...input,
          createRuntime: (runtimeConfig) => new WorkSessionRuntime(runtimeConfig),
          v2Agents: [{ id: 'codex', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'cert:s111:codex' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }],
          createV2Dispatcher: ({ defaultDispatcher }) => ({
            inspectRepository: defaultDispatcher.inspectRepository,
            dispatch: async ({ action, task: state }) => {
              actions.push(action)
              if (action === 'EXECUTE') {
                await repoWrite(repo, 'apps/web/src/ticket-count.ts', 'export const ticketCount = true\n')
                return { status: 'SUCCESS', providerHistory: ['codex'] }
              }
              if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: state.verificationPlan!.steps.map((step) => ({ name: step.command, status: 'passed' as const })) }
              return { status: 'BLOCKED', blockers: [`unexpected action ${action}`] }
            },
          }),
        })
        app = created
        return created
      },
    } })
    try {
      await launchpad.start()
      const response = await postCreate(launchpad, {
        requestId: `cert-s111-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}-00000000`,
        targetRepo: repo,
        branch: 'feat/real-003-v028-smoke',
        tasks: [{ id: 'REAL-003-V028', goal: 'Add a filtered X / Y ticket count beside the existing ticket filters.' }],
        directPathEnabled: true,
        guardian: {
          allowedPaths: ['apps/web/**'],
          acceptanceCriteria: ['AC1:', '没有筛选时显示 X = Y。'],
          constraints: ['不修改后端。', '不修改数据库 schema。', '不新增依赖。'],
          forbiddenPaths: ['apps/api/**', 'database/**', 'migrations/**'],
        },
        autoCommit: false,
      })
      ctx.h.check(response.status === 202, `Launchpad accepted REAL-003-V028 (got ${response.status} ${(await response.text()).slice(0, 200)})`)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && app?.runtime.getDurableState()?.state !== 'COMPLETED' && app?.runtime.getDurableState()?.state !== 'SUSPENDED') {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
      const state = app?.runtime.getDurableState()
      const taskState = state?.taskStatesV2?.['REAL-003-V028']
      const events = taskState === undefined ? [] : state?.taskEventLogs?.['REAL-003-V028'] ?? []
      ctx.h.check(state?.state === 'COMPLETED', `real production runtime completed (got ${state?.state ?? 'missing'}: ${state?.humanRequired?.category ?? 'no-category'} / ${state?.humanRequired?.reason ?? 'no-reason'}; actions=${actions.join(' -> ')}; blockers=${JSON.stringify(taskState?.blockers)}; escalation=${JSON.stringify(events.find((event) => event.type === 'DIRECT_PATH_ESCALATED')?.metadata)})`)
      ctx.h.check(taskState?.verificationPlan?.confidence === 'HIGH', 'VerificationPlan generated with HIGH confidence')
      ctx.h.check(taskState?.execution?.path === 'DIRECT' && taskState.execution.escalated === false, 'task remained DIRECT eligible')
      ctx.h.check(actions.join(' -> ') === 'EXECUTE -> VERIFY', `Direct protocol dispatched EXECUTE -> VERIFY (got ${actions.join(' -> ')})`)
      ctx.h.check(events.some((event) => event.type === 'VERIFICATION_PLANNED') && events.some((event) => event.type === 'DIRECT_PATH_STARTED'), 'PLANNING preceded Direct execution')
      ctx.h.check(!events.some((event) => event.type === 'CONTROLLER_DECIDED'), 'legacy Controller missing-binding validator was not reached')
      ctx.h.check(taskState?.completion.bindings.every((binding) => binding.requiredEvidence.length > 0), 'all natural-language ACs received Planner evidence')
      ctx.h.check(!taskState?.verificationPlan?.steps.some((step) => step.command === 'npm test' && step.cwd === '.'), 'Planner did not invent a root npm test fallback')
      ctx.h.check(taskState?.verificationPlan?.steps.some((step) => step.command === 'node --test apps/web/ticketFilters.test.mjs'), 'Planner selected the closest filter test with a repository-relative execution path')
      ctx.h.check(!taskState?.verificationPlan?.steps.some((step) => step.command.includes('overview.test.mjs')), 'Planner excluded the unrelated same-package test')
      const persisted = await discoverTrustedWorkSessionConfigs(configsDir)
      const serialized = JSON.parse(await readFile(persisted[0]!.configPath, 'utf8')) as TrustedWorkSessionConfig
      ctx.h.check(serialized.session.directPath?.enabled === true, 'directPath.enabled survived the real Launchpad persistence boundary')
    } finally {
      await launchpad.close().catch(() => undefined)
    }
  },
}
