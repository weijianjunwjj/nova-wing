/* global process */
import { rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const allowedOutputs = new Set(['dist', 'dist-tests'])
const requestedOutput = process.argv[2]

if (requestedOutput === undefined || !allowedOutputs.has(requestedOutput)) {
  throw new Error('clean-output accepts only dist or dist-tests')
}

const outputPath = resolve(repositoryRoot, requestedOutput)
const relativePath = relative(repositoryRoot, outputPath)
if (relativePath !== requestedOutput || isAbsolute(relativePath)) {
  throw new Error('refusing to clean a path outside the repository output allowlist')
}

rmSync(outputPath, { recursive: true, force: true })
