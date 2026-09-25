import type { TaskAction } from '../work-session/task-controller.js'
import { TaskController, type ControllerRuntimeState } from '../work-session/task-controller.js'
import { createTaskStateV2, type TaskStateV2 } from '../work-session/task-state-v2.js'
import type { DecisionClient, DecisionClientOutcome } from './client.js'
import { TASK_ACTIONS, type DecisionShadowStateProjection } from './contract.js'
import { buildDecisionShadowStateProjection } from './state-projection.js'

export type DecisionBenchmarkCheckpoint = 'english' | 'typed-decisions'

export interface DecisionBenchmarkObservation {
  status: DecisionClientOutcome['status']
  action: TaskAction | null
  latencyMs: number
  confidence: number | null
  probabilities: Partial<Record<TaskAction, number>> | null
}

export interface DecisionBenchmarkCase {
  caseId: string
  projection: DecisionShadowStateProjection
  referenceAction: TaskAction
  english: DecisionBenchmarkObservation
  typedDecisions: DecisionBenchmarkObservation
}

export interface DecisionBenchmarkInput {
  caseId: string
  projection: DecisionShadowStateProjection
  referenceAction: TaskAction
}

export interface CheckpointBenchmarkReport {
  successful: number
  exact_match_rate: number
  by_action_match_rate: Record<TaskAction, { samples: number; matches: number; match_rate: number | null }>
  confusion_matrix: Record<TaskAction, Partial<Record<TaskAction | 'ERROR', number>>>
  latency_p50: number | null
  latency_p95: number | null
}

export interface DecisionBenchmarkReport {
  samples: number
  action_coverage: TaskAction[]
  cases: DecisionBenchmarkCase[]
  english: CheckpointBenchmarkReport
  typed_decisions: CheckpointBenchmarkReport
  better_checkpoint: DecisionBenchmarkCheckpoint | 'inconclusive'
}

const SESSION = { id: 'decision-shadow-benchmark', branch: 'spike/laya-decision-benchmark' }
const BINDINGS = [{ criterion: 'tests pass', requiredEvidence: ['test'] }]
const TASK = { id: 'benchmark-task', goal: 'Implement the scoped change', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: BINDINGS }
const GIT = { repositoryIdentity: 'benchmark-repo', branch: SESSION.branch, headSha: 'benchmark-head', changedFiles: [] as string[], worktreeFingerprint: 'benchmark-worktree' }
const EVIDENCE = [{ type: 'test', status: 'PASSED' as const, source: 'deterministic', repositoryIdentity: GIT.repositoryIdentity, branch: GIT.branch, headSha: GIT.headSha, workspaceIdentity: GIT.worktreeFingerprint, timestamp: 'benchmark' }]

function initial(overrides: Partial<TaskStateV2> = {}): TaskStateV2 {
  return { ...createTaskStateV2(SESSION, TASK), ...overrides }
}

function verified(overrides: Partial<TaskStateV2> = {}): TaskStateV2 {
  return initial({
    status: 'ACTIVE',
    gitState: GIT,
    verificationState: { results: [{ name: 'test', status: 'passed' }] },
    completion: { evidence: EVIDENCE, bindings: BINDINGS },
    ...overrides,
  })
}

function benchmarkInput(caseId: string, state: TaskStateV2, runtime: ControllerRuntimeState = {}): DecisionBenchmarkInput {
  const referenceAction = new TaskController().decide(state, runtime).action
  return { caseId, projection: buildDecisionShadowStateProjection(state, runtime), referenceAction }
}

/** Mirrors deterministic states already exercised by task-state, risk-evidence, and controller tests. */
export function createDecisionBenchmarkCases(): DecisionBenchmarkInput[] {
  const implementer = { agent: 'coder', provider: 'codex', runtimeIdentity: 'runtime-coder' }
  const failedReviewState = verified({
    implementer,
    completion: {
      evidence: EVIDENCE,
      bindings: BINDINGS,
      review: {
        passed: false,
        findings: ['blocking issue'],
        severity: 'HIGH',
        blockingFindings: ['blocking issue'],
        reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'runtime-reviewer' },
        implementer,
        reviewedRepository: GIT.repositoryIdentity,
        reviewedBranch: GIT.branch,
        reviewedCommit: GIT.headSha,
        reviewedWorkspace: GIT.worktreeFingerprint,
        reviewedFiles: [],
        timestamp: 'benchmark',
      },
    },
  })
  const highRisk = verified({
    goal: 'Change public API contract',
    gitState: { ...GIT, changedFiles: ['src/public-api.ts'] },
  })
  const approvalRequired = verified({
    completion: { evidence: EVIDENCE, bindings: [{ ...BINDINGS[0]!, requiresApproval: true }] },
  })
  return [
    benchmarkInput('acceptance-analysis-required', initial({ acceptanceCriteria: [], completion: { evidence: [], bindings: [] } })),
    benchmarkInput('pending-execute', initial()),
    benchmarkInput('pending-verify-only', initial({ humanConstraints: { verifyOnly: true } })),
    benchmarkInput('blocker-suspend', initial({ blockers: ['blocked by a deterministic prerequisite'] })),
    benchmarkInput('repository-reconcile', initial(), { reconciliationRequired: true }),
    benchmarkInput('environment-failure-suspend', initial({ status: 'ACTIVE', verificationState: { results: [{ name: 'test', status: 'failed', classification: 'ENVIRONMENT_FAILURE' }] } })),
    benchmarkInput('code-failure-execute', initial({ status: 'ACTIVE', verificationState: { results: [{ name: 'test', status: 'failed', classification: 'CODE_FAILURE' }] } })),
    benchmarkInput('missing-evidence-verify', initial({ status: 'ACTIVE', verificationState: { results: [{ name: 'test', status: 'passed' }] } })),
    benchmarkInput('failed-review-execute', failedReviewState),
    benchmarkInput('high-risk-review', highRisk),
    benchmarkInput('approval-required', approvalRequired),
    benchmarkInput('completion-satisfied', verified()),
  ]
}

