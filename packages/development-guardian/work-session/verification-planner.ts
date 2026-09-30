import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { VerificationExecutionStep } from '../model.js'
import { assessVerificationCommand, normalizeNamedNpmTestScript } from '../verification-command-policy.js'
import type { WorkSessionTask } from './model.js'
import type { AcceptanceEvidenceBinding, RiskLevel, VerifierCommandCanonicalization } from './risk-evidence.js'
import { isRuntimeAcceptanceBinding, runtimeAcceptanceEvidence } from './completion-criteria.js'

export type VerificationScope = 'FILE' | 'PACKAGE' | 'WORKSPACE' | 'REPOSITORY'
export type VerificationPlanConfidence = 'HIGH' | 'MEDIUM' | 'INSUFFICIENT'
export type VerificationFailureExpectation =
  | 'CODE_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'VERIFIER_CONFIGURATION_FAILURE'
  | 'UNRELATED_TEST_FAILURE'
  | 'EVIDENCE_MISSING'
  | 'UNKNOWN'

export interface VerificationPlanStep extends Omit<VerificationExecutionStep, 'stepId'> {
  id: string
  scope: VerificationScope
  reason: string
  expectedCoverage: readonly string[]
  environmentPrerequisites: readonly string[]
  failureClassifications: readonly VerificationFailureExpectation[]
}

export interface VerificationAcceptanceMapping {
  criterion: string
  evidence: readonly string[]
  scope: VerificationScope
  reason: string
  requiresApproval?: boolean
  commandCanonicalizations?: readonly VerifierCommandCanonicalization[] | undefined
}

export interface VerificationPlan {
  planId: string
  fingerprint: string
  mappings: readonly VerificationAcceptanceMapping[]
  steps: readonly VerificationPlanStep[]
  escalationSequence: readonly string[]
  estimatedScope: VerificationScope
  estimatedCost: 'LOW' | 'MEDIUM' | 'HIGH'
  confidence: VerificationPlanConfidence
  approvalRequired: boolean
  invalidationConditions: readonly string[]
  packageRoots: readonly string[]
  explicitBindings: boolean
  rationale: readonly string[]
}

export interface VerificationPlannerInput {
  repositoryRoot: string
  task: Pick<WorkSessionTask, 'id' | 'goal' | 'constraints' | 'acceptanceCriteria' | 'allowedPaths' | 'forbiddenPaths' | 'acceptanceEvidenceBindings'>
  risk?: RiskLevel
  changedAreaHint?: readonly string[]
  environment?: Readonly<Record<string, boolean>>
}

interface PackageFacts {
  root: string
  scripts: Readonly<Record<string, string>>
  files: readonly string[]
}

const IGNORED = new Set([
  '.cache', '.git', '.mypy_cache', '.next', '.parcel-cache', '.pytest_cache', '.ruff_cache', '.tmp', '.turbo', '.venv', '.vite',
  '__pycache__', 'coverage', 'dist', 'dist-tests', 'node_modules',
])
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|[._-])(?:test|spec)\.[^/]+$/iu
const NODE_TEST_SOURCE = /\.(?:[cm]?[jt]s|jsx|tsx)$/iu
const ROOT_SUITE = /^(?:npm|pnpm|yarn)(?:\s+run)?\s+test(?:\s|$)/iu
const TOKEN = /[a-z0-9]{2,}/giu
const GENERIC_VERIFICATION_WORDS = new Set([
  'deterministic', 'human', 'pass', 'passed', 'relevant', 'run', 'smoke', 'test', 'testing', 'tests', 'verification', 'verify',
])

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
}

async function inventory(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && IGNORED.has(entry.name.toLocaleLowerCase('en-US'))) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(normalizePath(relative(root, absolute)))
    }
  }
  await visit(root)
  return files.sort()
}

