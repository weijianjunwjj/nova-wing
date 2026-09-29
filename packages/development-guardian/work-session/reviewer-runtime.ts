/**
 * NovaWing v0.2.4 — Provider-agnostic Reviewer Runtime.
 *
 * Reviewer 是一个 **capability**，不是一个固定身份。TaskController 根据 Task State /
 * Risk / Capability / Identity Independence / Provider Health / Policy 动态选出当前
 * Action 需要的角色；本模块只负责「按被选中的 AgentCapabilityProfile 派发到对应
 * provider 的 Reviewer Runtime」，绝不假设「Codex 执行、DeepSeek 审查」。
 *
 * 边界：
 * - Reviewer Runtime 只读：不写 repository、不 commit、不 push、不改 TaskStateV2；
 * - 它只生产 ReviewEvidence 事实，不拥有 completion authority；
 * - 它对 repository 的任何写入尝试都必须被拒绝，且由调用方用 fingerprint 复核；
 * - runtime 失败（OFFLINE / QUOTA_EXHAUSTED / TIMEOUT / DEGRADED）与 review 判定失败
 *   是两件事，必须分开表达。
 */

import type { TaskActorIdentity } from './task-state-v2.js'
import type { AgentCapabilityProfile } from './v2-controller-task-runner.js'
import type { VerificationResult } from '../model.js'
import type { EvidenceV2 } from './risk-evidence.js'
import type { AssertionReviewVerdict } from './risk-evidence.js'

/** Reviewer 收到的、只读的 Task 上下文。 */
export interface ReviewerTaskContext {
  taskId: string
  goal: string
  constraints: readonly string[]
  acceptanceCriteria: readonly string[]
  implementer?: TaskActorIdentity | undefined
  /** 真实产生实现的 provider 序列（runtime provider history），不是自报身份。 */
  implementerProviders: readonly string[]
  repositoryIdentity?: string | undefined
  branch?: string | undefined
  headSha?: string | undefined
  workspaceFingerprint?: string | undefined
  reviewBaseCommit?: string | undefined
  reviewHeadCommit?: string | undefined
  /** Exact base..head diff, plus current uncommitted files when present. */
  reviewChangedFiles?: readonly string[]
  changedFiles: readonly string[]
  verificationEvidence: readonly VerificationResult[]
  evidence: readonly EvidenceV2[]
  blockers: readonly string[]
  risk: string
}

export type ReviewerProviderFailureStatus = 'OFFLINE' | 'QUOTA_EXHAUSTED' | 'TIMEOUT' | 'DEGRADED'

/** 一次真实 review 的判定结果。 */
export interface ReviewerVerdictOutcome {
  kind: 'VERDICT'
  passed: boolean
  findings: readonly string[]
  blockingFindings: readonly string[]
  summary: string
  provider: string
  assertionVerdicts?: readonly AssertionReviewVerdict[]
}

/** Reviewer runtime 本身失败：这是环境问题，不是对实现的判定。 */
export interface ReviewerRuntimeFailureOutcome {
  kind: 'RUNTIME_FAILURE'
  provider: string
  status: ReviewerProviderFailureStatus
  reason: string
}

export type ReviewerOutcome = ReviewerVerdictOutcome | ReviewerRuntimeFailureOutcome

export interface ReviewerReviewInput {
  task: ReviewerTaskContext
  agent: AgentCapabilityProfile
  timeoutMs?: number
}

/** 统一 Reviewer contract。provider 由被选中的 agent profile 决定。 */
export interface ReviewerRuntime {
  /** Provider this runtime serves; matches AgentCapabilityProfile.identity.provider. */
  readonly provider: string
  review(input: ReviewerReviewInput): Promise<ReviewerOutcome>
}

/** provider → ReviewerRuntime 的注册表。缺失即 fail closed，绝不回落别的 provider。 */
export class ReviewerRuntimeRegistry {
  private readonly runtimes = new Map<string, ReviewerRuntime>()

  constructor(runtimes: readonly ReviewerRuntime[] = []) {
    for (const runtime of runtimes) this.register(runtime)
  }

  register(runtime: ReviewerRuntime): void {
    this.runtimes.set(runtime.provider, runtime)
  }

  has(provider: string): boolean {
    return this.runtimes.has(provider)
  }

  providers(): readonly string[] {
    return [...this.runtimes.keys()]
  }

  /** 没有对应 provider 的 reviewer runtime 时返回 undefined；调用方必须 fail closed。 */
  forProvider(provider: string): ReviewerRuntime | undefined {
    return this.runtimes.get(provider)
  }
}

export function reviewerProviderOf(agent: AgentCapabilityProfile): string {
  return agent.identity?.provider ?? agent.id
}

/**
 * 真实产生实现的 provider 集合：Controller 声明的 implementer 身份 + runtime
 * provider history。provider 级独立性判定必须用它，而不是只看 agentId。
 */
export function implementerProvidersOf(task: {
  implementer?: TaskActorIdentity | undefined
  providerHistory: readonly string[]
}): readonly string[] {
  return [...new Set([
    ...(task.implementer === undefined ? [] : [task.implementer.provider]),
    ...task.providerHistory,
  ])]
}

/** True when the agent may independently review work produced for this task. */
export function isIndependentReviewerCandidate(
  agent: AgentCapabilityProfile,
  task: { implementer?: TaskActorIdentity | undefined; providerHistory: readonly string[] },
): boolean {
  const identity = agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
  if (agent.capabilities.review !== true) return false
  if (task.implementer !== undefined && identity.runtimeIdentity === task.implementer.runtimeIdentity) return false
  return !implementerProvidersOf(task).includes(identity.provider)
}

export interface ReviewerIndependenceDecision {
  independent: boolean
  reasons: readonly string[]
}

/**
 * 真正的独立性判定。只看 provider 名或 agentId 不同都不够：
 * - runtimeIdentity 必须与 implementer 不同；
 * - reviewer provider 不得是真实产生实现的任一 provider（provider-level 独立性）；
 * - capability/health/risk 必须满足。
 */
export function validateReviewerIndependence(input: {
  reviewer: AgentCapabilityProfile
  implementer?: TaskActorIdentity | undefined
  implementerProviders: readonly string[]
  requireIndependentReviewer: boolean
}): ReviewerIndependenceDecision {
  const reasons: string[] = []
  const { reviewer, implementer, implementerProviders } = input
  const identity = reviewer.identity ?? { agent: reviewer.id, provider: reviewer.id, runtimeIdentity: reviewer.id }

  if (reviewer.capabilities.review !== true) {
    reasons.push(`agent ${reviewer.id} is not review-capable`)
  }
  if (!reviewer.available) reasons.push(`agent ${reviewer.id} is unavailable`)
  if (reviewer.quotaExhausted) reasons.push(`agent ${reviewer.id} has exhausted its quota`)
  if (reviewer.degraded) reasons.push(`agent ${reviewer.id} is degraded`)
  if (identity.runtimeIdentity.trim().length === 0) {
    reasons.push(`agent ${reviewer.id} has no runtime identity`)
  }
  if (implementer !== undefined && identity.runtimeIdentity === implementer.runtimeIdentity) {
    reasons.push(`agent ${reviewer.id} shares the implementer runtime identity (self-review)`)
  }
  if (implementerProviders.includes(identity.provider)) {
    reasons.push(`agent ${reviewer.id} uses provider ${identity.provider}, which produced the implementation`)
  }
  if (input.requireIndependentReviewer && implementer === undefined) {
    reasons.push('an independent reviewer was required but no implementer identity was recorded')
  }
  return { independent: reasons.length === 0, reasons }
}
