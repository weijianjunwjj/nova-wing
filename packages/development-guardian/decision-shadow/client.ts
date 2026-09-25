import type { DecisionChoice, DecisionShadowStateProjection } from './contract.js'

export type DecisionClientOutcome =
  | { status: 'ok'; latencyMs: number; decision: DecisionChoice }
  | { status: 'timeout' | 'http_error' | 'invalid_response' | 'exception'; latencyMs: number }

export interface DecisionClient {
  decide(state: DecisionShadowStateProjection): Promise<DecisionClientOutcome>
}
