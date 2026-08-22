/* global console, process */
import { createInterface } from 'node:readline/promises'

import {
  defaultLocalSmtpSecretPath,
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
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    const result = {}
    for (const key of keys) {
      if (key === 'NOVAWING_SMTP_PASS') {
        process.stdout.write(`${key}: `)
        process.stdin.setRawMode(true)
        const password = await new Promise((resolvePassword) => {
          let value = ''
          function read(chunk) {
            const text = String(chunk)
            const newline = text.search(/[\r\n]/u)
            if (newline !== -1) return resolvePassword(value + text.slice(0, newline))
            value += text
            process.stdin.once('data', read)
          }
          process.stdin.once('data', read)
        })
        process.stdin.setRawMode(false)
        process.stdout.write('\n')
        result[key] = password
      } else {
        result[key] = await readline.question(`${key}: `)
      }
    }
    return result
  } finally {
    readline.close()
  }
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
