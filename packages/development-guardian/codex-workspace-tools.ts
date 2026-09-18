import { workspacePathKey } from './platform/paths.js'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, mkdir, writeFile, unlink, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { GuardianTask } from './model.js'
import { scopeBlockers } from './claude-code-executor.js'

const PROTECTED = new Set(['.git', '.codex', '.claude', '.openai', 'node_modules', '.venv'])

export type CodexWorkspaceProbeName = 'git_status' | 'list_files' | 'read_file'

export interface CodexWorkspaceProbeResult {
  name: CodexWorkspaceProbeName
  status: 'passed' | 'failed'
  /** This is intentionally a bounded, credential-redacted diagnostic for Human Required. */
  reason?: string
}

function safeWorkspaceError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'workspace operation failed'
  return message
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\b\s*[:=]\s*\S+/giu, '$1= [redacted]')
    .slice(0, 300)
}

export function readWorkspaceGit(cwd: string, kind: 'status' | 'diff' | 'branch' | 'head'): Promise<string> {
  const args = {
    status: ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'],
    diff: ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD'],
    branch: ['branch', '--show-current'], head: ['rev-parse', 'HEAD'],
  }[kind]
  return new Promise((resolveRun, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk; if (output.length > 2_000_000) child.kill() })
    child.stderr.resume()
    child.once('error', () => { clearTimeout(timer); reject(new Error('Workspace git inspection unavailable')) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun(output)
      else reject(new Error('Workspace git inspection failed'))
    })
  })
}

/** All Codex writes pass this host-owned boundary. Native Codex runs read-only, without shell. */
export class CodexWorkspaceTools {
  readonly commandsRun: string[] = []
  readonly probeResults: CodexWorkspaceProbeResult[] = []
  private open = true
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(readonly root: string, private readonly task: GuardianTask) {}

  static async create(root: string, task: GuardianTask): Promise<CodexWorkspaceTools> {
    if (!task.allowedPaths?.length) throw new Error('Codex requires explicit allowed paths')
    return new CodexWorkspaceTools(await realpath(root), task)
  }

