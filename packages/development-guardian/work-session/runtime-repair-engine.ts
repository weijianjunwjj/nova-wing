/**
 * NovaWing v0.2.4 — Runtime Repair cascade engine.
 *
 * 级联顺序：deterministic RepairAgent 先跑；只有在仍未完整解决、且剩下的 issue 落在
 * LLM_RUNTIME_REPAIRABLE_REASON_CODES 时才调用 LLM RepairAgent。任何 agent 的
 * proposal 都必须通过 deterministic validator；LLM 只能返回 RuntimeRepairProposal，
 * 不能直接执行 permission / risk / approval / review bypass / push / merge。
 */

import type {
  RuntimeRepairContext,
  RuntimeRepairOutcome,
  RuntimeRepairProposal,
  RuntimeRepairReasonCode,
} from './runtime-repair.js'
import {
  discoverIndependentReviewer,
  hasLlmRuntimeRepairableReason,
  validateRuntimeRepairProposal,
} from './runtime-repair.js'
import type { RepairModelRunner } from './launchpad/repair-model.js'
import {
  createCodexRepairModelRunner,
  REPAIR_DEFAULT_MODEL,
  REPAIR_DEFAULT_REASONING_EFFORT,
  REPAIR_DEFAULT_TIMEOUT_MS,
  RepairProviderUnavailableError,
} from './launchpad/repair-model.js'

/** A Runtime Repair Agent either proposes a mechanical repair or refuses. */
export interface RuntimeRepairAgent {
  readonly id: string
  repair(context: RuntimeRepairContext): Promise<RuntimeRepairOutcome>
}

function requiresHuman(
  reasonCode: RuntimeRepairReasonCode,
  reason: string,
): RuntimeRepairOutcome {
  return { classification: 'RUNTIME_REPAIR_REQUIRES_HUMAN', reasonCode, reason, executorReran: false }
}

function repaired(
  context: RuntimeRepairContext,
  proposal: RuntimeRepairProposal,
): RuntimeRepairOutcome {
  return { classification: 'REPAIRED', reasonCode: context.reasonCode, proposal, executorReran: false }
}

export interface DeterministicRuntimeRepairAgentOptions {
  refreshProviderHealth?: (context: RuntimeRepairContext) => Promise<RuntimeRepairContext>
}

/**
 * deterministic reference Runtime Repair Agent。它刷新 provider health / runtime
 * availability，然后对 NO_AVAILABLE_AGENT_FOR_REVIEW 查询独立 Reviewer。任何它无法
 * 安全判定的情况都返回 REQUIRES_HUMAN，绝不猜测。
 */
export function createDeterministicRuntimeRepairAgent(
  options: DeterministicRuntimeRepairAgentOptions = {},
): RuntimeRepairAgent {
  const refresh = options.refreshProviderHealth ?? defaultRefreshProviderHealth
  return {
    id: 'deterministic-runtime-repair-agent',
    async repair(context) {
      const refreshed = await refresh(context)
      // A pending REVIEW needs an independent reviewer whether the reviewer was never
      // found or the reviewer runtime itself failed (OFFLINE / QUOTA / TIMEOUT).
      const needsReviewer =
        refreshed.reasonCode === 'NO_AVAILABLE_AGENT_FOR_REVIEW' || refreshed.currentAction === 'REVIEW'
      if (needsReviewer) {
        const discovery = discoverIndependentReviewer(refreshed)
        if (discovery.reviewer === undefined) {
          return requiresHuman(
            context.reasonCode,
            `no independent reviewer available: ${discovery.exclusions.join('; ')}`,
          )
        }
        const reviewer = discovery.reviewer
        const identity = reviewer.identity ?? { agent: reviewer.id, provider: reviewer.id, runtimeIdentity: reviewer.id }
        return repaired(context, {
          reasonCode: context.reasonCode,
          mechanism: 'SELECT_INDEPENDENT_REVIEWER',
          chosenReviewer: { ...identity },
          refreshedProviderHealth: [...refreshed.providerHealth],
          repairs: [`Selected independent reviewer ${reviewer.id} (${identity.provider}) after refreshing provider health`],
        })
      }
      // 其它 runtime issue：确定性修复 = 刷新 provider health，判断是否有 provider 恢复。
      const restored = refreshed.providerHealth.filter((observation) => observation.status === 'AVAILABLE')
      if (restored.length > 0) {
        return repaired(context, {
          reasonCode: context.reasonCode,
          mechanism: 'RESTORE_PROVIDER_AVAILABILITY',
          refreshedProviderHealth: [...refreshed.providerHealth],
          repairs: restored.map((observation) => `${observation.provider} restored to AVAILABLE`),
        })
      }
      return requiresHuman(context.reasonCode, `runtime issue could not be resolved deterministically: ${context.humanRequired.reason}`)
    },
  }
}

