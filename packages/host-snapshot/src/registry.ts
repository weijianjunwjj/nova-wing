import { DatabaseSync } from 'node:sqlite'

import {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  NOVAWING_SNAPSHOT_FORMAT,
  NOVAWING_SNAPSHOT_VERSION,
  verifyNovaWingAfterSnapshotRestore,
  verifyNovaWingBeforeSnapshotExport,
} from 'nova-wing/sqlite'
import type { NovaWingSnapshotManifest } from 'nova-wing/sqlite'

import {
  HostSnapshotError,
  createComponentSnapshotManifest,
  createHostSnapshotV3Manifest,
  validateHostSnapshotV3Manifest,
} from './contract.js'
import type {
  ComponentSnapshotManifest,
  HostSnapshotIdentity,
  HostSnapshotV3Manifest,
} from './contract.js'

export type SnapshotComponentOwner = 'host' | 'novawing'

export interface SnapshotComponent {
  readonly component: string
  readonly owner: SnapshotComponentOwner
  readonly format: string
  readonly snapshotVersion: number
  readonly authoritativeTables: readonly string[]
  verifyBeforeExport(context: unknown): ComponentSnapshotManifest
  verifyAfterRestore(context: unknown, manifest: ComponentSnapshotManifest): void
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function requireContext(
  contexts: ReadonlyMap<string, unknown>,
  component: string,
): unknown {
  if (!contexts.has(component)) {
    throw new HostSnapshotError(
      'COMPONENT_VALIDATION_FAILED',
      `context is missing for component ${component}`,
    )
  }
  return contexts.get(component)
}

export class HostSnapshotRegistry {
  readonly #components = new Map<string, SnapshotComponent>()
  readonly #tableOwners = new Map<string, string>()

  register(component: SnapshotComponent): void {
    if (
      component.component.length === 0 ||
      component.format.length === 0 ||
      !Number.isSafeInteger(component.snapshotVersion) ||
      component.snapshotVersion <= 0 ||
      component.authoritativeTables.length === 0
    ) {
      throw new HostSnapshotError('COMPONENT_CONFLICT', 'component registration is incomplete')
    }
    if (this.#components.has(component.component)) {
      throw new HostSnapshotError(
        'COMPONENT_CONFLICT',
        `component ${component.component} is already registered`,
      )
    }
    const tables = sortedUnique(component.authoritativeTables)
    if (tables.length !== component.authoritativeTables.length) {
      throw new HostSnapshotError(
        'COMPONENT_CONFLICT',
        `component ${component.component} registers a table more than once`,
      )
    }
    if (component.owner === 'host' && tables.some((table) => table.startsWith('nw_'))) {
      throw new HostSnapshotError(
        'OWNERSHIP_VIOLATION',
        `host component ${component.component} cannot own nw_* tables`,
      )
    }
    if (
      component.owner === 'novawing' &&
      (component.component !== 'novawing' ||
        !sameStrings(tables, NOVAWING_AUTHORITATIVE_TABLE_NAMES))
    ) {
      throw new HostSnapshotError(
        'OWNERSHIP_VIOLATION',
        'NovaWing must declare exactly its frozen authoritative table set',
      )
    }
    for (const table of tables) {
      const currentOwner = this.#tableOwners.get(table)
      if (currentOwner !== undefined) {
        throw new HostSnapshotError(
          'COMPONENT_CONFLICT',
          `table ${table} is already registered by ${currentOwner}`,
        )
      }
    }
    this.#components.set(component.component, component)
    for (const table of tables) {
      this.#tableOwners.set(table, component.component)
    }
  }

