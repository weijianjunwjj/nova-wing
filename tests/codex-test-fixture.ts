import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export async function codexTestRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-codex-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true })
  execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true })
  return root
}
