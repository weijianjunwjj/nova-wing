import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutionReport, GuardianTask } from 'nova-wing/development-guardian'
import { classifyHumanRequired } from '../packages/development-guardian/work-session/guardian-task-runner.js'

function task(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'canary-classification',
    goal: 'complete the bounded task',
    state: 'HUMAN_REQUIRED',
    iteration: 1,
    maxIterations: 3,
    ...overrides,
  }
}

function report(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    summary: 'executor stopped',
    changedFiles: [],
    commandsRun: [],
    verificationResults: [],
    blockers: [],
    ...overrides,
  }
}

test('Finding #8: Claude Provider insufficient account balance requires credentials, not a decision', () => {
  for (const candidate of [
    task({ stopReason: 'Claude Code failed with 403 Insufficient account balance' }),
    task({
      stopReason: 'brain reported blocked',
      lastReport: report({ blockers: ['Claude Code failed with 403 Insufficient account balance'] }),
    }),
    task({
      stopReason:
        'Reviewer cannot continue because the old Claude Code report has HTTP 402 Insufficient Balance; changed_files are within allowed_paths and no forbidden_paths violation was found',
      lastReport: report({ blockers: ['Claude Code failed with HTTP 402 Insufficient Balance'] }),
    }),
  ]) {
    const humanRequired = classifyHumanRequired(candidate)
    assert.equal(humanRequired.category, 'CREDENTIAL_REQUIRED')
    assert.notEqual(humanRequired.category, 'DECISION_REQUIRED')
  }
})

test('Finding #8: ordinary business decisions and bare HTTP failures remain decisions', () => {
  for (const stopReason of [
    'Choose whether the public API should preserve the legacy response shape',
    'application request failed with HTTP 403',
    'ordinary API request failed with HTTP 500',
    'checkout rejected because customer has insufficient balance',
    'business account has insufficient account balance',
  ]) {
    assert.equal(classifyHumanRequired(task({ stopReason })).category, 'DECISION_REQUIRED')
  }
})

test('Finding #8: structured Guardian capability denials remain permission required', () => {
  const humanRequired = classifyHumanRequired(task({
    stopReason: 'Reviewer blocked because the approved capability is unavailable',
    lastPacket: {
      verdict: 'blocked',
      goal: 'complete the bounded task',
      instructions: [],
      constraints: [],
      verification: [],
      doNotDo: [],
    },
    lastReport: report({
      permissionDenials: [{ tool: 'Bash', operation: 'npm install', summary: 'not approved' }],
    }),
  }))

  assert.equal(humanRequired.category, 'PERMISSION_REQUIRED')
})

test('Finding #10: preservation prose containing worktree is not repository drift', () => {
  const humanRequired = classifyHumanRequired(task({
    stopReason:
      'T006 cannot return done because required pytest verification failed while the existing implementation and worktree must be preserved',
  }))

  assert.notEqual(humanRequired.category, 'REPO_DRIFT')
})

test('Finding #10: explicit drift marker and pre-existing changes remain repository drift', () => {
  for (const stopReason of [
    'REPO_DRIFT: worktree files changed since checkpoint',
    'cannot start autonomously because pre-existing changes are present',
  ]) {
    assert.equal(classifyHumanRequired(task({ stopReason })).category, 'REPO_DRIFT')
  }
})