async function defaultRefreshProviderHealth(context: RuntimeRepairContext): Promise<RuntimeRepairContext> {
  if (context.refreshProviderHealth === undefined) return context
  const refresh = await context.refreshProviderHealth()
  return { ...context, agents: refresh.agents, providerHealth: refresh.providerHealth }
}

const RUNTIME_REPAIR_SYSTEM_PROMPT = [
  'You are the NovaWing Runtime Repair Agent.',
  'A running NovaWing Session reached Human Required on a runtime issue.',
  'You may propose ONLY a mechanical runtime repair from the documented mechanism set.',
  '',
  'Hard rules:',
  '- You may not change goal, allowed paths, forbidden paths, constraints, risk, or permissions.',
  '- You may not approve anything, bypass review, skip review, or request elevated trust.',
  '- You may not push, merge, or touch the repository.',
  '- For a review-availability issue you may only name an independent reviewer from the supplied agent list.',
  '',
  'Answer with ONE JSON object and nothing else:',
  '{"mechanism":"SELECT_INDEPENDENT_REVIEWER","chosenReviewerId":"<agent id>","repairs":["<description>"]}',
  'No prose, no markdown fences, no comments.',
].join('\n')

interface ParsedLlmRuntimeRepairDraft {
  mechanism: RuntimeRepairProposal['mechanism']
  chosenReviewerId?: string
  repairs: readonly string[]
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

/** Strict, fail-closed parse of the LLM's structured draft. */
export function parseLlmRuntimeRepairDraft(text: string): { ok: true; draft: ParsedLlmRuntimeRepairDraft } | { ok: false; reason: string } {
  if (text.trim().length === 0) return { ok: false, reason: 'model returned an empty response' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(text)) as unknown
  } catch {
    return { ok: false, reason: 'model response is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'model response is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const allowedKeys = new Set(['mechanism', 'chosenReviewerId', 'repairs'])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return { ok: false, reason: 'model response contains an unsupported field' }
  }
  if (record.mechanism !== 'REFRESH_PROVIDER_HEALTH' && record.mechanism !== 'SELECT_INDEPENDENT_REVIEWER' && record.mechanism !== 'RESTORE_PROVIDER_AVAILABILITY') {
    return { ok: false, reason: 'model response names an unknown mechanism' }
  }
  if (record.chosenReviewerId !== undefined && typeof record.chosenReviewerId !== 'string') {
    return { ok: false, reason: 'chosenReviewerId must be a string' }
  }
  if (!Array.isArray(record.repairs) || record.repairs.length === 0 || record.repairs.length > 20 ||
      record.repairs.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 500)) {
    return { ok: false, reason: 'repairs must be a non-empty array of short strings' }
  }
  return {
    ok: true,
    draft: {
      mechanism: record.mechanism,
      ...(record.chosenReviewerId === undefined ? {} : { chosenReviewerId: record.chosenReviewerId }),
      repairs: record.repairs.map((entry) => entry as string),
    },
  }
}

export interface LlmRuntimeRepairAgentOptions {
  runner?: RepairModelRunner
  model?: string
  reasoningEffort?: string
  timeoutMs?: number
}

/**
 * language-model Runtime Repair Agent。只返回结构化 RuntimeRepairProposal（经
 * deterministic validator 校验）；provider 复用既有 Codex repair runner。
 */
