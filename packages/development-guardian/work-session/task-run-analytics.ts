import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { WorkSessionDefinition, WorkSessionDurableState } from './model.js'
import type { RuntimeRepairReasonCode } from './runtime-repair.js'
import type { DecisionReasonCode, TaskEventV2 } from './task-observability.js'
import type { TaskStateV2 } from './task-state-v2.js'

export type TaskRunFinalStatus = 'COMPLETED' | 'FAILED' | 'SUSPENDED' | 'RUNNING'
export type TaskRunCommitResult = 'COMMITTED' | 'ALREADY_SATISFIED' | 'NO_CHANGES_REQUIRED' | 'COMMIT_FAILED' | 'NOT_REQUESTED' | 'UNKNOWN'
export type AnalyticsStage = 'EXECUTE' | 'VERIFY' | 'REVIEW' | 'AI_REPAIR' | 'RUNTIME_REPAIR' | 'HUMAN_WAIT'

export interface TaskRunSummary {
  sessionId: string; taskId: string; projectPath: string; branch: string
  startedAt: string | null; finishedAt: string | null; finalStatus: TaskRunFinalStatus; completionReason: string | null
  totalDurationMs: number | null
  executeCount: number; executeDurationMs: number
  verifyCount: number; verifyDurationMs: number; verificationFailureCount: number
  reviewCount: number; reviewDurationMs: number; reviewFailureCount: number
  aiRepairCount: number; aiRepairDurationMs: number
  runtimeRepairCount: number; runtimeRepairDurationMs: number
  humanRequiredCount: number; humanInterventionCount: number; humanActionCount: number; humanDecisionCount: number
  repairTriggeredByUser: number; humanWaitDurationMs: number
  providerSwitchCount: number; implementerProviders: readonly string[]; reviewerProviders: readonly string[]
  restartCount: number; reconciliationCount: number
  commitResult: TaskRunCommitResult; commitHash: string | null; changedFileCount: number | null; evidenceCount: number
  firstPassSuccess: boolean | null; zeroHumanCompletion: boolean | null
  createdAt: string; updatedAt: string
}

export interface TaskRunStage {
  sessionId: string; taskId: string; stage: AnalyticsStage; occurrence: number
  startedAt: string; finishedAt: string | null; durationMs: number | null
  result: string | null; provider: string | null; reasonCode: string | null
}

export interface RecentTaskRunAnalytics {
  limit: number; taskCount: number; completedCount: number; zeroHumanCompletionCount: number
  zeroHumanCompletionRate: number | null; firstPassSuccessCount: number; humanDecisionCount: number
  aiRepairCount: number; runtimeRepairCount: number; averageTotalDurationMs: number | null
  averageExecuteDurationMs: number | null; averageReviewDurationMs: number | null
  verificationFailureCount: number; reviewFailureCount: number; providerSwitchCount: number
}

export interface ReasonCodeCount { reasonCode: string; count: number }

export type ReasonCategory = 'NORMAL' | 'ACTIONABLE'

/**
 * 展示层 reason 分类，只服务「常见问题 / 修复原因」这类用户面向统计。
 * Controller、路由、恢复、审批与完成判断都不读取它。
 *
 * 键取自仓库现有 reason taxonomy 的完整成员（DecisionReasonCode +
 * RuntimeRepairReasonCode），因此 reason taxonomy 新增成员时 TypeScript 会强制
 * 在此处给出分类，而不是维护一份会随实现漂移的散乱字符串列表。
 *
 * NORMAL = 正常的路由 / 能力 / 策略 / 流程推进决策；
 * ACTIONABLE = provider 或 runtime 不可用、验证与审查失败、阻塞、停滞、
 * 仓库漂移、需要人工配置或决策等需要介入的原因。
 */
