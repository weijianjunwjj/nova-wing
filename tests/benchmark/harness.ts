/**
 * NovaWing v0.1 vs v0.2 deterministic control-plane benchmark harness.
 *
 * 本 harness 用**确定性的 scripted work**（脚本化 brain/executor 与 dispatcher）驱动
 * 两条真实执行路径：
 *
 * - v0.1 = Guardian-centric legacy path：runGuardianTask（GuardianTask + GuardianBrain +
 *   GuardianExecutor）。完成判定依赖 Reviewer('done') + executor 报告的 verification。
 * - v0.2 = TaskStateV2 + TaskController + V2ControllerTaskRunner。完成判定依赖
 *   deterministic Evidence Gate（EXECUTE/VERIFY 分离、criterion-specific binding）。
 *
 * 重要边界：
 * - 这不是 LLM 质量 benchmark。LLM/token/quota 指标一律标记 'UNAVAILABLE'。
 * - 相同任务、相同 work truth、相同验收/权限条件驱动两边；差异来自两条控制路径本身。
 * - 结果可复现（确定性执行），wall-clock 只测控制面开销，不具统计显著性。
 */

import { runGuardianTask } from '../../packages/development-guardian/guardian.js'
import type { GuardianTask } from '../../packages/development-guardian/model.js'
import type { GuardianBrain, GuardianExecutor } from '../../packages/development-guardian/ports.js'
import type { GuardianProgressEvent } from '../../packages/development-guardian/progress.js'
import { V2ControllerTaskRunner } from '../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { TaskEventLogV2 } from '../../packages/development-guardian/work-session/task-observability.js'
import type { WorkSessionTask } from '../../packages/development-guardian/work-session/model.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

export type Verdict = 'passed' | 'failed'

export interface Attempt {
  changedFiles: string[]
  verification: Verdict[]
}

export interface BenchmarkTaskSpec {
  id: string
  source: string
  category: string
  risk: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
  goal: string
  acceptanceCriteria: string[]
  requiredEvidence: string[]
  allowedPaths: string[]
  forbiddenPaths: string[]
  expectedDifficulty: number
  deterministic?: boolean
  notRunReason?: string
  work?: { blocked?: boolean; blockReason?: string; attempts: Attempt[] }
}

export interface BenchmarkCatalog {
  schemaVersion: number
  frozenAt: string
  tasks: BenchmarkTaskSpec[]
}

export interface BenchmarkMetrics {
  success: boolean
  totalDurationMs: number
  controllerDecisionCount: number
  agentDispatchCount: number
  providerSwitchCount: number
  handoffCount: number
  verificationRunCount: number
  verificationFailureCount: number
  retryCount: number
  reviewCount: number
  approvalCount: number
  humanInterventionCount: number
  taskEventCount: number
  llmCallCount: 'UNAVAILABLE'
  tokenUsage: 'UNAVAILABLE'
  quotaUsage: 'UNAVAILABLE'
  providerExecutionDurationMs: 'UNAVAILABLE'
}

export interface RunOutcome {
  mode: 'v1' | 'v2'
  taskId: string
  completed: boolean
  humanRequired: boolean
  failed: boolean
  terminalState: string
}

export interface TaskRun {
  taskId: string
  mode: 'v1' | 'v2'
  outcome: RunOutcome
  metrics: BenchmarkMetrics
  valid: boolean
  invalidReason?: string
}

export function loadCatalog(path = 'benchmark/tasks.json'): BenchmarkCatalog {
  const absolute = resolve(process.cwd(), path)
  const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as BenchmarkCatalog
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
    throw new Error('invalid benchmark catalog')
  }
  return parsed
}

export function executedTasks(catalog: BenchmarkCatalog): BenchmarkTaskSpec[] {
  return catalog.tasks.filter((task) => task.deterministic === true && task.work !== undefined)
}

function emptyMetrics(): BenchmarkMetrics {
  return {
    success: false,
    totalDurationMs: 0,
    controllerDecisionCount: 0,
    agentDispatchCount: 0,
    providerSwitchCount: 0,
    handoffCount: 0,
    verificationRunCount: 0,
    verificationFailureCount: 0,
    retryCount: 0,
    reviewCount: 0,
    approvalCount: 0,
    humanInterventionCount: 0,
    taskEventCount: 0,
    llmCallCount: 'UNAVAILABLE',
    tokenUsage: 'UNAVAILABLE',
    quotaUsage: 'UNAVAILABLE',
    providerExecutionDurationMs: 'UNAVAILABLE',
  }
}

