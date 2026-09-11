/**
 * NovaWing v0.2.4 — Runtime AI Repair & Resume domain vocabulary.
 *
 * 与 Launchpad 的 Contract Repair 同构但针对「运行中 Session 的 Human Required」：
 * - deterministic-first 级联，只有机械诊断无法判定、且 issue 落在允许自动修复的
 *   runtime 集合时才调用 LLM Repair；
 * - LLM 只能返回 RuntimeRepairProposal（结构化），且必须通过 deterministic validator；
 * - Proposal 在类型上就不可表达 goal / allowed·forbidden paths / risk / approval /
 *   review bypass / push / merge 等语义，因此不可修改。
 *
 * 本模块只含可 JSON 序列化的纯值模型与纯函数，不引入新的持久化通道。
 */

import type { TaskStateV2, TaskActorIdentity } from './task-state-v2.js'
import type { TaskAction } from './task-controller.js'
import type { AgentCapabilityProfile } from './v2-controller-task-runner.js'
import type { ProviderHealthObservation, TaskEventV2 } from './task-observability.js'
import type { EvidenceV2 } from './risk-evidence.js'

/** 可自动修复的 runtime issue 的稳定产品分类。 */
export type RuntimeRepairReasonCode =
  | 'NO_AVAILABLE_AGENT_FOR_REVIEW'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_OFFLINE'
  | 'STALE_PROVIDER_HEALTH'
  | 'LOCAL_RUNTIME_UNAVAILABLE'
  | 'DETERMINISTIC_VERIFIER_RUNTIME_UNAVAILABLE'

/** REVIEW 的独立性与排除约束；Runtime Repair 不得放宽它。 */
export interface RuntimeRepairReviewerConstraints {
  requireIndependentReviewer: boolean
  excludeRuntimeIdentities: readonly string[]
  /** 真实产生实现的 provider；reviewer 不得来自其中之一。 */
  excludeProviders: readonly string[]
}

/** 一次 provider health / runtime availability 刷新产生的新事实。 */
export interface RuntimeRepairRefresh {
  providerHealth: readonly ProviderHealthObservation[]
  agents: readonly AgentCapabilityProfile[]
}

/**
 * 运行中 Human Required 的最小修复上下文。collect 阶段至少应填满以下字段；
 * 缺字段宁可 fail closed（REQUIRES_HUMAN）也不猜测。
 */
export interface RuntimeRepairContext {
  sessionId: string
  taskId: string
  task: TaskStateV2
  currentAction?: TaskAction | undefined
  reasonCode: RuntimeRepairReasonCode
  humanRequired: { category: string; reason: string }
  implementer?: TaskActorIdentity | undefined
  requiredReviewerConstraints: RuntimeRepairReviewerConstraints
  agents: readonly AgentCapabilityProfile[]
  providerHealth: readonly ProviderHealthObservation[]
  repoHead?: string | undefined
  workspaceFingerprint?: string | undefined
  evidence: readonly EvidenceV2[]
  blockers: readonly string[]
  recentEvents: readonly TaskEventV2[]
  /** 确定性刷新 provider / runtime availability 的 seam；测试注入脚本化实现。 */
  refreshProviderHealth?: (() => Promise<RuntimeRepairRefresh>) | undefined
}

export type RuntimeRepairMechanism =
  | 'REFRESH_PROVIDER_HEALTH'
  | 'SELECT_INDEPENDENT_REVIEWER'
  | 'RESTORE_PROVIDER_AVAILABILITY'

/**
 * LLM 唯一可返回的结构化 Proposal。它只能表达「刷新 provider health」与
 * 「选择独立 Reviewer」两类机械修复；无法表达风险/审批/目标/路径/权限。
 */
export interface RuntimeRepairProposal {
  reasonCode: RuntimeRepairReasonCode
  mechanism: RuntimeRepairMechanism
  chosenReviewer?: TaskActorIdentity | undefined
  refreshedProviderHealth: readonly ProviderHealthObservation[]
  repairs: readonly string[]
}

