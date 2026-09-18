import type { AcceptanceEvidenceBinding } from '../risk-evidence.js'
import { parseTaskContractBindingDsl } from './contract-preflight.js'
import type { TaskContractIssue } from './contract-preflight.js'

/**
 * Launchpad AI Repair domain vocabulary.
 *
 * These five codes are the *product* classification of a preflight failure,
 * not the raw `ContractIssueCode`. A single `TASK_CONTRACT_INVALID` create
 * error is classified into exactly one of them so the UI and the Repair Agent
 * share one stable contract.
 */
export type RepairErrorCode =
  | 'MISSING_EVIDENCE_BINDING'
  | 'TASK_CONTRACT_INVALID'
  | 'INVALID_VERIFIER'
  | 'PLACEHOLDER_UNRESOLVED'
  | 'APPROVAL_PREFLIGHT_REQUIRED'

/** What a Repair Agent decided; REPAIRED is the only outcome that may launch. */
export type RepairClassification =
  | 'REPAIRED'
  | 'REPAIR_REJECTED'
  | 'NOVAWING_PRODUCT_BUG'
  /** The model provider could not be reached; the Task is preserved unchanged. */
  | 'PROVIDER_UNAVAILABLE'

/** The mechanical contract fields a Repair Agent is allowed to touch. */
export interface RepairContract {
  acceptanceCriteria: readonly string[]
  acceptanceEvidenceBindings: readonly AcceptanceEvidenceBinding[]
}

/**
 * Fields the Repair Agent must never change. They are carried read-only so the
 * audit log can record that they were held constant; they are structurally
 * absent from {@link ContractRepairProposal}, so a repair cannot touch them.
 */
export interface RepairFrozenFields {
  goals?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
  constraints?: readonly string[]
  doNotDo?: readonly string[]
}

export interface RepairContext {
  errorCode: RepairErrorCode
  issues: readonly TaskContractIssue[]
  contract: RepairContract
  targetRepo: string
  branch?: string
  frozen: RepairFrozenFields
}

export interface ContractRepairProposal extends RepairContract {
  repairs: readonly string[]
}

/** Structured, human-actionable record for a defect judged to be NovaWing's own. */
export interface StructuredRepairTask {
  taskId: string
  productComponent: string
  title: string
  evidence: readonly string[]
}

export interface RepairAgentOutcome {
  classification: RepairClassification
  proposal?: ContractRepairProposal
  reason?: string
  structuredRepairTask?: StructuredRepairTask
}

const MECHANICAL_ISSUE_CODES: ReadonlySet<TaskContractIssue['issueCode']> = new Set([
  'MISSING_EVIDENCE_BINDING',
  'EMPTY_VERIFIER_COMMAND',
  'UNRESOLVED_PLACEHOLDER',
  'PACKAGE_SCRIPT_NOT_FOUND',
  'TEST_PATH_NOT_FOUND',
  'VERIFIER_APPROVAL_REQUIRED',
  'UNSAFE_VERIFIER_EXTRACTION',
  'BINDING_IDENTITY_MISMATCH',
  'BINDING_DSL_AMBIGUOUS',
  'DUPLICATE_CRITERION',
  'DUPLICATE_BINDING',
])

/** Maps raw preflight issue codes to a single product-level repair code. */
export function classifyRepairErrorCode(issues: readonly TaskContractIssue[]): RepairErrorCode | undefined {
  if (issues.length === 0) return undefined
  const codes = new Set(issues.map((issue) => issue.issueCode))
  if (codes.has('VERIFIER_APPROVAL_REQUIRED')) return 'APPROVAL_PREFLIGHT_REQUIRED'
  if (codes.has('UNRESOLVED_PLACEHOLDER')) return 'PLACEHOLDER_UNRESOLVED'
  if (codes.has('MISSING_EVIDENCE_BINDING')) return 'MISSING_EVIDENCE_BINDING'
  if (
    codes.has('EMPTY_VERIFIER_COMMAND') ||
    codes.has('PACKAGE_SCRIPT_NOT_FOUND') ||
    codes.has('TEST_PATH_NOT_FOUND') ||
    codes.has('UNSAFE_VERIFIER_EXTRACTION') ||
    codes.has('BINDING_DSL_AMBIGUOUS')
  ) {
    return 'INVALID_VERIFIER'
  }
  return 'TASK_CONTRACT_INVALID'
}