function verificationResultsOf(packetVerification: string[], values: Verdict[]): { name: string; status: 'passed' | 'failed'; classification?: 'CODE_FAILURE' }[] {
  return packetVerification.map((name, index) => ({
    name,
    status: values[Math.min(index, values.length - 1)] === 'passed' ? 'passed' : 'failed',
    ...(values[Math.min(index, values.length - 1)] === 'passed' ? {} : { classification: 'CODE_FAILURE' as const }),
  }))
}

function isBlockedAttempt(spec: BenchmarkTaskSpec, attempt: Attempt): boolean {
  return spec.work?.blocked === true && attempt.changedFiles.some((file) =>
    spec.forbiddenPaths.some((forbidden) => file === forbidden || file.startsWith(`${forbidden.replace(/\/$/u, '')}/`)))
}

/** 每个 mode 执行前的 provider health snapshot（scripted，非 live）。 */
export function providerHealthSnapshot(): Record<string, string> {
  return { codex: 'AVAILABLE (scripted)', deepseek: 'AVAILABLE (scripted)' }
}

/**
 * ============ v0.1 Guardian-centric legacy path ============
 */
export async function runV1Internal(spec: BenchmarkTaskSpec): Promise<TaskRun> {
  const started = performance.now()
  const work = spec.work!
  const progress: GuardianProgressEvent[] = []
  let reviewCount = 0
  let executeCount = 0
  let verificationFailures = 0
  let attemptIndex = 0

  const brain: GuardianBrain = {
    async review({ report }) {
      reviewCount += 1
      if (report === undefined || report.verificationResults.some((result) => result.status !== 'passed')) {
        return {
          verdict: 'proceed',
          goal: spec.goal,
          instructions: ['implement the requested change'],
          constraints: [],
          verification: spec.requiredEvidence,
          doNotDo: [...spec.forbiddenPaths],
        }
      }
      return {
        verdict: 'done',
        goal: spec.goal,
        instructions: [],
        constraints: [],
        verification: spec.requiredEvidence,
        doNotDo: [...spec.forbiddenPaths],
      }
    },
  }

  const executor: GuardianExecutor = {
    async execute() {
      executeCount += 1
      const attempt = work.attempts[Math.min(attemptIndex, work.attempts.length - 1)]!
      attemptIndex += 1
      const blocked = isBlockedAttempt(spec, attempt)
      const results = verificationResultsOf(spec.requiredEvidence, attempt.verification)
      if (!blocked && results.some((result) => result.status === 'failed')) verificationFailures += 1
      return {
        summary: blocked ? 'attempted a forbidden-path change' : `implemented ${spec.id}`,
        changedFiles: attempt.changedFiles,
        commandsRun: [...spec.requiredEvidence],
        verificationResults: results,
        blockers: blocked ? [spec.work?.blockReason ?? 'forbidden path'] : [],
      }
    },
  }

  const guardianTask: GuardianTask = {
    id: spec.id,
    goal: spec.goal,
    state: 'READY',
    iteration: 0,
    maxIterations: Math.max(6, work.attempts.length + 2),
    constraints: [],
    doNotDo: [...spec.forbiddenPaths],
    allowedPaths: [...spec.allowedPaths],
    forbiddenPaths: [...spec.forbiddenPaths],
    acceptanceCriteria: [...spec.acceptanceCriteria],
  }

  const run = await runGuardianTask({ task: guardianTask, brain, executor, onProgress: (event) => progress.push(event) })
  const completed = run.task.state === 'COMPLETED'
  const humanRequired = run.task.state === 'HUMAN_REQUIRED'
  const failed = run.task.state === 'FAILED' || run.task.state === 'BRAIN_INFRASTRUCTURE_FAILED'
  const metrics = emptyMetrics()
  metrics.success = completed
  metrics.totalDurationMs = performance.now() - started
  metrics.controllerDecisionCount = reviewCount
  metrics.agentDispatchCount = executeCount
  metrics.providerSwitchCount = 0
  metrics.handoffCount = 0
  metrics.verificationRunCount = executeCount
  metrics.verificationFailureCount = verificationFailures
  metrics.retryCount = Math.max(0, executeCount - 1)
  metrics.reviewCount = reviewCount
  metrics.approvalCount = 0
  metrics.humanInterventionCount = humanRequired || failed ? 1 : 0
  metrics.taskEventCount = progress.length

  return {
    taskId: spec.id,
    mode: 'v1',
    outcome: { mode: 'v1', taskId: spec.id, completed, humanRequired, failed, terminalState: run.task.state },
    metrics,
    valid: true,
  }
}