async function observe(client: DecisionClient, projection: DecisionShadowStateProjection): Promise<DecisionBenchmarkObservation> {
  let outcome: DecisionClientOutcome
  try { outcome = await client.decide(projection) } catch { outcome = { status: 'exception', latencyMs: 0 } }
  return outcome.status === 'ok'
    ? { status: 'ok', action: outcome.decision.action, latencyMs: outcome.latencyMs, confidence: outcome.decision.confidence, probabilities: outcome.decision.probabilities }
    : { status: outcome.status, action: null, latencyMs: outcome.latencyMs, confidence: null, probabilities: null }
}

export async function runDecisionBenchmark(
  inputs: readonly DecisionBenchmarkInput[],
  clients: Record<DecisionBenchmarkCheckpoint, DecisionClient>,
): Promise<DecisionBenchmarkCase[]> {
  const results: DecisionBenchmarkCase[] = []
  for (const [index, input] of inputs.entries()) {
    let english: DecisionBenchmarkObservation
    let typedDecisions: DecisionBenchmarkObservation
    if (index % 2 === 0) {
      english = await observe(clients.english, input.projection)
      typedDecisions = await observe(clients['typed-decisions'], input.projection)
    } else {
      typedDecisions = await observe(clients['typed-decisions'], input.projection)
      english = await observe(clients.english, input.projection)
    }
    results.push({ ...input, english, typedDecisions })
  }
  return results
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null
}

function checkpointReport(cases: readonly DecisionBenchmarkCase[], checkpoint: 'english' | 'typedDecisions'): CheckpointBenchmarkReport {
  const byAction = Object.fromEntries(TASK_ACTIONS.map((action) => [action, { samples: 0, matches: 0, match_rate: null as number | null }])) as CheckpointBenchmarkReport['by_action_match_rate']
  const confusion = Object.fromEntries(TASK_ACTIONS.map((action) => [action, {}])) as CheckpointBenchmarkReport['confusion_matrix']
  let successful = 0
  let matches = 0
  for (const item of cases) {
    const observation = item[checkpoint]
    const row = byAction[item.referenceAction]
    row.samples++
    if (observation.status === 'ok' && observation.action !== null) {
      successful++
      confusion[item.referenceAction][observation.action] = (confusion[item.referenceAction][observation.action] ?? 0) + 1
      if (observation.action === item.referenceAction) { row.matches++; matches++ }
    } else confusion[item.referenceAction].ERROR = (confusion[item.referenceAction].ERROR ?? 0) + 1
  }
  for (const row of Object.values(byAction)) row.match_rate = row.samples === 0 ? null : row.matches / row.samples
  const latencies = cases
    .map((item) => item[checkpoint])
    .filter((observation) => observation.status === 'ok')
    .map((observation) => observation.latencyMs)
  return {
    successful,
    exact_match_rate: cases.length === 0 ? 0 : matches / cases.length,
    by_action_match_rate: byAction,
    confusion_matrix: confusion,
    latency_p50: percentile(latencies, 0.5),
    latency_p95: percentile(latencies, 0.95),
  }
}

export function buildDecisionBenchmarkReport(cases: DecisionBenchmarkCase[]): DecisionBenchmarkReport {
  const english = checkpointReport(cases, 'english')
  const typedDecisions = checkpointReport(cases, 'typedDecisions')
  const actionCoverage = TASK_ACTIONS.filter((action) => cases.some((item) => item.referenceAction === action))
  const sufficient = cases.length >= 12 && actionCoverage.length === TASK_ACTIONS.length
  const difference = english.exact_match_rate - typedDecisions.exact_match_rate
  const betterCheckpoint = !sufficient || Math.abs(difference) < 0.1
    ? 'inconclusive'
    : difference > 0 ? 'english' : 'typed-decisions'
  return { samples: cases.length, action_coverage: actionCoverage, cases, english, typed_decisions: typedDecisions, better_checkpoint: betterCheckpoint }
}
