/**
 * NovaWing v0.2.4 — REVIEW dispatch.
 *
 * Controller 只负责「当前 Action = REVIEW，需要满足独立性要求的 reviewer capability」，
 * 由本模块把被选中的 AgentCapabilityProfile 派发到对应 provider 的 Reviewer Runtime。
 * 这里没有「DeepSeek 是 Reviewer」这一假设；provider → runtime 的映射来自注册表。
 *
 * 安全边界：
 * - dispatch 前做真正的独立性校验，不独立即 fail closed；
 * - review 前后各做一次 repository inspection，fingerprint 变化即判定 reviewer 越权写入；
 * - Reviewer 只产出 ReviewEvidence；PASS/FAIL 都交回 TaskController。
 */

import type { TaskActorIdentity, TaskStateV2 } from './task-state-v2.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitExecutable } from '../platform/windows-git.js'
import type { AgentCapabilityProfile } from './v2-controller-task-runner.js'
import type { ProviderHealthObservation, ProviderHealthStatus } from './task-observability.js'
import { acceptanceAssertionIds, assertionCapabilityEvidenceValid, type AssertionReviewVerdict, type ReviewEvidence } from './risk-evidence.js'
import type { RepositoryReality } from './reconciliation.js'
import {
  ReviewerRuntimeRegistry,
  implementerProvidersOf,
  reviewerProviderOf,
  validateReviewerIndependence,
  type ReviewerTaskContext,
} from './reviewer-runtime.js'
import { REVIEW_DEFAULT_TIMEOUT_MS } from './reviewer-adapters.js'

export function agentIdentityOf(agent: AgentCapabilityProfile): TaskActorIdentity {
  return agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
}

export interface ReviewProviderFailure {
  provider: string
  status: ProviderHealthStatus
  reason: string
}

export interface ReviewDispatchResult {
  status: 'SUCCESS' | 'BLOCKED'
  review?: ReviewEvidence
  blockers?: readonly string[]
  providerHealth?: readonly ProviderHealthObservation[]
  /** Present only when the reviewer runtime — not the implementation — failed. */
  providerFailure?: ReviewProviderFailure
}

export interface ReviewDispatcher {
  dispatch(input: { agent: AgentCapabilityProfile; task: TaskStateV2 }): Promise<ReviewDispatchResult>
}

export interface ReviewDispatcherOptions {
  registry: ReviewerRuntimeRegistry
  inspectRepository: () => Promise<RepositoryReality>
  timeoutMs?: number
  now?: () => string
  /** Reviewer 拥有当前 Task 的 write authority 时必须被判定为不独立。 */
  requireIndependentReviewer?: boolean
}

const run = promisify(execFile)

