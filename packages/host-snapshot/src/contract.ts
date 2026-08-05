import { createHash } from 'node:crypto'

export const HOST_SNAPSHOT_V3_FORMAT = 'host.snapshot.v3' as const
export const HOST_SNAPSHOT_V3_VERSION = 3 as const

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface ComponentSnapshotTableManifest {
  name: string
  rowCount: number
  contentDigest: string
}

export interface ComponentSnapshotManifest {
  component: string
  format: string
  snapshotVersion: number
  schemaVersion: number
  metadata: Readonly<Record<string, JsonValue>>
  tables: ComponentSnapshotTableManifest[]
  manifestDigest: string
}

export interface HostSnapshotIdentity {
  name: string
  appVersion: string
  schemaVersion: number
}

export interface HostSnapshotV3Manifest {
  format: typeof HOST_SNAPSHOT_V3_FORMAT
  snapshotVersion: typeof HOST_SNAPSHOT_V3_VERSION
  createdAt: string
  host: HostSnapshotIdentity
  components: ComponentSnapshotManifest[]
  componentsDigest: string
  manifestDigest: string
}

export type HostSnapshotErrorCode =
  | 'COMPONENT_CONFLICT'
  | 'COMPONENT_MANIFEST_INVALID'
  | 'COMPONENT_VALIDATION_FAILED'
  | 'HOST_MANIFEST_INVALID'
  | 'OWNERSHIP_VIOLATION'
  | 'UNKNOWN_COMPONENT'

export class HostSnapshotError extends Error {
  readonly code: HostSnapshotErrorCode
  override readonly cause?: unknown

  constructor(code: HostSnapshotErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'HostSnapshotError'
    this.code = code
    if (options !== undefined && 'cause' in options) {
      this.cause = options.cause
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly JsonValue[]
    return `[${arrayValue.map((item) => canonicalize(item)).join(',')}]`
  }
  const objectValue = value as Readonly<Record<string, JsonValue>>
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key] as JsonValue)}`)
    .join(',')}}`
}

export function digestSnapshotValue(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

function tableDigestValue(table: ComponentSnapshotTableManifest): JsonValue {
  return {
    contentDigest: table.contentDigest,
    name: table.name,
    rowCount: table.rowCount,
  }
}

function componentDigestValue(
  manifest: Omit<ComponentSnapshotManifest, 'manifestDigest'>,
): Readonly<Record<string, JsonValue>> {
  return {
    component: manifest.component,
    format: manifest.format,
    metadata: manifest.metadata,
    schemaVersion: manifest.schemaVersion,
    snapshotVersion: manifest.snapshotVersion,
    tables: [...manifest.tables]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(tableDigestValue),
  }
}

function componentManifestValue(manifest: ComponentSnapshotManifest): JsonValue {
  return {
    ...componentDigestValue(manifest),
    manifestDigest: manifest.manifestDigest,
  }
}

export function createComponentSnapshotManifest(
  input: Omit<ComponentSnapshotManifest, 'manifestDigest'>,
): ComponentSnapshotManifest {
  const normalized = {
    ...input,
    tables: [...input.tables].sort((left, right) => left.name.localeCompare(right.name)),
  }
  return {
    ...normalized,
    manifestDigest: digestSnapshotValue(componentDigestValue(normalized)),
  }
}

function validateComponentTable(value: unknown): ComponentSnapshotTableManifest {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !isNonNegativeInteger(value.rowCount) ||
    !isDigest(value.contentDigest)
  ) {
    throw new HostSnapshotError(
      'COMPONENT_MANIFEST_INVALID',
      'component table descriptor is invalid',
    )
  }
  return value as unknown as ComponentSnapshotTableManifest
}