/** True when the issue code is one the deterministic repair engine understands. */
export function isKnownMechanicalIssue(issue: TaskContractIssue): boolean {
  return MECHANICAL_ISSUE_CODES.has(issue.issueCode)
}

export function normalizedCriterionIdentity(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

/**
 * Normalize a raw contract into the criterion/binding shape the preflight and
 * Repair Agent both operate on: a `criterion => verifier` acceptance criterion
 * is split into a plain criterion plus an inline evidence binding. This mirrors
 * the preflight's first phase so the Repair Agent sees the same identities the
 * failing issues reference.
 */
export function parseEffectiveRepairContract(input: {
  acceptanceCriteria: readonly string[]
  acceptanceEvidenceBindings: readonly AcceptanceEvidenceBinding[]
}): RepairContract {
  const criteria: string[] = []
  const inlineBindings: AcceptanceEvidenceBinding[] = []
  for (const raw of input.acceptanceCriteria) {
    const parsed = parseTaskContractBindingDsl(raw)
    if (parsed !== undefined && parsed.criterionText.length > 0 && parsed.verifierCommand.length > 0) {
      criteria.push(parsed.criterionText)
      inlineBindings.push({ criterion: parsed.criterionText, requiredEvidence: [parsed.verifierCommand] })
    } else {
      criteria.push(raw.trim())
    }
  }
  return {
    acceptanceCriteria: criteria,
    acceptanceEvidenceBindings: [...input.acceptanceEvidenceBindings, ...inlineBindings],
  }
}

function bindingApprovalMap(contract: RepairContract): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>()
  for (const binding of contract.acceptanceEvidenceBindings) {
    const key = normalizedCriterionIdentity(binding.criterion)
    map.set(key, map.get(key) === true || binding.requiresApproval === true)
  }
  return map
}

/**
 * Enforce the mechanical-only contract of a Repair Agent. This is the last line
 * of defense and runs on any agent's proposal — including an agent that returns
 * a semantically different contract — before re-preflight.
 *
 * Invariants:
 *   - the set of criterion identities is preserved exactly (no reword/add/drop);
 *   - every repaired binding references an original criterion;
 *   - every repaired verifier is an allowlisted deterministic command;
 *   - a new `requiresApproval` (trust widening) is rejected;
 *   - a valid original verifier is never dropped;
 *   - a verifier that is merely awaiting human approval is never replaced, since
 *     substituting a weaker command would silently widen what counts as proof.
 */
