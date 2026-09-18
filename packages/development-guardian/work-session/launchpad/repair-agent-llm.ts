import type { AcceptanceEvidenceBinding } from '../risk-evidence.js'
import {
  describeRepairRepository,
  TRUSTED_VERIFIER_COMMANDS,
  type RepairRepositoryFacts,
} from './contract-preflight.js'
import {
  normalizedCriterionIdentity,
  type ContractRepairProposal,
  type RepairAgentOutcome,
  type RepairContext,
} from './repair.js'
import type { RepairAgent } from './repair-agent.js'
import {
  createCodexRepairModelRunner,
  isCodexRepairRuntimeAvailable,
  REPAIR_DEFAULT_MODEL,
  REPAIR_DEFAULT_REASONING_EFFORT,
  REPAIR_DEFAULT_TIMEOUT_MS,
  RepairProviderUnavailableError,
  type RepairModelRunner,
} from './repair-model.js'

/**
 * A language-model Repair Agent. It is asked for one thing only: the evidence
 * binding each failing criterion should carry, chosen from a deterministic
 * allowlist plus whatever the repository itself proves. It never returns
 * criteria, goals, paths, risk or permissions — its proposal is re-validated by
 * `validateMechanicalRepair` and re-run through preflight before anything runs.
 */
export interface LlmRepairAgentOptions {
  runner?: RepairModelRunner
  model?: string
  reasoningEffort?: string
  timeoutMs?: number
  describeRepository?: (targetRepo: string) => Promise<RepairRepositoryFacts>
  isRuntimeAvailable?: () => boolean
}

export const REPAIR_SYSTEM_PROMPT = [
  'You are the NovaWing Launchpad Task Contract Repair Agent.',
  'A Task Contract failed preflight. You must propose ONLY the missing or broken evidence bindings.',
  '',
  'Hard rules:',
  '- You may not change, reword, add, or drop any acceptance criterion. Copy criterion text exactly.',
  '- You may not change goals, allowed paths, forbidden paths, constraints, risk, or permissions.',
  '- You may not approve anything, widen an allowlist, or request elevated trust.',
  '- Every verifier command you return MUST appear verbatim in the allowed verifier list.',
  '- If you cannot fix an issue using only allowed verifier commands, return an empty list.',
  '',
  'Answer with ONE JSON object and nothing else:',
  '{"acceptanceEvidenceBindings":[{"criterion":"<exact criterion text>","requiredEvidence":["<allowed verifier command>"]}]}',
  'No prose, no markdown fences, no comments.',
].join('\n')

interface ParsedRepairBinding {
  criterion: string
  requiredEvidence: readonly string[]
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

/**
 * Strict, fail-closed parse. Anything that is not exactly the documented shape
 * is rejected: a half-understood model answer must never reach the contract.
 */
export function parseRepairProposalJson(text: string): { ok: true; bindings: readonly ParsedRepairBinding[] } | { ok: false; reason: string } {
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
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'acceptanceEvidenceBindings')) {
    return { ok: false, reason: 'model response must contain only acceptanceEvidenceBindings' }
  }
  const raw = record.acceptanceEvidenceBindings
  if (!Array.isArray(raw) || raw.length > 100) {
    return { ok: false, reason: 'acceptanceEvidenceBindings must be an array of at most 100 entries' }
  }
  const bindings: ParsedRepairBinding[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'every binding must be an object' }
    }
    const binding = entry as Record<string, unknown>
    if (Object.keys(binding).some((key) => key !== 'criterion' && key !== 'requiredEvidence')) {
      return { ok: false, reason: 'binding contains an unsupported field' }
    }
    if (typeof binding.criterion !== 'string' || binding.criterion.trim().length === 0 || binding.criterion.length > 500) {
      return { ok: false, reason: 'binding criterion must be a non-empty string of at most 500 characters' }
    }
    if (!Array.isArray(binding.requiredEvidence) || binding.requiredEvidence.length === 0 || binding.requiredEvidence.length > 100) {
      return { ok: false, reason: 'binding requiredEvidence must be a non-empty array of at most 100 commands' }
    }
    const commands: string[] = []
    for (const command of binding.requiredEvidence) {
      if (typeof command !== 'string' || command.trim().length === 0 || command.length > 500) {
        return { ok: false, reason: 'every requiredEvidence entry must be a non-empty command string' }
      }
      commands.push(command.trim())
    }
    bindings.push({ criterion: binding.criterion.trim(), requiredEvidence: [...new Set(commands)] })
  }
  return { ok: true, bindings }
}

function renderIssues(context: RepairContext): string {
  return context.issues
    .map((issue, index) => `${index + 1}. [${issue.issueCode}] criterion=${JSON.stringify(issue.criterion ?? null)} reason=${issue.reason}`)
    .join('\n')
}

