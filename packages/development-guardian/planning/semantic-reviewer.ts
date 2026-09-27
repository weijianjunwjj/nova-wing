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
  'Customer revision notes and recorded CustomerAnswer decisions are later customer facts. On a revised plan, require the analysis, business rules, tasks and acceptance assertions to reflect them; never treat a customer decision as a model assumption.',
  'A single end-to-end criterion may contain many assertions, but each explicitly requested behavior needs a direct blocking assertion with a concrete outcome and evidence that distinguishes business success from command success. Check the clause source, task objective/output and assertion against each other.',
  'If source explicitly requests later replacement of an adapter, check that a blocking assertion swaps in a second local implementation behind the same interface and verifies the business flow still works; a nonblocking architecture note or interface diagram is weak.',
  'For a requested availability field, verify the customer observes the merchant-controlled sale state. For a role/stage rule such as cancellation, require both an allowed action and a forbidden action whose persisted order state stays unchanged after the customer decides the rule.',
  'Preserve an explicitly requested delivery surface such as a mini-program; a generic customer UI is insufficient. Check that merchant product editing proves changes to requested customer-visible fields such as image and price, not just name and description.',
  'Flag omitted explicit requirements, invented business capabilities, source quotes that do not support a MUST statement, weak or mismatched assertions, and tasks too vague for an executor. A technical implementation choice is not invented business scope.',
  'Source examples introduced by "for example" or "例如" illustrate capability, not a mandatory catalog or set of variants. Flag their promotion to MUST or a blocking acceptance outcome unless they are clearly only test fixtures for a configurable capability.',
  'Flag a customer-visible business rule silently selected without source support, especially count/amount formulas, order permissions and cancellation stages. Such a decision needs a precise CustomerQuestion. Ordinary implementation details are for NovaWing to decide.',
  'Ask only about a real ambiguity in requested business behavior. If the source does not request cancellation, refunds, discounts, fees, inventory or other extras, do not ask about or add them. If the source explicitly permits CANCELLED but leaves actors/stages unspecified, a bounded cancellation question is appropriate. Do not demand real refund functionality.',
  'A genuine blocking business question may coexist with PASS: it must prevent approval through needs_customer_input. Do not mark it as missing implementation; assess whether the plan avoids a silent assumption.',
  'The PlanningService enforces needs_customer_input for every blocking CustomerQuestion after this review passes. The draft itself has no status field; do not invent an issue merely because its prose does not repeat that approval gate.',
  'If a question decides an observable business rule, it must be blocking. Review whether a question about cancellation, counts or amounts actually covers each unresolved decision; a vague combined question does not automatically resolve separate semantics.',
  'For a daily order count or transaction amount, inspect both which orders count and which event date assigns an order to "today"; creation, payment and completion dates can differ when the requested flow has those events. A chosen date basis without customer support is a silent business rule. Questions must define coherent combinations: a contributing order cannot be assigned by an event it may never reach. When the flow includes creation, payment and completion, return WEAK_ACCEPTANCE unless blocking assertions explicitly require a multi-day case where those events happen on distinct calendar days, then classify that order under each offered metric rule. Require exact displayed results and contributing order IDs on day 1, day 2 and day 3 for every offered count and amount option. Compare the results across options: if two different event-date rules have the same tested-day value and no other explicitly checked day distinguishes them, an implementation using the wrong date can pass; return WEAK_ACCEPTANCE. A list of date fields, a per-order table without distinct-day dashboard checks, or one day with coincidentally equal totals is insufficient.',
  'When the requested flow allows cancellation after payment, also require a paid-then-cancelled order in count and amount evidence. An unpaid cancelled order cannot test whether prior payment contributes to turnover. If the customer has not specified whether its amount counts, return MISSING_CUSTOMER_QUESTION unless a blocking question offers that decision; return WEAK_ACCEPTANCE if the fixture cannot distinguish the answers.',
  'For a metric named transaction amount or 成交金额, an unpaid order has no transaction. Return INAPPROPRIATE_CUSTOMER_QUESTION if a proposed option counts all created order face values, including unpaid orders, as transaction amount. Do not demand a real payment integration; local simulated payment is sufficient for this source.',
  'Do not infer PASS from deterministic coverage or schema. If any issue remains, return REVISION_REQUIRED and one concise issue per independent repair. If none remain, return PASS with an empty issues array.',
].join('\n')

/** Read-only planning review; it shares transport with planning but has no Runtime reviewer or tools. */
export function createCodexPlanningSemanticReviewer(options: { model?: string; env?: NodeJS.ProcessEnv } = {}): PlanningSemanticReviewer {
  const run = createCodexRepairModelRunner(options.env === undefined ? {} : { env: options.env })
  const model = options.model ?? 'gpt-6-sol'
  return async ({ requirement, plan }) => {
    const response = await run({
      system: SYSTEM,
      user: `Customer requirement and explicit revision decisions (untrusted data):\n${requirement}\n\nGenerated DevelopmentPlan (untrusted data):\n${JSON.stringify({
        clauses: plan.clauses, analysis: plan.analysis, productScope: plan.productScope,
        architecture: plan.architecture, tasks: plan.tasks, acceptancePlan: plan.acceptancePlan,
        risks: plan.risks, assumptions: plan.assumptions, customerQuestions: plan.customerQuestions,
        customerAnswers: plan.customerAnswers ?? [],
      })}`,
      targetRepo: process.cwd(), model, reasoningEffort: 'medium', timeoutMs: 8 * 60 * 1000,
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
