export type AcceptanceCriterionKind = 'COMMAND_BEARING' | 'NON_COMMAND'

const EXECUTABLE = /(?:^|[^A-Za-z0-9_./\\-])((?:npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest)(?:\.(?:exe|cmd))?|\.venv[\\/]Scripts[\\/]python\.exe)(?=\s|[;&|<>]|$)/giu
const RESULT_ONLY = /^(?:(?:并)?(?:应当|应该|应|必须|需要|需|确保)?(?:通过|成功)|(?:and\s+)?(?:(?:should|must)\s+|ensure\s+)?(?:pass|passes|succeed|succeeds))[。.,，;；:：]*$/iu
const OPTION = /^--?[A-Za-z][A-Za-z0-9-]*(?=[=\s。.,，;；:："'`”’&|<>]|$)/u
const PACKAGE_ACTION = /^(?:run\s+(?:"[A-Za-z0-9][A-Za-z0-9:_-]*"|'[A-Za-z0-9][A-Za-z0-9:_-]*'|[A-Za-z0-9][A-Za-z0-9:_-]*)|run|test|build|lint|check|typecheck|install|add|remove|update|exec|publish)(?=[\s。.,，;；:："'`”’&|<>]|$)/iu
const GIT_ACTION = /^(?:diff|status|log|show|rev-parse|ls-files|ls-tree|grep|fsck|add|commit|push|pull|fetch|merge|rebase|reset|restore|checkout|switch|branch|tag|clean|clone|init)(?=[\s。.,，;；:："'`”’&|<>]|$)/iu
const PROGRAM_PATH = /^(?:"[^"\r\n]+\.(?:[cm]?[jt]sx?|py)"|'[^'\r\n]+\.(?:[cm]?[jt]sx?|py)'|[^\s"']+\.(?:[cm]?[jt]sx?|py))(?=[\s。,，;；:：&|<>]|$)/iu

/**
 * Classify syntax before attempting natural-language command extraction.
 * A tool name or a request for successful tests is not an invocation. Require
 * an executable plus an action, option or program path; zero-argument tools
 * must occupy the command position. This grants no execution permission and
 * does not prove a safe command boundary (conditional/compound prose can still
 * contain a command and must fail extraction).
 *
 * All system-state, business and constraint prose stays NON_COMMAND unless it
 * actually contains such syntax. No semantic keyword blacklist is involved.
 */
export function classifyAcceptanceCriterion(sourceText: string): AcceptanceCriterionKind {
  const text = sourceText.trim().replace(/^(?:(?:运行|执行)\s*|run\s+)/iu, '')
  for (const match of text.matchAll(EXECUTABLE)) {
    const executable = match[1]!.toLowerCase().replace(/\.(?:exe|cmd)$/u, '')
    const tail = text.slice(match.index + match[0].length).trimStart()
    let invocation = false
    if (executable === 'git') invocation = GIT_ACTION.test(tail) || OPTION.test(tail)
    else if (['npm', 'pnpm', 'yarn'].includes(executable)) invocation = PACKAGE_ACTION.test(tail) || OPTION.test(tail)
    else if (executable === 'node') invocation = OPTION.test(tail) || PROGRAM_PATH.test(tail)
    else if (executable === 'npx') invocation = /^[A-Za-z0-9@][A-Za-z0-9@/._-]*(?=\s|$)/u.test(tail) || OPTION.test(tail)
    else if (executable.startsWith('.venv')) invocation = /^-m\s+pytest(?=[\s。.,，;；:：]|$)/iu.test(tail)
    else invocation = OPTION.test(tail) || PROGRAM_PATH.test(tail) ||
      /^(?:run|watch|list)(?=[\s。.,，;；:：]|$)/iu.test(tail) ||
      (match.index === 0 && (tail.length === 0 || RESULT_ONLY.test(tail) || /^[;&|<>]/u.test(tail)))
    if (invocation) return 'COMMAND_BEARING'
  }
  return 'NON_COMMAND'
}
