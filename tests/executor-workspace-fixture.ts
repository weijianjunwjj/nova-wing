import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

export async function createExecutorTestWorkspace(t: TestContext, label: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), `novawing-${label}-`))
  const workspace = await realpath(created)
  t.after(async () => { await rm(created, { recursive: true, force: true }) })
  return workspace
}
