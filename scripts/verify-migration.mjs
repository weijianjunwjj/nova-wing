/* global console */
import { DatabaseSync } from 'node:sqlite'

import {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  inspectNovaWingMigration,
  migrateNovaWing,
} from 'nova-wing/sqlite'
import { TaskRunAnalyticsStore } from 'nova-wing/development-guardian'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const database = new DatabaseSync(':memory:')
try {
  migrateNovaWing(database)
  const firstMigration = inspectNovaWingMigration(database)
  migrateNovaWing(database)
  const secondMigration = inspectNovaWingMigration(database)

  if (firstMigration.fingerprint !== secondMigration.fingerprint) {
    throw new Error('migration changed the schema fingerprint on its second execution')
  }
  const tables = database
    .prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'nw_%'
      ORDER BY name
    `)
    .all()
    .map((row) => row.name)
  if (
    JSON.stringify(tables) !==
    JSON.stringify([...NOVAWING_AUTHORITATIVE_TABLE_NAMES].sort())
  ) {
    throw new Error(`unexpected migrated table set: ${tables.join(', ')}`)
  }

  console.log(
    JSON.stringify({
      fingerprint: firstMigration.fingerprint,
      schemaVersion: firstMigration.schemaVersion,
      tables,
      status: 'ok',
    }),
  )
} finally {
  database.close()
}

const analyticsDirectory = mkdtempSync(join(tmpdir(), 'novawing-analytics-migration-'))
const analyticsPath = join(analyticsDirectory, 'analytics.db')
try {
  new TaskRunAnalyticsStore(analyticsPath).close()
  new TaskRunAnalyticsStore(analyticsPath).close()
  const analytics = new DatabaseSync(analyticsPath)
  try {
    const tables = analytics.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'task_run_%' ORDER BY name").all().map((row) => row.name)
    const version = analytics.prepare('SELECT MAX(version) version FROM task_run_analytics_migration').get()?.version
    if (version !== 1 || !tables.includes('task_run_summary') || !tables.includes('task_run_stage') || !tables.includes('task_run_reason')) {
      throw new Error(`invalid task analytics migration: version=${String(version)} tables=${tables.join(',')}`)
    }
    console.log(JSON.stringify({ analyticsSchemaVersion: version, analyticsTables: tables, status: 'ok' }))
  } finally {
    analytics.close()
  }
} finally {
  rmSync(analyticsDirectory, { recursive: true, force: true })
}
