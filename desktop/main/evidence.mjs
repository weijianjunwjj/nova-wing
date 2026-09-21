import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Local diagnostics only: callers provide fixed metadata, never prompts/env/tokens. */
export function createDesktopEvidence(dataDirectory) {
  const directory = join(dataDirectory, 'desktop')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'events.jsonl')
  return (event, detail) => {
    try { appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`, 'utf8') }
    catch (error) { console.error('DESKTOP_EVIDENCE_WRITE_FAILED', error.code) }
  }
}
