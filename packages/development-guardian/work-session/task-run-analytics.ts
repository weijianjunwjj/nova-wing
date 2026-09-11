import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { WorkSessionDefinition, WorkSessionDurableState } from './model.js'
import type { TaskEventV2 } from './task-observability.js'
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
  firstPassSuccess: boolean | null; zeroHumanCompletion: boolean
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
export interface TaskRunProjectionInput {
  definition: WorkSessionDefinition; state: WorkSessionDurableState; task: TaskStateV2; events: readonly TaskEventV2[]
  finalStatus?: TaskRunFinalStatus; completionReason?: string | null; commitResult?: TaskRunCommitResult; commitHash?: string | null; now?: string
}

const SCHEMA_VERSION = 1
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_run_analytics_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_run_summary(
 session_id TEXT NOT NULL, task_id TEXT NOT NULL, project_path TEXT NOT NULL, branch TEXT NOT NULL,
 started_at TEXT, finished_at TEXT, final_status TEXT NOT NULL, completion_reason TEXT, total_duration_ms INTEGER,
 execute_count INTEGER NOT NULL, execute_duration_ms INTEGER NOT NULL, verify_count INTEGER NOT NULL, verify_duration_ms INTEGER NOT NULL,
 verification_failure_count INTEGER NOT NULL, review_count INTEGER NOT NULL, review_duration_ms INTEGER NOT NULL, review_failure_count INTEGER NOT NULL,
 ai_repair_count INTEGER NOT NULL, ai_repair_duration_ms INTEGER NOT NULL, runtime_repair_count INTEGER NOT NULL, runtime_repair_duration_ms INTEGER NOT NULL,
 human_required_count INTEGER NOT NULL, human_intervention_count INTEGER NOT NULL, human_action_count INTEGER NOT NULL, human_decision_count INTEGER NOT NULL,
 repair_triggered_by_user INTEGER NOT NULL, human_wait_duration_ms INTEGER NOT NULL, provider_switch_count INTEGER NOT NULL,
 implementer_providers TEXT NOT NULL, reviewer_providers TEXT NOT NULL, restart_count INTEGER NOT NULL, reconciliation_count INTEGER NOT NULL,
 commit_result TEXT NOT NULL, commit_hash TEXT, changed_file_count INTEGER, evidence_count INTEGER NOT NULL,
 first_pass_success INTEGER, zero_human_completion INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(session_id, task_id));
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
    firstPassSuccess, zeroHumanCompletion: humanActionCount === 0 && humanDecisionCount === 0, createdAt: now, updatedAt: now,
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
    firstPassSuccess: row.first_pass_success === null ? null : n('first_pass_success') === 1, zeroHumanCompletion: n('zero_human_completion') === 1, createdAt: s('created_at'), updatedAt: s('updated_at') }
}