  list(): readonly SnapshotComponent[] {
    return [...this.#components.values()].sort((a, b) => a.component.localeCompare(b.component))
  }

  get(component: string): SnapshotComponent | undefined {
    return this.#components.get(component)
  }
}

function validateRegisteredManifest(
  component: SnapshotComponent,
  manifest: ComponentSnapshotManifest,
): void {
  if (
    manifest.component !== component.component ||
    manifest.format !== component.format ||
    manifest.snapshotVersion !== component.snapshotVersion ||
    !sameStrings(
      manifest.tables.map((table) => table.name),
      component.authoritativeTables,
    )
  ) {
    throw new HostSnapshotError(
      'COMPONENT_MANIFEST_INVALID',
      `manifest contract does not match registered component ${component.component}`,
    )
  }
}

export function createRegisteredHostSnapshotManifest(input: {
  registry: HostSnapshotRegistry
  contexts: ReadonlyMap<string, unknown>
  createdAt: string
  host: HostSnapshotIdentity
}): HostSnapshotV3Manifest {
  const components = input.registry.list().map((component) => {
    try {
      const manifest = component.verifyBeforeExport(
        requireContext(input.contexts, component.component),
      )
      validateRegisteredManifest(component, manifest)
      return manifest
    } catch (error: unknown) {
      if (error instanceof HostSnapshotError) {
        throw error
      }
      throw new HostSnapshotError(
        'COMPONENT_VALIDATION_FAILED',
        `pre-export validation failed for ${component.component}`,
        { cause: error },
      )
    }
  })
  return createHostSnapshotV3Manifest({
    createdAt: input.createdAt,
    host: input.host,
    components,
  })
}

export function validateRegisteredHostSnapshotManifest(
  value: unknown,
  registry: HostSnapshotRegistry,
): HostSnapshotV3Manifest {
  const manifest = validateHostSnapshotV3Manifest(value)
  const registered = registry.list()
  if (manifest.components.length !== registered.length) {
    throw new HostSnapshotError(
      'UNKNOWN_COMPONENT',
      'host manifest component set does not match the explicit registry',
    )
  }
  for (const componentManifest of manifest.components) {
    const component = registry.get(componentManifest.component)
    if (component === undefined) {
      throw new HostSnapshotError(
        'UNKNOWN_COMPONENT',
        `component ${componentManifest.component} is not registered`,
      )
    }
    validateRegisteredManifest(component, componentManifest)
  }
  return manifest
}

export function verifyRegisteredComponentsAfterRestore(input: {
  manifest: unknown
  registry: HostSnapshotRegistry
  contexts: ReadonlyMap<string, unknown>
}): void {
  const manifest = validateRegisteredHostSnapshotManifest(input.manifest, input.registry)
  for (const componentManifest of manifest.components) {
    const component = input.registry.get(componentManifest.component)
    if (component === undefined) {
      throw new HostSnapshotError('UNKNOWN_COMPONENT', componentManifest.component)
    }
    try {
      component.verifyAfterRestore(
        requireContext(input.contexts, component.component),
        componentManifest,
      )
    } catch (error: unknown) {
      throw new HostSnapshotError(
        'COMPONENT_VALIDATION_FAILED',
        `post-restore validation failed for ${component.component}`,
        { cause: error },
      )
    }
  }
}

function requireDatabase(context: unknown): DatabaseSync {
  if (!(context instanceof DatabaseSync)) {
    throw new TypeError('NovaWing snapshot component requires a dedicated DatabaseSync connection')
  }
  return context
}

export function createNovaWingSnapshotComponent(): SnapshotComponent {
  return {
    component: 'novawing',
    owner: 'novawing',
    format: NOVAWING_SNAPSHOT_FORMAT,
    snapshotVersion: NOVAWING_SNAPSHOT_VERSION,
    authoritativeTables: NOVAWING_AUTHORITATIVE_TABLE_NAMES,
    verifyBeforeExport(context: unknown): ComponentSnapshotManifest {
      const manifest = verifyNovaWingBeforeSnapshotExport(requireDatabase(context))
      return createComponentSnapshotManifest({
        component: 'novawing',
        format: manifest.format,
        snapshotVersion: manifest.snapshotVersion,
        schemaVersion: manifest.schemaVersion,
        metadata: { currentCoreRevision: manifest.currentCoreRevision },
        tables: manifest.tables,
      })
    },
    verifyAfterRestore(context: unknown, componentManifest: ComponentSnapshotManifest): void {
      validateRegisteredManifest(this, componentManifest)
      const currentCoreRevision = componentManifest.metadata.currentCoreRevision
      if (typeof currentCoreRevision !== 'number' || !Number.isSafeInteger(currentCoreRevision)) {
        throw new HostSnapshotError(
          'COMPONENT_MANIFEST_INVALID',
          'NovaWing component revision metadata is invalid',
        )
      }
      const manifest: NovaWingSnapshotManifest = {
        format: NOVAWING_SNAPSHOT_FORMAT,
        snapshotVersion: NOVAWING_SNAPSHOT_VERSION,
        schemaVersion: componentManifest.schemaVersion,
        currentCoreRevision,
        tables: NOVAWING_AUTHORITATIVE_TABLE_NAMES.map((name) => {
          const table = componentManifest.tables.find((candidate) => candidate.name === name)
          if (table === undefined) {
            throw new HostSnapshotError(
              'COMPONENT_MANIFEST_INVALID',
              `NovaWing table ${name} is missing from its component manifest`,
            )
          }
          return table as NovaWingSnapshotManifest['tables'][number]
        }),
      }
      verifyNovaWingAfterSnapshotRestore(requireDatabase(context), manifest)
    },
  }
}
