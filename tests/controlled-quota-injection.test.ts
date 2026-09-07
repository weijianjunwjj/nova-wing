import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { codexTestRepo } from './codex-test-fixture.js'
import { readWorkspaceGit } from '../packages/development-guardian/codex-workspace-tools.js'
import { CodingExecutionStore } from '../packages/development-guardian/work-session/coding-execution-store.js'
import { requestControlledCodexQuotaExhaustion } from '../packages/development-guardian/work-session/controlled-quota-injection.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import type { WorkSessionDefinition, WorkSessionDurableState } from '../packages/development-guardian/work-session/model.js'

test('controlled quota injection is disabled by default and enforces exact Task, diff, safe boundary and one shot', async () => {
  const repo = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-quota-injection-'))
  const store = new CodingExecutionStore(join(data, 'executor.sqlite'))
  const definition: WorkSessionDefinition = { id: 'session-1', targetRepo: repo, branch: 'main',
    tasks: [{ id: 'T031-HANDOFF', goal: 'handoff' }], limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 } }
  const key = '["session-1","T031-HANDOFF"]'
  const env = { NODE_ENV: 'development', NOVAWING_ENABLE_CONTROLLED_QUOTA_INJECTION: '1' }
  try {
    await writeFile(join(repo, 'src/a.ts'), 'export const codexContribution = true\n')
    const status = await readWorkspaceGit(repo, 'status')
    const entries = parseGitStatus(status)
    const report = { summary: 'Codex contribution', changedFiles: ['src/a.ts'],
      commandsRun: ['git status', 'git diff', 'read_file src/a.ts'], verificationResults: [], blockers: [] }
    const task = { id: 'T031-HANDOFF', goal: 'handoff', state: 'HUMAN_REQUIRED' as const, iteration: 2,
      maxIterations: 10, lastReport: report }
    const state: WorkSessionDurableState = { sessionId: definition.id, state: 'SUSPENDED', currentTaskIndex: 0,
      currentTaskId: task.id, completedTaskIds: [], createdAt: new Date(), updatedAt: new Date(),
      currentTaskCheckpoint: { version: 1, task, provider: {}, capturedAt: new Date().toISOString(),
        repo: { repoPath: repo, branch: 'main', headSha: 'head', changedFiles: ['src/a.ts'],
          worktreeFingerprint: await computeWorktreeFingerprint(repo, entries) } } }
    store.save(key, { mode: 'auto', activeExecutor: 'codex', history: ['codex'],
      model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    { type: 'executor_completed', executor: 'codex', timestamp: new Date().toISOString() })
    const base = { definition, state, taskId: task.id,
      confirmation: 'INJECT T031-HANDOFF codex_quota_exhausted', env, store }

    await assert.rejects(requestControlledCodexQuotaExhaustion({ ...base, env: {} }), /disabled/u)
    await assert.rejects(requestControlledCodexQuotaExhaustion({ ...base, taskId: 'wrong' }), /confirmation|exact suspended/u)
    const resolved = await realpath(repo)
    const release = store.acquire(process.platform === 'win32' ? resolved.toLowerCase() : resolved, key)
    await assert.rejects(requestControlledCodexQuotaExhaustion(base), /active writer/u)
    release()

    const injection = await requestControlledCodexQuotaExhaustion(base)
    assert.equal(injection.kind, 'codex_quota_exhausted')
    assert.equal(injection.status, 'pending')
    assert.ok(injection.expectedDiffBytes > 0)
    await assert.rejects(requestControlledCodexQuotaExhaustion(base), /already exists/u)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
})

test('controlled quota injection rejects missing Codex diff evidence', async () => {
  const repo = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-quota-no-diff-'))
  const store = new CodingExecutionStore(join(data, 'executor.sqlite'))
  const taskId = 'T031-HANDOFF'
  const definition: WorkSessionDefinition = { id: 'session-2', targetRepo: repo, branch: 'main',
    tasks: [{ id: taskId, goal: 'handoff' }], limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 } }
  const task = { id: taskId, goal: 'handoff', state: 'HUMAN_REQUIRED' as const, iteration: 1, maxIterations: 3,
    lastReport: { summary: '', changedFiles: [], commandsRun: ['git status'], verificationResults: [], blockers: [] } }
  const state: WorkSessionDurableState = { sessionId: definition.id, state: 'SUSPENDED', currentTaskIndex: 0,
    currentTaskId: taskId, completedTaskIds: [], createdAt: new Date(), updatedAt: new Date(),
    currentTaskCheckpoint: { version: 1, task, provider: {}, capturedAt: new Date().toISOString(),
      repo: { repoPath: repo, branch: 'main', headSha: 'head', changedFiles: [], worktreeFingerprint: '' } } }
  try {
    await assert.rejects(requestControlledCodexQuotaExhaustion({ definition, state, taskId,
      confirmation: `INJECT ${taskId} codex_quota_exhausted`,
      env: { NODE_ENV: 'test', NOVAWING_ENABLE_CONTROLLED_QUOTA_INJECTION: '1' }, store }), /changed files evidence/u)
  } finally { await rm(repo, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})
