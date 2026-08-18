import { spawn } from 'node:child_process'
import type { ExecutionReport, VerificationReport } from './types.js'

function runGitBash(command: string, workspace: string, env?: NodeJS.ProcessEnv): Promise<ExecutionReport> {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: workspace,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (exitCode) => {
      resolve({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

export class ClaudeCodeAdapter {
  async execute(prompt: string, workspace: string): Promise<ExecutionReport> {
    return runGitBash('claude -p "$NW_GUARDIAN_PROMPT"', workspace, {
      NW_GUARDIAN_PROMPT: prompt,
    })
  }
}

export async function verifyCommands(
  commands: readonly string[],
  workspace: string,
): Promise<VerificationReport> {
  const results: VerificationReport['commands'] = []

  for (const command of commands) {
    const report = await runGitBash(command, workspace)
    results.push({
      command,
      exitCode: report.exitCode,
      stdout: report.stdout,
      stderr: report.stderr,
    })
    if (!report.ok) return { ok: false, commands: results }
  }

  return { ok: true, commands: results }
}
