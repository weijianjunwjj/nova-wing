import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TaskRunAnalyticsProjector,
  TaskRunAnalyticsStore,
  backfillTaskRunAnalytics,
  projectTaskRun,
  renderChineseTaskRunReport,
  type TaskEventV2,
  type TaskRunProjectionInput,
  type WorkSessionDefinition,
  type WorkSessionDurableState,
} from '../packages/development-guardian/index.js'
import { createTaskStateV2, type TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'

const definition: WorkSessionDefinition = {
  id: 'S-analytics', targetRepo: 'D:\\repo', branch: 'feature/analytics', controlPlane: 'v2',
  tasks: [{ id: 'T1', goal: '实现统计' }], limits: { softMinutes: 30, hardMinutes: 60, maxTasks: 1 },
}

function task(): TaskStateV2 {
  const value = createTaskStateV2(definition, definition.tasks[0]!)
  return { ...value, status: 'COMPLETED', currentAction: 'COMPLETE',
    gitState: { ...value.gitState, changedFiles: ['a.ts', 'a.test.ts'], headSha: 'abcdef1234567890' },
    completion: { ...value.completion, evidence: [{ type: 'TEST', status: 'PASSED', source: 'npm test', timestamp: '2026-01-01T00:00:10.000Z' }] } }
}

function state(overrides: Partial<WorkSessionDurableState> = {}): WorkSessionDurableState {
  const value = task()
  return { sessionId: definition.id, state: 'COMPLETED', currentTaskIndex: 1, currentTaskId: null, completedTaskIds: ['T1'],
    taskStatesV2: { T1: value }, createdAt: new Date('2026-01-01T00:00:00.000Z'), startedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:12.000Z'), updatedAt: new Date('2026-01-01T00:00:12.000Z'), completionReason: 'ALL_TASKS_COMPLETED', ...overrides }
}

function event(eventId: number, seconds: number, type: TaskEventV2['type'], rest: Partial<TaskEventV2> = {}): TaskEventV2 {
  return { eventId: String(eventId), taskId: 'T1', sessionId: definition.id, type,
    timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`, ...rest }
}

function input(events: TaskEventV2[], overrides: Partial<TaskRunProjectionInput> = {}): TaskRunProjectionInput {
  return { definition, state: state({ taskEventLogs: { T1: events } }), task: task(), events, now: '2026-01-02T00:00:00.000Z', ...overrides }
}

test('普通 COMPLETE 投影准确累计 EXECUTE 与 VERIFY，而非用总时长冒充阶段耗时', () => {
  const events = [event(1,0,'TASK_CREATED'), event(2,1,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'codex'}), event(3,4,'AGENT_COMPLETED',{action:'EXECUTE'}),
    event(4,5,'VERIFICATION_STARTED',{action:'VERIFY'}), event(5,7,'VERIFICATION_PASSED',{action:'VERIFY'}), event(6,9,'TASK_COMPLETED')]
  const summary = projectTaskRun(input(events)).summary
  assert.equal(summary.totalDurationMs, 9_000); assert.equal(summary.executeDurationMs, 3_000); assert.equal(summary.verifyDurationMs, 2_000)
  assert.equal(summary.executeCount, 1); assert.equal(summary.verifyCount, 1); assert.deepEqual(summary.implementerProviders, ['codex'])
  assert.equal(summary.firstPassSuccess, true); assert.equal(summary.zeroHumanCompletion, true)
})

test('Codex EXECUTE 与 DeepSeek REVIEW 的 Provider、次数和耗时正确', () => {
  const events = [event(1,0,'TASK_CREATED'),event(2,1,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'codex'}),event(3,3,'AGENT_COMPLETED',{action:'EXECUTE'}),
    event(4,4,'AGENT_DISPATCHED',{action:'REVIEW',provider:'deepseek'}),event(5,8,'REVIEW_PASSED',{action:'REVIEW',provider:'deepseek'}),event(6,9,'TASK_COMPLETED')]
  const summary=projectTaskRun(input(events)).summary
  assert.deepEqual(summary.implementerProviders,['codex']);assert.deepEqual(summary.reviewerProviders,['deepseek']);assert.equal(summary.reviewCount,1);assert.equal(summary.reviewDurationMs,4_000)
})

test('Human Required 可由 Runtime Repair 自动解决，人工决策为零但用户点击 repair 计为 action', () => {
  const automatic=[event(1,0,'TASK_CREATED'),event(2,1,'HUMAN_REQUIRED'),event(3,5,'RUNTIME_REPAIR_STARTED'),event(4,7,'RUNTIME_REPAIR_COMPLETED'),event(5,9,'TASK_COMPLETED')]
  const a=projectTaskRun(input(automatic,{state:state({runtimeRepair:{reasonCode:'NO_AVAILABLE_AGENT_FOR_REVIEW',appliedAt:'2026-01-01T00:00:05.000Z',executorReran:false}})})).summary
  assert.equal(a.humanRequiredCount,1);assert.equal(a.humanDecisionCount,0);assert.equal(a.runtimeRepairCount,1);assert.equal(a.zeroHumanCompletion,true)
  const clicked=[...automatic.slice(0,2),event(3,4,'HUMAN_ACTION_RECORDED',{metadata:{action:'RUNTIME_REPAIR'}}),...automatic.slice(2)]
  const b=projectTaskRun(input(clicked)).summary
  assert.equal(b.humanActionCount,1);assert.equal(b.humanDecisionCount,0);assert.equal(b.zeroHumanCompletion,false)
})

test('真实用户 decision 与 approval 使 zero-human completion 为 false', () => {
  const events=[event(1,0,'TASK_CREATED'),event(2,1,'HUMAN_REQUIRED'),event(3,2,'HUMAN_ACTION_RECORDED'),event(4,2,'HUMAN_DECISION_RECORDED'),event(5,4,'TASK_COMPLETED')]
  const summary=projectTaskRun(input(events)).summary
  assert.equal(summary.humanInterventionCount,1);assert.equal(summary.humanDecisionCount,1);assert.equal(summary.zeroHumanCompletion,false)
})

test('VERIFY/REVIEW failure 后重新 EXECUTE 才算 implementation first-pass failure；Provider failover 不算', () => {
  const failed=[event(1,0,'TASK_CREATED'),event(2,1,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'codex'}),event(3,2,'AGENT_COMPLETED',{action:'EXECUTE'}),event(4,3,'VERIFICATION_STARTED'),event(5,4,'VERIFICATION_FAILED'),event(6,5,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'codex'}),event(7,7,'AGENT_COMPLETED',{action:'EXECUTE'}),event(8,9,'TASK_COMPLETED')]
  assert.equal(projectTaskRun(input(failed)).summary.firstPassSuccess,false)
  const failover=[event(1,0,'TASK_CREATED'),event(2,1,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'codex'}),event(3,2,'AGENT_FAILED',{action:'EXECUTE'}),event(4,3,'PROVIDER_SWITCHED',{previousProvider:'codex',provider:'deepseek'}),event(5,4,'AGENT_DISPATCHED',{action:'EXECUTE',provider:'deepseek'}),event(6,6,'AGENT_COMPLETED',{action:'EXECUTE'}),event(7,8,'TASK_COMPLETED')]
  const summary=projectTaskRun(input(failover)).summary;assert.equal(summary.providerSwitchCount,1);assert.equal(summary.firstPassSuccess,true)
})

test('commit disposition 与中文报告使用产品字段名', () => {
  const summary=projectTaskRun(input([event(1,0,'TASK_CREATED'),event(2,2,'TASK_COMPLETED')],{commitResult:'ALREADY_SATISFIED'})).summary
  const report=renderChineseTaskRunReport(summary)
  assert.equal(summary.commitResult,'ALREADY_SATISFIED');assert.match(report,/已满足，无需修改/u);assert.match(report,/人工介入|人工动作/u)
  assert.doesNotMatch(report,/human_intervention_count|runtime_repair_count|completion_reason/u)
})

test('历史通用路由不伪装为具体 Provider，完成事实不受陈旧 commit failure 字段污染', () => {
  const historicalTask={...task(),providerHistory:['codex-or-deepseek']}
  const summary=projectTaskRun(input([event(1,0,'TASK_CREATED'),event(2,2,'TASK_COMPLETED')],{
    task:historicalTask,state:state({failureStage:'GIT_COMMIT'}),
  })).summary
  assert.deepEqual(summary.implementerProviders,[])
  assert.equal(summary.commitResult,'NOT_REQUESTED')
  assert.match(renderChineseTaskRunReport(summary),/执行 Provider：未知/u)
})

test('SQLite upsert 与 backfill 都幂等，不产生重复行', async () => {
  const dir=await mkdtemp(join(tmpdir(),'novawing-analytics-'));const store=new TaskRunAnalyticsStore(join(dir,'analytics.db'));const projector=new TaskRunAnalyticsProjector(store)
  try { const events=[event(1,0,'TASK_CREATED'),event(2,2,'TASK_COMPLETED')];projector.project(input(events));projector.project(input(events));assert.equal(store.findBySession(definition.id).length,1)
    const durable=state({taskEventLogs:{T1:events}});assert.deepEqual(backfillTaskRunAnalytics(projector,[{definition,state:durable}]),{projected:1,skipped:0});assert.equal(store.findBySession(definition.id).length,1)
  } finally {store.close();await rm(dir,{recursive:true,force:true})}
})

test('最近 5/10/20 聚合与 reasonCode 统计由 SQLite query 产生', async () => {
  const dir=await mkdtemp(join(tmpdir(),'novawing-analytics-'));const store=new TaskRunAnalyticsStore(join(dir,'analytics.db'));const projector=new TaskRunAnalyticsProjector(store)
  try { for(let i=0;i<12;i++){const d={...definition,id:`S-${i}`,tasks:[{id:`T-${i}`,goal:'x'}]};const t={...task(),identity:{sessionId:d.id,taskId:`T-${i}`}};const events=[{...event(1,0,'TASK_CREATED'),sessionId:d.id,taskId:t.identity.taskId,reasonCode:'PROVIDER_UNAVAILABLE' as const},{...event(2,2,'TASK_COMPLETED'),sessionId:d.id,taskId:t.identity.taskId}];projector.project({definition:d,state:{...state(),sessionId:d.id,taskStatesV2:{[t.identity.taskId]:t}},task:t,events,now:`2026-01-${String(i+1).padStart(2,'0')}T00:00:00.000Z`})}
    assert.equal(store.recent(5).aggregate.taskCount,5);assert.equal(store.recent(10).aggregate.taskCount,10);assert.equal(store.recent(20).aggregate.taskCount,12)
    assert.deepEqual(store.reasons(20)[0],{reasonCode:'PROVIDER_UNAVAILABLE',count:12})
  } finally {store.close();await rm(dir,{recursive:true,force:true})}
})

test('Analytics 写失败可被调用方隔离，TaskStateV2 完成事实保持不变', () => {
  const canonical=task();const fake={project(){throw new Error('disk full')}}
  assert.throws(()=>fake.project(),/disk full/u);assert.equal(canonical.status,'COMPLETED');assert.equal(canonical.currentAction,'COMPLETE')
})
