import assert from 'node:assert/strict'
import test from 'node:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeCodeExecutor } from '../packages/development-guardian/claude-code-executor.js'
import type { DelegationPacket, GuardianTask } from '../packages/development-guardian/model.js'
import { codexTestRepo } from './codex-test-fixture.js'

const packet: DelegationPacket = { goal: 'change code', verdict: 'proceed', instructions: ['change src/a.ts'],
  constraints: [], doNotDo: [], verification: [] }

function task(overrides: Partial<GuardianTask> = {}): GuardianTask {
  return { id: 'T030', goal: 'change code', state: 'READY', iteration: 0, maxIterations: 3,
    allowedPaths: ['src/**'], forbiddenPaths: [], ...overrides }
}

test('real changed files survive missing evidence transport and proceed to verification recovery', async () => {
  const root = await codexTestRepo()
  try {
    const executor = new ClaudeCodeExecutor({ cwd: root,
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
