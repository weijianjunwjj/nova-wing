#!/usr/bin/env node
/**
 * NovaWing certification verifier fixture (test-only).
 *
 * Passes when `<repoPath>/<relPath>` has no trailing whitespace on any line.
 * Reads only.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [, , repoPath, relPath] = process.argv
if (repoPath === undefined || relPath === undefined) {
  process.stderr.write('usage: verify-no-whitespace.mjs <repoPath> <relPath>\n')
  process.exit(2)
}

async function main() {
  const actual = await readFile(join(repoPath, relPath), 'utf8')
  const offender = actual.split(/\r?\n/u).findIndex((line) => /[ \t]+$/u.test(line))
  if (offender < 0) {
    process.stdout.write('passed\n')
    process.exit(0)
  }
  process.stdout.write(`failed: line ${offender + 1} has trailing whitespace\n`)
  process.exit(1)
}

main().catch((error) => {
  process.stdout.write(`failed: ${String(error)}\n`)
  process.exit(1)
})