const REASON_CATEGORY: Record<DecisionReasonCode | RuntimeRepairReasonCode, ReasonCategory> = {
  CONTINUE_CURRENT_AGENT: 'NORMAL',
  CAPABILITY_MATCH: 'NORMAL',
  CAPABILITY_MISMATCH: 'NORMAL',
  INDEPENDENT_REVIEW_REQUIRED: 'NORMAL',
  RISK_REQUIRES_REVIEW: 'NORMAL',
  RISK_REQUIRES_APPROVAL: 'NORMAL',
  EVIDENCE_MISSING: 'NORMAL',
  TASK_NOT_STARTED: 'NORMAL',
  ACCEPTANCE_ANALYSIS_REQUIRED: 'NORMAL',
  COMPLETION_CRITERIA_SATISFIED: 'NORMAL',
  PROVIDER_QUOTA_EXHAUSTED: 'ACTIONABLE',
  PROVIDER_UNAVAILABLE: 'ACTIONABLE',
  PROVIDER_OFFLINE: 'ACTIONABLE',
  STALE_PROVIDER_HEALTH: 'ACTIONABLE',
  LOCAL_RUNTIME_UNAVAILABLE: 'ACTIONABLE',
  DETERMINISTIC_VERIFIER_RUNTIME_UNAVAILABLE: 'ACTIONABLE',
  NO_AVAILABLE_AGENT: 'ACTIONABLE',
  NO_AVAILABLE_AGENT_FOR_REVIEW: 'ACTIONABLE',
  EVIDENCE_STALE: 'ACTIONABLE',
  REVIEW_FAILED: 'ACTIONABLE',
  VERIFICATION_FAILED: 'ACTIONABLE',
  VERIFICATION_ENVIRONMENT_FAILURE: 'ACTIONABLE',
  VERIFIER_CONFIGURATION_FAILURE: 'ACTIONABLE',
  UNRELATED_TEST_FAILURE: 'ACTIONABLE',
  VERIFICATION_UNKNOWN: 'ACTIONABLE',
  BLOCKER_PRESENT: 'ACTIONABLE',
  ACCEPTANCE_EVIDENCE_BINDING_MISSING: 'ACTIONABLE',
  STALLED_NO_PROGRESS: 'ACTIONABLE',
  NO_IMPLEMENTATION_PROGRESS: 'ACTIONABLE',
  CYCLIC_NO_PROGRESS: 'ACTIONABLE',
  ACTION_BUDGET_EXHAUSTED: 'ACTIONABLE',
  RECOVERY_BUDGET_GRANTED: 'NORMAL',
  RECOVERY_BUDGET_EXHAUSTED: 'ACTIONABLE',
  FAILED_TASK_RECOVERY: 'ACTIONABLE',
  HUMAN_DECISION_REQUIRED: 'ACTIONABLE',
  REPOSITORY_RECONCILIATION_REQUIRED: 'ACTIONABLE',
}

/**
 * 未知 reason code（不在现有 taxonomy 内）归为 ACTIONABLE：宁可让用户看到一条
 * 无法归类的原因，也不把可能的异常静默沉掉。全量原因仍可通过 reasons() 查询。
 */
function reasonCategory(reasonCode: string): ReasonCategory {
  return (REASON_CATEGORY as Record<string, ReasonCategory | undefined>)[reasonCode] ?? 'ACTIONABLE'
}

export interface TaskRunProjectionInput {
  definition: WorkSessionDefinition; state: WorkSessionDurableState; task: TaskStateV2; events: readonly TaskEventV2[]
  finalStatus?: TaskRunFinalStatus; completionReason?: string | null; commitResult?: TaskRunCommitResult; commitHash?: string | null; now?: string
}

const SCHEMA_VERSION = 2
const SUMMARY_COLUMNS_SQL = `
 session_id TEXT NOT NULL, task_id TEXT NOT NULL, project_path TEXT NOT NULL, branch TEXT NOT NULL,
 started_at TEXT, finished_at TEXT, final_status TEXT NOT NULL, completion_reason TEXT, total_duration_ms INTEGER,
 execute_count INTEGER NOT NULL, execute_duration_ms INTEGER NOT NULL, verify_count INTEGER NOT NULL, verify_duration_ms INTEGER NOT NULL,
 verification_failure_count INTEGER NOT NULL, review_count INTEGER NOT NULL, review_duration_ms INTEGER NOT NULL, review_failure_count INTEGER NOT NULL,
 ai_repair_count INTEGER NOT NULL, ai_repair_duration_ms INTEGER NOT NULL, runtime_repair_count INTEGER NOT NULL, runtime_repair_duration_ms INTEGER NOT NULL,
 human_required_count INTEGER NOT NULL, human_intervention_count INTEGER NOT NULL, human_action_count INTEGER NOT NULL, human_decision_count INTEGER NOT NULL,
 repair_triggered_by_user INTEGER NOT NULL, human_wait_duration_ms INTEGER NOT NULL, provider_switch_count INTEGER NOT NULL,
 implementer_providers TEXT NOT NULL, reviewer_providers TEXT NOT NULL, restart_count INTEGER NOT NULL, reconciliation_count INTEGER NOT NULL,
 commit_result TEXT NOT NULL, commit_hash TEXT, changed_file_count INTEGER, evidence_count INTEGER NOT NULL,
 first_pass_success INTEGER, zero_human_completion INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(session_id, task_id)`
