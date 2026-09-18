import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { platformAdapters, inspectCommonSource } from './check-platform-boundaries.mjs'

// Count matched lines, not occurrences: every line has exactly one classification.
const pattern = /process\.platform|win32|darwin|linux|[A-Z]:[\\/]|LOCALAPPDATA|APPDATA|ProgramFiles|PROGRAMFILES|ProgramW6432|USERNAME|USERPROFILE|AppData|Library\/Application Support|XDG_CONFIG_HOME|XDG_DATA_HOME|\.exe|\.cmd|bash\.exe|cmd\.exe|powershell\.exe|wscript|cscript|\.vbs|Git Bash|MINGW|MSYS|CYGWIN|WSL|icacls|chmod|0o600|windowsHide|path\.win32|path\.posix|\/tmp|tmpdir|homedir|C\.UTF-8|locale|shell:|spawn|execFile|exec\(/u
const baseline = process.argv.includes('--baseline')
const files = execFileSync('git', baseline ? ['ls-tree', '-r', '--name-only', 'ce2fea6'] : ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')
const matches = []
const excluded = ['docs/audit/platform-before.json', 'docs/audit/platform-after.json']
for (const file of [...new Set(files)].sort()) {
  if (excluded.includes(file)) continue // Generated inventories contain source excerpts; counting them recurses.
  const source = baseline ? execFileSync('git', ['show', `ce2fea6:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8')
  if (source.includes('\0')) continue
  const violations = baseline ? [] : inspectCommonSource(file, source)
  for (const [index, text] of source.split('\n').entries()) {
    if (!pattern.test(text)) continue
    let category = 'C', reason = 'Portable Node API, argv execution, SQL exec, wire-format path normalization, ordering or shared platform contract; no host requirement.'
    if (file.startsWith('tests/') || file.startsWith('benchmark/')) { category = 'D'; reason = 'Test/benchmark fixture or recorded result, not production; Windows fixtures retained with explicit host seams.' }
    else if (file.startsWith('docs/') || file.endsWith('.md') || file === 'package-lock.json' || file.startsWith('patches/') || file.startsWith('.github/')) { category = 'E'; reason = 'Documentation, dependency target metadata, upstream patch context, or explicitly selected CI runner; not common runtime.' }
    else if (file.endsWith('.vbs')) { category = 'B'; reason = 'Explicit Windows-only optional launcher; npm Launchpad entry does not invoke it.' }
    else if (platformAdapters[file]) {
      category = /windows-|secret-protection|process\.ts|codex-development-runtime/u.test(file) ? 'B' : 'C'
      reason = platformAdapters[file]
    } else if (baseline) {
      const comment = /^\s*(?:\/\/|\*|\/\*|#)/u.test(text)
      if (comment) { category = 'E'; reason = 'Source comment documents a historical or platform-specific behavior; no runtime effect.' }
      else if (file.endsWith('browser-launcher.ts') || (file.endsWith('codex-executor.ts') && index + 1 >= 113 && index + 1 <= 118)) { category = 'C'; reason = 'Host browser discovery or credential-filtered child environment belongs to the shared platform contract.' }
      else if (/notifier\.ts$|shell-contract\.ts$|codex-runtime\.ts$/u.test(file) || (file.endsWith('ask-bridge-brain.ts') && index + 1 >= 84 && index + 1 <= 123) || (file.endsWith('codex-executor.ts') && index + 1 < 113)) {
        category = 'B'; reason = 'Existing guarded native adapter; moved to explicit platform directory, preserving Windows behavior.'
      } else if (/LOCALAPPDATA|AppData|ask-bridge\.exe|Scripts.*python|hasWindowsVenvPython|[A-Z]:[\\/]|MINGW|Git Bash|Windows Git Bash only/u.test(text) || (file.endsWith('local-smtp-secrets.ts') && /win32|Windows|USERNAME|icacls/u.test(text))) {
        category = 'A'; reason = 'Windows-only default/path/probe/recommendation or inconsistent discovery in common entrypoint; replaced by shared host contract.'
      } else if (file.endsWith('browser-launcher.ts')) { category = 'C'; reason = 'Optional browser launcher needs explicit host discovery boundary; absence must not block server.' }
    } else if (/^\s*(?:\/\/|\*|\/\*|#)/u.test(text)) { category = 'E'; reason = 'Source comment only; no runtime effect.'
    } else if (violations.some((value) => value.startsWith(`${file}:${index + 1}:`))) {
      category = 'A'; reason = 'Static platform boundary violation in common source; must be resolved before PASS.'
    }
    matches.push({ file, line: index + 1, text, category, reason })
  }
}
const result = { base: baseline ? 'ce2fea6' : 'working-tree', unit: 'one matched source line; multiple tokens count once',
  excludedGeneratedInventories: excluded, total: matches.length,
  counts: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((category) => [category, matches.filter((match) => match.category === category).length])), matches }
writeFileSync(`docs/audit/platform-${baseline ? 'before' : 'after'}.json`, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ total: result.total, counts: result.counts }))
if (!baseline && result.counts.A) process.exitCode = 1
