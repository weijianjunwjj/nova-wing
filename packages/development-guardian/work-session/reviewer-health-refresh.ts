import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveClaudeProviderEnvironment } from '../deepseek-executor.js'
import { taskRetryRequestSchema } from './task-retry.js'
import { createDeepSeekReviewerRuntime, spawnReviewCommand } from './reviewer-adapters.js'
import type { ReviewerRuntime } from './reviewer-runtime.js'

export const reviewerHealthRefreshRequestSchema = taskRetryRequestSchema.omit({ reasonCode: true })
  .extend({ provider: z.literal('deepseek') }).strict()
export type ReviewerHealthRefreshRequest = z.infer<typeof reviewerHealthRefreshRequestSchema>
export const reviewerHealthProbeResultSchema = z.object({
  probeId: z.string().uuid(), provider: z.literal('deepseek'),
  status: z.enum(['AVAILABLE', 'DEGRADED', 'OFFLINE', 'TIMEOUT', 'QUOTA_EXHAUSTED']),
  reasonCode: z.enum(['REVIEWER_PROBE_PASSED', 'REVIEWER_PROBE_FAILED']),
  requestedModel: z.string().regex(/^[A-Za-z0-9_.[\]-]{1,120}$/u),
  resolvedModel: z.string().regex(/^[A-Za-z0-9_.[\]-]{1,120}$/u).optional(),
  observedAt: z.iso.datetime(),
}).strict().superRefine((result, context) => {
  if ((result.status === 'AVAILABLE') !== (result.reasonCode === 'REVIEWER_PROBE_PASSED'))
    context.addIssue({ code: 'custom', message: 'Inconsistent reviewer health probe' })
})
export type ReviewerHealthProbeResult = z.infer<typeof reviewerHealthProbeResultSchema>

/** One bounded provider request on an isolated fixture; never uses the customer's task or repository. */
export async function probeDeepSeekReviewer(options: {
  cwd: string; model: string; env: NodeJS.ProcessEnv
  /** Fixture seam; production always uses the formal Claude CLI reviewer adapter. */
  createReviewer?: (input: { cwd: string; env: NodeJS.ProcessEnv }) => ReviewerRuntime
}): Promise<ReviewerHealthProbeResult> {
  const probeId = randomUUID()
  const root = await mkdtemp(join(tmpdir(), 'novawing-reviewer-health-'))
  let resolvedModel: string | undefined
  const finish = (status: ReviewerHealthProbeResult['status']): ReviewerHealthProbeResult => ({
    probeId, provider: 'deepseek', status,
    reasonCode: status === 'AVAILABLE' ? 'REVIEWER_PROBE_PASSED' : 'REVIEWER_PROBE_FAILED',
    requestedModel: options.model, ...(resolvedModel === undefined ? {} : { resolvedModel }), observedAt: new Date().toISOString(),
  })
  try {
    const env = await resolveClaudeProviderEnvironment(options.cwd, options.env)
    const repo = join(root, 'fixture'), config = join(root, 'claude')
    await mkdir(repo); await mkdir(config)
    // Credentials remain in memory. All CLI state/history is isolated; CC Switch files are not written.
    const isolatedEnv = { ...env, CLAUDE_CONFIG_DIR: config }
    const file = join(repo, 'health.txt'), content = `Reviewer health fixture: ${probeId}\n`
    await writeFile(file, content)
    const digest = createHash('sha256').update(content).digest('hex')
    const runtime = options.createReviewer?.({ cwd: repo, env: isolatedEnv }) ?? createDeepSeekReviewerRuntime({
      cwd: repo, model: options.model, env: isolatedEnv, timeoutMs: 60_000, maxTurns: 3,
      commandRunner: async request => {
        const result = await spawnReviewCommand(request)
        try {
          const models = Object.keys((JSON.parse(result.stdout) as { modelUsage?: Record<string, unknown> }).modelUsage ?? {})
          if (models.length === 1 && /^[A-Za-z0-9_.[\]-]{1,120}$/u.test(models[0]!)) resolvedModel = models[0]
        } catch { /* No model identity is inferred from model prose. */ }
        return result
      },
    })
    const outcome = await runtime.review({
      agent: { id: 'health-probe-reviewer', identity: { agent: 'health-probe-reviewer', provider: 'deepseek', runtimeIdentity: `probe:${probeId}` },
        available: true, degraded: false, quotaExhausted: false, capabilities: { review: true, reasoning: true } },
      task: { taskId: 'HEALTH_PROBE', goal: 'Read only health.txt once and return the verdict JSON immediately. This is a provider health probe, not a customer task.',
        constraints: ['Do not modify any file. Do not explore outside this one-file fixture.'],
        acceptanceCriteria: [`AcceptanceAssertion HEALTH_PROBE: health.txt contains the exact fixture identifier ${probeId}. Cite that identifier in evidence.`],
        implementer: { agent: 'fixture', provider: 'fixture', runtimeIdentity: 'host-fixture' }, implementerProviders: ['fixture'],
        repositoryIdentity: repo, changedFiles: ['health.txt'], verificationEvidence: [{ name: `host SHA-256 ${digest}`, status: 'passed' }],
        evidence: [], blockers: [], risk: 'LOW' },
    })
    if (runtime.provider !== 'deepseek' || outcome.provider !== 'deepseek') return finish('DEGRADED')
    if (outcome.kind === 'RUNTIME_FAILURE') return finish(outcome.status)
    const assertion = outcome.assertionVerdicts?.find(item => item.assertionId === 'HEALTH_PROBE')
    if (!outcome.passed || assertion?.verdict !== 'PASS' || !assertion.evidence.includes(probeId) ||
      createHash('sha256').update(await readFile(file)).digest('hex') !== digest) return finish('DEGRADED')
    return finish('AVAILABLE')
  } catch { return finish('DEGRADED') }
  finally { await rm(root, { recursive: true, force: true }) }
}
