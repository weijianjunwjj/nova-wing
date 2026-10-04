import { mintSession, startOperator, sessionFetch } from './operator-session.js'
/**
 * v0.4.0: the Composer must declare real capability profiles so a HIGH-risk task
 * can obtain an independent reviewer. The reviewer is declared only when its real
 * provider route is confirmed; otherwise REVIEW stays fail-closed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createNovaWingLaunchpad,
  discoverTrustedWorkSessionConfigs,
  type NovaWingLaunchpad,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'
import { trustedAgents } from '../packages/development-guardian/work-session/production.js'
import { deriveRuntimeRepairReasonCode } from '../packages/development-guardian/work-session/runtime-repair.js'
import { isIndependentReviewerCandidate } from '../packages/development-guardian/work-session/reviewer-runtime.js'
import {
  V2ControllerTaskRunner,
  selectAgent,
  type AgentCapabilityProfile,
  type V2ActionDispatcher,
} from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import type { WorkSessionTask } from '../packages/development-guardian/work-session/model.js'

interface ComposerState { receivedConfigs: TrustedWorkSessionConfig[] }

function fakeWorkSessionFactory(state: ComposerState) {
  return async (config: TrustedWorkSessionConfig) => {
    state.receivedConfigs.push(config)
    let live = true
    return {
      controller: { start: () => ({ started: true }) },
      async start() { return { url: 'http://127.0.0.1:54321' } },
      isLive: () => live,
      hasActiveSession: () => true,
      async close() { live = false },
    }
  }
}

/** Composer create needs only a trusted config directory and a branch read. */
async function composeSession(
  reviewerRoute: () => Promise<boolean>,
  reviewerProvider?: () => Promise<'deepseek' | 'claude' | undefined>,
): Promise<{ directory: string; launchpad: NovaWingLaunchpad; config: TrustedWorkSessionConfig; persistedJson: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-reviewer-'))
  const state: ComposerState = { receivedConfigs: [] }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      resolveEnvironment: async () => ({}),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      resolveReviewerRouteAvailable: reviewerRoute,
      ...(reviewerProvider === undefined ? {} : { resolveReviewerProvider: reviewerProvider }),
    },
  })
  const address = await startOperator(launchpad)
  const response = await sessionFetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': await mintSession(launchpad), Origin: address.url },
    body: JSON.stringify({
      requestId: `reviewer-wiring-${Math.random().toString(16).slice(2)}`,
      targetRepo: process.cwd(),
      tasks: [{ id: 'T-REVIEW', goal: 'Implement a focused deterministic change with tests.' }],
      guardian: { allowedPaths: ['packages/**', 'tests/**'] },
    }),
  })
  assert.equal(response.status, 202, await response.text())
  const discovered = await discoverTrustedWorkSessionConfigs(directory)
  assert.equal(discovered.length, 1)
  return {
    directory, launchpad, config: discovered[0]!.config,
    persistedJson: await readFile(discovered[0]!.configPath, 'utf8'),
  }
}

/** A task whose contract alone is assessed HIGH risk, so REVIEW is required. */
const highRiskTask: WorkSessionTask = {
  id: 'T-REVIEW', goal: 'Ship the public API compatibility change.',
  acceptanceCriteria: ['tests pass'],
  acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }],
}

function reviewRunner(
  config: TrustedWorkSessionConfig,
  agents: readonly AgentCapabilityProfile[],
  calls: Array<{ action: string; agent: string }>,
) {
  let changedFiles: readonly string[] = []
  const implementer = agents.find((candidate) => candidate.id === 'executor-router')?.identity ??
    { agent: 'executor-router', provider: 'codex-or-deepseek', runtimeIdentity: 'session:executor-router' }
  const dispatcher: V2ActionDispatcher = {
    async inspectRepository() {
      return { repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }
    },
    async dispatch({ action, agent, task }) {
      calls.push({ action, agent: agent.id })
      if (action === 'EXECUTE') {
        changedFiles = ['src/public-api.mjs']
        return { status: 'SUCCESS', changedFiles }
      }
      if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
      if (action === 'REVIEW') {
        return { status: 'SUCCESS', review: {
          passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
          reviewer: agent.identity!, implementer,
          reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h',
          reviewedWorkspace: 'w', reviewBaseCommit: task.taskBaseCommit!, reviewHeadCommit: 'h', reviewedFiles: ['src/public-api.mjs'], timestamp: 'now',
        } }
      }
      return { status: 'SUCCESS' }
    },
  }
  return new V2ControllerTaskRunner({
    sessionId: config.session.id, branch: config.session.branch, agents, dispatcher,
  })
}

test('v040: a confirmed DeepSeek route makes the Composer declare an independent reviewer', async () => {
  const composed = await composeSession(async () => true)
  try {
    const agents = composed.config.agents
    assert.ok(agents !== undefined && agents.length >= 1, 'the composed config must carry real capability profiles')
    const byId = new Map(agents!.map((agent) => [agent.id, agent]))
    assert.deepEqual([...byId.keys()].sort(), ['deepseek-reviewer', 'executor-router'])
    assert.equal(byId.get('executor-router')?.provider, 'codex-or-deepseek')
    assert.equal(byId.get('executor-router')?.capabilities?.review, false, 'the executor never reviews')
    assert.equal(byId.get('deepseek-reviewer')?.provider, 'deepseek')
    assert.equal(byId.get('deepseek-reviewer')?.capabilities?.review, true)
    assert.equal(byId.get('deepseek-reviewer')?.capabilities?.reasoning, true)
    // The persisted artifact - what an installed Session actually reads - must match.
    assert.match(composed.persistedJson, /"deepseek-reviewer"/u)
    assert.match(composed.persistedJson, /"review": true/u)

    const profiles = trustedAgents(composed.config, composed.config.session.id)!
    const calls: Array<{ action: string; agent: string }> = []
    const result = await reviewRunner(composed.config, profiles, calls).run(highRiskTask)

    assert.deepEqual(calls.filter((call) => call.action === 'REVIEW'), [{ action: 'REVIEW', agent: 'deepseek-reviewer' }])
    assert.equal(result.status, 'COMPLETED')
    assert.equal(result.taskStateV2?.completion.review?.reviewer.provider, 'deepseek')
  } finally {
    await composed.launchpad.close()
    await rm(composed.directory, { recursive: true, force: true })
  }
})

