import type { TaskAction } from '../work-session/task-controller.js'
import { TASK_ACTIONS } from './contract.js'
import type { DecisionShadowRecord } from './observer.js'

export interface DecisionShadowReport {
  samples: number
  successful: number
  errors: number
  exact_match_rate: number | null
  by_reference_action: Record<TaskAction, { samples: number; successful: number; matches: number; match_rate: number | null }>
  confusion_matrix: Record<TaskAction, Partial<Record<TaskAction, number>>>
  latency_p50: number | null
  latency_p95: number | null
  confidence_avg: number | null
  confidence_match_avg: number | null
  confidence_mismatch_avg: number | null
  input_tokens_total: number
  output_tokens_total: number
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null
}

export function buildDecisionShadowReport(records: readonly DecisionShadowRecord[]): DecisionShadowReport {
  const ok = records.filter((record) => record.shadow.status === 'ok' && record.shadow.action !== null && record.match !== null)
  const byReference = Object.fromEntries(TASK_ACTIONS.map((action) => [action, { samples: 0, successful: 0, matches: 0, match_rate: null as number | null }])) as DecisionShadowReport['by_reference_action']
  const confusion = Object.fromEntries(TASK_ACTIONS.map((action) => [action, {}])) as DecisionShadowReport['confusion_matrix']
  for (const record of records) byReference[record.reference.action].samples++
  for (const record of ok) {
    const row = byReference[record.reference.action]
    row.successful++
    if (record.match) row.matches++
    const action = record.shadow.action!
    confusion[record.reference.action][action] = (confusion[record.reference.action][action] ?? 0) + 1
  }
  for (const row of Object.values(byReference)) row.match_rate = row.successful === 0 ? null : row.matches / row.successful
  const confidence = ok.flatMap((record) => record.shadow.confidence === null ? [] : [record.shadow.confidence])
  const matchedConfidence = ok.flatMap((record) => record.match && record.shadow.confidence !== null ? [record.shadow.confidence] : [])
  const mismatchedConfidence = ok.flatMap((record) => !record.match && record.shadow.confidence !== null ? [record.shadow.confidence] : [])
  return {
    samples: records.length,
    successful: ok.length,
    errors: records.length - ok.length,
    exact_match_rate: ok.length === 0 ? null : ok.filter((record) => record.match).length / ok.length,
    by_reference_action: byReference,
    confusion_matrix: confusion,
    latency_p50: percentile(ok.flatMap((record) => record.shadow.latencyMs === null ? [] : [record.shadow.latencyMs]), 0.5),
    latency_p95: percentile(ok.flatMap((record) => record.shadow.latencyMs === null ? [] : [record.shadow.latencyMs]), 0.95),
    confidence_avg: average(confidence),
    confidence_match_avg: average(matchedConfidence),
    confidence_mismatch_avg: average(mismatchedConfidence),
    input_tokens_total: ok.reduce((sum, record) => sum + (record.shadow.inputTokens ?? 0), 0),
    output_tokens_total: ok.reduce((sum, record) => sum + (record.shadow.outputTokens ?? 0), 0),
  }
}
