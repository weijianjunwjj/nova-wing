import { win32 } from 'node:path'
import { spawn } from 'node:child_process'
import { guardianShellCommand } from './shell.js'
export const DEFAULT_CODEX_WSL_DISTRO = 'Ubuntu-24.04'
export const WINDOWS_WSL_EXECUTABLE = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')

export interface CodexDevelopmentRuntimeProbeOptions {
  platform?: NodeJS.Platform
  cwd: string
  distro?: string
  commandRunner?: (request: { executable: string; args: readonly string[]; timeoutMs: number }) => Promise<{
    exitCode: number; stdout: string; stderr: string; timedOut?: boolean
  }>
}

function windowsPathToWsl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const match = /^([a-z]):\/(.*)$/iu.exec(normalized)
  if (match === null) throw Object.assign(new Error('Codex workspace must use an absolute Windows drive path'), { code: 'configuration_error' })
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]}`
}

function runDevelopmentRuntimeProbe(request: { executable: string; args: readonly string[]; timeoutMs: number }): Promise<{
  exitCode: number; stdout: string; stderr: string; timedOut?: boolean
}> {
  return new Promise((resolveRun) => {
    const child = spawn(request.executable, [...request.args], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(result)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => finish({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', (code) => finish({ exitCode: code ?? 1, stdout, stderr }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: 1, stdout, stderr, timedOut: true })
    }, request.timeoutMs)
    timer.unref()
  })
}

/** Explicitly selects a development WSL distro and proves bash + cwd + Git are usable. */
export async function inspectCodexDevelopmentRuntime(options: CodexDevelopmentRuntimeProbeOptions): Promise<{
  distro: string; workspace: string; bash: string
}> {
  if ((options.platform ?? process.platform) !== 'win32') {
    const shell = guardianShellCommand('bash --version >/dev/null && git --version >/dev/null', { platform: options.platform ?? process.platform })
    const result = await (options.commandRunner ?? runDevelopmentRuntimeProbe)({ executable: shell.executable, args: shell.args, timeoutMs: 15_000 })
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error('Native bash or Git inspection failed'), { code: 'configuration_error' })
    return { distro: 'native', workspace: options.cwd, bash: shell.executable }
  }
  const distro = options.distro ?? DEFAULT_CODEX_WSL_DISTRO
  if (!/^[A-Za-z0-9._-]+$/u.test(distro) || /^docker-desktop(?:-data)?$/iu.test(distro)) {
    throw Object.assign(new Error('No supported development WSL distribution available'), { code: 'configuration_error' })
  }
  const workspace = windowsPathToWsl(options.cwd)
  const script = [
    'set -eu',
    'test "$(command -v bash)" = /usr/bin/bash -o "$(command -v bash)" = /bin/bash',
    'bash --version >/dev/null',
    'git --version >/dev/null',
    'test "$(pwd)" != /',
    'git -c safe.directory="$PWD" status --short >/dev/null',
    'printf "NOVAWING_CODEX_PREFLIGHT|%s|%s" "$(command -v bash)" "$(pwd)"',
  ].join('; ')
  const result = await (options.commandRunner ?? runDevelopmentRuntimeProbe)({
    executable: WINDOWS_WSL_EXECUTABLE,
    args: ['-d', distro, '--cd', workspace, '--exec', '/usr/bin/bash', '-lc', script],
    timeoutMs: 15_000,
  })
  if (result.exitCode !== 0 || result.timedOut === true ||
      !result.stdout.includes(`NOVAWING_CODEX_PREFLIGHT|/usr/bin/bash|${workspace}`)) {
    throw Object.assign(new Error('Codex development WSL workspace, bash, or Git inspection is unavailable'), {
      code: 'configuration_error',
    })
  }
  return { distro, workspace, bash: '/usr/bin/bash' }
}
