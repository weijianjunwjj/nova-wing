import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { VerificationResult } from '../model.js'
import { redactSensitiveText } from './failure-classification.js'
import { parseGitStatus } from './worktree-fingerprint.js'

type ReadOnlyGit = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\')
}

/** Read the current diff without invoking repository diff drivers or external tools. */
export async function readAutonomousRecoveryDiff(repositoryRoot: string, git: ReadOnlyGit): Promise<string> {
  const [diff, status] = await Promise.all([
    git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--']),
    git(['status', '--porcelain', '-z', '--untracked-files=all']),
  ])
  if (diff.exitCode !== 0 || status.exitCode !== 0) throw new Error('recovery diff inspection failed')
  const root = await realpath(repositoryRoot)
  const additions: string[] = []
  for (const entry of parseGitStatus(status.stdout)) {
    if (entry.status !== '??') continue
    const path = await realpath(resolve(root, entry.path))
    if (!inside(root, path)) throw new Error('untracked evidence escapes the repository')
    const info = await stat(path)
    if (!info.isFile() || info.size > 256_000) throw new Error('untracked evidence cannot be safely inspected')
    const content = await readFile(path, 'utf8')
    if (content.includes('\0')) throw new Error('binary recovery evidence requires human inspection')
    additions.push(`Untracked file: ${entry.path}\n${content}`)
  }
  return redactSensitiveText([diff.stdout, ...additions].join('\n'))
}

/** Only the existing verifier artifact directory can supply stdout/stderr evidence. */
export async function readAutonomousVerificationOutput(directory: string, result: VerificationResult): Promise<string | undefined> {
  if (result.rawOutputRef === undefined) return undefined
  const [root, path] = await Promise.all([realpath(directory), realpath(result.rawOutputRef)])
  if (!inside(root, path)) throw new Error('verification output is outside the session artifact directory')
  return redactSensitiveText(await readFile(path, 'utf8'))
}
