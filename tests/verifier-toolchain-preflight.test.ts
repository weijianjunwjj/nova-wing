import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeCodeExecutor } from '../packages/development-guardian/claude-code-executor.js'
import type { ExecutionReport, GuardianTask } from '../packages/development-guardian/model.js'
import { createExecutorTestWorkspace } from './executor-workspace-fixture.js'

/** A PATH that cannot supply a JavaScript toolchain, like a Finder-launched macOS app. */
const TOOLLESS_PATH = '/nonexistent-novawing-toolchain'

function task(): GuardianTask {
  return { id: 'task-preflight', goal: 'prove the verifier preflight', state: 'EXECUTING', iteration: 0, maxIterations: 3 }
}

function report(): ExecutionReport {
  return { summary: '', commandsRun: [], blockers: [], changedFiles: [], verificationResults: [] }
}

// On the real macOS host this step produced `bash: npm: command not found` -> exit 127 ->
// UNKNOWN, which hid a missing toolchain behind "an unknown error". It must be classified
// before the shell is ever spawned, and no injected runner may stand in for the host here.
test('a verifier whose tool cannot resolve is classified without spawning a shell', async (t) => {
  const cwd = await createExecutorTestWorkspace(t, 'verifier-preflight')
  const executor = new ClaudeCodeExecutor({ cwd, environment: { PATH: TOOLLESS_PATH } })
  const result = await executor.retryVerification({
    task: task(), report: report(),
    verificationSteps: [{ stepId: 'verify-2', command: 'npm test', cwd: '.' }],
  })
  const [first] = result.verificationResults
  assert.equal(first?.status, 'skipped')
  assert.equal(first?.classification, 'ENVIRONMENT_FAILURE', 'must not be UNKNOWN')
  assert.match(String(first?.details), /npm/u)
  assert.equal(result.commandsRun.includes('npm test'), false, 'the verifier must never be spawned')
  assert.match(String(result.blockers.join(' ')), /npm/u)
})
