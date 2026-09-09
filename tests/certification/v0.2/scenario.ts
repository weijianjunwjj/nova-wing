/**
 * NovaWing v0.2 automated certification — scenario contract and helpers.
 */
import { join } from 'node:path'
import type { ScenarioProvider } from './provider.js'
import { agentProfile } from './provider.js'
import type { AgentCapabilityProfile } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { ScenarioHarness } from './harness.js'
import { CertificationError } from './harness.js'

export interface ScenarioDirs {
  runId: string
  scenarioId: string
  root: string
  repo: string
  data: string
}

export interface ScenarioContext {
  dirs: ScenarioDirs
  h: ScenarioHarness
}

export interface ScenarioResult {
  scenarioId: string
  passed: boolean
  /** Short machine tag for the report matrix. */
  tag: string
  durationMs: number
  notes: string[]
  checks: Array<{ message: string; passed: boolean }>
  error?: string
}

export interface CertificationScenario {
  id: string
  title: string
  group: 'control' | 'risk' | 'recovery' | 'compatibility'
  run(ctx: ScenarioContext): Promise<void>
}

/** Implementer agent with a stable, trusted runtime identity. */
export function implementerAgent(overrides: Partial<Parameters<typeof agentProfile>[0]> = {}): AgentCapabilityProfile {
  return agentProfile({
    id: 'coder',
    provider: 'codex',
    runtimeIdentity: 'cert:coder',
    capabilities: { coding: true, reasoning: true, repoNavigation: true, verification: true, debugging: true },
    ...overrides,
  })
}

/** Independent reviewer agent with a distinct runtime identity. */
export function reviewerAgent(overrides: Partial<Parameters<typeof agentProfile>[0]> = {}): AgentCapabilityProfile {
  return agentProfile({
    id: 'reviewer',
    provider: 'reviewer-provider',
    runtimeIdentity: 'cert:reviewer',
    capabilities: { review: true, reasoning: true, coding: false, verification: false },
    ...overrides,
  })
}

/** Quote a single argv token for the certification command DSL. */
export function quoteArg(value: string): string {
  if (value.length === 0) return "''"
  if (!/[ \t'"\\\n]/u.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

const VERIFIER_DIR = join(process.cwd(), 'scripts', 'certification', 'verifiers')

export function verifierScript(name: string): string {
  return join(VERIFIER_DIR, name)
}

/** Evidence command string that runs a real node verifier fixture. */
export function fileContentCmd(repo: string, rel: string, expected: string): string {
  return `node ${quoteArg(verifierScript('verify-file-content.mjs'))} ${quoteArg(repo)} ${quoteArg(rel)} ${quoteArg(expected)}`
}

export function noWhitespaceCmd(repo: string, rel: string): string {
  return `node ${quoteArg(verifierScript('verify-no-whitespace.mjs'))} ${quoteArg(repo)} ${quoteArg(rel)}`
}

export function reportSchemaCmd(repo: string, rel: string, keys: readonly string[]): string {
  return `node ${quoteArg(verifierScript('verify-report-schema.mjs'))} ${quoteArg(repo)} ${quoteArg(rel)} ${keys.map(quoteArg).join(' ')}`
}

export { agentProfile, CertificationError }
export type { AgentCapabilityProfile, ScenarioProvider }
