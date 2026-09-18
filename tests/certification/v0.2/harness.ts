/**
 * NovaWing v0.2 automated certification — scenario driver.
 *
 * Every deterministic scenario enters through the trusted production entry:
 *   validateTrustedWorkSessionConfig → persisted trusted JSON (optional) →
 *   createProductionWorkSessionUi → WorkSessionRuntime → V2ControllerTaskRunner.
 * Provider responses are scripted at the documented createV2Dispatcher seam.
 */
import { join } from 'node:path'
import type { ProductionWorkSessionUi } from '../../../packages/development-guardian/work-session/production.js'
import {
  createProductionWorkSessionUi,
  validateTrustedWorkSessionConfig,
  type TrustedWorkSessionConfig,
} from '../../../packages/development-guardian/work-session/production.js'
import type { WorkSessionRuntime } from '../../../packages/development-guardian/work-session/runtime.js'
import type { WorkSessionDurableState } from '../../../packages/development-guardian/work-session/model.js'
import type { AgentCapabilityProfile } from '../../../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { AcceptanceEvidenceBinding } from '../../../packages/development-guardian/work-session/risk-evidence.js'
import { ScenarioProvider, makeDispatcher, ScriptedDispatcherOptions } from './provider.js'
import { storageUrl } from './util.js'

export interface ScenarioAssertionSink {
  check(condition: unknown, message: string): void
  checkpoint(message: string): void
}

export class CertificationError extends Error {}

/** Per-run observation sink; assertions accumulate as checks, failures throw once. */
export class ScenarioHarness implements ScenarioAssertionSink {
  checks: Array<{ message: string; passed: boolean }> = []
  checkpoints: string[] = []

  check(condition: unknown, message: string): void {
    this.checks.push({ message, passed: Boolean(condition) })
    if (!condition) {
      throw new CertificationError(`assertion failed: ${message}`)
    }
  }

  checkpoint(message: string): void {
    this.checkpoints.push(message)
  }
}

export interface TaskSpec {
  id: string
  goal: string
  constraints?: readonly string[]
  acceptanceCriteria: readonly string[]
  allowedPaths: readonly string[]
  forbiddenPaths?: readonly string[]
  bindings?: readonly AcceptanceEvidenceBinding[]
  risk?: 'LOW' | 'NORMAL' | 'HIGH'
}

export interface TrustedAgentSpec {
  id: string
  provider: string
  runtimeIdentity?: string
  model?: string
  capabilities: Partial<Record<'coding' | 'reasoning' | 'review' | 'repoNavigation' | 'debugging' | 'verification', boolean>>
}

export interface TrustedConfigSpec {
  sessionId: string
  repo: string
  branch?: string
  controlPlane?: 'v1' | 'v2'
  tasks: readonly TaskSpec[]
  softMinutes?: number
  hardMinutes?: number
  maxTasks?: number
  scheduledStartAt?: string | null
  /** Capability profiles declared by the trusted config (v0.2.4). */
  agents?: readonly TrustedAgentSpec[]
}

export async function buildTrustedConfig(spec: TrustedConfigSpec): Promise<TrustedWorkSessionConfig> {
  return validateTrustedWorkSessionConfig({
    session: {
      id: spec.sessionId,
      targetRepo: spec.repo,
      branch: spec.branch ?? 'main',
      limits: { softMinutes: spec.softMinutes ?? 15, hardMinutes: spec.hardMinutes ?? 30, maxTasks: spec.maxTasks ?? 1 },
      controlPlane: spec.controlPlane ?? 'v2',
      ...(spec.scheduledStartAt === undefined ? {} : { scheduledStartAt: spec.scheduledStartAt }),
    },
    tasks: spec.tasks.map((task) => ({
      id: task.id,
      goal: task.goal,
      guardian: {
        constraints: [...(task.constraints ?? [])],
        acceptanceCriteria: [...task.acceptanceCriteria],
        doNotDo: [],
        allowedPaths: [...task.allowedPaths],
        forbiddenPaths: [...(task.forbiddenPaths ?? [])],
      },
      ...(task.bindings === undefined ? {} : { acceptanceEvidenceBindings: task.bindings.map((binding) => ({ criterion: binding.criterion, requiredEvidence: [...binding.requiredEvidence], ...(binding.requiresApproval === undefined ? {} : { requiresApproval: binding.requiresApproval }) })) }),
    })),
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'codex', maxTurns: 4, allowNpmInstall: false, allowPythonBootstrap: false },
    ...(spec.agents === undefined
      ? {}
      : { agents: spec.agents.map((agent) => ({ ...agent, capabilities: { ...agent.capabilities } })) }),
  })
}

export interface ProductionAppOptions {
  config: TrustedWorkSessionConfig
  dataDir: string
  agents: readonly AgentCapabilityProfile[]
  provider: ScenarioProvider
  dispatcherExtras?: Omit<ScriptedDispatcherOptions, 'repo' | 'provider'>
  runtimeRepair?: import('../../../packages/development-guardian/work-session/production.js').ProductionWorkSessionDependencies['runtimeRepair']
  /** Provider-agnostic reviewer runtimes injected into the production composition. */
  reviewerRegistry?: import('../../../packages/development-guardian/work-session/reviewer-runtime.js').ReviewerRuntimeRegistry
  /** Use the capability profiles declared by the trusted config instead of `agents`. */
  useConfigAgents?: boolean
  /**
   * Script EXECUTE/VERIFY via the scenario provider but delegate REVIEW to the real
   * production review dispatcher, so the production review path is under test.
   */
  productionReview?: boolean
  onRuntimeReady?: (runtime: WorkSessionRuntime) => void
}

export async function createCertProductionApp(options: ProductionAppOptions): Promise<{ app: ProductionWorkSessionUi; runtime: WorkSessionRuntime }> {
  const dispatcher = makeDispatcher({
    repo: options.config.session.targetRepo,
    provider: options.provider,
    ...(options.dispatcherExtras ?? {}),
  })
  const app = await createProductionWorkSessionUi(options.config, {
    env: { ...process.env, NOVAWING_DATA_DIR: options.dataDir },
    createV2Dispatcher: options.productionReview === true
      ? ({ defaultDispatcher }) => ({
          inspectRepository: defaultDispatcher.inspectRepository,
          dispatch: async (input) =>
            input.action === 'REVIEW' ? defaultDispatcher.dispatch(input) : dispatcher.dispatch(input),
        })
      : () => dispatcher,
    ...(options.useConfigAgents === true ? {} : { v2Agents: options.agents }),
    ...(options.reviewerRegistry === undefined ? {} : { createReviewerRegistry: () => options.reviewerRegistry! }),
    ...(options.runtimeRepair === undefined ? {} : { runtimeRepair: options.runtimeRepair }),
  })
  const runtime = app.runtime as unknown as WorkSessionRuntime
  options.onRuntimeReady?.(runtime)
  return { app, runtime }
}

/** Duration helpers, uniform for start/resume result. */
export type DurableResult = WorkSessionDurableState

export function dataDirFor(runId: string, scenario: string): string {
  return join(process.cwd(), '.tmp', 'certification', runId, scenario, 'data')
}

export function repoDirFor(runId: string, scenario: string): string {
  return join(process.cwd(), '.tmp', 'certification', runId, scenario, 'repo')
}

export { storageUrl }
