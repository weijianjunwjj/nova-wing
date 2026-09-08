/**
 * NovaWing v0.1 vs v0.2 benchmark CLI.
 *
 *   node dist-tests/tests/benchmark/run-benchmark.js --all
 *   node dist-tests/tests/benchmark/run-benchmark.js --task T06 --mode v1
 *
 * Deterministic control-plane comparison. LLM-dependent KPIs are reported as
 * UNAVAILABLE; see docs/benchmark report for full limitations.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  executedTasks,
  loadCatalog,
  providerHealthSnapshot,
  runTask,
  type BenchmarkMetrics,
  type TaskRun,
} from './harness.js'

interface CliOptions {
  task: string | undefined
  mode: 'v1' | 'v2' | 'both'
  all: boolean
  out: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { task: undefined, mode: 'both', all: false, out: 'benchmark/results.json' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--task') options.task = argv[++index]
    else if (arg === '--mode') {
      const value = argv[++index]
      if (value !== 'v1' && value !== 'v2' && value !== 'both') throw new Error(`invalid --mode: ${value}`)
      options.mode = value
    } else if (arg === '--all') options.all = true
    else if (arg === '--out') options.out = argv[++index]!
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.all && options.task !== undefined) throw new Error('--all and --task are mutually exclusive')
  if (!options.all && options.task === undefined) throw new Error('provide --all or --task <id>')
  return options
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function numericAggregate(values: number[]): { mean: number; median: number; min: number; max: number; n: number } {
  return {
    n: values.length,
    mean: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    median: median(values),
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
  }
}

interface MetricAggregate {
  name: string
  mean: number
  median: number
  min: number
  max: number
}

function aggregateRuns(runs: TaskRun[]): { aggregates: MetricAggregate[]; completionRate: number; firstPassRate: number; humanInterventions: number; retryTotal: number } {
  const names: (keyof BenchmarkMetrics)[] = [
    'totalDurationMs', 'controllerDecisionCount', 'agentDispatchCount', 'providerSwitchCount',
    'handoffCount', 'verificationRunCount', 'verificationFailureCount', 'retryCount',
    'reviewCount', 'approvalCount', 'humanInterventionCount', 'taskEventCount',
  ]
  const aggregates: MetricAggregate[] = []
  for (const name of names) {
    const values = runs.map((run) => run.metrics[name] as number)
    const agg = numericAggregate(values)
    aggregates.push({ name, mean: agg.mean, median: agg.median, min: agg.min, max: agg.max })
  }
  const completed = runs.filter((run) => run.outcome.completed).length
  const firstPass = runs.filter((run) => run.outcome.completed && run.metrics.retryCount === 0).length
  const humanInterventions = runs.reduce((sum, run) => sum + (run.outcome.humanRequired || run.outcome.failed ? 1 : 0), 0)
  const retryTotal = runs.reduce((sum, run) => sum + run.metrics.retryCount, 0)
  return {
    aggregates,
    completionRate: runs.length === 0 ? 0 : completed / runs.length,
    firstPassRate: runs.length === 0 ? 0 : firstPass / runs.length,
    humanInterventions,
    retryTotal,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const catalog = loadCatalog('benchmark/tasks.json')
  const allExecuted = executedTasks(catalog)
  const selected = options.task === undefined
    ? allExecuted
    : allExecuted.filter((task) => task.id === options.task)
  if (options.task !== undefined && selected.length === 0) {
    throw new Error(`task ${options.task} is not a deterministic executed task`)
  }

  const modes: ('v1' | 'v2')[] = options.mode === 'both' ? ['v1', 'v2'] : [options.mode]
  const runs: TaskRun[] = []
  for (const task of selected) {
    for (const mode of modes) {
      runs.push(await runTask(task, mode))
    }
  }

  const validRuns = runs.filter((run) => run.valid)
  const invalidRuns = runs.filter((run) => !run.valid).map((run) => ({ taskId: run.taskId, mode: run.mode, reason: run.invalidReason ?? 'invalid' }))
  const v1Runs = validRuns.filter((run) => run.mode === 'v1')
  const v2Runs = validRuns.filter((run) => run.mode === 'v2')

  const v1Agg = aggregateRuns(v1Runs)
  const v2Agg = aggregateRuns(v2Runs)

  const durationMean = (agg: { aggregates: MetricAggregate[] }): number => agg.aggregates.find((metric) => metric.name === 'totalDurationMs')?.mean ?? 0
  const speedPct = v1Agg.aggregates.length === 0 ? null : ((durationMean(v2Agg) - durationMean(v1Agg)) / Math.max(durationMean(v1Agg), 0.0001)) * 100
  const handoffV1 = v1Runs.reduce((sum, run) => sum + run.metrics.handoffCount, 0)
  const handoffV2 = v2Runs.reduce((sum, run) => sum + run.metrics.handoffCount, 0)

  const result = {
    environment: {
      platform: process.platform,
      node: process.version,
      providers: providerHealthSnapshot(),
    },
    frozenAt: catalog.frozenAt,
    commit: { observabilityBaseline: '648d11c' },
    methodology: {
      harness: 'deterministic control-plane harness; scripted brain/executor (v0.1) and scripted dispatcher (v0.2)',
      executedTaskIds: selected.map((task) => task.id),
      repeatability: 'deterministic: single run per task/mode; identical output on repeat',
      note: 'LLM/token/quota/cost and wall-clock across live providers are UNAVAILABLE in this environment',
    },
    invalidRuns,
    runs,
    aggregated: {
      v1: v1Agg,
      v2: v2Agg,
    },
    deltas: {
      speedControlPlanePct: speedPct === null ? null : Math.round(speedPct * 100) / 100,
      speedTarget30Pct: speedPct === null ? null : speedPct <= -30,
      costPct: 'UNAVAILABLE',
      handoffV1Total: handoffV1,
      handoffV2Total: handoffV2,
      unnecessaryHandoffCount: { v1: 0, v2: 0, note: 'no provider switches occur in deterministic runs; not computed' },
      firstPassRate: { v1: v1Agg.firstPassRate, v2: v2Agg.firstPassRate },
      completionRate: { v1: v1Agg.completionRate, v2: v2Agg.completionRate },
      humanInterventionTotal: { v1: v1Agg.humanInterventions, v2: v2Agg.humanInterventions },
      retryTotal: { v1: v1Agg.retryTotal, v2: v2Agg.retryTotal },
    },
    verdicts: {
      speed: 'INSUFFICIENT_DATA',
      cost: 'UNAVAILABLE',
      handoff: 'INSUFFICIENT_DATA',
      completionReliability: v2Agg.completionRate > 0 || v1Agg.completionRate > 0 ? 'PARTIALLY_SUPPORTED' : 'INSUFFICIENT_DATA',
    },
  }

  writeFileSync(resolve(process.cwd(), options.out), `${JSON.stringify(result, null, 2)}\n`)

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    executedTaskIds: selected.map((task) => task.id),
    runCount: runs.length,
    validRuns: validRuns.length,
    v1: { completionRate: v1Agg.completionRate, firstPassRate: v1Agg.firstPassRate },
    v2: { completionRate: v2Agg.completionRate, firstPassRate: v2Agg.firstPassRate },
    writtenTo: options.out,
  }, null, 2))
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
