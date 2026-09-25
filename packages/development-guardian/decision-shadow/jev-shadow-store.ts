import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { platformPaths, type PlatformPathOptions } from '../platform/paths.js'
import type { JevShadowRecord } from './jev-shadow-observer.js'

export function defaultJevShadowDecisionPath(options: PlatformPathOptions = {}): string {
  return platformPaths(options).jevShadowDecisions
}

export interface JevShadowStore {
  append(record: JevShadowRecord): Promise<void>
}

export class FileJevShadowStore implements JevShadowStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(readonly path = defaultJevShadowDecisionPath()) {}

  append(record: JevShadowRecord): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    })
    this.pending = write.catch(() => undefined)
    return write
  }
}

export async function readJevShadowRecords(path = defaultJevShadowDecisionPath()): Promise<JevShadowRecord[]> {
  let contents: string
  try { contents = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return contents.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as JevShadowRecord } catch { throw new Error(`invalid Jev shadow JSONL record at line ${index + 1}`) }
  })
}
