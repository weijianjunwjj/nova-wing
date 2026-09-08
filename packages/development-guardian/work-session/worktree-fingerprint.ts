/**
 * W003 Worktree Fingerprint
 * 用于验证 resume 时 worktree 是否与 checkpoint 一致
 *
 * computeWorktreeFingerprint 是唯一权威 fingerprint API，包含：
 * - normalized status/path
 * - meaningful changed/untracked file content digest
 * - stable ordering
 * - SHA-256
 */

import { createHash } from 'node:crypto'
import { readFile, lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepositoryCheckpoint } from './checkpoint.js'

export interface GitStatusEntry {
  status: string
  path: string
  /** Literal path from NUL-delimited porcelain, with no rename display syntax. */
  contentPath?: string
}

/**
 * 解析 git status --porcelain --untracked-files=all 输出
 */
export function parseGitStatus(output: string): GitStatusEntry[] {
  if (output.includes('\0')) {
    const fields = output.split('\0')
    const entries: GitStatusEntry[] = []
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!
      if (!field) continue
      const status = field.slice(0, 2)
      const path = field.slice(3)
      entries.push({ status, path, contentPath: path })
      if (/[RC]/.test(status)) {
        const source = fields[++i]
        if (source === undefined || source === '') throw new Error('invalid porcelain rename')
        entries.push({ status: status.includes('R') ? ' D' : ' C', path: source, contentPath: source })
      }
    }
    return entries
  }
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const status = line.slice(0, 2)
      const path = line.slice(3).trim()
      return { status, path }
    })
    .filter((entry) => entry.path.length > 0)
}

/**
 * 标准化路径（Windows 兼容）
 */
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '')
}

/** untracked 且位于依赖/产物目录时跳过内容读取，避免扫描整个依赖树 */
const SKIP_CONTENT_DIR_SEGMENTS = new Set(['node_modules', '.venv', 'dist'])

function shouldSkipUntrackedContent(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((segment) => SKIP_CONTENT_DIR_SEGMENTS.has(segment))
}

/** rename 输出 'old -> new'，取新路径读取内容 */
function contentPathOf(path: string): string {
  const arrow = path.indexOf(' -> ')
  return arrow >= 0 ? path.slice(arrow + 4) : path
}

/**
 * 计算 worktree fingerprint（唯一权威实现，SHA-256）
 *
 * 在 normalized status/path 基础上纳入 meaningful changed/untracked 文件
 * 的内容 digest，使同路径内容变化也能被检测：
 * - deleted 文件：内容不可读，使用 '[deleted]' 占位
 * - untracked 且位于 node_modules/.venv/dist 等依赖目录：跳过内容读取
 *   （tracked 修改即使位于这些目录也始终纳入内容）
 * - 文件读取失败（移动中/竞态）：使用 '[unreadable]' 占位，仍纳入 digest
 */
export async function computeWorktreeFingerprint(
  repoPath: string,
  entries: GitStatusEntry[],
  options: { strict?: boolean } = {},
): Promise<string> {
  const hash = createHash('sha256')

  const normalized = entries
    .map((entry) => ({
      status: entry.status,
      path: normalizePath(entry.path),
      contentPath: entry.contentPath,
    }))
    .sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path)
      if (pathCmp !== 0) return pathCmp
      return a.status.localeCompare(b.status)
    })

  for (const entry of normalized) {
    hash.update(`${entry.status}|${entry.path}\n`)

    if (!options.strict && entry.status.includes('D')) {
      hash.update('CONTENT:[deleted]\n')
      continue
    }

    if (!options.strict && entry.status.startsWith('??') && shouldSkipUntrackedContent(entry.path)) {
      hash.update('CONTENT:[untracked-skipped]\n')
      continue
    }

    const absPath = join(repoPath, entry.contentPath ?? contentPathOf(entry.path))
    try {
      if (options.strict) {
        const info = await lstat(absPath)
        hash.update('CONTENT:')
        hash.update(info.isSymbolicLink() ? await readlink(absPath) : await readFile(absPath))
        hash.update('\n')
      } else {
        const content = await readFile(absPath, 'utf8')
        hash.update(`CONTENT:${content}\n`)
      }
    } catch (error) {
      if (options.strict) {
        if (entry.status.includes('D') && (error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('CONTENT:[deleted]\n'); continue }
        throw error
      }
      hash.update('CONTENT:[unreadable]\n')
    }
  }

  return hash.digest('hex')
}

/**
 * 验证当前 worktree 是否与 checkpoint 一致
 */
export async function verifyWorktreeCheckpoint(
  checkpoint: RepositoryCheckpoint,
  currentBranch: string,
  currentHead: string,
  repoPath: string,
  currentEntries: GitStatusEntry[],
): Promise<{ matches: boolean; reason?: string }> {
  if (checkpoint.branch !== currentBranch) {
    return {
      matches: false,
      reason: `branch mismatch: expected ${checkpoint.branch}, got ${currentBranch}`,
    }
  }

  if (checkpoint.headSha !== currentHead) {
    return {
      matches: false,
      reason: `HEAD mismatch: expected ${checkpoint.headSha.slice(0, 8)}, got ${currentHead.slice(0, 8)}`,
    }
  }

  const currentFingerprint = await computeWorktreeFingerprint(repoPath, currentEntries)
  if (checkpoint.worktreeFingerprint !== currentFingerprint) {
    return {
      matches: false,
      reason: 'worktree files changed since checkpoint',
    }
  }

  return { matches: true }
}
