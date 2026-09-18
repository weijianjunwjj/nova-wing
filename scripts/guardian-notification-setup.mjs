/* global console, process */
import { createInterface } from 'node:readline/promises'

import {
  saveLocalSmtpSecrets,
  smtpEnvironmentFrom,
} from 'nova-wing/development-guardian'

const keys = [
  'NOVAWING_SMTP_HOST', 'NOVAWING_SMTP_PORT', 'NOVAWING_SMTP_SECURE',
  'NOVAWING_SMTP_USER', 'NOVAWING_SMTP_PASS', 'NOVAWING_NOTIFY_FROM', 'NOVAWING_NOTIFY_TO',
]

async function interactiveSecrets() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive SMTP setup requires a TTY; use --from-env instead')
  }
  const result = {}
  for (const key of keys) {
    if (key !== 'NOVAWING_SMTP_PASS') {
      const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      try { result[key] = await readline.question(`${key}: `) }
      finally { readline.close() }
      continue
    }
    // No readline listener is attached while the secret is typed: no echo.
    process.stdout.write(`${key}: `)
    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    try {
      result[key] = await new Promise((resolvePassword, rejectPassword) => {
        let value = ''
        const cleanup = () => process.stdin.off('data', read)
        function read(chunk) {
          for (const character of String(chunk)) {
            if (character === '\u0003' || character === '\u0004') { cleanup(); rejectPassword(new Error('SMTP setup cancelled')); return }
            if (character === '\r' || character === '\n') { cleanup(); resolvePassword(value); return }
            if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
            else value += character
          }
        }
        process.stdin.on('data', read)
      })
    } finally {
      process.stdin.setRawMode(wasRaw)
      process.stdin.pause()
      process.stdout.write('\n')
    }
  }
  return result
}

try {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--from-env')) {
    throw new Error('Usage: npm run guardian:notification:setup -- [--from-env]')
  }
  const secrets = process.argv[2] === '--from-env'
    ? smtpEnvironmentFrom(process.env)
    : await interactiveSecrets()
  if (secrets === undefined) {
    throw new Error('no SMTP environment values found; use interactive setup or provide all 7 values')
  }
  const location = await saveLocalSmtpSecrets(secrets)
  console.log('NovaWing SMTP notification secrets saved.')
  console.log(`Location: ${location}`)
  console.log('SMTP user: configured')
  console.log('Notify to: configured')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SMTP notification setup failed')
  process.exitCode = 1
}