async function packageFacts(repositoryRoot: string, files: readonly string[]): Promise<PackageFacts[]> {
  const manifests = files.filter((file) => file === 'package.json' || file.endsWith('/package.json'))
  const facts: PackageFacts[] = []
  for (const manifest of manifests) {
    const root = normalizePath(dirname(manifest)) === '.' ? '' : normalizePath(dirname(manifest))
    try {
      const parsed = JSON.parse(await readFile(join(repositoryRoot, manifest), 'utf8')) as { scripts?: unknown }
      const scripts = parsed.scripts !== null && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
        ? Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0))
        : {}
      facts.push({ root, scripts, files: files.filter((file) => root.length === 0 || file.startsWith(`${root}/`)) })
    } catch {
      // Invalid manifests are not planner evidence. Contract preflight may report them separately.
    }
  }
  return facts.sort((left, right) => right.root.length - left.root.length)
}

function taskWithoutBindings(task: VerificationPlannerInput['task']): VerificationPlannerInput['task'] {
  const { acceptanceEvidenceBindings: _bindings, ...rest } = task
  return rest
}

function ownerOf(path: string, packages: readonly PackageFacts[]): PackageFacts | undefined {
  const normalized = normalizePath(path)
  return packages.find((candidate) => candidate.root.length === 0 || normalized === candidate.root || normalized.startsWith(`${candidate.root}/`))
}

function keywords(input: VerificationPlannerInput): Set<string> {
  const source = [input.task.goal, ...(input.task.acceptanceCriteria ?? []), ...(input.changedAreaHint ?? []), ...(input.task.allowedPaths ?? [])].join(' ')
  return new Set((source.match(TOKEN) ?? []).map((token) => {
    const normalized = token.toLocaleLowerCase('en-US')
    if (normalized.length > 6 && normalized.endsWith('ing')) return normalized.slice(0, -3)
    if (normalized.length > 5 && normalized.endsWith('s')) return normalized.slice(0, -1)
    return normalized
  }).filter((token) => !GENERIC_VERIFICATION_WORDS.has(token) && !['with', 'from', 'that', 'this', '显示', '修改', '功能'].includes(token)))
}

function relevance(value: string, words: ReadonlySet<string>): number {
  const normalized = value.toLocaleLowerCase('en-US')
  let score = 0
  for (const word of words) if (normalized.includes(word)) score += Math.min(word.length, 8)
  return score
}

/** npm/node targeted verification accepts source tests owned by that package, never cache artifacts or foreign runtimes. */
function trustedNodeTestSource(file: string, owner: PackageFacts, packages: readonly PackageFacts[]): boolean {
  return TEST_FILE.test(file) && NODE_TEST_SOURCE.test(file) && ownerOf(file, packages)?.root === owner.root
}

function scopeRank(scope: VerificationScope): number {
  return { FILE: 0, PACKAGE: 1, WORKSPACE: 2, REPOSITORY: 3 }[scope]
}

function cwdFor(root: string): string { return root.length === 0 ? '.' : root }

function canonicalPlan(plan: Omit<VerificationPlan, 'planId' | 'fingerprint'>): string {
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
      : value
  return JSON.stringify(stable(plan))
}

function finish(plan: Omit<VerificationPlan, 'planId' | 'fingerprint'>): VerificationPlan {
  const fingerprint = createHash('sha256').update(canonicalPlan(plan)).digest('hex')
  return { ...plan, planId: `vp-${fingerprint.slice(0, 12)}`, fingerprint }
}

export function verificationPlanFingerprintValid(plan: VerificationPlan): boolean {
  const { planId: _planId, fingerprint, ...content } = plan
  const stable = createHash('sha256').update(canonicalPlan(content)).digest('hex')
  const legacy = createHash('sha256').update(JSON.stringify(content)).digest('hex')
  return fingerprint === stable || fingerprint === legacy
}

