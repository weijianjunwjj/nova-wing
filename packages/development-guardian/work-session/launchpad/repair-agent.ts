import { randomBytes } from 'node:crypto'

import {
  resolveRepairTestEntry,
  TRUSTED_VERIFIER_COMMANDS,
} from './contract-preflight.js'
import {
  normalizedCriterionIdentity,
  validateMechanicalRepair,
  type ContractRepairProposal,
  type RepairAgentOutcome,
  type RepairContext,
  type StructuredRepairTask,
} from './repair.js'

/**
 * A Repair Agent receives a classified preflight failure and either proposes a
 * mechanical-only contract repair or refuses. It is the AI seam: production can
 * inject an LLM-backed agent, while the deterministic reference agent below
 * covers the MVP and the certification suite.
 */
export interface RepairAgent {
  readonly id: string
  repair(context: RepairContext): Promise<RepairAgentOutcome>
}

export interface DeterministicRepairAgentOptions {
  resolveTestEntry?: (targetRepo: string) => Promise<string | undefined>
}

/** Conservative "does this criterion plausibly claim tests pass" heuristic. */
function isTestShaped(criterion: string): boolean {
  return /(?:test|测试|验证|验收|verify|pass|run|check)/iu.test(criterion)
}

function productBugOutcome(context: RepairContext, evidence: readonly string[]): RepairAgentOutcome {
  const structuredRepairTask: StructuredRepairTask = {
    taskId: `NW-REPAIR-${randomBytes(3).toString('hex').toUpperCase()}`,
    productComponent: 'NovaWing Launchpad Task Contract Preflight',
    title: 'Preflight emitted an unexpected issue code',
    evidence: [`targetRepo: ${context.targetRepo}`, ...evidence],
  }
  return {
    classification: 'NOVAWING_PRODUCT_BUG',
    reason: 'preflight failed with an issue the Repair Agent cannot attribute to the Task contract; no NovaWing source was modified',
    structuredRepairTask,
  }
}

/**
 * Deterministic reference Repair Agent. It only ever proposes allowlisted
 * verifiers and preserves every valid original verifier; anything it cannot fix
 * safely becomes a refusal, never a guess.
 */
export function createDeterministicRepairAgent(
  options: DeterministicRepairAgentOptions = {},
): RepairAgent {
  const resolveTestEntry = options.resolveTestEntry ?? resolveRepairTestEntry
  return {
    id: 'deterministic-repair-agent',
    async repair(context) {
      const unknownEvidence = context.issues
        .filter((issue) => !KNOWN_MECHANICAL_CODES.has(issue.issueCode))
        .map((issue) => `${issue.issueCode}: ${issue.reason}`)
      if (unknownEvidence.length > 0) return productBugOutcome(context, unknownEvidence)

      // Granting human approval would widen trust; a Repair Agent must refuse.
      if (context.issues.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED')) {
        return {
          classification: 'REPAIR_REJECTED',
          reason: 'verifier approval cannot be granted by a Repair Agent; the original contract is preserved',
        }
      }

      const testEntry = await resolveTestEntry(context.targetRepo)
      const allowed = [...TRUSTED_VERIFIER_COMMANDS, ...(testEntry === undefined ? [] : [testEntry])]

      const acceptanceCriteria = [...context.contract.acceptanceCriteria]
      const bindings = context.contract.acceptanceEvidenceBindings.map((binding) => ({
        criterion: binding.criterion,
        requiredEvidence: [...binding.requiredEvidence],
        ...(binding.requiresApproval === undefined ? {} : { requiresApproval: binding.requiresApproval }),
      }))
      const byIdentity = new Map(bindings.map((binding) => [normalizedCriterionIdentity(binding.criterion), binding]))
      const repairs: string[] = []

      for (const issue of context.issues) {
        const criterion = issue.criterion
        if (criterion === undefined) {
          return {
            classification: 'REPAIR_REJECTED',
            reason: `issue ${issue.issueCode} cannot be attributed to a criterion`,
          }
        }

        if (issue.issueCode === 'MISSING_EVIDENCE_BINDING') {
          if (testEntry === undefined || !isTestShaped(criterion)) {
            return {
              classification: 'REPAIR_REJECTED',
              reason: `cannot bind criterion without one authoritative test entry and a test-shaped criterion: ${criterion}`,
            }
          }
          bindings.push({ criterion, requiredEvidence: [testEntry] })
          repairs.push(`Bound missing evidence for "${criterion}" to ${testEntry}`)
          continue
        }

        if (VERIFIER_ISSUE_CODES.has(issue.issueCode)) {
          const key = normalizedCriterionIdentity(criterion)
          const current = byIdentity.get(key)
          if (current === undefined) {
            return {
              classification: 'REPAIR_REJECTED',
              reason: `verifier issue has no matching binding to repair: ${criterion}`,
            }
          }
          const keep = current.requiredEvidence.filter((command) => allowed.includes(command))
          const broken = current.requiredEvidence.filter((command) => !allowed.includes(command))
          if (broken.length === 0 || testEntry === undefined) {
            return {
              classification: 'REPAIR_REJECTED',
              reason: `cannot resolve a broken verifier for "${criterion}" without an authoritative test entry`,
            }
          }
          current.requiredEvidence = [...new Set([...keep, testEntry])]
          repairs.push(`Replaced broken verifier for "${criterion}" with ${testEntry}`)
          continue
        }

        // BINDING_IDENTITY_MISMATCH / BINDING_DSL_AMBIGUOUS / DUPLICATE_* are not safely auto-repairable.
        return {
          classification: 'REPAIR_REJECTED',
          reason: `issue ${issue.issueCode} is not safely auto-repairable`,
        }
      }

      const proposal: ContractRepairProposal = { acceptanceCriteria, acceptanceEvidenceBindings: bindings, repairs }
      const validation = validateMechanicalRepair(context.contract, proposal, allowed)
      if (!validation.ok) {
        return { classification: 'REPAIR_REJECTED', reason: validation.reasons.join('; ') }
      }
      return { classification: 'REPAIRED', proposal }
    },
  }
}

const KNOWN_MECHANICAL_CODES: ReadonlySet<string> = new Set([
  'MISSING_EVIDENCE_BINDING',
  'EMPTY_VERIFIER_COMMAND',
  'UNRESOLVED_PLACEHOLDER',
  'PACKAGE_SCRIPT_NOT_FOUND',
  'TEST_PATH_NOT_FOUND',
  'VERIFIER_APPROVAL_REQUIRED',
  'BINDING_IDENTITY_MISMATCH',
  'BINDING_DSL_AMBIGUOUS',
  'DUPLICATE_CRITERION',
  'DUPLICATE_BINDING',
])

const VERIFIER_ISSUE_CODES: ReadonlySet<string> = new Set([
  'EMPTY_VERIFIER_COMMAND',
  'UNRESOLVED_PLACEHOLDER',
  'PACKAGE_SCRIPT_NOT_FOUND',
  'TEST_PATH_NOT_FOUND',
])
