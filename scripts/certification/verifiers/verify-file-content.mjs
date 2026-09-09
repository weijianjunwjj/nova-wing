#!/usr/bin/env node
/**
 * NovaWing certification verifier fixture (test-only).
 *
 * Passes when `<repoPath>/<relPath>` file content equals `<expected>`.
 * This verifier reads the repository only; it never mutates it.
 *
 * Usage: node verify-file-content.mjs <repoPath> <relPath> <expected>
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [, , repoPath, relPath, expected] = process.argv
if (repoPath === undefined || relPath === undefined || expected === undefined) {
  process.stderr.write('usage: verify-file-content.mjs <repoPath> <relPath> <expected>\n')
  process.exit(2)
}

async function main() {
  const actual = await readFile(join(repoPath, relPath), 'utf8')
  if (actual === expected) {
    process.stdout.write(`${JSON.stringify({ name: process.argv.slice(2).join(' '), status: 'passed' })}\n`)
    process.exit(0)
  }
  process.stdout.write(`${JSON.stringify({ name: process.argv.slice(2).join(' '), status: 'failed', details: 'file content mismatch' })}\n`)
  process.exit(1)
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ name: process.argv.slice(2).join(' '), status: 'failed', details: String(error) })}\n`)
  process.exit(1)
})