/**
 * ============ v0.2 TaskStateV2 + TaskController path ============
 */
export async function runV2Internal(spec: BenchmarkTaskSpec): Promise<TaskRun> {
  const started = performance.now()
  const work = spec.work!
  const eventLog = new TaskEventLogV2()
  let attemptIndex = 0
  let observedChangedFiles: string[] = []

  const workSessionTask: WorkSessionTask = {
    id: spec.id,
    goal: spec.goal,
    constraints: [],
    acceptanceCriteria: [...spec.acceptanceCriteria],
    allowedPaths: [...spec.allowedPaths],
    forbiddenPaths: [...spec.forbiddenPaths],
    acceptanceEvidenceBindings: spec.acceptanceCriteria.map((criterion) => ({ criterion, requiredEvidence: [...spec.requiredEvidence] })),
  }

  const runner = new V2ControllerTaskRunner({
    sessionId: 'bench-session',
    branch: 'main',
    agents: [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }],
    dispatcher: {
      inspectRepository: async () => ({
        repositoryIdentity: 'bench-repo',
        branch: 'main',
        headSha: 'h',
        changedFiles: [...observedChangedFiles],
        worktreeFingerprint: `w-${attemptIndex}-${observedChangedFiles.join('|')}`,
      }),
      dispatch: async ({ action }) => {
        if (action === 'EXECUTE') {
          const attempt = work.attempts[Math.min(attemptIndex, work.attempts.length - 1)]!
          attemptIndex += 1
          observedChangedFiles = [...new Set([...observedChangedFiles, ...attempt.changedFiles])]
          return { status: 'SUCCESS' as const, changedFiles: [...attempt.changedFiles] }
        }
        if (action === 'VERIFY') {
          const step = Math.min(Math.max(attemptIndex - 1, 0), work.attempts.length - 1)
          const attempt = work.attempts[step]!
          return { status: 'SUCCESS' as const, verificationResults: verificationResultsOf(spec.requiredEvidence, attempt.verification) }
        }
        return { status: 'SUCCESS' as const }
      },
    },
  })

  const result = await runner.run(workSessionTask, undefined, undefined, { taskEventLog: eventLog })

  const completed = result.status === 'COMPLETED'
  const humanRequired = result.status === 'HUMAN_REQUIRED'
  const failed = result.status === 'FAILED' || result.status === 'BRAIN_INFRASTRUCTURE_FAILED'
  const events = eventLog.events
  const metrics = emptyMetrics()
  metrics.success = completed
  metrics.totalDurationMs = performance.now() - started
  metrics.controllerDecisionCount = events.filter((event) => event.type === 'CONTROLLER_DECIDED').length
  metrics.agentDispatchCount = events.filter((event) => event.type === 'AGENT_DISPATCHED').length
  metrics.providerSwitchCount = events.filter((event) => event.type === 'PROVIDER_SWITCHED').length
  metrics.handoffCount = events.filter((event) => event.type === 'PROVIDER_SWITCHED').length
  metrics.verificationRunCount = events.filter((event) => event.type === 'VERIFICATION_STARTED').length
  metrics.verificationFailureCount = events.filter((event) => event.type === 'VERIFICATION_FAILED').length
  const executeDispatches = events.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE').length
  metrics.retryCount = Math.max(0, executeDispatches - 1)
  metrics.reviewCount = events.filter((event) => event.type === 'REVIEW_REQUIRED').length
  metrics.approvalCount = events.filter((event) => event.type === 'APPROVAL_REQUIRED').length
  metrics.humanInterventionCount = humanRequired || failed ? 1 : 0
  metrics.taskEventCount = events.length

  return {
    taskId: spec.id,
    mode: 'v2',
    outcome: { mode: 'v2', taskId: spec.id, completed, humanRequired, failed, terminalState: result.status },
    metrics,
    valid: true,
  }
}

export async function runTask(spec: BenchmarkTaskSpec, mode: 'v1' | 'v2'): Promise<TaskRun> {
  if (spec.work === undefined) {
    return { taskId: spec.id, mode, outcome: { mode, taskId: spec.id, completed: false, humanRequired: false, failed: false, terminalState: 'NOT_RUN' }, metrics: emptyMetrics(), valid: false, invalidReason: 'no deterministic work plan' }
  }
  return mode === 'v1' ? runV1Internal(spec) : runV2Internal(spec)
}

export type ArchitectureBenchmarkCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
export interface ArchitectureBenchmarkSpec {
  id: string
  category: ArchitectureBenchmarkCategory
  description: string
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  changedFiles: readonly string[]
  evidence: readonly string[]
  firstVerificationFails?: boolean
}

