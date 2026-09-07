/**
 * W003 ENVIRONMENT_REQUIRED Classification
 *
 * 真实 Canary 证明：Python 解释器不可用 → python -m venv 无法执行、pytest 无法运行，
 * 这不是 DECISION_REQUIRED。
 *
 * W003 BOOTSTRAP CLOSURE：".venv/Scripts/python.exe 不存在"本身不能推出 ENVIRONMENT_REQUIRED。
 * - venv target missing + 无宿主 runtime 失败证据 → recoverable bootstrap prerequisite，
 *   由 Reviewer revise 触发 bootstrap（NOT ENVIRONMENT_REQUIRED）；
 * - venv target missing + bootstrap capability 不可用 → 不伪装成 environment failure；
 * - 真实 bootstrap attempt 失败（宿主 python / executable / venv module 不可用）
 *   → ENVIRONMENT_REQUIRED。
 *
 * 本测试验证最小结构化修复：
 * - 真实宿主 runtime 失败证据（python 解释器不可用导致 venv/pytest 无法运行）→ ENVIRONMENT_REQUIRED
 *   （不得 DECISION_REQUIRED）；
 * - venv target missing（无宿主失败证据）→ 不得 ENVIRONMENT_REQUIRED（recoverable / 交回 Reviewer）；
 * - 后续 Reviewer timeout 不得把已明确的 ENVIRONMENT_REQUIRED evidence 覆盖成 DECISION_REQUIRED；
 * - 纯 Reviewer timeout（无更强 blocker）→ STALLED；
 * - 普通 pytest 断言失败（非缺失解释器）不误判为 ENVIRONMENT_REQUIRED；
 * - 存在 permission / scope 证据时不得归类为 ENVIRONMENT_REQUIRED。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExecutionReport, GuardianTask } from 'nova-wing/development-guardian'
import { classifyHumanRequired } from '../packages/development-guardian/work-session/guardian-task-runner.js'

/** venv target 缺失：bootstrap 尚未完成，不一定是宿主环境故障 */
const venvMissingReport: ExecutionReport = {
  summary: 'venv 未创建，pytest 无法运行',
  changedFiles: [],
  commandsRun: ['claude -p --output-format json', '.venv/Scripts/python.exe -m pytest'],
  verificationResults: [
    { name: 'git diff --check', status: 'passed' },
    {
      name: '.venv/Scripts/python.exe -m pytest',
      status: 'failed',
      details: 'bash: line 1: .venv/Scripts/python.exe: No such file or directory',
    },
  ],
  blockers: [],
}

/** 真实宿主运行时失败：python 解释器不可用导致 venv bootstrap 真实失败 */
const hostRuntimeFailureReport: ExecutionReport = {
  ...venvMissingReport,
  summary:
    "python -m venv .venv 真实执行失败：'python' 不是内部或外部命令，也不是可运行的程序或批处理文件",
  verificationResults: [
    { name: 'git diff --check', status: 'passed' },
    {
      name: '.venv/Scripts/python.exe -m pytest',
      status: 'failed',
      details: "python is not recognized as an internal or external command; .venv/Scripts/python.exe: No such file or directory",
    },
  ],
}

function envTask(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'T-env',
    goal: 'Bootstrap FastAPI application',
    state: 'HUMAN_REQUIRED',
    iteration: 1,
    maxIterations: 10,
    ...overrides,
  }
}

test('real host runtime failure (python unavailable) maps to ENVIRONMENT_REQUIRED (not DECISION_REQUIRED)', () => {
  const task = envTask({ lastReport: hostRuntimeFailureReport })

  const hr = classifyHumanRequired(task)

  assert.strictEqual(hr.category, 'ENVIRONMENT_REQUIRED')
  assert.notStrictEqual(hr.category, 'DECISION_REQUIRED')
  assert.ok(
    hr.reason.includes('.venv/Scripts/python.exe -m pytest'),
    'reason must carry the failed runtime verification command',
  )
})

test('venv target missing with python bootstrap capability is recoverable (NOT ENVIRONMENT_REQUIRED)', () => {
  const task = envTask({
    lastReport: {
      ...venvMissingReport,
      executorCapabilities: ['python venv bootstrap', 'venv pip install'],
      deterministicVerificationCapabilities: ['.venv/Scripts/python.exe -m pytest', 'git diff --check'],
    },
  })

  const hr = classifyHumanRequired(task)

  assert.notStrictEqual(hr.category, 'ENVIRONMENT_REQUIRED', 'venv missing is a recoverable bootstrap prerequisite')
  assert.notStrictEqual(hr.category, 'PERMISSION_REQUIRED', 'bootstrap capability is already approved')
})

test('venv target missing without bootstrap capability is not disguised as environment failure', () => {
  const task = envTask({ lastReport: venvMissingReport })

  const hr = classifyHumanRequired(task)

  assert.notStrictEqual(hr.category, 'ENVIRONMENT_REQUIRED', 'must not disguise missing venv as host environment failure')
})

test('later Reviewer timeout does not override already-clear ENVIRONMENT_REQUIRED evidence', () => {
  const task = envTask({
    stopReason: 'brain review failed: ChatGPT review timed out after 120000ms',
    lastReport: hostRuntimeFailureReport,
  })

  const hr = classifyHumanRequired(task)

  assert.strictEqual(hr.category, 'ENVIRONMENT_REQUIRED')
  assert.notStrictEqual(hr.category, 'DECISION_REQUIRED')
  assert.ok(hr.reason.includes('timed out'), 'reason must preserve the timeout context')
})

test('pure Reviewer timeout without stronger blocker maps to STALLED', () => {
  const task = envTask({
    stopReason: 'brain review failed: ChatGPT review timed out after 120000ms',
  })

  const hr = classifyHumanRequired(task)

  assert.strictEqual(hr.category, 'STALLED')
  assert.notStrictEqual(hr.category, 'DECISION_REQUIRED')
})

test('plain pytest assertion failure is not classified as ENVIRONMENT_REQUIRED', () => {
  const task = envTask({
    stopReason: 'brain reported blocked',
    lastReport: {
      ...venvMissingReport,
      verificationResults: [
        { name: 'git diff --check', status: 'passed' },
        {
          name: '.venv/Scripts/python.exe -m pytest',
          status: 'failed',
          details: 'assert error: expected 1, got 2',
        },
      ],
    },
  })

  const hr = classifyHumanRequired(task)

  assert.notStrictEqual(hr.category, 'ENVIRONMENT_REQUIRED')
})

test('permission denials suppress ENVIRONMENT_REQUIRED classification', () => {
  const task = envTask({
    lastReport: {
      ...hostRuntimeFailureReport,
      permissionDenials: [
        { tool: 'Bash', operation: 'python -m venv .venv', summary: 'denied' },
      ],
    },
  })

  const hr = classifyHumanRequired(task)

  assert.notStrictEqual(hr.category, 'ENVIRONMENT_REQUIRED')
})

test('scope violation suppresses ENVIRONMENT_REQUIRED classification', () => {
  const task = envTask({
    stopReason: 'changed file is outside allowed scope: src/evil.py',
    lastReport: {
      ...hostRuntimeFailureReport,
      blockers: ['changed file is outside allowed scope: src/evil.py'],
    },
  })

  const hr = classifyHumanRequired(task)

  assert.notStrictEqual(hr.category, 'ENVIRONMENT_REQUIRED')
})
