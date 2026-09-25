import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { platformPaths, type PlatformPathOptions } from '../platform/paths.js'
import type { DecisionShadowRecord } from './observer.js'

export function defaultDecisionShadowPath(options: PlatformPathOptions = {}): string {
  return platformPaths(options).decisionShadowRecords
}

export interface DecisionShadowStore {
  append(record: DecisionShadowRecord): Promise<void>
}

export class FileDecisionShadowStore implements DecisionShadowStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(readonly path = defaultDecisionShadowPath()) {}

  append(record: DecisionShadowRecord): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.pending = write.catch(() => undefined)
    return write
  }
}

export async function readDecisionShadowRecords(path = defaultDecisionShadowPath()): Promise<DecisionShadowRecord[]> {
  let contents: string
  try { contents = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return contents.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as DecisionShadowRecord } catch { throw new Error(`invalid decision shadow JSONL record at line ${index + 1}`) }
  })
}