export class TaskRunAnalyticsStore {
  readonly #db: DatabaseSync; #closed = false
  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true }); this.#db = new DatabaseSync(databasePath)
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;')
    try { this.#db.exec(SCHEMA_SQL); this.#db.prepare('INSERT OR IGNORE INTO task_run_analytics_migration VALUES(?,?)').run(SCHEMA_VERSION, new Date().toISOString()); this.#db.exec('COMMIT') }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); this.#db.close(); throw error }
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
        s.firstPassSuccess === null ? null : Number(s.firstPassSuccess),Number(s.zeroHumanCompletion),s.createdAt,s.updatedAt)
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
    const a = this.#db.prepare(`SELECT COUNT(*) task_count,SUM(final_status='COMPLETED') completed_count,SUM(zero_human_completion) zero_human_count,
      SUM(first_pass_success=1) first_pass_count,SUM(human_decision_count) human_decisions,SUM(ai_repair_count) ai_repairs,SUM(runtime_repair_count) runtime_repairs,
      AVG(total_duration_ms) avg_total,AVG(execute_duration_ms) avg_execute,AVG(review_duration_ms) avg_review,SUM(verification_failure_count) verification_failures,
      SUM(review_failure_count) review_failures,SUM(provider_switch_count) provider_switches FROM(SELECT * FROM task_run_summary ORDER BY COALESCE(finished_at,updated_at) DESC LIMIT ?)` ).get(limit) as Row
    const count = Number(a.task_count)
    return { summaries, aggregate: { limit,taskCount:count,completedCount:Number(a.completed_count??0),zeroHumanCompletionCount:Number(a.zero_human_count??0),zeroHumanCompletionRate:count===0?null:Number(a.zero_human_count??0)/count,
      firstPassSuccessCount:Number(a.first_pass_count??0),humanDecisionCount:Number(a.human_decisions??0),aiRepairCount:Number(a.ai_repairs??0),runtimeRepairCount:Number(a.runtime_repairs??0),
      averageTotalDurationMs:a.avg_total===null?null:Math.round(Number(a.avg_total)),averageExecuteDurationMs:a.avg_execute===null?null:Math.round(Number(a.avg_execute)),averageReviewDurationMs:a.avg_review===null?null:Math.round(Number(a.avg_review)),
      verificationFailureCount:Number(a.verification_failures??0),reviewFailureCount:Number(a.review_failures??0),providerSwitchCount:Number(a.provider_switches??0) } }
  }
  reasons(limit: number): ReasonCodeCount[] { return (this.#db.prepare('SELECT reason_code,COUNT(*) count FROM task_run_reason GROUP BY reason_code ORDER BY count DESC,reason_code LIMIT ?').all(limit) as Row[]).map((r)=>({reasonCode:String(r.reason_code),count:Number(r.count)})) }
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
export function formatDurationZh(ms:number|null):string{if(ms===null)return'未知';const seconds=Math.round(ms/1000),minutes=Math.floor(seconds/60);return minutes===0?`${seconds} 秒`:`${minutes} 分 ${seconds%60} 秒`}
export function renderChineseTaskRunReport(s:TaskRunSummary):string{return ['NovaWing 任务运行报告','',`任务：${s.taskId}`,`Session：${s.sessionId}`,`最终结果：${STATUS_ZH[s.finalStatus]??s.finalStatus}`,`项目：${s.projectPath}`,`分支：${s.branch}`,`总耗时：${formatDurationZh(s.totalDurationMs)}`,'',
 `执行 Provider：${s.implementerProviders.join('、')||'未知'}`,`执行次数：${s.executeCount}`,`执行耗时：${formatDurationZh(s.executeDurationMs)}`,`验证次数：${s.verifyCount}`,`验证失败：${s.verificationFailureCount}`,`验证耗时：${formatDurationZh(s.verifyDurationMs)}`,
 `审查 Provider：${s.reviewerProviders.join('、')||'无'}`,`审查次数：${s.reviewCount}`,`审查失败：${s.reviewFailureCount}`,`审查耗时：${formatDurationZh(s.reviewDurationMs)}`,`AI 修复次数：${s.aiRepairCount}`,`运行时修复次数：${s.runtimeRepairCount}`,
 `曾需要人工处理：${s.humanRequiredCount} 次`,`人工动作：${s.humanActionCount} 次`,`实际人工决策：${s.humanDecisionCount} 次`,`是否零人工完成：${s.zeroHumanCompletion?'是':'否'}`,`是否首次通过：${s.firstPassSuccess===null?'未知':s.firstPassSuccess?'是':'否'}`,
 `Provider 切换：${s.providerSwitchCount} 次`,`最终提交：${COMMIT_ZH[s.commitResult]??s.commitResult}${s.commitHash===null?'':` · ${s.commitHash.slice(0,8)}`}`,`变更文件：${s.changedFileCount===null?'未知':`${s.changedFileCount} 个`}`,`证据数量：${s.evidenceCount}`,`完成原因：${s.completionReason??'未知'}`,'',`最终结论：${s.finalStatus==='COMPLETED'?'Task 已满足全部验收标准并完成。':'Task 未完成，请查看失败原因与时间线。'}`].join('\n')}
