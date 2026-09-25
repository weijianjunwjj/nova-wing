import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { RuntimeConfigV1 } from './contract.js'
import { canonicalRuntimeConfigJson } from './contract.js'

export interface StoredRuntimeConfig {
  sourceKey: string
  contractVersion: 1
  payload: unknown
  payloadSha256: string
  fetchedAt: string
  validatedAt: string
}

export function runtimeConfigSourceKey(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex')
}

export class RuntimeConfigStore {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.withDb((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_config_lkg (
        source_key TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL CHECK(contract_version = 1),
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        validated_at TEXT NOT NULL
      )
    `))
  }

  private withDb<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path)
    try { db.exec('PRAGMA busy_timeout = 5000'); return operation(db) } finally { db.close() }
  }

  save(sourceKey: string, config: RuntimeConfigV1, fetchedAt: string, validatedAt: string): StoredRuntimeConfig {
    const payloadJson = canonicalRuntimeConfigJson(config)
    const payloadSha256 = createHash('sha256').update(payloadJson).digest('hex')
    this.withDb((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`INSERT INTO runtime_config_lkg
          (source_key, contract_version, payload_json, payload_sha256, fetched_at, validated_at)
          VALUES (?, 1, ?, ?, ?, ?)
          ON CONFLICT(source_key) DO UPDATE SET
            contract_version=excluded.contract_version, payload_json=excluded.payload_json,
            payload_sha256=excluded.payload_sha256, fetched_at=excluded.fetched_at,
            validated_at=excluded.validated_at`)
          .run(sourceKey, payloadJson, payloadSha256, fetchedAt, validatedAt)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    return { sourceKey, contractVersion: 1, payload: JSON.parse(payloadJson) as unknown, payloadSha256, fetchedAt, validatedAt }
  }

  read(sourceKey?: string): StoredRuntimeConfig | undefined {
    return this.withDb((db) => {
      const row = sourceKey === undefined
        ? db.prepare('SELECT * FROM runtime_config_lkg ORDER BY validated_at DESC LIMIT 1').get()
        : db.prepare('SELECT * FROM runtime_config_lkg WHERE source_key=?').get(sourceKey)
      if (row === undefined) return undefined
      const payloadJson = String(row.payload_json)
      const payloadSha256 = String(row.payload_sha256)
      if (createHash('sha256').update(payloadJson).digest('hex') !== payloadSha256) return undefined
      let payload: unknown
      try { payload = JSON.parse(payloadJson) as unknown } catch { return undefined }
      if (Number(row.contract_version) !== 1) return undefined
      return {
        sourceKey: String(row.source_key), contractVersion: 1, payload, payloadSha256,
        fetchedAt: String(row.fetched_at), validatedAt: String(row.validated_at),
      }
    })
  }
}
