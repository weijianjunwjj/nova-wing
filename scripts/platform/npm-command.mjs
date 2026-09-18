import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Execute npm's JS CLI with Node. Never spawn a Windows .cmd through a shell. */
export function npmCommand(args, env = process.env) {
  const candidates = [env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const cli = candidates.find((path) => path && existsSync(path))
  if (!cli) throw new Error('npm CLI is unavailable; run this command through npm run with Node.js 24+')
  return { executable: process.execPath, args: [cli, ...args] }
}