export function createLlmRuntimeRepairAgent(options: LlmRuntimeRepairAgentOptions = {}): RuntimeRepairAgent {
  const model = options.model ?? REPAIR_DEFAULT_MODEL
  const reasoningEffort = options.reasoningEffort ?? REPAIR_DEFAULT_REASONING_EFFORT
  const timeoutMs = options.timeoutMs ?? REPAIR_DEFAULT_TIMEOUT_MS
  const runner = options.runner ?? createCodexRepairModelRunner()
  return {
    id: 'llm-runtime-repair-agent',
    async repair(context) {
      let text: string
      try {
        ({ text } = await runner({
          system: RUNTIME_REPAIR_SYSTEM_PROMPT,
          user: [
            `Diagnosed reasonCode: ${context.reasonCode}`,
            `Human Required: ${JSON.stringify(context.humanRequired)}`,
            `Implementer runtime identity: ${context.implementer?.runtimeIdentity ?? '(none)'}`,
            `Available agents:\n${context.agents.map((agent) => {
              const identity = agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
              return `- id=${agent.id} provider=${identity.provider} runtimeIdentity=${identity.runtimeIdentity} review=${String(agent.capabilities.review === true)} available=${String(agent.available)} quotaExhausted=${String(agent.quotaExhausted)}`
            }).join('\n')}`,
            'Return the mechanical runtime repair, or refuse with an empty repairs list if you cannot.',
          ].join('\n\n'),
          targetRepo: context.task.gitState.repositoryIdentity ?? '',
          model,
          reasoningEffort,
          timeoutMs,
        }))
      } catch (error) {
        if (error instanceof RepairProviderUnavailableError) {
          return { classification: 'PROVIDER_UNAVAILABLE', reasonCode: context.reasonCode, reason: error.safeReason, executorReran: false }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { classification: 'PROVIDER_UNAVAILABLE', reasonCode: context.reasonCode, reason: reason.slice(0, 300), executorReran: false }
      }

      const parsed = parseLlmRuntimeRepairDraft(text)
      if (!parsed.ok) {
        return requiresHuman(context.reasonCode, `LLM runtime repair output failed structured parsing: ${parsed.reason}`)
      }
      const draft = parsed.draft
      if (draft.mechanism === 'SELECT_INDEPENDENT_REVIEWER') {
        if (draft.chosenReviewerId === undefined) {
          return requiresHuman(context.reasonCode, 'LLM runtime repair selected a reviewer mechanism without a reviewer')
        }
        const chosen = context.agents.find((agent) => agent.id === draft.chosenReviewerId)
        if (chosen === undefined) {
          return requiresHuman(context.reasonCode, `LLM runtime repair named an unknown reviewer: ${draft.chosenReviewerId}`)
        }
        const identity = chosen.identity ?? { agent: chosen.id, provider: chosen.id, runtimeIdentity: chosen.id }
        return repaired(context, {
          reasonCode: context.reasonCode,
          mechanism: 'SELECT_INDEPENDENT_REVIEWER',
          chosenReviewer: { ...identity },
          refreshedProviderHealth: [...context.providerHealth],
          repairs: [...draft.repairs],
        })
      }
      return repaired(context, {
        reasonCode: context.reasonCode,
        mechanism: draft.mechanism,
        refreshedProviderHealth: [...context.providerHealth],
        repairs: [...draft.repairs],
      })
    },
  }
}

export interface RuntimeRepairEngineOptions {
  deterministic?: RuntimeRepairAgent
  llm?: RuntimeRepairAgent
  validator?: (context: RuntimeRepairContext, proposal: RuntimeRepairProposal) => { ok: true } | { ok: false; reasons: readonly string[] }
}

/**
 * deterministic-first 级联 engine。任何 agent 的 proposal 都必须通过 validator。
 */
export function createRuntimeRepairEngine(options: RuntimeRepairEngineOptions = {}): RuntimeRepairAgent {
  const deterministic = options.deterministic ?? createDeterministicRuntimeRepairAgent()
  const llm = options.llm ?? createLlmRuntimeRepairAgent()
  const validator = options.validator ?? validateRuntimeRepairProposal
  return {
    id: 'runtime-repair-engine',
    async repair(context) {
      const deterministicOutcome = await deterministic.repair(context)
      if (deterministicOutcome.classification === 'REPAIRED') {
        const proposal = deterministicOutcome.proposal!
        const validation = validator(context, proposal)
        if (!validation.ok) {
          return requiresHuman(context.reasonCode, `deterministic runtime repair failed validation: ${validation.reasons.join('; ')}`)
        }
        return deterministicOutcome
      }
      if (deterministicOutcome.classification === 'NOVAWING_PRODUCT_BUG') return deterministicOutcome
      // Independent-reviewer availability is fully determined by capability, runtime
      // identity, provider health and policy facts. A refusal there is final and is
      // never escalated to a model.
      const reviewerAvailabilityDetermined =
        context.reasonCode === 'NO_AVAILABLE_AGENT_FOR_REVIEW' || context.currentAction === 'REVIEW'
      if (reviewerAvailabilityDetermined || !hasLlmRuntimeRepairableReason(context)) return deterministicOutcome

      const llmOutcome = await llm.repair(context)
      if (llmOutcome.classification === 'REPAIRED') {
        const proposal = llmOutcome.proposal!
        const validation = validator(context, proposal)
        if (!validation.ok) {
          return requiresHuman(context.reasonCode, `LLM runtime repair failed validation: ${validation.reasons.join('; ')}`)
        }
        return llmOutcome
      }
      return llmOutcome
    },
  }
}