export type RuntimeRepairClassification =
  | 'REPAIRED'
  | 'RUNTIME_REPAIR_REQUIRES_HUMAN'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOVAWING_PRODUCT_BUG'

export interface RuntimeRepairOutcome {
  classification: RuntimeRepairClassification
  reasonCode: RuntimeRepairReasonCode
  reason?: string
  proposal?: RuntimeRepairProposal
  /** Runtime Repair 绝不重跑 Executor；合法修复恒为 false。 */
  executorReran: boolean
}

/** 稳定的 audit 事件名。 */
export const RUNTIME_REPAIR_AUDIT_EVENTS = [
  'RUNTIME_REPAIR_STARTED',
  'RUNTIME_REPAIR_DIAGNOSED',
  'RUNTIME_REPAIR_PROPOSED',
  'RUNTIME_REPAIR_VALIDATED',
  'RUNTIME_REPAIR_APPLIED',
  'RUNTIME_REPAIR_FAILED',
  'SESSION_RESUMED_AFTER_REPAIR',
] as const

export type RuntimeRepairAuditEventName = (typeof RUNTIME_REPAIR_AUDIT_EVENTS)[number]

/** 从 Human Required reason 推导稳定的 runtime repair reason code。 */
export function deriveRuntimeRepairReasonCode(
  humanRequired: { category: string; reason: string },
): RuntimeRepairReasonCode | undefined {
  const reason = humanRequired.reason
  if (/no available agent for REVIEW/iu.test(reason)) return 'NO_AVAILABLE_AGENT_FOR_REVIEW'
  if (/no available agent for VERIFY/iu.test(reason)) return 'DETERMINISTIC_VERIFIER_RUNTIME_UNAVAILABLE'
  if (/PROVIDER_UNAVAILABLE/iu.test(reason)) return 'PROVIDER_UNAVAILABLE'
  if (/PROVIDER_OFFLINE/iu.test(reason)) return 'PROVIDER_OFFLINE'
  if (/STALE_PROVIDER_HEALTH/iu.test(reason)) return 'STALE_PROVIDER_HEALTH'
  if (/LOCAL_RUNTIME_UNAVAILABLE/iu.test(reason)) return 'LOCAL_RUNTIME_UNAVAILABLE'
  return undefined
}

/** 只有 ENVIRONMENT_REQUIRED 且能推导出已知 runtime reason code 才可能自动修复。 */
export function isRuntimeRepairable(humanRequired: { category: string; reason: string }): boolean {
  return humanRequired.category === 'ENVIRONMENT_REQUIRED' &&
    deriveRuntimeRepairReasonCode(humanRequired) !== undefined
}

function identityOf(agent: AgentCapabilityProfile): TaskActorIdentity {
  return agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
}

export interface ReviewerDiscovery {
  reviewer?: AgentCapabilityProfile
  exclusions: readonly string[]
}

/**
 * 查询所有 reviewer-capable Agent，并按顺序排除：与 implementer 相同 runtime
 * identity、不满足独立 review policy、OFFLINE、QUOTA_EXHAUSTED、capability 不足。
 */
export function discoverIndependentReviewer(context: RuntimeRepairContext): ReviewerDiscovery {
  const implementerRuntimeIdentity = context.implementer?.runtimeIdentity
  const excludedProviders = context.requiredReviewerConstraints.excludeProviders
  const exclusions: string[] = []
  for (const agent of context.agents) {
    const identity = identityOf(agent)
    const usable = agent.available && !agent.quotaExhausted && !agent.degraded &&
      agent.capabilities.review === true
    if (!usable) {
      exclusions.push(`${agent.id}: unavailable, quota-exhausted, degraded, or not review-capable`)
      continue
    }
    if (implementerRuntimeIdentity !== undefined && identity.runtimeIdentity === implementerRuntimeIdentity) {
      exclusions.push(`${agent.id}: shares the implementer runtime identity (self-review)`)
      continue
    }
    if (context.requiredReviewerConstraints.excludeRuntimeIdentities.includes(identity.runtimeIdentity)) {
      exclusions.push(`${agent.id}: excluded by the independent review policy`)
      continue
    }
    if (excludedProviders.includes(identity.provider)) {
      exclusions.push(`${agent.id}: uses provider ${identity.provider}, which produced the implementation`)
      continue
    }
    return { reviewer: agent, exclusions }
  }
  return { exclusions }
}