export const architectureBenchmarkTasks: readonly ArchitectureBenchmarkSpec[] = [
  { id: 'AB-A', category: 'A', description: 'single-file UI copy', risk: 'LOW', changedFiles: ['apps/web/src/copy.ts'], evidence: ['node --test tests/ui.test.js', 'git diff --check'] },
  { id: 'AB-B', category: 'B', description: 'frontend interaction and targeted test', risk: 'LOW', changedFiles: ['apps/web/src/ticket-filter.ts'], evidence: ['node --test tests/ticket.test.js', 'npm run typecheck', 'git diff --check'] },
  { id: 'AB-C', category: 'C', description: 'logic change and targeted test', risk: 'LOW', changedFiles: ['packages/core/src/counter.ts'], evidence: ['node --test tests/logic.test.js', 'git diff --check'] },
  { id: 'AB-D', category: 'D', description: 'code failure then repair', risk: 'LOW', changedFiles: ['packages/core/src/repair.ts'], evidence: ['node --test tests/logic.test.js'], firstVerificationFails: true },
  { id: 'AB-E', category: 'E', description: 'medium multi-file change', risk: 'MEDIUM', changedFiles: ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/tests/a.test.ts'], evidence: ['node --test tests/ui.test.js', 'npm run typecheck'] },
  { id: 'AB-F', category: 'F', description: 'public API contract high risk', risk: 'HIGH', changedFiles: ['packages/core/src/public-contract.ts'], evidence: ['node --test tests/logic.test.js', 'npm run typecheck'] },
  { id: 'AB-G', category: 'G', description: 'REAL-002 PostgreSQL root-suite trap', risk: 'LOW', changedFiles: ['apps/web/src/ticket-filter.ts'], evidence: ['node --test tests/ticket.test.js', 'npm run typecheck', 'git diff --check'] },
  { id: 'AB-H', category: 'H', description: 'REAL-003 X/Y counter', risk: 'LOW', changedFiles: ['apps/web/src/ticket-count.ts'], evidence: ['node --test tests/ticket.test.js', 'npm run typecheck', 'git diff --check'] },
]

export interface ArchitectureBenchmarkMetrics {
  executionPath: 'DIRECT' | 'GOLDEN' | 'CONTROLLER'
  completed: boolean
  firstPass: boolean
  wallClockMs: number
  controllerDecisionCount: number
  dispatchCount: number
  executeCount: number
  verifyCount: number
  reviewCount: number
  repoInspectionCount: number
  gitProcessCount: number
  verifierProcessCount: number
  stateWriteCount: number
  modelProviderCallCount: number
  humanActionCount: number
  humanDecisionCount: number
  failureSurface: readonly string[]
  escalated: boolean
  finalStatus: string
}

export interface ArchitectureBenchmarkRun { taskId: string; category: ArchitectureBenchmarkCategory; mode: 'CONTROLLER' | 'DIRECT'; metrics: ArchitectureBenchmarkMetrics }

function architectureFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'novawing-ab-'))
  for (const directory of ['apps/web/src', 'apps/web/tests', 'packages/core/src', 'packages/core/tests']) mkdirSync(join(root, directory), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node unavailable-postgres.js', 'test:logic': 'node --test packages/core/tests', typecheck: 'tsc --noEmit' } }))
  writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:ticket': 'node --test tests/ticket.test.js', 'test:ui': 'node --test tests/ui.test.js', typecheck: 'tsc --noEmit' } }))
  writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:logic': 'node --test tests/logic.test.js', typecheck: 'tsc --noEmit' } }))
  for (const file of ['apps/web/tests/ticket.test.js', 'apps/web/tests/ui.test.js', 'packages/core/tests/logic.test.js']) writeFileSync(join(root, file), 'export {}\n')
  return root
}

