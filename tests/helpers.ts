import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { createNovaWingFacade } from 'nova-wing/core'
import type {
  CreateProposalInput,
  NovaWingFacade,
} from 'nova-wing/core'
import {
  openSqliteNovaWingStore,
  type OpenSqliteNovaWingStoreOptions,
  type SqliteNovaWingStore,
} from 'nova-wing/sqlite'

interface TestCleanupContext {
  after(cleanup: () => void): void
}

interface Closable {
  close(): void
}

export interface TestWorkspace {
  databasePath: string
  track<T extends Closable>(resource: T): T
}

export interface TestHarness {
  facade: NovaWingFacade
  store: SqliteNovaWingStore
}

export function createTestWorkspace(test: TestCleanupContext): TestWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'nova-wing-test-'))
  const closers: Closable[] = []
  test.after(() => {
    for (const closer of closers.reverse()) {
      try {
        closer.close()
      } catch {
        // A test may intentionally close and reopen a resource.
      }
    }
    const relativeToTemp = relative(resolve(tmpdir()), resolve(root))
    if (relativeToTemp.startsWith('..') || isAbsolute(relativeToTemp)) {
      throw new Error('refusing to remove a test directory outside the system temp directory')
    }
    rmSync(root, { recursive: true, force: true })
  })
  return {
    databasePath: join(root, 'nova-wing.sqlite'),
    track<T extends Closable>(resource: T): T {
      closers.push(resource)
      return resource
    },
  }
}

export function createHarness(
  workspace: TestWorkspace,
  prefix: string,
  options: Omit<OpenSqliteNovaWingStoreOptions, 'databasePath'> = {},
): TestHarness {
  const store = workspace.track(
    openSqliteNovaWingStore({ databasePath: workspace.databasePath, ...options }),
  )
  let sequence = 0
  const facade = createNovaWingFacade(store, {
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    generateId: () => `${prefix}-${String(++sequence)}`,
  })
  return { facade, store }
}

export function manualSetInput(
  overrides: Partial<CreateProposalInput> = {},
): CreateProposalInput {
  return {
    action: 'set',
    memoryKey: 'global.current_phase',
    category: 'phase',
    assertionType: 'user_decision',
    scope: 'global',
    proposedStatement: '当前阶段优先建立稳定节奏。',
    rationale: '该原则会影响多个长期决策。',
    evidenceSummary: '用户根据近期持续证据确认。',
    sourceType: 'manual',
    ...overrides,
  }
}

export function createPending(facade: NovaWingFacade, input = manualSetInput()): string {
  const draft = facade.createProposal(input)
  facade.submitProposal(draft.id)
  return draft.id
}