/**
 * deterministic validator：任何 agent（含 LLM）返回的 Proposal 都必须通过。
 * 它是「LLM 不能执行 permission / risk / approval / review bypass / push / merge」
 * 的唯一实现点——Proposal 在类型上就不可表达这些字段，此处再对其可表达面收紧。
 */
export function validateRuntimeRepairProposal(
  context: RuntimeRepairContext,
  proposal: RuntimeRepairProposal,
): { ok: true } | { ok: false; reasons: readonly string[] } {
  const reasons: string[] = []
  if (proposal.reasonCode !== context.reasonCode) {
    reasons.push(`proposal reasonCode ${proposal.reasonCode} does not match the diagnosed issue ${context.reasonCode}`)
  }
  if (
    proposal.mechanism !== 'REFRESH_PROVIDER_HEALTH' &&
    proposal.mechanism !== 'SELECT_INDEPENDENT_REVIEWER' &&
    proposal.mechanism !== 'RESTORE_PROVIDER_AVAILABILITY'
  ) {
    reasons.push(`unknown repair mechanism: ${proposal.mechanism}`)
  }
  // A reviewer may be selected only when the pending action is an independent REVIEW.
  const reviewerSelectionAllowed =
    proposal.reasonCode === 'NO_AVAILABLE_AGENT_FOR_REVIEW' || context.currentAction === 'REVIEW'
  if (reviewerSelectionAllowed) {
    const chosen = proposal.chosenReviewer
    if (chosen === undefined && proposal.reasonCode === 'NO_AVAILABLE_AGENT_FOR_REVIEW') {
      reasons.push('NO_AVAILABLE_AGENT_FOR_REVIEW requires a chosen independent reviewer')
    }
    if (chosen !== undefined) {
      const match = context.agents.find((agent) => {
        const identity = identityOf(agent)
        return identity.runtimeIdentity === chosen.runtimeIdentity && identity.provider === chosen.provider &&
          agent.capabilities.review === true
      })
      if (match === undefined) {
        reasons.push('chosen reviewer is not a review-capable agent in the current agent set')
      }
      if (context.implementer !== undefined && chosen.runtimeIdentity === context.implementer.runtimeIdentity) {
        reasons.push('chosen reviewer shares the implementer runtime identity (self-review)')
      }
      if (context.requiredReviewerConstraints.excludeProviders.includes(chosen.provider)) {
        reasons.push(`chosen reviewer uses provider ${chosen.provider}, which produced the implementation`)
      }
      if (context.requiredReviewerConstraints.excludeRuntimeIdentities.includes(chosen.runtimeIdentity)) {
        reasons.push('chosen reviewer violates the independent review policy')
      }
    }
  } else if (proposal.chosenReviewer !== undefined) {
    reasons.push('a reviewer may only be selected for a review-availability issue')
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/**
 * 允许送去 LLM Repair 的 runtime issue 集合。NO_AVAILABLE_AGENT_FOR_REVIEW 与
 * DETERMINISTIC_VERIFIER_RUNTIME_UNAVAILABLE 由 deterministic agent 完整判定，不回落 LLM。
 */
export const LLM_RUNTIME_REPAIRABLE_REASON_CODES: ReadonlySet<RuntimeRepairReasonCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_OFFLINE',
  'STALE_PROVIDER_HEALTH',
  'LOCAL_RUNTIME_UNAVAILABLE',
])

export function hasLlmRuntimeRepairableReason(context: RuntimeRepairContext): boolean {
  return LLM_RUNTIME_REPAIRABLE_REASON_CODES.has(context.reasonCode)
}