function renderContract(context: RepairContext): string {
  const criteria = context.contract.acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${JSON.stringify(criterion)}`)
    .join('\n')
  const bindings = context.contract.acceptanceEvidenceBindings.length === 0
    ? '(none)'
    : context.contract.acceptanceEvidenceBindings
      .map((binding) => `- ${JSON.stringify(binding.criterion)} => ${JSON.stringify(binding.requiredEvidence)}`)
      .join('\n')
  return `Acceptance criteria:\n${criteria}\n\nExisting evidence bindings:\n${bindings}`
}

function renderRepository(facts: RepairRepositoryFacts, allowed: readonly string[]): string {
  const scripts = Object.entries(facts.packageScripts)
    .map(([name, command]) => `  ${name}: ${command}`)
    .join('\n')
  return [
    `Allowed verifier commands (ONLY these may be used):\n${allowed.map((command) => `- ${command}`).join('\n')}`,
    `package.json scripts:\n${scripts.length === 0 ? '  (none)' : scripts}`,
    `Repository test entry resolved by NovaWing: ${facts.resolvedTestEntry ?? '(none)'}`,
    `Test file candidates:\n${facts.testFileCandidates.length === 0 ? '  (none)' : facts.testFileCandidates.map((path) => `  ${path}`).join('\n')}`,
    `Top-level entries: ${facts.topLevelEntries.join(', ') || '(none)'}`,
    `pytest config present: ${String(facts.hasPytestConfig)}`,
    `Host .venv python present: ${String(facts.hasVenvPython)}`,
  ].join('\n\n')
}

export function createLlmRepairAgent(options: LlmRepairAgentOptions = {}): RepairAgent {
  const model = options.model ?? REPAIR_DEFAULT_MODEL
  const reasoningEffort = options.reasoningEffort ?? REPAIR_DEFAULT_REASONING_EFFORT
  const timeoutMs = options.timeoutMs ?? REPAIR_DEFAULT_TIMEOUT_MS
  const describeRepository = options.describeRepository ?? describeRepairRepository
  const isRuntimeAvailable = options.isRuntimeAvailable ?? isCodexRepairRuntimeAvailable
  const runner = options.runner ?? createCodexRepairModelRunner()

  return {
    id: 'llm-repair-agent',
    async repair(context) {
      if (context.issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION')) {
        return { classification: 'REPAIR_REJECTED', reason: '未能安全识别验证命令，需要确认；a model cannot supply missing command authority.' }
      }
      if (options.runner === undefined && !isRuntimeAvailable()) {
        return {
          classification: 'PROVIDER_UNAVAILABLE',
          reason: 'the local Codex repair runtime is not available on this host',
        }
      }

      const repository = await describeRepository(context.targetRepo)
      const testEntry = repository.resolvedTestEntry
      const allowed = [...TRUSTED_VERIFIER_COMMANDS, ...(testEntry === undefined ? [] : [testEntry])]

      let text: string
      try {
        ({ text } = await runner({
          system: REPAIR_SYSTEM_PROMPT,
          user: [
            `Error classification: ${context.errorCode}`,
            `Target repository: ${context.targetRepo}${context.branch === undefined ? '' : ` (branch ${context.branch})`}`,
            `Preflight issues:\n${renderIssues(context)}`,
            renderContract(context),
            renderRepository(repository, allowed),
            'Return the evidence bindings that fix the issues above, or an empty list if you cannot.',
          ].join('\n\n'),
          targetRepo: context.targetRepo,
          model,
          reasoningEffort,
          timeoutMs,
        }))
      } catch (error) {
        if (error instanceof RepairProviderUnavailableError) {
          return { classification: 'PROVIDER_UNAVAILABLE', reason: error.safeReason }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { classification: 'PROVIDER_UNAVAILABLE', reason: reason.slice(0, 300) }
      }

      const parsed = parseRepairProposalJson(text)
      if (!parsed.ok) {
        return {
          classification: 'REPAIR_REJECTED',
          reason: `LLM repair output failed structured parsing: ${parsed.reason}`,
        }
      }

      const criterionByCriterion = new Map<string, string>(
        context.contract.acceptanceCriteria.map((criterion) => [normalizedCriterionIdentity(criterion), criterion]),
      )
      const originalByIdentity = new Map<string, AcceptanceEvidenceBinding>(
        context.contract.acceptanceEvidenceBindings.map((binding) => [normalizedCriterionIdentity(binding.criterion), binding]),
      )
      const proposedByIdentity = new Map<string, ParsedRepairBinding>()
      const repairs: string[] = []
      for (const binding of parsed.bindings) {
        const identity = normalizedCriterionIdentity(binding.criterion)
        const criterion = criterionByCriterion.get(identity)
        if (criterion === undefined) {
          return {
            classification: 'REPAIR_REJECTED',
            reason: `LLM repair referenced an unknown criterion: ${binding.criterion}`,
          }
        }
        for (const command of binding.requiredEvidence) {
          if (!allowed.includes(command)) {
            return {
              classification: 'REPAIR_REJECTED',
              reason: `LLM repair proposed a verifier outside the deterministic allowlist: ${command}`,
            }
          }
        }
        proposedByIdentity.set(identity, { criterion, requiredEvidence: binding.requiredEvidence })
        repairs.push(`LLM bound evidence for "${criterion}" to ${binding.requiredEvidence.join(', ')}`)
      }

      if (proposedByIdentity.size === 0) {
        return {
          classification: 'REPAIR_REJECTED',
          reason: 'LLM repair returned no usable evidence binding',
        }
      }

      // Criteria the model stayed silent about keep their original binding; the
      // mechanical validator then decides whether the merged contract is legal.
      const acceptanceEvidenceBindings = context.contract.acceptanceCriteria.map((criterion) => {
        const identity = normalizedCriterionIdentity(criterion)
        const proposed = proposedByIdentity.get(identity)
        if (proposed !== undefined) {
          const original = originalByIdentity.get(identity)
          return {
            criterion,
            requiredEvidence: [...proposed.requiredEvidence],
            ...(original?.requiresApproval === true ? { requiresApproval: true } : {}),
          }
        }
        const original = originalByIdentity.get(identity)
        return original === undefined
          ? { criterion, requiredEvidence: [] }
          : { criterion: original.criterion, requiredEvidence: [...original.requiredEvidence], ...(original.requiresApproval === undefined ? {} : { requiresApproval: original.requiresApproval }) }
      })

      const proposal: ContractRepairProposal = {
        acceptanceCriteria: [...context.contract.acceptanceCriteria],
        acceptanceEvidenceBindings,
        repairs,
      }
      return { classification: 'REPAIRED', proposal }
    },
  }
}

export type { RepairAgentOutcome }
