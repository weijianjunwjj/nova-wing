// Commands use Bash syntax; these are command arguments, not host filesystem joins.
export function pythonRuntime(platform: NodeJS.Platform = process.platform) {
  const venv = platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  return { venv, bootstrap: `${platform === 'win32' ? 'python' : 'python3'} -m venv .venv`, pytest: `${venv} -m pytest` }
}

/** Parsing historical task contracts is portable, but new recommendations use the host. */
export const VENV_PYTEST_COMMANDS = ['.venv/Scripts/python.exe -m pytest', '.venv/bin/python -m pytest'] as const
export const VENV_PYTHON_PATHS = ['.venv/Scripts/python.exe', '.venv/bin/python'] as const
export function isVenvMissingDetail(detail: string): boolean {
  return /\.venv[/\\](?:Scripts[/\\]python\.exe|bin[/\\]python)/iu.test(detail) && /no such file or directory|\bENOENT\b|the system cannot find the file specified/iu.test(detail)
}

export function codexChatGptEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA',
    'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])
  const environment = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0].toUpperCase() !== 'NO_PROXY' && allowed.has(entry[0].toUpperCase())))
  const bypasses = Object.entries(source)
    .filter(([key, value]) => key.toUpperCase() === 'NO_PROXY' && value !== undefined)
    .flatMap(([, value]) => (value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  environment.NO_PROXY = [...bypasses, 'localhost', '127.0.0.1', '::1']
    .filter((entry) => {
      const key = entry.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(',')
  return environment
}

export function isVenvPythonPath(value: string): boolean {
  return VENV_PYTHON_PATHS.some((path) => path === value.replaceAll('\\', '/'))
}
export const RECOGNIZED_EXECUTABLE_PATTERN = /(?:^|[^A-Za-z0-9_./\\-])((?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest)(?:\.(?:exe|cmd))?|\.venv[\\/](?:Scripts[\\/]python\.exe|bin[\\/]python))(?=\s|[;&|<>]|$)/giu