/** Production-shaped A/B seam: same TaskState/dispatcher/events, only the Direct flag differs. */
export async function runArchitectureBenchmark(spec: ArchitectureBenchmarkSpec, mode: 'CONTROLLER' | 'DIRECT'): Promise<ArchitectureBenchmarkRun> {
  const root = architectureFixture()
  const started = performance.now()
  const eventLog = new TaskEventLogV2()
  let repoInspectionCount = 0, gitProcessCount = 0, verifierProcessCount = 0, stateWriteCount = 0, modelProviderCallCount = 0
  let changed = false, executeCount = 0, verifyCount = 0
  try {
    const task: WorkSessionTask = { id: spec.id, goal: spec.description, constraints: [], acceptanceCriteria: [`${spec.id} accepted`],
      allowedPaths: spec.category === 'C' || spec.category === 'D' || spec.category === 'F' ? ['packages/core'] : ['apps/web'], forbiddenPaths: ['.env'], risk: spec.risk,
      acceptanceEvidenceBindings: [{ criterion: `${spec.id} accepted`, requiredEvidence: [...spec.evidence] }] }
    const reality = () => ({ repositoryIdentity: root, branch: 'main', headSha: 'benchmark-head', changedFiles: changed ? [...spec.changedFiles] : [], worktreeFingerprint: changed ? `changed-${executeCount}` : 'clean' })
    const runner = new V2ControllerTaskRunner({ sessionId: `bench-${mode.toLowerCase()}`, branch: 'main', directPath: { enabled: mode === 'DIRECT', repositoryRoot: root },
      agents: [
        { id: 'executor-router', identity: { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'router' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } },
        { id: 'reviewer', identity: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'reviewer' }, available: true, quotaExhausted: false, degraded: false, capabilities: { review: true } },
      ], dispatcher: {
        async inspectRepository() { repoInspectionCount += 1; gitProcessCount += 4; return reality() },
        async dispatch({ action, task: state, agent }) {
          if (action === 'EXECUTE') { executeCount += 1; modelProviderCallCount += 1; changed = true; return { status: 'SUCCESS' as const, changedFiles: [...spec.changedFiles], providerHistory: ['codex'], ...(executeCount > 1 ? { implementationEvidenceAdded: true } : {}) } }
          if (action === 'VERIFY') { verifyCount += 1; const evidence = state.verificationPlan?.steps.map((step) => step.command) ?? state.completion.bindings.flatMap((binding) => binding.requiredEvidence); verifierProcessCount += evidence.length
            const failed = spec.firstVerificationFails === true && verifyCount === 1
            return { status: 'SUCCESS' as const, verificationResults: [...new Set(evidence)].map((name) => ({ name, status: failed ? 'failed' as const : 'passed' as const, ...(failed ? { classification: 'CODE_FAILURE' as const } : {}) })) } }
          if (action === 'REVIEW') { modelProviderCallCount += 1; const reviewer = agent.identity!; return { status: 'SUCCESS' as const, review: { passed: true, findings: [], blockingFindings: [], severity: 'HIGH' as const, reviewer,
            implementer: state.implementer!, reviewedRepository: state.gitState.repositoryIdentity!, reviewedBranch: state.gitState.branch!, reviewedCommit: state.gitState.headSha!, reviewedWorkspace: state.gitState.worktreeFingerprint!, reviewedFiles: state.gitState.changedFiles, timestamp: new Date().toISOString() } } }
          return { status: 'SUCCESS' as const }
        },
      } })
    const result = await runner.run(task, undefined, undefined, { taskEventLog: eventLog, persistTaskStateV2: async () => { stateWriteCount += 1 } })
    const events = eventLog.events
    const failureSurface = events
      .filter((event) => event.type === 'VERIFICATION_CLASSIFIED' || event.type === 'AGENT_FAILED' || event.type === 'TASK_SUSPENDED')
      .map((event) => String(event.metadata?.classification ?? event.reasonCode ?? event.type))
    return { taskId: spec.id, category: spec.category, mode, metrics: {
      executionPath: result.taskStateV2?.execution?.path ?? 'CONTROLLER', completed: result.status === 'COMPLETED',
      firstPass: result.status === 'COMPLETED' && events.filter((event) => event.type === 'VERIFICATION_FAILED').length === 0,
      wallClockMs: performance.now() - started, controllerDecisionCount: events.filter((event) => event.type === 'CONTROLLER_DECIDED').length,
      dispatchCount: events.filter((event) => event.type === 'AGENT_DISPATCHED').length, executeCount: events.filter((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE').length,
      verifyCount: events.filter((event) => event.type === 'VERIFICATION_STARTED').length, reviewCount: events.filter((event) => event.type === 'REVIEW_STARTED').length,
      repoInspectionCount, gitProcessCount, verifierProcessCount, stateWriteCount, modelProviderCallCount, humanActionCount: events.filter((event) => event.type === 'HUMAN_ACTION_RECORDED').length,
      humanDecisionCount: events.filter((event) => event.type === 'HUMAN_DECISION_RECORDED').length, failureSurface,
      escalated: events.some((event) => event.type === 'DIRECT_PATH_ESCALATED'), finalStatus: result.status,
    } }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