/** zero_human_completion 可空：非 COMPLETED 的 Task 该指标不适用，必须区分「否」和「不适用」。 */
function summaryTableSql(name: string): string { return `CREATE TABLE IF NOT EXISTS ${name}(${SUMMARY_COLUMNS_SQL});` }
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_run_analytics_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
${summaryTableSql('task_run_summary')}
CREATE INDEX IF NOT EXISTS task_run_summary_recent_idx ON task_run_summary(finished_at DESC, updated_at DESC);
CREATE TABLE IF NOT EXISTS task_run_stage(
 session_id TEXT NOT NULL, task_id TEXT NOT NULL, stage TEXT NOT NULL, occurrence INTEGER NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, result TEXT, provider TEXT, reason_code TEXT,
 PRIMARY KEY(session_id,task_id,stage,occurrence), FOREIGN KEY(session_id,task_id) REFERENCES task_run_summary(session_id,task_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS task_run_reason(
 session_id TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT NOT NULL, reason_code TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(session_id,task_id,event_id,reason_code), FOREIGN KEY(session_id,task_id) REFERENCES task_run_summary(session_id,task_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS task_run_reason_recent_idx ON task_run_reason(created_at DESC,reason_code);
CREATE TABLE IF NOT EXISTS task_run_analytics_diagnostic(
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, task_id TEXT, operation TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);`

type Row = Record<string, string | number | null>

export function defaultTaskRunAnalyticsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'NovaWing', 'work-sessions', 'task-run-analytics.db')
}

function duration(start: string, end: string): number | null {
  const a = Date.parse(start); const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null
}
function ordered(events: readonly TaskEventV2[]): TaskEventV2[] {
  return [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || Number(a.eventId) - Number(b.eventId))
}
function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}
function concreteProviders(values: readonly (string | undefined)[]): string[] {
  return unique(values).filter((value) => value !== 'codex-or-deepseek')
}

function projectStages(events: readonly TaskEventV2[]): TaskRunStage[] {
  const stages: TaskRunStage[] = []; const counts = new Map<AnalyticsStage, number>(); const source = ordered(events)
  const rules: ReadonlyArray<{ stage: AnalyticsStage; start: (event: TaskEventV2) => boolean; ends: ReadonlySet<string> }> = [
    { stage: 'EXECUTE', start: (e) => e.type === 'AGENT_DISPATCHED' && e.action === 'EXECUTE', ends: new Set(['AGENT_COMPLETED', 'AGENT_FAILED']) },
    { stage: 'VERIFY', start: (e) => e.type === 'VERIFICATION_STARTED', ends: new Set(['VERIFICATION_PASSED', 'VERIFICATION_FAILED']) },
    { stage: 'REVIEW', start: (e) => e.type === 'REVIEW_STARTED' || (e.type === 'AGENT_DISPATCHED' && e.action === 'REVIEW'), ends: new Set(['REVIEW_PASSED', 'REVIEW_FAILED']) },
    { stage: 'AI_REPAIR', start: (e) => e.type === 'AI_REPAIR_STARTED', ends: new Set(['AI_REPAIR_COMPLETED', 'AI_REPAIR_FAILED']) },
    { stage: 'RUNTIME_REPAIR', start: (e) => e.type === 'RUNTIME_REPAIR_STARTED', ends: new Set(['RUNTIME_REPAIR_COMPLETED', 'RUNTIME_REPAIR_FAILED']) },
    { stage: 'HUMAN_WAIT', start: (e) => e.type === 'HUMAN_REQUIRED', ends: new Set(['HUMAN_ACTION_RECORDED', 'TASK_RESUMED', 'RUNTIME_REPAIR_STARTED']) },
  ]
  for (const rule of rules) {
    let open: TaskEventV2 | undefined
    for (const event of source) {
      if (open === undefined && rule.start(event)) { open = event; continue }
      if (open !== undefined && rule.ends.has(event.type)) {
        const occurrence = (counts.get(rule.stage) ?? 0) + 1; counts.set(rule.stage, occurrence)
        stages.push({ sessionId: event.sessionId, taskId: event.taskId, stage: rule.stage, occurrence, startedAt: open.timestamp,
          finishedAt: event.timestamp, durationMs: duration(open.timestamp, event.timestamp), result: event.type,
          provider: open.provider ?? event.provider ?? null, reasonCode: event.reasonCode ?? open.reasonCode ?? null }); open = undefined
      }
    }
    if (open !== undefined) {
      const occurrence = (counts.get(rule.stage) ?? 0) + 1; counts.set(rule.stage, occurrence)
      stages.push({ sessionId: open.sessionId, taskId: open.taskId, stage: rule.stage, occurrence, startedAt: open.timestamp,
        finishedAt: null, durationMs: null, result: null, provider: open.provider ?? null, reasonCode: open.reasonCode ?? null })
    }
  }
  return stages
}
function stageDuration(stages: readonly TaskRunStage[], stage: AnalyticsStage): number {
  return stages.filter((item) => item.stage === stage).reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
}
function inferCommit(input: TaskRunProjectionInput): TaskRunCommitResult {
  if (input.commitResult !== undefined) return input.commitResult
  if (input.commitHash ?? input.state.checkpointCommits?.[input.task.identity.taskId]) return 'COMMITTED'
  const finalStatus = input.finalStatus ?? input.task.status
  if (finalStatus === 'COMPLETED') return input.task.gitState.changedFiles.length === 0 ? 'NO_CHANGES_REQUIRED' : 'NOT_REQUESTED'
  if (finalStatus === 'FAILED' && input.state.failureStage === 'GIT_COMMIT') return 'COMMIT_FAILED'
  return 'NOT_REQUESTED'
}

export function projectTaskRun(input: TaskRunProjectionInput): { summary: TaskRunSummary; stages: TaskRunStage[]; reasons: ReasonCodeCount[] } {
  const events = ordered(input.events); const stages = projectStages(events)
  const first = events[0]?.timestamp ?? input.state.startedAt?.toISOString() ?? null
  const terminal = [...events].reverse().find((event) => event.type === 'TASK_COMPLETED' || event.type === 'TASK_FAILED')
  const finalStatus = input.finalStatus ?? (input.task.status === 'COMPLETED' ? 'COMPLETED' : input.task.status === 'FAILED' ? 'FAILED' : input.task.status === 'SUSPENDED' ? 'SUSPENDED' : 'RUNNING')
  const finished = terminal?.timestamp ?? (finalStatus === 'RUNNING' ? null : input.state.completedAt?.toISOString() ?? input.state.updatedAt.toISOString())
  const execute = events.filter((e) => e.type === 'AGENT_DISPATCHED' && e.action === 'EXECUTE')
  const review = events.filter((e) => e.type === 'AGENT_DISPATCHED' && e.action === 'REVIEW')
  const failures = events.flatMap((event, index) => event.type === 'VERIFICATION_FAILED' || event.type === 'REVIEW_FAILED' ? [index] : [])
  const firstPassSuccess = execute.length === 0 ? null : !failures.some((index) => events.slice(index + 1).some((e) => e.type === 'AGENT_DISPATCHED' && e.action === 'EXECUTE'))
  const humanActionCount = events.filter((e) => e.type === 'HUMAN_ACTION_RECORDED').length
  const explicitHumanDecisions = events.filter((e) => e.type === 'HUMAN_DECISION_RECORDED').length
  const humanDecisionCount = explicitHumanDecisions > 0 ? explicitHumanDecisions : events.filter((e) => e.type === 'APPROVAL_GRANTED').length
  const explicitHumanRequired = events.filter((e) => e.type === 'HUMAN_REQUIRED').length
  const reasonMap = new Map<string, number>(); for (const event of events) if (event.reasonCode !== undefined) reasonMap.set(event.reasonCode, (reasonMap.get(event.reasonCode) ?? 0) + 1)
  const now = input.now ?? new Date().toISOString()
  return { summary: {
    sessionId: input.task.identity.sessionId, taskId: input.task.identity.taskId, projectPath: input.definition.targetRepo,
    branch: input.task.gitState.branch ?? input.definition.branch, startedAt: first, finishedAt: finished, finalStatus,
    completionReason: input.completionReason ?? (finalStatus === 'COMPLETED' ? input.state.completionReason ?? 'TASK_COMPLETED' : input.state.failureCategory ?? null),
    totalDurationMs: first !== null && finished !== null ? duration(first, finished) : null,
    executeCount: execute.length, executeDurationMs: stageDuration(stages, 'EXECUTE'), verifyCount: events.filter((e) => e.type === 'VERIFICATION_STARTED').length,
    verifyDurationMs: stageDuration(stages, 'VERIFY'), verificationFailureCount: events.filter((e) => e.type === 'VERIFICATION_FAILED').length,
    reviewCount: review.length, reviewDurationMs: stageDuration(stages, 'REVIEW'), reviewFailureCount: events.filter((e) => e.type === 'REVIEW_FAILED').length,
    aiRepairCount: events.filter((e) => e.type === 'AI_REPAIR_STARTED').length, aiRepairDurationMs: stageDuration(stages, 'AI_REPAIR'),
    runtimeRepairCount: Math.max(events.filter((e) => e.type === 'RUNTIME_REPAIR_STARTED').length, input.state.runtimeRepair === undefined ? 0 : 1),
    runtimeRepairDurationMs: stageDuration(stages, 'RUNTIME_REPAIR'), humanRequiredCount: explicitHumanRequired > 0 ? explicitHumanRequired : events.filter((e) => e.type === 'APPROVAL_REQUIRED' || e.type === 'TASK_SUSPENDED').length,
    humanInterventionCount: humanActionCount, humanActionCount, humanDecisionCount,
    repairTriggeredByUser: events.filter((e) => e.type === 'HUMAN_ACTION_RECORDED' && e.metadata?.action === 'AI_REPAIR').length,
    humanWaitDurationMs: stageDuration(stages, 'HUMAN_WAIT'), providerSwitchCount: events.filter((e) => e.type === 'PROVIDER_SWITCHED').length,
    implementerProviders: concreteProviders(input.task.providerHistory.length > 0 ? input.task.providerHistory : execute.map((e) => e.provider)), reviewerProviders: concreteProviders(review.map((e) => e.provider)),
    restartCount: Math.max(0, events.filter((e) => e.type === 'TASK_RESUMED').length - humanActionCount - (input.state.runtimeRepair === undefined ? 0 : 1)),
    reconciliationCount: events.filter((e) => e.type === 'RECONCILIATION_COMPLETED' || e.type === 'RECONCILIATION_REQUIRED').length,
    commitResult: inferCommit(input), commitHash: input.commitHash ?? input.state.checkpointCommits?.[input.task.identity.taskId] ?? null,
    changedFileCount: input.task.gitState.changedFiles.length, evidenceCount: input.task.completion.evidence.length,
    firstPassSuccess,
    // 只有 COMPLETED 才有「零人工完成」可言；RUNNING / SUSPENDED / FAILED 等一律不适用（NULL）。
    zeroHumanCompletion: finalStatus === 'COMPLETED' ? humanActionCount === 0 && humanDecisionCount === 0 : null,
    createdAt: now, updatedAt: now,
  }, stages, reasons: [...reasonMap].map(([reasonCode, count]) => ({ reasonCode, count })) }
}

function fromRow(row: Row): TaskRunSummary {
  const n = (key: string): number => Number(row[key]); const ns = (key: string): number | null => row[key] === null ? null : n(key)
  const s = (key: string): string => String(row[key]); const ss = (key: string): string | null => row[key] === null ? null : s(key)
  return { sessionId: s('session_id'), taskId: s('task_id'), projectPath: s('project_path'), branch: s('branch'), startedAt: ss('started_at'), finishedAt: ss('finished_at'),
    finalStatus: s('final_status') as TaskRunFinalStatus, completionReason: ss('completion_reason'), totalDurationMs: ns('total_duration_ms'),
    executeCount: n('execute_count'), executeDurationMs: n('execute_duration_ms'), verifyCount: n('verify_count'), verifyDurationMs: n('verify_duration_ms'), verificationFailureCount: n('verification_failure_count'),
    reviewCount: n('review_count'), reviewDurationMs: n('review_duration_ms'), reviewFailureCount: n('review_failure_count'), aiRepairCount: n('ai_repair_count'), aiRepairDurationMs: n('ai_repair_duration_ms'),
    runtimeRepairCount: n('runtime_repair_count'), runtimeRepairDurationMs: n('runtime_repair_duration_ms'), humanRequiredCount: n('human_required_count'), humanInterventionCount: n('human_intervention_count'),
    humanActionCount: n('human_action_count'), humanDecisionCount: n('human_decision_count'), repairTriggeredByUser: n('repair_triggered_by_user'), humanWaitDurationMs: n('human_wait_duration_ms'),
    providerSwitchCount: n('provider_switch_count'), implementerProviders: JSON.parse(s('implementer_providers')) as string[], reviewerProviders: JSON.parse(s('reviewer_providers')) as string[],
    restartCount: n('restart_count'), reconciliationCount: n('reconciliation_count'), commitResult: s('commit_result') as TaskRunCommitResult, commitHash: ss('commit_hash'), changedFileCount: ns('changed_file_count'), evidenceCount: n('evidence_count'),
    firstPassSuccess: row.first_pass_success === null ? null : n('first_pass_success') === 1, zeroHumanCompletion: row.zero_human_completion === null ? null : n('zero_human_completion') === 1, createdAt: s('created_at'), updatedAt: s('updated_at') }
}

export class TaskRunAnalyticsStore {
  readonly #db: DatabaseSync; #closed = false
  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true }); this.#db = new DatabaseSync(databasePath)
    try {
      // 迁移需要重建父表：临时关闭 FK（避免级联删除子表）与 ALTER TABLE 引用重写（避免改写子表 FK）。
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;')
      this.#db.exec('BEGIN IMMEDIATE;')
      try {
        this.#migrateZeroHumanCompletionNullable()
        this.#db.exec(SCHEMA_SQL)
        this.#db.prepare('INSERT OR IGNORE INTO task_run_analytics_migration VALUES(?,?)').run(SCHEMA_VERSION, new Date().toISOString())
        this.#db.exec('COMMIT')
      } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error }
      this.#db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;')
    } catch (error) { this.#db.close(); throw error }
  }
  /**
   * v1 -> v2：`zero_human_completion` 由 NOT NULL 改为可空，并按新语义回填历史行——
   * 该指标只对 COMPLETED 有意义，非 COMPLETED 一律置 NULL（不适用），不推测。
   */
  #migrateZeroHumanCompletionNullable(): void {
    const column = this.#db.prepare(`SELECT "notnull" AS not_null FROM pragma_table_info('task_run_summary') WHERE name='zero_human_completion'`).get() as Row | undefined
    if (column === undefined || Number(column.not_null) !== 1) return
    this.#db.exec(summaryTableSql('task_run_summary_migrated'))
    this.#db.exec(`INSERT INTO task_run_summary_migrated SELECT
     session_id,task_id,project_path,branch,started_at,finished_at,final_status,completion_reason,total_duration_ms,
     execute_count,execute_duration_ms,verify_count,verify_duration_ms,verification_failure_count,review_count,review_duration_ms,review_failure_count,
     ai_repair_count,ai_repair_duration_ms,runtime_repair_count,runtime_repair_duration_ms,
     human_required_count,human_intervention_count,human_action_count,human_decision_count,
     repair_triggered_by_user,human_wait_duration_ms,provider_switch_count,
     implementer_providers,reviewer_providers,restart_count,reconciliation_count,
     commit_result,commit_hash,changed_file_count,evidence_count,
     first_pass_success,
     CASE WHEN final_status='COMPLETED' THEN zero_human_completion ELSE NULL END,
     created_at,updated_at FROM task_run_summary`)
    this.#db.exec('DROP TABLE task_run_summary')
    this.#db.exec('ALTER TABLE task_run_summary_migrated RENAME TO task_run_summary')
  }
  close(): void { if (!this.#closed) this.#db.close(); this.#closed = true }
  upsert(p: ReturnType<typeof projectTaskRun>): void {
    const s = p.summary; this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`INSERT INTO task_run_summary VALUES(${Array.from({ length: 40 }, () => '?').join(',')}) ON CONFLICT(session_id,task_id) DO UPDATE SET
       project_path=excluded.project_path,branch=excluded.branch,started_at=excluded.started_at,finished_at=excluded.finished_at,final_status=excluded.final_status,
       completion_reason=excluded.completion_reason,total_duration_ms=excluded.total_duration_ms,execute_count=excluded.execute_count,execute_duration_ms=excluded.execute_duration_ms,
       verify_count=excluded.verify_count,verify_duration_ms=excluded.verify_duration_ms,verification_failure_count=excluded.verification_failure_count,review_count=excluded.review_count,
       review_duration_ms=excluded.review_duration_ms,review_failure_count=excluded.review_failure_count,ai_repair_count=excluded.ai_repair_count,ai_repair_duration_ms=excluded.ai_repair_duration_ms,
       runtime_repair_count=excluded.runtime_repair_count,runtime_repair_duration_ms=excluded.runtime_repair_duration_ms,human_required_count=excluded.human_required_count,
       human_intervention_count=excluded.human_intervention_count,human_action_count=excluded.human_action_count,human_decision_count=excluded.human_decision_count,
       repair_triggered_by_user=excluded.repair_triggered_by_user,human_wait_duration_ms=excluded.human_wait_duration_ms,provider_switch_count=excluded.provider_switch_count,
       implementer_providers=excluded.implementer_providers,reviewer_providers=excluded.reviewer_providers,restart_count=excluded.restart_count,reconciliation_count=excluded.reconciliation_count,
       commit_result=excluded.commit_result,commit_hash=excluded.commit_hash,changed_file_count=excluded.changed_file_count,evidence_count=excluded.evidence_count,
       first_pass_success=excluded.first_pass_success,zero_human_completion=excluded.zero_human_completion,updated_at=excluded.updated_at`).run(
        s.sessionId,s.taskId,s.projectPath,s.branch,s.startedAt,s.finishedAt,s.finalStatus,s.completionReason,s.totalDurationMs,s.executeCount,s.executeDurationMs,s.verifyCount,s.verifyDurationMs,s.verificationFailureCount,
        s.reviewCount,s.reviewDurationMs,s.reviewFailureCount,s.aiRepairCount,s.aiRepairDurationMs,s.runtimeRepairCount,s.runtimeRepairDurationMs,s.humanRequiredCount,s.humanInterventionCount,s.humanActionCount,s.humanDecisionCount,
        s.repairTriggeredByUser,s.humanWaitDurationMs,s.providerSwitchCount,JSON.stringify(s.implementerProviders),JSON.stringify(s.reviewerProviders),s.restartCount,s.reconciliationCount,s.commitResult,s.commitHash,s.changedFileCount,s.evidenceCount,
        s.firstPassSuccess === null ? null : Number(s.firstPassSuccess),s.zeroHumanCompletion === null ? null : Number(s.zeroHumanCompletion),s.createdAt,s.updatedAt)
      this.#db.prepare('DELETE FROM task_run_stage WHERE session_id=? AND task_id=?').run(s.sessionId,s.taskId)
      const insertStage = this.#db.prepare('INSERT INTO task_run_stage VALUES(?,?,?,?,?,?,?,?,?,?)')
      for (const x of p.stages) insertStage.run(x.sessionId,x.taskId,x.stage,x.occurrence,x.startedAt,x.finishedAt,x.durationMs,x.result,x.provider,x.reasonCode)
      this.#db.prepare('DELETE FROM task_run_reason WHERE session_id=? AND task_id=?').run(s.sessionId,s.taskId)
      const insertReason = this.#db.prepare('INSERT INTO task_run_reason VALUES(?,?,?,?,?)')
      for (const [index, reason] of p.reasons.entries()) for (let occurrence=0; occurrence<reason.count; occurrence++) insertReason.run(s.sessionId,s.taskId,`aggregate-${index}-${occurrence}`,reason.reasonCode,s.finishedAt ?? s.updatedAt)
      this.#db.exec('COMMIT')
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error }
  }
  findBySession(id: string): TaskRunSummary[] { return (this.#db.prepare('SELECT * FROM task_run_summary WHERE session_id=? ORDER BY task_id').all(id) as Row[]).map(fromRow) }
  findByTask(id: string): TaskRunSummary[] { return (this.#db.prepare('SELECT * FROM task_run_summary WHERE task_id=? ORDER BY finished_at DESC').all(id) as Row[]).map(fromRow) }
  recent(limit: 5|10|20): { summaries: TaskRunSummary[]; aggregate: RecentTaskRunAnalytics } {
    const summaries = (this.#db.prepare('SELECT * FROM task_run_summary ORDER BY COALESCE(finished_at,updated_at) DESC LIMIT ?').all(limit) as Row[]).map(fromRow)
    const a = this.#db.prepare(`SELECT COUNT(*) task_count,SUM(final_status='COMPLETED') completed_count,
      SUM(CASE WHEN final_status='COMPLETED' AND zero_human_completion=1 THEN 1 ELSE 0 END) zero_human_count,
      SUM(first_pass_success=1) first_pass_count,SUM(human_decision_count) human_decisions,SUM(ai_repair_count) ai_repairs,SUM(runtime_repair_count) runtime_repairs,
      AVG(total_duration_ms) avg_total,AVG(execute_duration_ms) avg_execute,AVG(review_duration_ms) avg_review,SUM(verification_failure_count) verification_failures,
      SUM(review_failure_count) review_failures,SUM(provider_switch_count) provider_switches FROM(SELECT * FROM task_run_summary ORDER BY COALESCE(finished_at,updated_at) DESC LIMIT ?)` ).get(limit) as Row
    const count = Number(a.task_count)
    const completedCount = Number(a.completed_count ?? 0)
    // 零人工完成只统计 COMPLETED 且确实零人工介入的 Task，因此恒有 zeroHumanCompletionCount <= completedCount。
    const zeroHumanCompletionCount = Number(a.zero_human_count ?? 0)
    return { summaries, aggregate: { limit,taskCount:count,completedCount,zeroHumanCompletionCount,
      zeroHumanCompletionRate:completedCount===0?null:zeroHumanCompletionCount/completedCount,
      firstPassSuccessCount:Number(a.first_pass_count??0),humanDecisionCount:Number(a.human_decisions??0),aiRepairCount:Number(a.ai_repairs??0),runtimeRepairCount:Number(a.runtime_repairs??0),
      averageTotalDurationMs:a.avg_total===null?null:Math.round(Number(a.avg_total)),averageExecuteDurationMs:a.avg_execute===null?null:Math.round(Number(a.avg_execute)),averageReviewDurationMs:a.avg_review===null?null:Math.round(Number(a.avg_review)),
      verificationFailureCount:Number(a.verification_failures??0),reviewFailureCount:Number(a.review_failures??0),providerSwitchCount:Number(a.provider_switches??0) } }
  }
  reasons(limit: number): ReasonCodeCount[] { return (this.#db.prepare('SELECT reason_code,COUNT(*) count FROM task_run_reason GROUP BY reason_code ORDER BY count DESC,reason_code LIMIT ?').all(limit) as Row[]).map((r)=>({reasonCode:String(r.reason_code),count:Number(r.count)})) }
  /**
   * 用户面向的「常见问题 / 修复原因」：只保留 actionable reason，过滤掉 CAPABILITY_MATCH、
   * CAPABILITY_MISMATCH、COMPLETION_CRITERIA_SATISFIED、TASK_NOT_STARTED 等普通决策原因。
   * 全量原因仍由 reasons() 提供。先取全部分组再过滤，避免 SQL LIMIT 先用普通原因占满名额。
   */
  actionableReasons(limit: number): ReasonCodeCount[] {
    return (this.#db.prepare('SELECT reason_code,COUNT(*) count FROM task_run_reason GROUP BY reason_code').all() as Row[])
      .map((r) => ({ reasonCode: String(r.reason_code), count: Number(r.count) }))
      .filter((entry) => reasonCategory(entry.reasonCode) === 'ACTIONABLE')
      .sort((a, b) => b.count - a.count || (a.reasonCode < b.reasonCode ? -1 : a.reasonCode > b.reasonCode ? 1 : 0))
      .slice(0, limit)
  }
  recordDiagnostic(input:{sessionId?:string;taskId?:string;operation:string;message:string}):void { this.#db.prepare('INSERT INTO task_run_analytics_diagnostic(session_id,task_id,operation,message,created_at) VALUES(?,?,?,?,?)').run(input.sessionId??null,input.taskId??null,input.operation,input.message.slice(0,500),new Date().toISOString()) }
}

export class TaskRunAnalyticsProjector {
  constructor(readonly store: TaskRunAnalyticsStore) {}
  project(input: TaskRunProjectionInput): TaskRunSummary { const projected=projectTaskRun(input); this.store.upsert(projected); return projected.summary }
}

export function backfillTaskRunAnalytics(projector:TaskRunAnalyticsProjector,sessions:readonly {definition:WorkSessionDefinition;state:WorkSessionDurableState}[]):{projected:number;skipped:number}{
  let projected=0,skipped=0
  for(const session of sessions) for(const task of session.definition.tasks){const state=session.state.taskStatesV2?.[task.id];if(state===undefined){skipped++;continue}
    try{projector.project({definition:session.definition,state:session.state,task:state,events:session.state.taskEventLogs?.[task.id]??[]});projected++}
    catch(error){skipped++;try{projector.store.recordDiagnostic({sessionId:session.definition.id,taskId:task.id,operation:'BACKFILL',message:error instanceof Error?error.message:String(error)})}catch{}}}
  return{projected,skipped}
}

const STATUS_ZH:Record<string,string>={COMPLETED:'已完成',FAILED:'失败',SUSPENDED:'已暂停',RUNNING:'运行中'}
const COMMIT_ZH:Record<string,string>={COMMITTED:'已提交',ALREADY_SATISFIED:'已满足，无需修改',NO_CHANGES_REQUIRED:'无需提交代码',COMMIT_FAILED:'提交失败',NOT_REQUESTED:'未要求提交',UNKNOWN:'未知'}
/** 三态展示：null 必须显示为「不适用」，不能与「否」混同。 */
const TRI_STATE_ZH=(value:boolean|null):string=>value===null?'不适用':value?'是':'否'
export function formatDurationZh(ms:number|null):string{if(ms===null)return'未知';const seconds=Math.round(ms/1000),minutes=Math.floor(seconds/60);return minutes===0?`${seconds} 秒`:`${minutes} 分 ${seconds%60} 秒`}
export function renderChineseTaskRunReport(s:TaskRunSummary):string{return ['NovaWing 任务运行报告','',`任务：${s.taskId}`,`Session：${s.sessionId}`,`最终结果：${STATUS_ZH[s.finalStatus]??s.finalStatus}`,`项目：${s.projectPath}`,`分支：${s.branch}`,`总耗时：${formatDurationZh(s.totalDurationMs)}`,'',
 `执行 Provider：${s.implementerProviders.join('、')||'未知'}`,`执行次数：${s.executeCount}`,`执行耗时：${formatDurationZh(s.executeDurationMs)}`,`验证次数：${s.verifyCount}`,`验证失败：${s.verificationFailureCount}`,`验证耗时：${formatDurationZh(s.verifyDurationMs)}`,
 `审查 Provider：${s.reviewerProviders.join('、')||'无'}`,`审查次数：${s.reviewCount}`,`审查失败：${s.reviewFailureCount}`,`审查耗时：${formatDurationZh(s.reviewDurationMs)}`,`AI 修复次数：${s.aiRepairCount}`,`运行时修复次数：${s.runtimeRepairCount}`,
 `曾需要人工处理：${s.humanRequiredCount} 次`,`人工动作：${s.humanActionCount} 次`,`实际人工决策：${s.humanDecisionCount} 次`,`是否零人工完成：${TRI_STATE_ZH(s.zeroHumanCompletion)}`,`是否首次通过：${s.firstPassSuccess===null?'未知':s.firstPassSuccess?'是':'否'}`,
 `Provider 切换：${s.providerSwitchCount} 次`,`最终提交：${COMMIT_ZH[s.commitResult]??s.commitResult}${s.commitHash===null?'':` · ${s.commitHash.slice(0,8)}`}`,`变更文件：${s.changedFileCount===null?'未知':`${s.changedFileCount} 个`}`,`证据数量：${s.evidenceCount}`,`完成原因：${s.completionReason??'未知'}`,'',`最终结论：${s.finalStatus==='COMPLETED'?'Task 已满足全部验收标准并完成。':'Task 未完成，请查看失败原因与时间线。'}`].join('\n')}
