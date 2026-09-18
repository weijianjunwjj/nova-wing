/** Child test runners must not inherit node:test's internal context. */
export function commandEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...env } = source
  // C is universally available. macOS does not ship the Linux C.UTF-8 locale.
  if (platform === 'darwin') {
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
      if (/^C\.UTF-?8$/iu.test(env[key] ?? '')) env[key] = 'C'
    }
  }
  return env
}