async function reviewScope(task: TaskStateV2, reality: RepositoryReality): Promise<{
  base?: string; head?: string; files: string[]
}> {
  const base = task.taskBaseCommit ?? task.ownedCheckpoints?.[0]?.before.headSha ??
    task.execution?.startCheckpoint?.headSha
  const head = reality.headSha
  if (!base) return { files: [...task.gitState.changedFiles] } // Legacy standalone review without a captured Task base.
  if (task.gitState.headSha !== head || task.gitState.repositoryIdentity !== reality.repositoryIdentity ||
    task.gitState.branch !== reality.branch || task.gitState.worktreeFingerprint !== reality.worktreeFingerprint ||
    JSON.stringify(task.gitState.changedFiles) !== JSON.stringify(reality.changedFiles))
    throw new Error('review repository differs from the trusted Task observation')
  const repo = reality.repositoryIdentity
  await run(gitExecutable(), ['merge-base', '--is-ancestor', base, head], { cwd: repo })
  const { stdout } = await run(gitExecutable(), ['diff', '--no-renames', '--name-only', '-z', base, head, '--'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const files = [...new Set([...stdout.split('\0').filter(Boolean), ...reality.changedFiles])].sort()
  return { base, head, files }
}

function reviewContext(task: TaskStateV2, scope: Awaited<ReturnType<typeof reviewScope>>): ReviewerTaskContext {
  return {
    taskId: task.identity.taskId,
    goal: task.goal,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    implementer: task.implementer,
    implementerProviders: implementerProvidersOf(task),
    repositoryIdentity: task.gitState.repositoryIdentity,
    branch: task.gitState.branch,
    headSha: task.gitState.headSha,
    workspaceFingerprint: task.gitState.worktreeFingerprint,
    reviewBaseCommit: scope.base,
    reviewHeadCommit: scope.head,
    reviewChangedFiles: scope.files,
    changedFiles: task.gitState.changedFiles,
    verificationEvidence: task.verificationState.results,
    evidence: task.completion.evidence,
    blockers: task.blockers,
    risk: task.risk,
  }
}

function sameReality(left: RepositoryReality, right: RepositoryReality): boolean {
  return left.repositoryIdentity === right.repositoryIdentity &&
    left.branch === right.branch &&
    left.headSha === right.headSha &&
    left.worktreeFingerprint === right.worktreeFingerprint
}

function unprovedAssertionIds(task: TaskStateV2, verdicts: readonly AssertionReviewVerdict[]): string[] {
  return acceptanceAssertionIds(task.acceptanceCriteria).filter((id) =>
    verdicts.filter((item) => item.assertionId === id &&
      item.verdict === (task.acceptanceCriteria.some((criterion) => criterion.startsWith(`AcceptanceAssertion ${id}: `) &&
        /\| VerificationReadiness: (?:EXTERNAL_DEFERRED|HUMAN_DEFERRED) \|/u.test(criterion)) ? 'DEFERRED' : 'PASS') &&
      item.evidence.trim() && assertionCapabilityEvidenceValid(task, item)).length !== 1)
}

function missingAssertionIds(task: TaskStateV2, verdicts: readonly AssertionReviewVerdict[]): string[] {
  return acceptanceAssertionIds(task.acceptanceCriteria).filter((id) =>
    verdicts.filter((item) => item.assertionId === id).length !== 1)
}

export function createReviewDispatcher(options: ReviewDispatcherOptions): ReviewDispatcher {
  const timeoutMs = options.timeoutMs ?? REVIEW_DEFAULT_TIMEOUT_MS
  const now = options.now ?? ((): string => new Date().toISOString())
  const requireIndependentReviewer = options.requireIndependentReviewer ?? true

  return {
    async dispatch({ agent, task }): Promise<ReviewDispatchResult> {
      const provider = reviewerProviderOf(agent)
      const runtime = options.registry.forProvider(provider)

      // Independence is checked before any provider work; a violation never runs a reviewer.
      const independence = validateReviewerIndependence({
        reviewer: agent,
        implementer: task.implementer,
        implementerProviders: implementerProvidersOf(task),
        requireIndependentReviewer,
      })
      if (!independence.independent) {
        return {
          status: 'BLOCKED',
          blockers: [`reviewer independence violated: ${independence.reasons.join('; ')}`],
          providerHealth: [{ provider, status: 'DEGRADED', reason: independence.reasons.join('; '), observedAt: now(), source: 'runtime' }],
          providerFailure: { provider, status: 'DEGRADED', reason: independence.reasons.join('; ') },
        }
      }

      if (runtime === undefined) {
        const reason = `no reviewer runtime is registered for provider ${provider}`
        return {
          status: 'BLOCKED',
          blockers: [reason],
          providerHealth: [{ provider, status: 'OFFLINE', reason, observedAt: now(), source: 'runtime' }],
          providerFailure: { provider, status: 'OFFLINE', reason },
        }
      }

      const before = await options.inspectRepository()
      let scope: Awaited<ReturnType<typeof reviewScope>>
      try { scope = await reviewScope(task, before) }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { status: 'BLOCKED', blockers: [`cannot establish exact review scope: ${reason}`],
          providerHealth: [{ provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
          providerFailure: { provider, status: 'DEGRADED', reason } }
      }
      const context = reviewContext(task, scope)
      let outcome = await runtime.review({ task: context, agent, timeoutMs })

      if (outcome.kind === 'RUNTIME_FAILURE') {
        const reason = `reviewer provider failure (${outcome.status}): ${outcome.reason}`
        return {
          status: 'BLOCKED',
          blockers: [reason],
          providerHealth: [{ provider: outcome.provider, status: outcome.status, reason: outcome.reason, observedAt: now(), source: 'runtime' }],
          providerFailure: { provider: outcome.provider, status: outcome.status, reason: outcome.reason },
        }
      }

      // A reviewer must never mutate the repository. Verify it with real repository facts.
      let after: RepositoryReality
      try {
        after = await options.inspectRepository()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          status: 'BLOCKED',
          blockers: [`cannot verify reviewer read-only guarantee: ${reason}`],
          providerHealth: [{ provider: outcome.provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
          providerFailure: { provider: outcome.provider, status: 'DEGRADED', reason },
        }
      }
      if (!sameReality(before, after)) {
        const reason = 'repository changed during review; the reviewer write attempt was rejected'
        return {
          status: 'BLOCKED',
          blockers: [reason],
          providerHealth: [{ provider: outcome.provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
          providerFailure: { provider: outcome.provider, status: 'DEGRADED', reason },
        }
      }

      // A PASS that omits an exact assertion verdict is a reviewer protocol
      // failure, not an implementation defect. Retry the same independent
      // reviewer once at the same repository state before failing closed.
      const missing = outcome.passed ? missingAssertionIds(task, outcome.assertionVerdicts ?? []) : []
      if (missing.length > 0) {
        const retry = await runtime.review({ task: { ...context,
          reviewProtocolFeedback: `The previous response omitted exact verdicts for ${missing.join(', ')}. Return exactly one evidence-backed verdict for every AcceptanceAssertion ID listed above, including DEFERRED for completion-only external or human evidence.` },
        agent, timeoutMs })
        if (retry.kind === 'RUNTIME_FAILURE') {
          const reason = `reviewer provider failure (${retry.status}): ${retry.reason}`
          return { status: 'BLOCKED', blockers: [reason],
            providerHealth: [{ provider: retry.provider, status: retry.status, reason: retry.reason, observedAt: now(), source: 'runtime' }],
            providerFailure: { provider: retry.provider, status: retry.status, reason: retry.reason } }
        }
        outcome = retry
        try { after = await options.inspectRepository() }
        catch (error) {
          const reason = `cannot verify reviewer read-only guarantee: ${error instanceof Error ? error.message : String(error)}`
          return { status: 'BLOCKED', blockers: [reason],
            providerHealth: [{ provider: retry.provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
            providerFailure: { provider: retry.provider, status: 'DEGRADED', reason } }
        }
        if (!sameReality(before, after)) {
          const reason = 'repository changed during review; the reviewer write attempt was rejected'
          return { status: 'BLOCKED', blockers: [reason],
            providerHealth: [{ provider: retry.provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
            providerFailure: { provider: retry.provider, status: 'DEGRADED', reason } }
        }
        const stillMissing = outcome.passed ? missingAssertionIds(task, outcome.assertionVerdicts ?? []) : []
        if (stillMissing.length > 0) {
          const reason = `reviewer omitted exact assertion verdicts after one retry: ${stillMissing.join(', ')}`
          return { status: 'BLOCKED', blockers: [reason],
            providerHealth: [{ provider: retry.provider, status: 'DEGRADED', reason, observedAt: now(), source: 'runtime' }],
            providerFailure: { provider: retry.provider, status: 'DEGRADED', reason } }
        }
      }

      const identity = agentIdentityOf(agent)
      const requiredAssertionIds = acceptanceAssertionIds(task.acceptanceCriteria)
      const assertionVerdicts = outcome.assertionVerdicts ?? []
      if (task.acceptanceCriteria.some((criterion) => criterion.startsWith(`TechnicalOutput ${task.identity.taskId}/`)) &&
          assertionVerdicts.length > 0) return { status: 'BLOCKED',
        blockers: ['Contributor review returned a customer assertion verdict.'] }
      const unproved = unprovedAssertionIds(task, assertionVerdicts)
      const blockingFindings = [...outcome.blockingFindings,
        ...unproved.map((id) => `AcceptanceAssertion ${id} lacks its required exact verdict with evidence.`),
        ...(assertionVerdicts.some((item) => !requiredAssertionIds.includes(item.assertionId))
          ? ['Reviewer returned an unexpected AcceptanceAssertion ID.'] : [])]
      const review: ReviewEvidence = {
        passed: outcome.passed && blockingFindings.length === 0,
        findings: [...outcome.findings],
        severity: outcome.passed && blockingFindings.length === 0 ? 'LOW' : 'HIGH',
        blockingFindings,
        reviewer: { ...identity },
        implementer: task.implementer ?? { agent: 'unknown', provider: 'unknown', runtimeIdentity: 'unknown' },
        reviewedRepository: after.repositoryIdentity,
        reviewedBranch: after.branch,
        reviewedCommit: after.headSha,
        reviewedWorkspace: after.worktreeFingerprint,
        ...(scope.base === undefined ? {} : { reviewBaseCommit: scope.base }),
        ...(scope.head === undefined ? {} : { reviewHeadCommit: scope.head }),
        reviewedFiles: [...scope.files],
        timestamp: now(),
        ...(requiredAssertionIds.length === 0 ? {} : { assertionVerdicts: [...assertionVerdicts] }),
      }
      return {
        status: 'SUCCESS',
        review,
        providerHealth: [{ provider: outcome.provider, status: 'AVAILABLE', observedAt: now(), source: 'runtime' }],
      }
    },
  }
}