export function validateMechanicalRepair(
  original: RepairContract,
  proposal: RepairContract,
  allowedVerifiers: readonly string[],
  protectedVerifiers: readonly string[] = [],
): { ok: true } | { ok: false; reasons: readonly string[] } {
  const reasons: string[] = []
  const originalCriteria = new Set(original.acceptanceCriteria.map(normalizedCriterionIdentity))
  const proposedCriteria = [...new Set(proposal.acceptanceCriteria.map(normalizedCriterionIdentity))]
  const originalApproval = bindingApprovalMap(original)
  const allowed = new Set(allowedVerifiers)

  if (proposedCriteria.length !== originalCriteria.size) {
    reasons.push('repaired contract changes the number of acceptance criteria')
  }
  for (const criterion of proposedCriteria) {
    if (!originalCriteria.has(criterion)) reasons.push(`repaired contract rewords or adds criterion: ${criterion}`)
  }
  for (const criterion of originalCriteria) {
    if (!proposedCriteria.includes(criterion)) reasons.push(`repaired contract drops criterion: ${criterion}`)
  }

  for (const binding of proposal.acceptanceEvidenceBindings) {
    const key = normalizedCriterionIdentity(binding.criterion)
    if (!originalCriteria.has(key)) reasons.push(`repaired binding references an unknown criterion: ${binding.criterion}`)
    if (binding.requiresApproval === true && originalApproval.get(key) !== true) {
      reasons.push(`repaired binding widens trust with a new approval requirement: ${binding.criterion}`)
    }
    for (const command of binding.requiredEvidence) {
      if (!allowed.has(command)) reasons.push(`repaired verifier is outside the deterministic allowlist: ${command}`)
    }
  }

  const originalValidCommands = new Set(
    original.acceptanceEvidenceBindings
      .flatMap((binding) => binding.requiredEvidence)
      .filter((command) => allowed.has(command)),
  )
  const proposedCommands = new Set(proposal.acceptanceEvidenceBindings.flatMap((binding) => binding.requiredEvidence))
  for (const command of originalValidCommands) {
    if (!proposedCommands.has(command)) reasons.push(`repaired contract drops a valid verifier: ${command}`)
  }
  for (const command of protectedVerifiers) {
    if (!proposedCommands.has(command)) {
      reasons.push(`repaired contract replaces a verifier that requires human approval: ${command}`)
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/** Issue codes where a language model could plausibly propose a legal binding. */
export const LLM_REPAIRABLE_ISSUE_CODES: ReadonlySet<TaskContractIssue['issueCode']> = new Set([
  'MISSING_EVIDENCE_BINDING',
  'EMPTY_VERIFIER_COMMAND',
  'UNRESOLVED_PLACEHOLDER',
  'PACKAGE_SCRIPT_NOT_FOUND',
  'TEST_PATH_NOT_FOUND',
])

/** True when at least one remaining issue is worth a model round-trip. */
export function hasLlmRepairableIssue(issues: readonly TaskContractIssue[]): boolean {
  if (issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION')) return false
  return issues.some((issue) => LLM_REPAIRABLE_ISSUE_CODES.has(issue.issueCode))
}

/**
 * The issue codes an automatic preflight repair may attempt unattended.
 *
 * This is exactly the existing model-repairable taxonomy: a criterion that lost
 * its binding, or a verifier that is empty, unresolved, or points at a package
 * script / test path that does not exist. Every other preflight code stays a
 * human decision — approval cannot be granted by a program, and a duplicate or
 * ambiguous binding has no mechanical resolution. The taxonomy is not widened
 * here; automatic repair only changes *who* starts the existing cascade.
 */
export const AUTO_REPAIRABLE_ISSUE_CODES: ReadonlySet<TaskContractIssue['issueCode']> = LLM_REPAIRABLE_ISSUE_CODES

/**
 * True when every remaining issue is one an agent may safely attempt, so the
 * create path may start the repair cascade without asking the operator first.
 * An empty issue set is never auto-repairable.
 */
export function isAutoRepairableIssueSet(issues: readonly TaskContractIssue[]): boolean {
  return issues.length > 0 && issues.every((issue) => AUTO_REPAIRABLE_ISSUE_CODES.has(issue.issueCode))
}

/**
 * Upper bound on unattended repair cycles. The cascade names one repair
 * strategy per cycle (deterministic, then the model), so the bound is also the
 * number of distinct strategies: an automatic repair can never spin.
 */
export const MAX_AUTO_REPAIR_CYCLES = 2

/** The single reason an automatic repair stops without launching. */
export const AUTO_REPAIR_EXHAUSTED = 'AUTO_REPAIR_EXHAUSTED'

/** Verifiers that preflight judged valid but outside the deterministic allowlist. */
export function protectedVerifierCommands(verifiers: readonly { command: string; classification: string }[]): string[] {
  return [...new Set(verifiers.filter((verifier) => verifier.classification === 'APPROVAL_REQUIRED').map((verifier) => verifier.command))]
}
