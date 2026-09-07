import assert from 'node:assert/strict'
import test from 'node:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeCodeExecutor } from '../packages/development-guardian/claude-code-executor.js'
import { runGuardianTask } from '../packages/development-guardian/guardian.js'
import { classifyHumanRequired } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import type { DelegationPacket, ExecutionReport, GuardianTask } from '../packages/development-guardian/model.js'
import { codexTestRepo } from './codex-test-fixture.js'

const packet: DelegationPacket = { goal: 'change code', verdict: 'proceed', instructions: ['change src/a.ts'],
  constraints: [], doNotDo: [], verification: [] }

function task(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return { id: 'T030', goal: 'change code', state: 'READY', iteration: 0, maxIterations: 3,
    allowedPaths: ['src/**'], forbiddenPaths: [], ...overrides }
}

test('coding task with zero files and zero inspection evidence requires Executor retry', async () => {
  const root = await codexTestRepo()
  try {
    const executor = new ClaudeCodeExecutor({ cwd: root, gitBashPath: 'D:\\Git\\bin\\bash.exe',
      codingRuntime: { label: 'Codex Local', run: async () => ({ summary: 'no tools', commandsRun: [],
        blockers: ['NO_OP_EXECUTION: workspace inspection missing'] }) } })
    const report = await executor.execute({ task: task(), packet })
    assert.deepEqual(report.changedFiles, [])
    assert.match(report.blockers[0] ?? '', /^NO_OP_EXECUTION:/u)
    assert.equal(classifyHumanRequired(task({ stopReason: report.blockers[0]!, lastReport: {
      ...report, execution: { mode: 'auto', activeExecutor: 'codex', history: ['codex'], lastErrorKind: 'no_op_execution' },
    } })).category, 'EXECUTOR_RETRY_REQUIRED')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real changed files survive missing evidence transport and proceed to verification recovery', async () => {
  const root = await codexTestRepo()
  try {
    const executor = new ClaudeCodeExecutor({ cwd: root, gitBashPath: 'D:\\Git\\bin\\bash.exe',
      codingRuntime: { label: 'Codex Local', run: async () => {
        await writeFile(join(root, 'src/a.ts'), 'export const value = 2\n', 'utf8')
        return { summary: 'transport lost after write', commandsRun: [],
          blockers: ['NO_OP_EXECUTION: workspace inspection missing'] }
      } } })
    const report = await executor.execute({ task: task(), packet })
    assert.deepEqual(report.changedFiles, ['src/a.ts'])
    assert.deepEqual(report.blockers, [])
    assert.equal(report.verificationResults.find((result) => result.name === 'git diff --check')?.status, 'passed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('confirmed no-op retry preserves T030 identity and scope before genuine execution', async () => {
  const prior: ExecutionReport = { summary: 'no tools', changedFiles: [], commandsRun: [], verificationResults: [],
    blockers: ['NO_OP_EXECUTION: workspace inspection missing'], execution: {
      mode: 'auto', activeExecutor: 'codex', history: ['codex'], lastErrorKind: 'no_op_execution',
    } }
  let reviews = 0
  let executions = 0
  const result = await runGuardianTask({
    task: task({ state: 'HUMAN_REQUIRED', recoveryContinuation: true, resumeInput: { approval: true },
      stopReason: 'NO_OP_EXECUTION: workspace inspection missing', lastReport: prior, lastPacket: packet }),
    brain: { review: async ({ task: current }) => {
      reviews++
      assert.equal(current.id, 'T030')
      assert.deepEqual(current.allowedPaths, ['src/**'])
      if (current.lastReport === undefined) return packet
      return { ...packet, verdict: 'done' }
    } },
    executor: { preflight: async (current) => { assert.equal(current.id, 'T030') }, execute: async ({ task: current }) => {
      executions++
      assert.equal(current.id, 'T030')
      return { summary: 'implemented', changedFiles: ['src/a.ts'], commandsRun: ['read_file src/a.ts'],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] }
    } },
  })
  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(result.task.id, 'T030')
  assert.equal(reviews, 2)
  assert.equal(executions, 1)
})

test('failed preflight prevents EXECUTING and preserves iteration zero', async () => {
  let executions = 0
  const result = await runGuardianTask({ task: task(), brain: { review: async () => packet },
    executor: { preflight: async () => { throw { stage: 'list', safeMessage: 'workspace list preflight failed: directory is unavailable' } }, execute: async () => {
      executions++
      throw new Error('must not execute')
    } } })
  assert.equal(result.task.state, 'HUMAN_REQUIRED')
  assert.equal(result.task.iteration, 0)
  assert.equal(result.task.stopReason, 'EXECUTOR_ENVIRONMENT_UNAVAILABLE: workspace list preflight failed: directory is unavailable')
  assert.equal(executions, 0)
})