  private async path(input: string, write: boolean): Promise<string> {
    const path = input.replaceAll('\\', '/')
    if (!path || path.startsWith('/') || path.includes(':') || path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part) ||
        PROTECTED.has(part.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
      throw new Error('Path is outside the permitted workspace')
    }
    const scopedTask = workspacePathKey('A') === 'a' ? { ...this.task,
      ...(this.task.allowedPaths ? { allowedPaths: this.task.allowedPaths.map(p => p.toLowerCase()) } : {}),
      ...(this.task.forbiddenPaths ? { forbiddenPaths: this.task.forbiddenPaths.map(p => p.toLowerCase()) } : {}) } : this.task
    const scopedPath = workspacePathKey(path)
    if (write && scopeBlockers(scopedTask, [scopedPath]).length > 0) throw new Error('Write violates Task scope')
    // For reads, forbidden paths are hard denials too. No symlink/junction/hardlink escapes.
    if (scopeBlockers({ ...scopedTask, allowedPaths: [] }, [scopedPath]).length > 0) throw new Error('Read violates Task scope')
    let current = this.root
    for (const part of path.split('/')) {
      current = join(current, part)
      const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return undefined
        throw e
      })
      if (info?.isSymbolicLink() || (info?.isFile() && info.nlink > 1)) throw new Error('Linked paths are not permitted')
      if (info !== undefined) current = await realpath(current)
    }
    const canonical = relative(this.root, resolve(current)).replaceAll('\\', '/')
    if (canonical.startsWith('..') || canonical.split('/').some(part => PROTECTED.has(part.toLowerCase()))) throw new Error('Path escapes workspace')
    const canonicalScope = workspacePathKey(canonical)
    if (scopeBlockers(write ? scopedTask : { ...scopedTask, allowedPaths: [] }, [canonicalScope]).length > 0) {
      throw new Error('Canonical path violates Task scope')
    }
    return current
  }

  async call(name: string, args: { path?: string; content?: string }): Promise<string> {
    const operation = this.queue.then(async () => {
      if (!this.open) throw new Error('Codex execution ownership has been released')
      if (name === 'git_status' || name === 'git_diff_summary') {
        const result = await readWorkspaceGit(this.root, name === 'git_status' ? 'status' : 'diff')
        this.commandsRun.push(name === 'git_status' ? 'git status --porcelain --untracked-files=all' : 'git diff --no-ext-diff --no-textconv --stat HEAD')
        return result
      }
      if (name === 'list_files') {
        const directory = args.path ? await this.path(args.path, false) : this.root
        const entries = await readdir(directory, { withFileTypes: true })
        const result = entries.filter((e) => !PROTECTED.has(e.name.toLowerCase()) && !e.isSymbolicLink())
          .slice(0, 1000).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n')
        this.commandsRun.push(`list_files ${args.path ?? '.'}`)
        return result
      }
      const path = await this.path(args.path ?? '', name !== 'read_file')
      if (name === 'read_file') {
        const info = await lstat(path)
        if (!info.isFile() || info.size > 512_000) throw new Error('Read requires a file under 512 KB')
        const result = await readFile(path, 'utf8')
        this.commandsRun.push(`read_file ${args.path}`)
        return result
      }
      if (name === 'write_file') {
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 512_000) throw new Error('Write exceeds limit')
        await mkdir(dirname(path), { recursive: true })
        await this.path(args.path!, true)
        await writeFile(path, args.content, 'utf8')
        this.commandsRun.push(`write_file ${args.path}`)
        return 'File written; independent Guardian verification is still required.'
      }
      if (name === 'delete_file') {
        await unlink(path)
        this.commandsRun.push(`delete_file ${args.path}`)
        return 'File deleted within Task scope.'
      }
      throw new Error('Unsupported workspace tool')
    })
    const tracked = operation.then(
      (result) => {
        if (name === 'git_status' || name === 'list_files' || name === 'read_file') {
          this.probeResults.push({ name, status: 'passed' })
        }
        return result
      },
      (error: unknown) => {
        if (name === 'git_status' || name === 'list_files' || name === 'read_file') {
          this.probeResults.push({ name, status: 'failed', reason: safeWorkspaceError(error) })
        }
        throw error
      },
    )
    this.queue = tracked.catch(() => undefined)
    return tracked
  }

  async revoke(): Promise<void> { this.open = false; await this.queue }

  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    const route = `/task/${randomUUID()}`
    const transports = new Set<StreamableHTTPServerTransport>()
    const server = createServer(async (request, response) => {
      if (!this.open || request.url !== route || request.headers.origin !== undefined || request.method !== 'POST') {
        response.writeHead(403).end(); return
      }
      const mcp = new McpServer({ name: 'novawing-workspace', version: '1.0.0' })
      const register = (name: string, description: string, inputSchema: Record<string, z.ZodType>) => {
        mcp.registerTool(name, { description, inputSchema }, async (args) => {
          try { return { content: [{ type: 'text' as const, text: await this.call(name, args) }] } }
          catch { return { isError: true, content: [{ type: 'text' as const, text: 'Workspace operation rejected or unavailable; respect Task scope.' }] } }
        })
      }
      register('list_files', 'List a repository directory (omit path for root).', { path: z.string().optional() })
      register('read_file', 'Read a current repository file before editing it.', { path: z.string() })
      register('write_file', 'Write the complete contents of one Task-authorized file.', { path: z.string(), content: z.string() })
      register('delete_file', 'Delete one Task-authorized file.', { path: z.string() })
      register('git_status', 'Inspect the real current working tree before starting or continuing.', {})
      register('git_diff_summary', 'Inspect a read-only diff summary against HEAD.', {})
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      transports.add(transport)
      response.on('close', () => { transports.delete(transport); void mcp.close() })
      try {
        // Upstream SDK's optional callbacks predate exactOptionalPropertyTypes.
        await mcp.connect(transport as Parameters<McpServer['connect']>[0])
        await transport.handleRequest(request, response)
      } catch { if (!response.headersSent) response.writeHead(500).end() }
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Workspace tool bridge unavailable')
    return {
      url: `http://127.0.0.1:${address.port}${route}`,
      close: async () => {
        await this.revoke()
        await Promise.all([...transports].map((t) => t.close()))
        await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections() })
      },
    }
  }
}