function explicitPlan(input: VerificationPlannerInput, packages: readonly PackageFacts[]): VerificationPlan {
  const bindings = input.task.acceptanceEvidenceBindings ?? []
  const packageRoots = [...new Set((input.changedAreaHint ?? input.task.allowedPaths ?? []).map((path) => ownerOf(path, packages)?.root).filter((root): root is string => root !== undefined))]
  const commands = [...new Set(bindings.flatMap((binding) => binding.requiredEvidence.map((item) => item.trim())).filter(Boolean))]
  let invalidCommand = false
  const steps = commands.map((command, index): VerificationPlanStep => {
    const root = packageRoots.length === 1 && !ROOT_SUITE.test(command) ? packageRoots[0]! : ''
    const owner = packages.find((candidate) => candidate.root === root)
    const script = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([^\s]+)(?:\s|$)/u.exec(command)?.[1]
    if (script !== undefined && owner?.scripts[script] === undefined) invalidCommand = true
    if (!/^(?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest|\.venv[\\/])/iu.test(command)) invalidCommand = true
    const admission = assessVerificationCommand(command)
    return { id: `verify-${index + 1}`, command, cwd: cwdFor(root), admission: admission.status, admissionReason: admission.reason, scope: root.length > 0 ? 'PACKAGE' : 'REPOSITORY',
      reason: 'Explicit user evidence binding has precedence.', expectedCoverage: bindings.filter((binding) => binding.requiredEvidence.includes(command)).map((binding) => binding.criterion),
      environmentPrerequisites: command.startsWith('npm') ? ['node', 'package manager'] : command.startsWith('git') ? ['git'] : [],
      failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNRELATED_TEST_FAILURE', 'UNKNOWN'] }
  })
  const unavailablePrerequisites = [...new Set(steps.flatMap((step) => step.environmentPrerequisites))]
    .filter((prerequisite) => input.environment?.[prerequisite] === false)
  const invalid = bindings.length !== (input.task.acceptanceCriteria ?? []).length || commands.length === 0 || invalidCommand || unavailablePrerequisites.length > 0
  const maxScope = steps.reduce<VerificationScope>((scope, step) => scopeRank(step.scope) > scopeRank(scope) ? step.scope : scope, 'FILE')
  return finish({
    mappings: (input.task.acceptanceCriteria ?? []).map((criterion) => { const binding = bindings.find((item) => item.criterion === criterion); return { criterion, evidence: binding?.requiredEvidence ?? [], scope: maxScope, reason: 'Explicit user binding.', ...(binding?.requiresApproval === undefined ? {} : { requiresApproval: binding.requiresApproval }), ...(binding?.commandCanonicalizations === undefined ? {} : { commandCanonicalizations: binding.commandCanonicalizations }) } }),
    steps, escalationSequence: ['PLAN_INVALIDATED', 'CONTROLLER'], estimatedScope: maxScope,
    estimatedCost: maxScope === 'REPOSITORY' ? 'HIGH' : 'LOW', confidence: invalid ? 'INSUFFICIENT' : 'HIGH',
    approvalRequired: bindings.some((binding) => binding.requiresApproval === true) || steps.some((step) => step.admission !== 'ALLOWED'),
    invalidationConditions: ['changed paths leave allowed scope', 'package boundary expands', 'risk surface expands', 'explicit binding changes'],
    packageRoots, explicitBindings: true, rationale: [
      'Explicit evidence bindings were preserved without planner substitution.',
      ...(unavailablePrerequisites.length === 0 ? [] : [`Known environment prerequisites are unavailable: ${unavailablePrerequisites.join(', ')}.`]),
    ],
  })
}

/** Deterministic-first, repository-local verification planning. It never invents a script or path. */
export async function planVerification(input: VerificationPlannerInput): Promise<VerificationPlan> {
  const runtimeCriteria = (input.task.acceptanceCriteria ?? []).filter((criterion) => {
    const binding = input.task.acceptanceEvidenceBindings?.find((item) => item.criterion === criterion)
    return runtimeAcceptanceEvidence(criterion) !== undefined && (binding === undefined || isRuntimeAcceptanceBinding(binding))
  })
  if (runtimeCriteria.length > 0) {
    const runtimeSet = new Set(runtimeCriteria)
    const remainingCriteria = (input.task.acceptanceCriteria ?? []).filter((criterion) => !runtimeSet.has(criterion))
    const verification = remainingCriteria.length === 0
      ? finish({ mappings: [], steps: [], escalationSequence: ['PLAN_INVALIDATED', 'CONTROLLER'], estimatedScope: 'REPOSITORY',
        estimatedCost: 'LOW', confidence: 'HIGH', approvalRequired: false, invalidationConditions: ['completion assertions change'],
        packageRoots: [], explicitBindings: false, rationale: [] })
      : await planVerification({ ...input, task: { ...input.task, acceptanceCriteria: remainingCriteria,
        acceptanceEvidenceBindings: input.task.acceptanceEvidenceBindings?.filter((binding) => !runtimeSet.has(binding.criterion)) } })
    const { planId: _planId, fingerprint: _fingerprint, ...content } = verification
    return finish({ ...content,
      approvalRequired: verification.approvalRequired || input.task.acceptanceEvidenceBindings?.some((binding) => runtimeSet.has(binding.criterion) && binding.requiresApproval === true) === true,
      mappings: (input.task.acceptanceCriteria ?? []).map((criterion) => {
        if (!runtimeSet.has(criterion)) return verification.mappings.find((mapping) => mapping.criterion === criterion)!
        const binding = input.task.acceptanceEvidenceBindings?.find((candidate) => candidate.criterion === criterion)
        return { criterion, evidence: [runtimeAcceptanceEvidence(criterion)!], scope: 'REPOSITORY' as const,
          ...(binding?.requiresApproval === undefined ? {} : { requiresApproval: binding.requiresApproval }),
          reason: 'Runtime-owned checkpoint evidence is required during FINALIZING; no shell verifier proves this assertion.' }
      }),
      rationale: [...verification.rationale, 'Runtime completion assertions are checked by finalization, never converted into verifier commands.'],
    })
  }
  const repositoryRoot = resolve(input.repositoryRoot)
  const files = await inventory(repositoryRoot)
  const packages = await packageFacts(repositoryRoot, files)
  if ((input.task.acceptanceEvidenceBindings?.length ?? 0) > 0) {
    const explicit = explicitPlan(input, packages)
    const explicitCriteria = new Set(input.task.acceptanceEvidenceBindings!.map((binding) => binding.criterion))
    const missingCriteria = (input.task.acceptanceCriteria ?? []).filter((criterion) => !explicitCriteria.has(criterion))
    if (missingCriteria.length === 0) return explicit
    const automatic = await planVerification({ ...input, task: { ...taskWithoutBindings(input.task), acceptanceCriteria: missingCriteria } })
    const steps = [...explicit.steps]
    for (const step of automatic.steps) if (!steps.some((candidate) => candidate.command === step.command && candidate.cwd === step.cwd)) steps.push(step)
    const mappings = (input.task.acceptanceCriteria ?? []).map((criterion) => explicitCriteria.has(criterion)
      ? explicit.mappings.find((mapping) => mapping.criterion === criterion)!
      : automatic.mappings.find((mapping) => mapping.criterion === criterion)!)
    return finish({ mappings, steps, escalationSequence: explicit.escalationSequence,
      estimatedScope: scopeRank(explicit.estimatedScope) > scopeRank(automatic.estimatedScope) ? explicit.estimatedScope : automatic.estimatedScope,
      estimatedCost: explicit.estimatedCost === 'HIGH' || automatic.estimatedCost === 'HIGH' ? 'HIGH' : 'MEDIUM',
      confidence: automatic.confidence === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'HIGH', approvalRequired: explicit.approvalRequired,
      invalidationConditions: [...new Set([...explicit.invalidationConditions, ...automatic.invalidationConditions])],
      packageRoots: [...new Set([...explicit.packageRoots, ...automatic.packageRoots])], explicitBindings: true,
      rationale: ['Explicit bindings took precedence.', ...automatic.rationale] })
  }

  const areas = input.changedAreaHint ?? input.task.allowedPaths ?? []
  const owners = [...new Set(areas.map((path) => ownerOf(path, packages)?.root).filter((root): root is string => root !== undefined))]
  const candidates = owners.map((root) => packages.find((candidate) => candidate.root === root)).filter((item): item is PackageFacts => item !== undefined)
  const words = keywords(input)
  const selected: VerificationPlanStep[] = []
  const rationale: string[] = []

  if (candidates.length === 1) {
    const owner = candidates[0]!
    const namedTests = Object.keys(owner.scripts).filter((name) => /(?:^|:)test(?::|$)/iu.test(name) && name !== 'test')
      .map((name) => ({ name, score: relevance(name, words) })).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    const bestNamed = namedTests.find((item) => item.score > 0)
    const nearbyTests = owner.files.filter((file) => trustedNodeTestSource(file, owner, packages)).map((file) => ({ file, score: relevance(file, words) }))
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    if (bestNamed !== undefined) {
      const packageFiles = owner.files.map((file) => owner.root.length === 0 ? file : file.slice(owner.root.length + 1))
      const normalized = normalizeNamedNpmTestScript({ scriptName: bestNamed.name, scripts: owner.scripts, packageFiles })
      if (normalized !== undefined) {
        selected.push({ id: 'targeted-test', command: normalized.command, originalCommand: normalized.originalCommand,
          cwd: cwdFor(owner.root), admission: 'ALLOWED', admissionReason: normalized.reason,
          sourceManifest: owner.root.length === 0 ? 'package.json' : `${owner.root}/package.json`, sourceScript: bestNamed.name,
          sourceFingerprint: normalized.sourceFingerprint, scope: 'FILE', reason: normalized.reason,
          expectedCoverage: input.task.acceptanceCriteria ?? [], environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNRELATED_TEST_FAILURE', 'UNKNOWN'] })
        rationale.push(normalized.reason)
      } else {
        rationale.push(`Named script ${bestNamed.name} was not auto-approved because it is not one existing, hook-free scoped node --test command.`)
      }
    }
    if (!selected.some((step) => step.id === 'targeted-test') && nearbyTests[0]?.score &&
        (owner.scripts.test !== undefined || bestNamed === undefined)) {
      const local = owner.root.length === 0 ? nearbyTests[0].file : nearbyTests[0].file.slice(owner.root.length + 1)
      const command = owner.scripts.test === undefined || /^\s*node(?:\.exe)?\s+--test(?:\s|$)/iu.test(owner.scripts.test)
        ? `node --test ${local}` : `npm test -- ${local}`
      const admission = assessVerificationCommand(command)
      selected.push({ id: 'targeted-test', command, cwd: cwdFor(owner.root), admission: admission.status, admissionReason: admission.reason, scope: 'FILE', reason: `Nearest existing test file (${nearbyTests[0].file}) matches task terms.`,
        expectedCoverage: input.task.acceptanceCriteria ?? [], environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNRELATED_TEST_FAILURE', 'UNKNOWN'] })
      rationale.push('Selected the nearest existing test file before a package suite.')
    } else if (!selected.some((step) => step.id === 'targeted-test') && owner.root.length > 0 && owner.scripts.test !== undefined) {
      selected.push({ id: 'package-test', command: 'npm test', cwd: cwdFor(owner.root), admission: 'ALLOWED', admissionReason: assessVerificationCommand('npm test').reason, scope: 'PACKAGE', reason: 'Owning package exposes an existing test script.',
        expectedCoverage: input.task.acceptanceCriteria ?? [], environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNRELATED_TEST_FAILURE', 'UNKNOWN'] })
      rationale.push('Selected package-local tests; root suite was not considered sufficient by default.')
    } else if (!selected.some((step) => step.id === 'targeted-test' || step.id === 'package-test') && bestNamed !== undefined) {
      const originalCommand = `npm run ${bestNamed.name}`
      const admission = assessVerificationCommand(originalCommand)
      selected.push({ id: 'targeted-test', command: originalCommand, originalCommand, cwd: cwdFor(owner.root), admission: admission.status,
        admissionReason: 'Named script could not be proven equivalent to one hook-free scoped node --test command.', scope: 'FILE',
        reason: `Closest named test script (${bestNamed.name}) requires explicit approval.`, expectedCoverage: input.task.acceptanceCriteria ?? [],
        environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNKNOWN'] })
    }
    if (owner.scripts.typecheck !== undefined) {
      selected.push({ id: 'package-typecheck', command: 'npm run typecheck', cwd: cwdFor(owner.root), admission: 'ALLOWED', admissionReason: assessVerificationCommand('npm run typecheck').reason, scope: 'PACKAGE', reason: 'Owning package exposes an existing typecheck script.',
        expectedCoverage: ['static compatibility of changed package'], environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNKNOWN'] })
    } else if (owner.scripts.lint !== undefined) {
      selected.push({ id: 'package-lint', command: 'npm run lint', cwd: cwdFor(owner.root), admission: 'ALLOWED', admissionReason: assessVerificationCommand('npm run lint').reason, scope: 'PACKAGE', reason: 'Owning package exposes an existing static lint check.',
        expectedCoverage: ['static consistency of changed package'], environmentPrerequisites: ['node', 'package manager'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNKNOWN'] })
    }
  }

  if (selected.length > 0) selected.push({ id: 'diff-check', command: 'git diff --check', cwd: '.', admission: 'ALLOWED', admissionReason: assessVerificationCommand('git diff --check').reason, scope: 'REPOSITORY', reason: 'Repository-native whitespace and patch integrity check.',
    expectedCoverage: ['patch integrity'], environmentPrerequisites: ['git'], failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'UNKNOWN'] })

  const criteria = input.task.acceptanceCriteria ?? []
  const unavailablePrerequisites = [...new Set(selected.flatMap((step) => step.environmentPrerequisites))]
    .filter((prerequisite) => input.environment?.[prerequisite] === false)
  const hasBehavioralEvidence = selected.some((step) => step.id === 'targeted-test' || step.id === 'package-test')
  const sufficient = criteria.length > 0 && hasBehavioralEvidence && unavailablePrerequisites.length === 0
  const evidence = selected.map((step) => step.command)
  const coverageSteps = selected.filter((step) => step.id !== 'diff-check')
  const estimatedScope = coverageSteps.reduce<VerificationScope>((scope, step) => scopeRank(step.scope) > scopeRank(scope) ? step.scope : scope, 'FILE')
  if (!hasBehavioralEvidence) rationale.push('No trustworthy task-local or package-local behavioral verifier was found; root-suite fallback is forbidden.')
  if (unavailablePrerequisites.length > 0) rationale.push(`Known environment prerequisites are unavailable: ${unavailablePrerequisites.join(', ')}.`)
  return finish({ mappings: criteria.map((criterion) => ({ criterion, evidence: sufficient ? evidence : [], scope: estimatedScope, reason: sufficient ? 'Minimal sufficient package evidence selected from repository facts.' : 'Planning requires human evidence selection.' })),
    steps: selected, escalationSequence: ['PLAN_INVALIDATED', 'CONTROLLER'], estimatedScope, estimatedCost: selected.length <= 2 ? 'LOW' : 'MEDIUM',
    confidence: sufficient ? (selected[0]?.scope === 'FILE' ? 'HIGH' : 'MEDIUM') : 'INSUFFICIENT', approvalRequired: selected.some((step) => step.admission !== 'ALLOWED'),
    invalidationConditions: ['changed paths leave allowed scope', 'package boundary expands', 'risk surface expands', 'repository scripts or tests change'],
    packageRoots: owners, explicitBindings: false, rationale })
}

export function bindingsFromVerificationPlan(
  plan: VerificationPlan,
  options: { identity?: 'command' | 'step' } = {},
): AcceptanceEvidenceBinding[] {
  return plan.mappings.map((mapping) => ({
    criterion: mapping.criterion,
    requiredEvidence: options.identity === 'step'
      ? [...new Set(mapping.evidence.flatMap((evidence) => {
          const matching = plan.steps.filter((step) => step.command === evidence || step.originalCommand === evidence)
          return matching.length === 0 ? [evidence] : matching.map((step) => step.id)
        }))]
      : [...new Set(mapping.evidence)],
    ...(mapping.requiresApproval === undefined ? {} : { requiresApproval: mapping.requiresApproval }),
    ...(mapping.commandCanonicalizations === undefined ? {} : { commandCanonicalizations: mapping.commandCanonicalizations }),
  }))
}

/**
 * Completion truth addresses a planned step by its step id; executing a verifier
 * still needs the planned shell command. A step id must never reach a shell, so
 * every binding-to-execution handoff goes through this mapping. Command-identity
 * bindings (no plan) and unknown entries pass through unchanged.
 */
export function verificationCommandsForEvidence(
  plan: VerificationPlan | undefined,
  requiredEvidence: readonly string[],
): string[] {
  if (plan === undefined) return [...new Set(requiredEvidence)]
  const commands = new Map<string, string>()
  for (const step of plan.steps) {
    commands.set(step.id, step.command)
    commands.set(step.command, step.command)
    if (step.originalCommand !== undefined) commands.set(step.originalCommand, step.command)
  }
  return [...new Set(requiredEvidence.map((evidence) => commands.get(evidence) ?? evidence))]
}

/** One runtime-owned exact command can satisfy at most one non-allowed plan step. */
export function verificationPlanApprovalSatisfied(plan: VerificationPlan, approvedCommand: string | undefined): boolean {
  const blocked = plan.steps.filter((step) => step.admission !== undefined && step.admission !== 'ALLOWED')
  return blocked.length === 0 || (blocked.length === 1 && approvedCommand !== undefined &&
    (blocked[0]!.originalCommand ?? blocked[0]!.command) === approvedCommand)
}

export interface VerificationPlanValidation {
  valid: boolean
  reasons: readonly string[]
}

function matchesPathRule(path: string, rule: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRule = normalizePath(rule)
  if (normalizedRule.endsWith('/**')) {
    const prefix = normalizedRule.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedRule || normalizedPath.startsWith(`${normalizedRule}/`)
}

export function validateVerificationPlanAfterExecution(input: {
  plan: VerificationPlan
  changedFiles: readonly string[]
  allowedPaths: readonly string[]
  forbiddenPaths: readonly string[]
  riskBefore: RiskLevel
  riskAfter: RiskLevel
}): VerificationPlanValidation {
  const allowed = input.allowedPaths.map(normalizePath)
  const forbidden = input.forbiddenPaths.map(normalizePath)
  const changed = input.changedFiles.map(normalizePath)
  const reasons: string[] = []
  if (changed.some((file) => forbidden.some((path) => matchesPathRule(file, path)))) reasons.push('changed path is forbidden')
  if (allowed.length > 0 && changed.some((file) => !allowed.some((path) => matchesPathRule(file, path)))) reasons.push('changed path is outside allowed scope')
  if (input.plan.packageRoots.length > 0 && changed.some((file) => !input.plan.packageRoots.some((root) => root.length === 0 || file === root || file.startsWith(`${root}/`)))) reasons.push('changed path crossed a planned package boundary')
  if (scopeRank(input.riskAfter === 'CRITICAL' || input.riskAfter === 'HIGH' ? 'REPOSITORY' : input.riskAfter === 'MEDIUM' ? 'WORKSPACE' : 'FILE') >
      scopeRank(input.riskBefore === 'CRITICAL' || input.riskBefore === 'HIGH' ? 'REPOSITORY' : input.riskBefore === 'MEDIUM' ? 'WORKSPACE' : 'FILE')) reasons.push('risk surface expanded')
  return { valid: reasons.length === 0, reasons }
}
