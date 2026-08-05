/* global console */
import { DatabaseSync } from 'node:sqlite'

import {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  inspectNovaWingMigration,
  migrateNovaWing,
} from 'nova-wing/sqlite'

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
