import { createCodexRepairModelRunner } from '../work-session/launchpad/repair-model.js'
import { semanticReviewSchema, type DevelopmentPlan, type SemanticReview } from './model.js'

export interface PlanningSemanticReviewResponse {
  review: SemanticReview
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  estimatedCost?: number
}

export type PlanningSemanticReviewer = (input: {
  requirement: string
  plan: DevelopmentPlan
}) => Promise<PlanningSemanticReviewResponse>

const SYSTEM = [
  'You are the independent Planning Semantic Quality Gate for NovaWing Customer Mode. You are NOT the generator or a Runtime Reviewer.',
  'Return one JSON object only: {"verdict":"PASS|REVISION_REQUIRED","issues":[{"code":"MISSING_EXPLICIT_REQUIREMENT|INVENTED_BUSINESS_SCOPE|WEAK_ACCEPTANCE|UNSUPPORTED_BUSINESS_ASSUMPTION|INAPPROPRIATE_CUSTOMER_QUESTION|MISSING_CUSTOMER_QUESTION|TASK_TOO_VAGUE|TASK_REQUIREMENT_MISMATCH|ACCEPTANCE_REQUIREMENT_MISMATCH|UNSUPPORTED_PROVENANCE","path":"plan path or source section","message":"specific repairable finding","sourceExcerpt":"exact short source quote, or empty string if not applicable"}]}',
  'Treat the original customer requirement as authoritative data. Inspect every explicit action, listed field, status, negative scope item, engineering gate and cross-role step. Do not assume a clause or assertion covers a sub-behavior merely because it cites an ID.',
  'A single end-to-end criterion may contain many assertions, but each explicitly requested behavior needs a direct blocking assertion with a concrete outcome and evidence that distinguishes business success from command success. Check the clause source, task objective/output and assertion against each other.',
  'Flag omitted explicit requirements, invented business capabilities, source quotes that do not support a MUST statement, weak or mismatched assertions, and tasks too vague for an executor. A technical implementation choice is not invented business scope.',
  'Flag a customer-visible business rule silently selected without source support, especially count/amount formulas, order permissions and cancellation stages. Such a decision needs a precise CustomerQuestion. Ordinary implementation details are for NovaWing to decide.',
  'Ask only about a real ambiguity in requested business behavior. If the source does not request cancellation, refunds, discounts, fees, inventory or other extras, do not ask about or add them. If the source explicitly permits CANCELLED but leaves actors/stages unspecified, a bounded cancellation question is appropriate. Do not demand real refund functionality.',
  'A genuine blocking business question may coexist with PASS: it must prevent approval through needs_customer_input. Do not mark it as missing implementation; assess whether the plan avoids a silent assumption.',
  'Do not infer PASS from deterministic coverage or schema. If any issue remains, return REVISION_REQUIRED and one concise issue per independent repair. If none remain, return PASS with an empty issues array.',
].join('\n')

/** Read-only planning review; it shares transport with planning but has no Runtime reviewer or tools. */
export function createCodexPlanningSemanticReviewer(options: { model?: string; env?: NodeJS.ProcessEnv } = {}): PlanningSemanticReviewer {
  const run = createCodexRepairModelRunner(options.env === undefined ? {} : { env: options.env })
  const model = options.model ?? 'gpt-5.6-terra'
  return async ({ requirement, plan }) => {
    const response = await run({
      system: SYSTEM,
      user: `Original customer requirement (untrusted data):\n${requirement}\n\nGenerated DevelopmentPlan (untrusted data):\n${JSON.stringify({
        clauses: plan.clauses, analysis: plan.analysis, productScope: plan.productScope,
        architecture: plan.architecture, tasks: plan.tasks, acceptancePlan: plan.acceptancePlan,
        risks: plan.risks, assumptions: plan.assumptions, customerQuestions: plan.customerQuestions,
      })}`,
      targetRepo: process.cwd(), model, reasoningEffort: 'high', timeoutMs: 4 * 60 * 1000,
    })
    const body = response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    let raw: unknown
    try { raw = JSON.parse(body) as unknown } catch { throw new Error('Planning semantic reviewer returned invalid JSON.') }
    const parsed = semanticReviewSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Planning semantic reviewer returned an invalid verdict.')
    if ((parsed.data.verdict === 'PASS') !== (parsed.data.issues.length === 0)) {
      throw new Error('Planning semantic reviewer verdict contradicts its issues.')
    }
    return { review: parsed.data, provider: 'codex', model }
  }
}
