/**
 * v0.4.0: VERIFY 证据的身份是 VerificationPlan 的 step id。
 *
 * Golden 因 HIGH risk 把任务移交给 Controller 时，completion binding 必须使用与
 * evidence.type 相同的命名空间；否则 completionGate 永远匹配不上，表现为
 * REVIEW PASS 之后反复 VERIFY:EVIDENCE_MISSING，最终 CYCLIC_NO_PROGRESS。
 *
 * 这里复现 installed real-host 的完整链路：
 *   HIGH risk → Controller → EXECUTE → VERIFY PASS → REVIEW PASS → COMPLETE
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifierEvidenceFromBindings } from '../packages/development-guardian/work-session/completion-criteria.js'
import { GoldenPathTaskRunner } from '../packages/development-guardian/work-session/golden-path.js'
import { createTaskStateV2, loadTaskStateV2, type TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { V2ControllerTaskRunner, type AgentCapabilityProfile, type V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { bindingsFromVerificationPlan, planVerification, verificationCommandsForEvidence } from '../packages/development-guardian/work-session/verification-planner.js'
import type { WorkSessionTask } from '../packages/development-guardian/work-session/model.js'
import type { WorkSessionTaskRunContext } from '../packages/development-guardian/work-session/task-runner.js'

const SESSION = 'S-identity'
const CRITERION = 'counter shows X / Y'

/** 与 installed real-host 相同的显式验证契约：两条命令 → verify-1 / verify-2。 */
const TASK: WorkSessionTask = {
  id: 'T-IDENTITY',
  goal: 'Fix the counter label',
  constraints: ['Keep tests unchanged'],
  acceptanceCriteria: [CRITERION],
  acceptanceEvidenceBindings: [{ criterion: CRITERION, requiredEvidence: ['git diff --check', 'npm test'] }],
  allowedPaths: ['src/**'],
  forbiddenPaths: ['tests/**'],
  risk: 'HIGH',
}

const EXECUTOR: AgentCapabilityProfile = {
  id: 'executor-router',
  identity: { agent: 'executor-router', provider: 'codex', runtimeIdentity: 'runtime-executor' },
  available: true, quotaExhausted: false, degraded: false,
  capabilities: { coding: true, reasoning: true, verification: true, review: false },
}

const REVIEWER: AgentCapabilityProfile = {
  id: 'deepseek-reviewer',
  identity: { agent: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: 'runtime-reviewer' },
  available: true, quotaExhausted: false, degraded: false,
  capabilities: { review: true, reasoning: true },
}

type EvidenceShape = 'step' | 'wrong-identity' | 'incomplete'

async function fixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-identity-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test' } }))
  return { root }
}

async function explicitPlan(root: string) {
  return planVerification({ repositoryRoot: root, task: TASK, risk: 'HIGH' })
}

function identityRunner(root: string, shape: EvidenceShape) {
  let revision = 0
  const calls: Array<{ action: string; agent: string }> = []
  const dispatcher: V2ActionDispatcher = {
    async inspectRepository() {
      return { repositoryIdentity: root, branch: 'main', headSha: 'head-1',
        changedFiles: revision === 0 ? [] : ['src/counter.js'], worktreeFingerprint: `fp-${revision}` }
    },
    async dispatch(input) {
      calls.push({ action: input.action, agent: input.agent.id })
      if (input.action === 'EXECUTE') {
        revision = 1
        return { status: 'SUCCESS', summary: 'counter fixed', changedFiles: ['src/counter.js'] }
      }
      if (input.action === 'VERIFY') {
        // 真实 verifier 以 plan step id 作为结果身份，命令仍然是 step.command。
        const steps = input.task.verificationPlan!.steps.filter((step) => shape !== 'incomplete' || step.id !== 'verify-2')
        return { status: 'SUCCESS', verificationResults: steps.map((step) => ({
          name: step.command, command: step.command, cwd: step.cwd,
          stepId: shape === 'wrong-identity' ? `wrong-${step.id}` : step.id,
          status: 'passed' as const, exitCode: 0,
        })) }
      }
      if (input.action === 'REVIEW') {
        // REVIEW PASS 必须绑定当前被检查的仓库事实，否则 reviewSatisfied 仍为 false。
        return { status: 'SUCCESS', review: {
          passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
          reviewer: input.agent.identity!, implementer: EXECUTOR.identity!,
          reviewedRepository: input.task.gitState.repositoryIdentity!, reviewedBranch: input.task.gitState.branch!,
          reviewedCommit: input.task.gitState.headSha!, reviewedWorkspace: input.task.gitState.worktreeFingerprint!,
          reviewBaseCommit: input.task.taskBaseCommit!, reviewHeadCommit: input.task.gitState.headSha!,
          reviewedFiles: input.task.gitState.changedFiles, timestamp: '2026-09-22T00:00:00.000Z',
        } }
      }
      return { status: 'SUCCESS' }
    },
  }
  const runner = new GoldenPathTaskRunner({ sessionId: SESSION, branch: 'main', agents: [EXECUTOR, REVIEWER], dispatcher, repositoryRoot: root,
    fallbackRunner: new V2ControllerTaskRunner({ sessionId: SESSION, branch: 'main', agents: [EXECUTOR, REVIEWER], dispatcher }) })
  return { runner, calls }
}

