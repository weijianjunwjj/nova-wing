import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { AcceptanceEvidenceBinding } from '../risk-evidence.js'

export type ContractIssueCode =
  | 'MISSING_EVIDENCE_BINDING'
  | 'DUPLICATE_CRITERION'
  | 'DUPLICATE_BINDING'
  | 'BINDING_IDENTITY_MISMATCH'
  | 'EMPTY_VERIFIER_COMMAND'
  | 'UNRESOLVED_PLACEHOLDER'
  | 'PACKAGE_SCRIPT_NOT_FOUND'
  | 'TEST_PATH_NOT_FOUND'
  | 'BINDING_DSL_AMBIGUOUS'
  | 'VERIFIER_APPROVAL_REQUIRED'

export type VerifierPreflightClassification = 'TRUSTED' | 'APPROVAL_REQUIRED' | 'INVALID'

export interface TaskContractIssue {
  issueCode: ContractIssueCode
  criterion?: string
  binding?: AcceptanceEvidenceBinding
  reason: string
  attemptedRepair?: string
  whyRepairWasUnsafeOrImpossible?: string
}

export interface VerifierPreflightResult {
  criterion: string
  command: string
  classification: VerifierPreflightClassification
  reason: string
}

export type TaskContractPreflightResult =
  | {
      ok: true
      acceptanceCriteria: string[]
      acceptanceEvidenceBindings: AcceptanceEvidenceBinding[]
      verifiers: VerifierPreflightResult[]
      repairs: string[]
      planningRequired?: boolean
    }
  | {
      ok: false
      issues: TaskContractIssue[]
      verifiers: VerifierPreflightResult[]
      repairs: string[]
    }

export interface ParsedBindingDsl {
  criterionText: string
  verifierCommand: string
}

/** The text DSL is an input adapter only. A verifier may itself contain `=>`. */
export function parseTaskContractBindingDsl(value: string): ParsedBindingDsl | undefined {
  const delimiter = value.indexOf('=>')
  if (delimiter < 0) return undefined
  return {
    criterionText: value.slice(0, delimiter).trim(),
    verifierCommand: value.slice(delimiter + 2).trim(),
  }
}

const PLACEHOLDER = /(?:<[^>\r\n]*(?:对应|待定|替换|path|command|test)[^>\r\n]*>|\b(?:TODO|TBD|FIXME)\b)/iu
const TRUSTED_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm run check',
  'git diff --check',
  '.venv/Scripts/python.exe -m pytest',
])

/** Deterministic verifier allowlist, shared with the Repair Agent's safe-command gate. */
export const TRUSTED_VERIFIER_COMMANDS: ReadonlySet<string> = TRUSTED_COMMANDS
const IGNORED_REPOSITORY_DIRECTORIES = new Set(['.git', '.venv', 'node_modules', 'dist', 'dist-tests', 'coverage'])
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|[._-])(?:test|spec)\.[^/]+$/iu

interface RepositoryContractFacts {
  packageScripts: Readonly<Record<string, string>>
  files: ReadonlySet<string>
  hasPytestConfig: boolean
  hasWindowsVenvPython: boolean
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true
}

