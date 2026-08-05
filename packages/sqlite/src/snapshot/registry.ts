export const NOVAWING_AUTHORITATIVE_TABLES = [
  {
    name: 'nw_meta',
    primaryKey: ['key'],
    restoreOrderBy: ['key'],
    includedInSnapshot: true,
  },
  {
    name: 'nw_proposals',
    primaryKey: ['id'],
    restoreOrderBy: ['created_at', 'id'],
    includedInSnapshot: true,
  },
  {
    name: 'nw_mainline_entries',
    primaryKey: ['id'],
    restoreOrderBy: ['core_revision'],
    includedInSnapshot: true,
  },
] as const

export type NovaWingAuthoritativeTableName =
  (typeof NOVAWING_AUTHORITATIVE_TABLES)[number]['name']

export interface NovaWingAuthoritativeTableDescriptor {
  readonly name: NovaWingAuthoritativeTableName
  readonly primaryKey: readonly string[]
  readonly restoreOrderBy: readonly string[]
  readonly includedInSnapshot: true
}

export const NOVAWING_AUTHORITATIVE_TABLE_NAMES: readonly NovaWingAuthoritativeTableName[] =
  NOVAWING_AUTHORITATIVE_TABLES.map((table) => table.name)

