import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TaskRunAnalyticsProjector,
  TaskRunAnalyticsStore,
  WorkSessionRuntime,
  backfillTaskRunAnalytics,
  defaultStorageUrl,
  defaultTaskRunAnalyticsPath,
  defaultTrustedConfigDirectory,
  loadTrustedWorkSessionConfig,
  renderChineseTaskRunReport,
} from 'nova-wing/development-guardian'

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const configDirectory = option('--config-dir') ?? defaultTrustedConfigDirectory(process.env)
const analyticsPath = option('--analytics-path') ?? defaultTaskRunAnalyticsPath(process.env)
const requestedTask = option('--task')
const store = new TaskRunAnalyticsStore(analyticsPath)
const projector = new TaskRunAnalyticsProjector(store)
let projected = 0
let skipped = 0
const failures = []

try {
  const files = (await readdir(configDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  for (const entry of files) {
    const configPath = join(configDirectory, entry.name)
    let runtime
    try {
      const config = await loadTrustedWorkSessionConfig(configPath)
      const definition = {
        id: config.session.id,
        targetRepo: config.session.targetRepo,
        branch: config.session.branch,
        tasks: config.tasks.map((task) => ({ id: task.id, goal: task.goal,
          constraints: task.guardian.constraints, acceptanceCriteria: task.guardian.acceptanceCriteria,
          allowedPaths: task.guardian.allowedPaths, forbiddenPaths: task.guardian.forbiddenPaths,
          ...(task.acceptanceEvidenceBindings === undefined ? {} : { acceptanceEvidenceBindings: task.acceptanceEvidenceBindings }) })),
        limits: { ...config.session.limits },
        scheduledStartAt: config.session.scheduledStartAt ?? null,
        scheduleSource: config.session.scheduleSource ?? 'immediate',
        ...(config.session.createdAt === undefined ? {} : { createdAt: config.session.createdAt }),
        ...(config.session.controlPlane === undefined ? {} : { controlPlane: config.session.controlPlane }),
      }
      if (requestedTask !== undefined && !definition.tasks.some((task) => task.id === requestedTask)) continue
      const storageUrl = config.storageUrl ?? defaultStorageUrl(config.session.id, process.env)
      runtime = new WorkSessionRuntime({ definition, storageUrl, taskRunner: { async run() { return { status: 'FAILED', error: 'read-only analytics backfill' } } } })
      const state = await runtime.loadPersistedState()
      if (state === undefined) { skipped += definition.tasks.length; continue }
      const result = backfillTaskRunAnalytics(projector, [{ definition, state }])
      projected += result.projected; skipped += result.skipped
    } catch (error) {
      skipped += 1
      failures.push({ config: entry.name, error: error instanceof Error ? error.message : String(error) })
    } finally {
      await runtime?.close().catch(() => undefined)
    }
  }
  const selected = requestedTask === undefined ? [] : store.findByTask(requestedTask)
  process.stdout.write(`${JSON.stringify({ analyticsPath, projected, skipped, failures, selected }, null, 2)}\n`)
  if (selected[0] !== undefined) process.stdout.write(`\n${renderChineseTaskRunReport(selected[0])}\n`)
} finally {
  store.close()
}
