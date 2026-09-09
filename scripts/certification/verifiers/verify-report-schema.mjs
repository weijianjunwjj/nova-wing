#!/usr/bin/env node
/**
 * NovaWing certification verifier fixture (test-only).
 *
 * Passes when `<repoPath>/<relPath>` is valid JSON whose object contains all of
 * the required keys given as subsequent arguments. Reads only.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [, , repoPath, relPath, ...requiredKeys] = process.argv
if (repoPath === undefined || relPath === undefined || requiredKeys.length === 0) {
  process.stderr.write('usage: verify-report-schema.mjs <repoPath> <relPath> <key...>\n')
  process.exit(2)
}

async function main() {
  const actual = await readFile(join(repoPath, relPath), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(actual)
  } catch {
    process.stdout.write('failed: not valid JSON\n')
    process.exit(1)
  }
  const missing = requiredKeys.filter((key) => parsed?.[key] === undefined)
  if (missing.length === 0) {
    process.stdout.write('passed\n')
    process.exit(0)
  }
  process.stdout.write(`failed: missing keys ${missing.join(',')}\n`)
  process.exit(1)
}

main().catch((error) => {
  process.stdout.write(`failed: ${String(error)}\n`)
  process.exit(1)
})