function captureContext(events: TaskEventLogV2) {
  const snapshots: TaskStateV2[] = []
  const context: WorkSessionTaskRunContext = {
    taskEventLog: events,
    persistTaskStateV2: async (state) => { snapshots.push(loadTaskStateV2(JSON.parse(JSON.stringify(state)))) },
  }
  return { context, snapshots }
}

const decisions = (events: TaskEventLogV2) => events.events
  .filter((event) => event.type === 'CONTROLLER_DECIDED')
  .map((event) => `${event.action}:${event.reasonCode}`)

test('v0.4.0 the Golden to Controller handoff binds acceptance evidence by plan step id', async () => {
  const f = await fixture()
  try {
    const plan = await explicitPlan(f.root)
    assert.deepEqual(plan.steps.map((step) => [step.id, step.command]), [['verify-1', 'git diff --check'], ['verify-2', 'npm test']])
    const { runner } = identityRunner(f.root, 'step')
    const events = new TaskEventLogV2()
    const { context, snapshots } = captureContext(events)
    await runner.run(TASK, undefined, undefined, context)

    const handoff = snapshots.find((state) => state.execution?.path === 'CONTROLLER')
    assert.ok(handoff !== undefined, 'HIGH risk must hand the planned task to the Controller')
    assert.deepEqual(handoff.completion.bindings.map((binding) => [binding.criterion, [...binding.requiredEvidence]]),
      [[CRITERION, ['verify-1', 'verify-2']]])
    // 持久化的 binding 必须与 Controller 重新推导出的可信 binding 完全一致，否则会被判违规状态。
    assert.deepEqual(handoff.completion.bindings, bindingsFromVerificationPlan(plan, { identity: 'step' }))
    // production 用同一表达式把 completion identity 还原为可执行命令：step id 绝不进入 shell。
    assert.deepEqual(
      verificationCommandsForEvidence(handoff.verificationPlan, verifierEvidenceFromBindings(handoff.completion.bindings)),
      ['git diff --check', 'npm test'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 a REVIEW PASS is followed by COMPLETE on step-identity evidence', async () => {
  const f = await fixture()
  try {
    const { runner, calls } = identityRunner(f.root, 'step')
    const events = new TaskEventLogV2()
    const { context } = captureContext(events)
    const result = await runner.run(TASK, undefined, undefined, context)

    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired))
    assert.deepEqual(decisions(events), [
      'EXECUTE:TASK_NOT_STARTED',
      'VERIFY:EVIDENCE_MISSING',
      'REVIEW:RISK_REQUIRES_REVIEW',
      'COMPLETE:COMPLETION_CRITERIA_SATISFIED',
    ])
    // 证据身份与绑定身份同源：verify-1 / verify-2。
    assert.deepEqual(result.taskStateV2?.completion.evidence.map((item) => [item.type, item.status]),
      [['verify-1', 'PASSED'], ['verify-2', 'PASSED']])
    assert.deepEqual([...new Set(result.taskStateV2!.completion.bindings.flatMap((binding) => binding.requiredEvidence))],
      ['verify-1', 'verify-2'])
    assert.equal(events.count('REVIEW_PASSED'), 1)
    assert.deepEqual(calls.filter((call) => call.action === 'REVIEW'), [{ action: 'REVIEW', agent: 'deepseek-reviewer' }])
    // REVIEW PASS 之后不得再要求 VERIFY，也不得进入循环判定。
    assert.equal(decisions(events).filter((key) => key === 'VERIFY:EVIDENCE_MISSING').length, 1, '只有首次无证据时的合法 VERIFY')
    assert.equal(events.has('NO_PROGRESS_DETECTED'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 a step identity is resolved to its planned command before any execution', async () => {
  const f = await fixture()
  try {
    const plan = await explicitPlan(f.root)
    const identity = verifierEvidenceFromBindings(bindingsFromVerificationPlan(plan, { identity: 'step' }))
    assert.deepEqual(identity, ['verify-1', 'verify-2'])

    // completion truth 是 step id，实际 verifier command 仍然是计划里的命令。
    assert.deepEqual(verificationCommandsForEvidence(plan, identity), ['git diff --check', 'npm test'])
    assert.deepEqual(verificationCommandsForEvidence(plan, ['verify-2']), ['npm test'])
    assert.equal(verificationCommandsForEvidence(plan, ['verify-1']).includes('verify-1'), false, 'step id 绝不能进入 shell')

    // 没有 plan 的 legacy 路径保持 command identity 原样。
    assert.deepEqual(verificationCommandsForEvidence(undefined, ['npm test']), ['npm test'])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 the planner default keeps command identity for legacy callers', async () => {
  const f = await fixture()
  try {
    const plan = await explicitPlan(f.root)
    assert.deepEqual(bindingsFromVerificationPlan(plan), [{ criterion: CRITERION, requiredEvidence: ['git diff --check', 'npm test'] }])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('v0.4.0 verification evidence that does not match the bound identity can never complete', async () => {
  for (const shape of ['wrong-identity', 'incomplete'] as const) {
    const f = await fixture()
    try {
      const { runner } = identityRunner(f.root, shape)
      const events = new TaskEventLogV2()
      const { context } = captureContext(events)
      const result = await runner.run(TASK, undefined, undefined, context)

      assert.notEqual(result.status, 'COMPLETED', `${shape}: identity 修复不得放宽 evidence gate`)
      assert.equal(events.has('TASK_COMPLETED'), false, `${shape}: 不得产生 COMPLETE`)
      assert.ok(decisions(events).filter((key) => key === 'VERIFY:EVIDENCE_MISSING').length >= 2, `${shape}: 缺失证据必须仍判 EVIDENCE_MISSING`)
      assert.equal(result.taskStateV2?.status, 'SUSPENDED', shape)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  }
})

test('v0.4.0 stale convergence history does not misjudge a VERIFY that follows a recovery', async () => {
  const f = await fixture()
  try {
    const plan = await explicitPlan(f.root)
    // 旧 history 记的是恢复前的事实：decision / reality 都已过期。
    const seeded: TaskStateV2 = {
      ...createTaskStateV2({ id: SESSION, branch: 'main' }, TASK),
      status: 'ACTIVE',
      execution: { path: 'CONTROLLER', escalated: true },
      verificationPlan: plan,
      completion: { evidence: [], bindings: bindingsFromVerificationPlan(plan, { identity: 'step' }) },
      gitState: { repositoryIdentity: f.root, branch: 'main', headSha: 'head-1', changedFiles: [], worktreeFingerprint: 'fp-0' },
      implementer: EXECUTOR.identity!,
      providerHistory: ['codex'],
      controllerConvergence: { recentDecisions: [
        { decisionKey: 'VERIFY:EVIDENCE_MISSING', realityKey: JSON.stringify({ recovered: 'before', worktreeFingerprint: 'fp-stale' }) },
        { decisionKey: 'VERIFY:EVIDENCE_MISSING', realityKey: JSON.stringify({ recovered: 'before', worktreeFingerprint: 'fp-stale' }) },
      ] },
    }
    const { runner } = identityRunner(f.root, 'step')
    const events = new TaskEventLogV2()
    const { context } = captureContext(events)
    const result = await runner.run(TASK, undefined, undefined,
      { ...context, taskStateV2: loadTaskStateV2(JSON.parse(JSON.stringify(seeded))) })

    assert.equal(result.status, 'COMPLETED', JSON.stringify(result.humanRequired))
    assert.equal(events.has('NO_PROGRESS_DETECTED'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