async function inventoryRepository(root: string): Promise<Set<string>> {
  const files = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_REPOSITORY_DIRECTORIES.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.add(relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return files
}

async function inspectRepository(root: string): Promise<RepositoryContractFacts> {
  let packageScripts: Record<string, string> = {}
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (manifest.scripts !== null && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)) {
      packageScripts = Object.fromEntries(Object.entries(manifest.scripts as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }
  } catch {
    // A repository without package.json may still have a deterministic pytest verifier.
  }
  const files = await inventoryRepository(root)
  return {
    packageScripts,
    files,
    hasPytestConfig: files.has('pytest.ini') || files.has('pyproject.toml') || files.has('setup.cfg'),
    hasWindowsVenvPython: await fileExists(join(root, '.venv', 'Scripts', 'python.exe')),
  }
}

function resolveRepositoryTestCommand(facts: RepositoryContractFacts): string | undefined {
  if (facts.packageScripts.test?.trim()) return 'npm test'
  const namedTestScripts = Object.keys(facts.packageScripts).filter((name) => facts.packageScripts[name]?.trim() && /(?:^|:)test(?:$|:)/iu.test(name))
  if (namedTestScripts.length === 1) return `npm run ${namedTestScripts[0]}`
  if (facts.hasPytestConfig && facts.hasWindowsVenvPython) return '.venv/Scripts/python.exe -m pytest'
  return undefined
}

function packageScript(command: string): string | undefined {
  const match = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([^\s]+)(?:\s|$)/u.exec(command)
  return match?.[1]
}

function resolveTestEntryFromFacts(facts: RepositoryContractFacts): string | undefined {
  const authoritative = resolveRepositoryTestCommand(facts)
  if (authoritative !== undefined) return authoritative
  if (facts.packageScripts.check?.trim()) return 'npm run check'
  return undefined
}

/**
 * The Repair Agent's broader test-entry resolution. It extends the deterministic
 * preflight entry (test script / single named test script / venv pytest) with a
 * `check` script fallback, so an AI repair can resolve a placeholder the
 * fail-closed preflight deliberately left unresolved.
 */
export async function resolveRepairTestEntry(root: string): Promise<string | undefined> {
  return resolveTestEntryFromFacts(await inspectRepository(root))
}

const MAX_REPAIR_REPO_LISTING = 60

/** Bounded, secret-free repository reality for a Repair Agent prompt. */
export interface RepairRepositoryFacts {
  packageScripts: Readonly<Record<string, string>>
  resolvedTestEntry?: string
  testFileCandidates: readonly string[]
  topLevelEntries: readonly string[]
  hasPytestConfig: boolean
  hasWindowsVenvPython: boolean
}

/**
 * Report the repository facts a Repair Agent may rely on. Only files whose names
 * already look like tests are listed, so ordinary source and any credential file
 * never enters a model prompt.
 */
export async function describeRepairRepository(root: string): Promise<RepairRepositoryFacts> {
  const facts = await inspectRepository(resolve(root))
  const testFileCandidates = [...facts.files]
    .filter((path) => TEST_FILE.test(path))
    .sort()
    .slice(0, MAX_REPAIR_REPO_LISTING)
  const topLevelEntries = [...new Set(
    [...facts.files].map((path) => path.split('/')[0] ?? '').filter((entry) => entry.length > 0),
  )].sort().slice(0, MAX_REPAIR_REPO_LISTING)
  const resolvedTestEntry = resolveTestEntryFromFacts(facts)
  return {
    packageScripts: facts.packageScripts,
    ...(resolvedTestEntry === undefined ? {} : { resolvedTestEntry }),
    testFileCandidates,
    topLevelEntries,
    hasPytestConfig: facts.hasPytestConfig,
    hasWindowsVenvPython: facts.hasWindowsVenvPython,
  }
}

function obviousTestPaths(command: string): string[] {
  const candidates = command.match(/[A-Za-z0-9_@+.,={}()[\]/\\:-]+/gu) ?? []
  return candidates
    .map((candidate) => candidate.replaceAll('\\', '/').replace(/^['"]|['"]$/gu, ''))
    .filter((candidate) => !candidate.startsWith('-') && TEST_FILE.test(candidate) && extname(candidate).length > 0)
}

function classifyVerifier(
  command: string,
  criterion: string,
  facts: RepositoryContractFacts,
): VerifierPreflightResult {
  if (command.length === 0) return { criterion, command, classification: 'INVALID', reason: 'Verifier command is empty.' }
  if (PLACEHOLDER.test(command)) return { criterion, command, classification: 'INVALID', reason: 'Verifier contains an unresolved placeholder.' }
  const script = packageScript(command)
  if (script !== undefined && !facts.packageScripts[script]?.trim()) {
    return { criterion, command, classification: 'INVALID', reason: `package.json does not define script ${script}.` }
  }
  if (command === '.venv/Scripts/python.exe -m pytest' && !facts.hasWindowsVenvPython) {
    return { criterion, command, classification: 'INVALID', reason: 'Test path does not exist: .venv/Scripts/python.exe.' }
  }
  const missingPath = obviousTestPaths(command).find((path) => {
    if (isAbsolute(path)) return true
    return !facts.files.has(path.replace(/^\.\//u, ''))
  })
  if (missingPath !== undefined) return { criterion, command, classification: 'INVALID', reason: `Test path does not exist: ${missingPath}.` }
  if (TRUSTED_COMMANDS.has(command)) return { criterion, command, classification: 'TRUSTED', reason: 'Command is in the deterministic verifier allowlist and is valid for this repository.' }
  return { criterion, command, classification: 'APPROVAL_REQUIRED', reason: 'Command is repository-valid but outside the deterministic verifier allowlist.' }
}

function normalizedIdentity(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function looksLikeVerifierCommand(value: string): boolean {
  return /^(?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest|\.venv[\\/])/iu.test(value.trim())
}

/** Repository-aware, fail-closed preflight. It never changes Task semantics or permission policy. */
export async function preflightTaskContract(input: {
  targetRepo: string
  acceptanceCriteria: readonly string[]
  acceptanceEvidenceBindings: readonly AcceptanceEvidenceBinding[]
  verificationPlannerEnabled?: boolean
}): Promise<TaskContractPreflightResult> {
  const root = resolve(input.targetRepo)
  const facts = await inspectRepository(root)
  const issues: TaskContractIssue[] = []
  const repairs: string[] = []
  const criteria: string[] = []
  const inlineBindings: AcceptanceEvidenceBinding[] = []
  const originalToCriterion = new Map<string, string>()

  for (const rawCriterion of input.acceptanceCriteria) {
    const parsed = parseTaskContractBindingDsl(rawCriterion)
    const criterion = parsed?.criterionText ?? rawCriterion.trim()
    if (parsed !== undefined) {
      if (criterion.length === 0 || parsed.verifierCommand.length === 0) {
        issues.push({ issueCode: criterion.length === 0 ? 'BINDING_DSL_AMBIGUOUS' : 'EMPTY_VERIFIER_COMMAND', criterion: rawCriterion,
          reason: criterion.length === 0 ? 'Binding DSL has no criterion before the delimiter.' : 'Binding DSL has no verifier after the delimiter.',
          attemptedRepair: 'Split the inline binding at the first => delimiter.', whyRepairWasUnsafeOrImpossible: 'The missing side cannot be inferred without changing Task semantics.' })
        continue
      }
      inlineBindings.push({ criterion, requiredEvidence: [parsed.verifierCommand] })
      repairs.push(`Normalized inline binding for criterion: ${criterion}`)
    }
    originalToCriterion.set(rawCriterion.trim(), criterion)
    const duplicate = criteria.find((candidate) => normalizedIdentity(candidate) === normalizedIdentity(criterion))
    if (duplicate !== undefined) {
      repairs.push(`Removed duplicate mechanical criterion representation: ${criterion}`)
      continue
    }
    criteria.push(criterion)
  }

  const criteriaByIdentity = new Map(criteria.map((criterion) => [normalizedIdentity(criterion), criterion]))
  const bindingsByCriterion = new Map<string, AcceptanceEvidenceBinding>()
  for (const rawBinding of [...input.acceptanceEvidenceBindings, ...inlineBindings]) {
    const mappedOriginal = originalToCriterion.get(rawBinding.criterion.trim())
    const exact = criteria.includes(rawBinding.criterion.trim()) ? rawBinding.criterion.trim() : undefined
    const normalized = criteriaByIdentity.get(normalizedIdentity(rawBinding.criterion))
    const criterion = mappedOriginal ?? exact ?? normalized
    if (criterion === undefined) {
      issues.push({ issueCode: 'BINDING_IDENTITY_MISMATCH', binding: rawBinding, reason: 'Binding criterion does not identify exactly one acceptance criterion.',
        attemptedRepair: 'Match exact and normalized criterion identity.', whyRepairWasUnsafeOrImpossible: 'No unique semantic identity match exists.' })
      continue
    }
    if (criterion !== rawBinding.criterion) repairs.push(`Normalized binding identity to criterion: ${criterion}`)
    const requiredEvidence = [...new Set(rawBinding.requiredEvidence.map((command) => command.trim()))]
    const existing = bindingsByCriterion.get(criterion)
    if (existing !== undefined) {
      bindingsByCriterion.set(criterion, { criterion, requiredEvidence: [...new Set([...existing.requiredEvidence, ...requiredEvidence])],
        ...((existing.requiresApproval === true || rawBinding.requiresApproval === true) ? { requiresApproval: true } : {}) })
      repairs.push(`Merged duplicate mechanical evidence binding: ${criterion}`)
    } else {
      bindingsByCriterion.set(criterion, { criterion, requiredEvidence, ...(rawBinding.requiresApproval === undefined ? {} : { requiresApproval: rawBinding.requiresApproval }) })
    }
  }

  for (const criterion of criteria) {
    if (!bindingsByCriterion.has(criterion)) {
      if (looksLikeVerifierCommand(criterion)) {
        bindingsByCriterion.set(criterion, { criterion, requiredEvidence: [criterion] })
        repairs.push(`Bound command-shaped criterion to its exact verifier: ${criterion}`)
        continue
      }
      if (input.verificationPlannerEnabled === true) {
        repairs.push(`Deferred evidence selection to Verification Planner: ${criterion}`)
        continue
      }
      issues.push({ issueCode: 'MISSING_EVIDENCE_BINDING', criterion, reason: 'Acceptance criterion has no evidence binding.',
        attemptedRepair: 'Search explicit and inline bindings.', whyRepairWasUnsafeOrImpossible: 'Selecting evidence without an explicit verifier would guess what proves the criterion.' })
    }
  }

  for (const [criterion, binding] of bindingsByCriterion) {
    const repairedCommands: string[] = []
    if (binding.requiredEvidence.length === 0) {
      issues.push({ issueCode: 'EMPTY_VERIFIER_COMMAND', criterion, binding, reason: 'Evidence binding contains no verifier command.',
        whyRepairWasUnsafeOrImpossible: 'A verifier cannot be invented safely.' })
    }
    for (const command of binding.requiredEvidence) {
      if (command.length === 0) {
        issues.push({ issueCode: 'EMPTY_VERIFIER_COMMAND', criterion, binding, reason: 'Evidence binding contains an empty verifier command.',
          whyRepairWasUnsafeOrImpossible: 'A verifier cannot be invented safely.' })
        continue
      }
      if (PLACEHOLDER.test(command)) {
        const resolved = resolveRepositoryTestCommand(facts)
        if (resolved === undefined) {
          issues.push({ issueCode: 'UNRESOLVED_PLACEHOLDER', criterion, binding, reason: `Verifier contains an unresolved placeholder: ${command}`,
            attemptedRepair: 'Inspect package.json, test configuration, test directories, and repository files for one authoritative test entry.',
            whyRepairWasUnsafeOrImpossible: 'Repository evidence did not identify exactly one safe test entry command.' })
          continue
        }
        repairedCommands.push(resolved)
        repairs.push(`Replaced placeholder verifier for ${criterion} with repository test entry: ${resolved}`)
        continue
      }
      repairedCommands.push(command)
    }
    bindingsByCriterion.set(criterion, { ...binding, requiredEvidence: [...new Set(repairedCommands)] })
  }

  const bindings = criteria.flatMap((criterion) => {
    const binding = bindingsByCriterion.get(criterion)
    return binding === undefined ? [] : [binding]
  })
  const verifiers = bindings.flatMap((binding) => binding.requiredEvidence.map((command) => classifyVerifier(command, binding.criterion, facts)))
  for (const verifier of verifiers) {
    if (verifier.classification === 'TRUSTED') continue
    const binding = bindingsByCriterion.get(verifier.criterion)
    if (verifier.classification === 'APPROVAL_REQUIRED') {
      issues.push({ issueCode: 'VERIFIER_APPROVAL_REQUIRED', criterion: verifier.criterion, ...(binding === undefined ? {} : { binding }), reason: `${verifier.reason} Approval required for: ${verifier.command}`,
        whyRepairWasUnsafeOrImpossible: 'Preflight cannot grant human approval or widen the verifier allowlist.' })
    } else if (/package\.json/u.test(verifier.reason)) {
      issues.push({ issueCode: 'PACKAGE_SCRIPT_NOT_FOUND', criterion: verifier.criterion, ...(binding === undefined ? {} : { binding }), reason: verifier.reason,
        whyRepairWasUnsafeOrImpossible: 'Changing to another package script without a placeholder would alter an explicit verifier.' })
    } else if (/Test path/u.test(verifier.reason)) {
      issues.push({ issueCode: 'TEST_PATH_NOT_FOUND', criterion: verifier.criterion, ...(binding === undefined ? {} : { binding }), reason: verifier.reason,
        whyRepairWasUnsafeOrImpossible: 'No unique replacement path was established from the explicit command.' })
    } else {
      issues.push({ issueCode: 'UNRESOLVED_PLACEHOLDER', criterion: verifier.criterion, ...(binding === undefined ? {} : { binding }), reason: verifier.reason,
        whyRepairWasUnsafeOrImpossible: 'The invalid verifier could not be repaired without guessing.' })
    }
  }

  return issues.length > 0
    ? { ok: false, issues, verifiers, repairs }
    : { ok: true, acceptanceCriteria: criteria, acceptanceEvidenceBindings: bindings, verifiers, repairs,
        ...(criteria.some((criterion) => !bindingsByCriterion.has(criterion)) ? { planningRequired: true } : {}) }
}
