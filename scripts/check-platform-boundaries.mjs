import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Exact file allowlist: a new adapter requires a reviewed entry and rationale. */
export const platformAdapters = {
  'packages/development-guardian/platform/windows-git.ts': 'Verified Git for Windows installation discovery, registry and child PATH.',
  'desktop/main/platform.mjs': 'Early Windows AUMID and stable Toast activator identity.',
  'desktop/main/tray-icon.mjs': 'Host status-bar image selection and macOS template-image behaviour.',
  'scripts/platform/windows-package.mjs': 'Windows x64 NSIS staging and native package content audit.',
  'scripts/platform/macos-package.mjs': 'macOS arm64 .app staging, bundle identity and native package content audit.',
  'scripts/platform/third-party-licenses.mjs': 'Electron/Chromium distribution notice placement, bundle-level notice byte verification and DMG/ZIP container inspection via host unzip/hdiutil.',
  'scripts/platform/desktop-package-resolver.mjs': 'Single reviewed host-to-packaging-adapter selection.',
  'packages/development-guardian/platform/shell.ts': 'Native Git Bash / POSIX Bash contract and fingerprint.',
  'packages/development-guardian/platform/paths.ts': 'OS config/data roots, path identity and CLI path conversion.',
  'packages/development-guardian/platform/executables.ts': 'Native executable names, legacy Python task parsing and child environment allowlist.',
  'packages/development-guardian/platform/codex-runtime.ts': 'SDK-owned native package target matrix.',
  'packages/development-guardian/platform/codex-development-runtime.ts': 'Explicit legacy Windows WSL probe; never required by SDK executor.',
  'packages/development-guardian/platform/secret-protection.ts': 'Windows protected ACL / POSIX private modes, fail closed.',
  'packages/development-guardian/platform/process.ts': 'Owned child process cleanup, guarded Windows tree kill.',
  'packages/development-guardian/platform/environment.ts': 'Host locale compatibility and verifier test context isolation.',
  'packages/development-guardian/platform/posix-toolchain.ts': 'Bounded host toolchain discovery and verifier executable preflight.',
  'packages/development-guardian/platform/browser.ts': 'Optional browser discovery/opening for each host.',
  'packages/development-guardian/platform/windows-repair-notifier.ts': 'Guarded optional Windows toast adapter.',
  'packages/development-guardian/platform/windows-runtime-repair-notifier.ts': 'Guarded optional Windows toast adapter.',
  'packages/development-guardian/platform/windows-task-run-notifier.ts': 'Guarded optional Windows toast adapter.',
  'scripts/platform/npm-command.mjs': 'Node/npm CLI process entrypoint for tooling without shell shims.',
  'scripts/platform/desktop-smoke-environment.mjs': 'Isolated Electron smoke environment and owned child process cleanup for each host.',
  'scripts/run-isolated-tests.mjs': 'Test-only process entrypoint: temporary HOME, OS data/config roots and Git identity before loading application code.',
  'scripts/guardian-repair-notification-smoke.mjs': 'Explicit Windows notification acceptance script, not an app prerequisite.',
  'scripts/novawing-notification-channel-smoke.mjs': 'Notification acceptance script with deliberate Windows fixtures.',
  'scripts/check-platform-boundaries.mjs': 'Static guard definitions (not runtime).',
}
const forbiddenIdentifiers = /^(?:LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMW6432|USERNAME|USERPROFILE|MSYSTEM)$/iu
const literalRules = [
  ['drive-path', /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/u],
  ['os-environment', /\b(?:LOCALAPPDATA|APPDATA|ProgramFiles|ProgramW6432|USERPROFILE|USERNAME|XDG_CONFIG_HOME|XDG_DATA_HOME)\b/iu],
  ['native-executable', /\b[\w.-]+\.(?:exe|cmd|vbs)\b/iu],
  ['windows-tool', /\b(?:icacls|wscript|cscript|powershell|MINGW\w*|MSYS|CYGWIN)\b/iu],
  ['host-directory', /(?:AppData[\\/]|Library[\\/]Application Support|\/Applications\/|\/usr\/bin\/|\/tmp(?:\/|$))/u],
  ['fixed-locale', /\bC\.UTF-?8\b/iu],
]

export function inspectCommonSource(file, source) {
  if (platformAdapters[file]) return []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const failures = []
  function flag(node, rule) {
    failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${rule}`)
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const [name, rule] of literalRules) if (rule.test(node.text)) flag(node, name)
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.test(node.text) && node.text !== 'username') flag(node, 'os-environment-identifier')
    if (ts.isBinaryExpression(node) && /process\s*\.\s*platform/u.test(node.getText(ast))) flag(node, 'platform-branch')
    if (ts.isPropertyAccessExpression(node) && ['win32', 'posix'].includes(node.name.text)) flag(node, 'path-flavor')
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...new Set(failures)]
}

export function scanPlatformBoundaries(root) {
  const failures = []
  let files = 0
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'dist-tests', 'artifacts', '.tmp', 'docs', 'benchmark'].includes(entry.name)) continue
      // Root unit-test fixtures deliberately contain platform examples. Desktop smoke
      // entries execute in Electron Main and must retain the common-source guard.
      if (directory === root && entry.name === 'tests') continue
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (/\.(?:ts|mjs|cjs|js)$/u.test(entry.name)) {
        files++
        failures.push(...inspectCommonSource(relative(root, absolute).replaceAll('\\', '/'), readFileSync(absolute, 'utf8')))
      }
    }
  }
  walk(root)
  return { files, failures }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] === '--root' ? resolve(process.argv[3]) : resolve(import.meta.dirname, '..')
  const { files, failures } = scanPlatformBoundaries(root)
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log(`Platform boundaries PASS: ${files} common/adapter source files; exact adapter allowlist enforced.`)
}
