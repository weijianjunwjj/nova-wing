import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { runStagedEquivalentDiffCheck } from '../packages/development-guardian/claude-code-executor.js'

async function git(repoPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoPath })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`)))
  })
}

async function createRepo(): Promise<{ base: string; repo: string }> {
  const base = await mkdtemp(join(tmpdir(), 'guardian-staged-check-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await git(repo, ['init'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test User'])
  await writeFile(join(repo, 'tracked.ts'), 'export const tracked = 1\n')
  await git(repo, ['add', 'tracked.ts'])
  await git(repo, ['commit', '-m', 'base'])
  return { base, repo }
}

async function status(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error('status failed')))
  })
}

test('staged-equivalent diff check catches untracked whitespace without mutating real index', async () => {
  const { base, repo } = await createRepo()
  try {
    const file = join(repo, 'new.py')
    const contents = 'x = 1\n\n'
    await writeFile(file, contents)
    const check = await runStagedEquivalentDiffCheck(repo, 10_000)
    assert.notEqual(check.exitCode, 0)
    assert.match(check.stdout + check.stderr, /new blank line at EOF/)
    assert.equal(await readFile(file, 'utf8'), contents)
    assert.match(await status(repo), /^\?\? new\.py/m)
    await git(repo, ['diff', '--cached', '--quiet'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('staged-equivalent diff check accepts legal tracked and untracked changes and ignores runtime artifacts', async () => {
  const { base, repo } = await createRepo()
  try {
    await writeFile(join(repo, 'tracked.ts'), 'export const tracked = 2\n')
    await writeFile(join(repo, 'new.py'), 'x = 1\n')
    await mkdir(join(repo, '.venv'), { recursive: true })
    await writeFile(join(repo, '.venv', 'generated.py'), 'x = 1\n\n')
    const check = await runStagedEquivalentDiffCheck(repo, 10_000)
    assert.equal(check.exitCode, 0, check.stderr)
    assert.match(await status(repo), /^ M tracked\.ts/m)
    assert.match(await status(repo), /^\?\? new\.py/m)
    await git(repo, ['diff', '--cached', '--quiet'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