export function validateComponentSnapshotManifest(
  value: unknown,
): ComponentSnapshotManifest {
  if (
    !isRecord(value) ||
    typeof value.component !== 'string' ||
    value.component.length === 0 ||
    typeof value.format !== 'string' ||
    value.format.length === 0 ||
    !isNonNegativeInteger(value.snapshotVersion) ||
    value.snapshotVersion === 0 ||
    !isNonNegativeInteger(value.schemaVersion) ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.tables) ||
    !isDigest(value.manifestDigest)
  ) {
    throw new HostSnapshotError(
      'COMPONENT_MANIFEST_INVALID',
      'component manifest header is invalid',
    )
  }
  const tables = value.tables.map(validateComponentTable)
  if (new Set(tables.map((table) => table.name)).size !== tables.length) {
    throw new HostSnapshotError(
      'COMPONENT_MANIFEST_INVALID',
      `component ${value.component} contains duplicate tables`,
    )
  }
  const manifest = value as unknown as ComponentSnapshotManifest
  const expected = createComponentSnapshotManifest({
    component: manifest.component,
    format: manifest.format,
    snapshotVersion: manifest.snapshotVersion,
    schemaVersion: manifest.schemaVersion,
    metadata: manifest.metadata,
    tables,
  })
  if (manifest.manifestDigest !== expected.manifestDigest) {
    throw new HostSnapshotError(
      'COMPONENT_MANIFEST_INVALID',
      `component ${manifest.component} digest does not match its contents`,
    )
  }
  return { ...manifest, tables: [...tables].sort((a, b) => a.name.localeCompare(b.name)) }
}

function hostDigestValue(
  manifest: Omit<HostSnapshotV3Manifest, 'manifestDigest'>,
): JsonValue {
  return {
    components: manifest.components.map(componentManifestValue),
    componentsDigest: manifest.componentsDigest,
    createdAt: manifest.createdAt,
    format: manifest.format,
    host: {
      appVersion: manifest.host.appVersion,
      name: manifest.host.name,
      schemaVersion: manifest.host.schemaVersion,
    },
    snapshotVersion: manifest.snapshotVersion,
  }
}

export function createHostSnapshotV3Manifest(input: {
  createdAt: string
  host: HostSnapshotIdentity
  components: readonly ComponentSnapshotManifest[]
}): HostSnapshotV3Manifest {
  const components = [...input.components]
    .map(validateComponentSnapshotManifest)
    .sort((left, right) => left.component.localeCompare(right.component))
  const componentsDigest = digestSnapshotValue(components.map(componentManifestValue))
  const withoutDigest: Omit<HostSnapshotV3Manifest, 'manifestDigest'> = {
    format: HOST_SNAPSHOT_V3_FORMAT,
    snapshotVersion: HOST_SNAPSHOT_V3_VERSION,
    createdAt: input.createdAt,
    host: { ...input.host },
    components,
    componentsDigest,
  }
  return {
    ...withoutDigest,
    manifestDigest: digestSnapshotValue(hostDigestValue(withoutDigest)),
  }
}

export function validateHostSnapshotV3Manifest(value: unknown): HostSnapshotV3Manifest {
  if (
    !isRecord(value) ||
    value.format !== HOST_SNAPSHOT_V3_FORMAT ||
    value.snapshotVersion !== HOST_SNAPSHOT_V3_VERSION ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.host) ||
    typeof value.host.name !== 'string' ||
    value.host.name.length === 0 ||
    typeof value.host.appVersion !== 'string' ||
    value.host.appVersion.length === 0 ||
    !isNonNegativeInteger(value.host.schemaVersion) ||
    !Array.isArray(value.components) ||
    !isDigest(value.componentsDigest) ||
    !isDigest(value.manifestDigest)
  ) {
    throw new HostSnapshotError('HOST_MANIFEST_INVALID', 'host snapshot manifest header is invalid')
  }
  const components = value.components.map(validateComponentSnapshotManifest)
  if (new Set(components.map((component) => component.component)).size !== components.length) {
    throw new HostSnapshotError('HOST_MANIFEST_INVALID', 'host manifest contains duplicate components')
  }
  const expected = createHostSnapshotV3Manifest({
    createdAt: value.createdAt,
    host: value.host as unknown as HostSnapshotIdentity,
    components,
  })
  if (
    value.componentsDigest !== expected.componentsDigest ||
    value.manifestDigest !== expected.manifestDigest
  ) {
    throw new HostSnapshotError(
      'HOST_MANIFEST_INVALID',
      'host snapshot digest does not match all component manifests',
    )
  }
  return expected
}