test('a confirmed Claude route persists an independent Claude reviewer profile', async () => {
  const composed = await composeSession(async () => true, async () => 'claude')
  try {
    assert.deepEqual(composed.config.agents?.map((agent) => [agent.id, agent.provider]),
      [['executor-router', 'codex-or-deepseek'], ['claude-reviewer', 'claude']])
    assert.match(composed.persistedJson, /"claude-reviewer"/u)
    const profiles = trustedAgents(composed.config, composed.config.session.id)!
    const calls: Array<{ action: string; agent: string }> = []
    const result = await reviewRunner(composed.config, profiles, calls).run(highRiskTask)
    assert.deepEqual(calls.filter((call) => call.action === 'REVIEW'), [{ action: 'REVIEW', agent: 'claude-reviewer' }])
    assert.equal(result.status, 'COMPLETED')
  } finally {
    await composed.launchpad.close()
    await rm(composed.directory, { recursive: true, force: true })
  }
})

test('v040: without a confirmed route no reviewer is declared and REVIEW fails closed', async () => {
  for (const [label, probe] of [
    ['route absent', async () => false],
    ['probe failure', async () => { throw new Error('probe unavailable') }],
  ] as const) {
    const composed = await composeSession(probe)
    try {
      const agents = composed.config.agents
      assert.ok(agents !== undefined && agents.length >= 1, `${label}: executor profile is still declared`)
      assert.deepEqual(agents!.map((agent) => agent.id), ['executor-router'], `${label}: no reviewer profile`)
      assert.equal(agents!.some((agent) => agent.capabilities?.review === true), false)
      assert.doesNotMatch(composed.persistedJson, /deepseek-reviewer/u)

      const profiles = trustedAgents(composed.config, composed.config.session.id)!
      const calls: Array<{ action: string; agent: string }> = []
      const eventLog = new TaskEventLogV2()
      const result = await reviewRunner(composed.config, profiles, calls).run(highRiskTask, undefined, undefined, { taskEventLog: eventLog })

      assert.equal(result.status, 'HUMAN_REQUIRED', label)
      assert.equal(result.humanRequired?.category, 'ENVIRONMENT_REQUIRED', label)
      assert.match(result.humanRequired?.reason ?? '', /no available agent for REVIEW/u, label)
      assert.match(result.humanRequired?.reason ?? '', /Independent reviewer unavailable/u, label)
      assert.match(result.humanRequired?.reason ?? '', /未配置独立 Reviewer/u, label)
      assert.equal(calls.some((call) => call.action === 'REVIEW'), false, `${label}: REVIEW is never dispatched`)
      assert.equal(eventLog.count('TASK_SUSPENDED'), 1, label)
      // The stable token is preserved, so Runtime Repair still recognizes this issue.
      assert.equal(deriveRuntimeRepairReasonCode(result.humanRequired!), 'NO_AVAILABLE_AGENT_FOR_REVIEW', label)
    } finally {
      await composed.launchpad.close()
      await rm(composed.directory, { recursive: true, force: true })
    }
  }
})

test('v040: the Codex executor can never be selected or accepted as its own reviewer', () => {
  const executor: AgentCapabilityProfile = {
    id: 'executor-router',
    identity: { agent: 'executor-router', provider: 'codex', runtimeIdentity: 'R1' },
    available: true, quotaExhausted: false, degraded: false,
    capabilities: { coding: true, reasoning: true, verification: true, review: false },
  }
  const task = { implementer: { agent: 'executor-router', provider: 'codex', runtimeIdentity: 'R1' }, providerHistory: ['codex'] }
  assert.equal(isIndependentReviewerCandidate(executor, task), false, 'a non-review-capable profile is never a candidate')
  assert.equal(selectAgent('REVIEW', [executor], undefined), undefined)

  // Even a review-capable Codex profile is rejected: the implementer provider is Codex.
  const codexReviewer: AgentCapabilityProfile = {
    id: 'codex-reviewer',
    identity: { agent: 'codex-reviewer', provider: 'codex', runtimeIdentity: 'R9' },
    available: true, quotaExhausted: false, degraded: false,
    capabilities: { review: true, reasoning: true },
  }
  assert.equal(isIndependentReviewerCandidate(codexReviewer, task), false, 'provider-level independence excludes self-review')

  const deepseekReviewer: AgentCapabilityProfile = {
    id: 'deepseek-reviewer',
    identity: { agent: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: 'R10' },
    available: true, quotaExhausted: false, degraded: false,
    capabilities: { review: true, reasoning: true },
  }
  assert.equal(isIndependentReviewerCandidate(deepseekReviewer, task), true)
  assert.equal(selectAgent('REVIEW', [executor, deepseekReviewer], undefined)?.id, 'deepseek-reviewer')
})
