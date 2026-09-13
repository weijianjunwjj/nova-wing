import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { architectureBenchmarkTasks, runArchitectureBenchmark, type ArchitectureBenchmarkMetrics } from './harness.js'

function mean(runs: readonly { metrics: ArchitectureBenchmarkMetrics }[], key: keyof ArchitectureBenchmarkMetrics): number {
  const values = runs.map((run) => run.metrics[key]).filter((value): value is number => typeof value === 'number')
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function rate(runs: readonly { metrics: ArchitectureBenchmarkMetrics }[], predicate: (metrics: ArchitectureBenchmarkMetrics) => boolean): number {
  return runs.length === 0 ? 0 : runs.filter((run) => predicate(run.metrics)).length / runs.length
}

function reduction(baseline: number, direct: number): number | null {
  return baseline === 0 ? null : Math.round(((baseline - direct) / baseline) * 10_000) / 100
}

async function main(): Promise<void> {
  const runs = []
  for (const task of architectureBenchmarkTasks) {
    runs.push(await runArchitectureBenchmark(task, 'CONTROLLER'))
    runs.push(await runArchitectureBenchmark(task, 'DIRECT'))
  }
  const simpleCategories = new Set(['A', 'B', 'C', 'H'])
  const controller = runs.filter((run) => run.mode === 'CONTROLLER' && simpleCategories.has(run.category))
  const direct = runs.filter((run) => run.mode === 'DIRECT' && simpleCategories.has(run.category))
  const keys = ['wallClockMs', 'controllerDecisionCount', 'dispatchCount', 'repoInspectionCount', 'gitProcessCount', 'verifierProcessCount', 'stateWriteCount', 'modelProviderCallCount'] as const
  const averages = Object.fromEntries(keys.map((key) => [key, { controller: mean(controller, key), direct: mean(direct, key) }]))
  const reductions = Object.fromEntries(keys.map((key) => [key, reduction(averages[key]!.controller, averages[key]!.direct)]))
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), methodology: 'same Task Contract, scripted provider behavior, repository state and verifier results through the production V2 runner seams',
    categories: architectureBenchmarkTasks.map((task) => ({ id: task.id, category: task.category, description: task.description })), runs,
    simpleTaskComparison: { categories: ['A', 'B', 'C', 'H'], averages, reductionsPercent: reductions,
      completionRate: { controller: rate(controller, (metrics) => metrics.completed), direct: rate(direct, (metrics) => metrics.completed) },
      firstPassRate: { controller: rate(controller, (metrics) => metrics.firstPass), direct: rate(direct, (metrics) => metrics.firstPass) } } }
  const output = resolve(process.cwd(), 'benchmark/v028-results.json')
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, simpleTaskComparison: result.simpleTaskComparison }, null, 2))
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
