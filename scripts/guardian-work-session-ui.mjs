/* global console, process */
import { resolve } from 'node:path'

import {
  createProductionWorkSessionUi,
  loadTrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'

function configPathFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--config' || args[1].trim().length === 0) {
    throw new Error('Usage: npm run guardian:work-session:ui -- --config <path>')
  }
  const value = args[1]
  if (process.platform === 'win32') {
    const gitBashPath = value.match(/^\/([a-zA-Z])\/(.*)$/u)
    if (gitBashPath !== null) {
      return resolve(`${gitBashPath[1]}:/${gitBashPath[2]}`)
    }
  }
  return resolve(value)
}

try {
  const config = await loadTrustedWorkSessionConfig(configPathFromArgs(process.argv.slice(2)))
  const app = await createProductionWorkSessionUi(config)
  const address = await app.start()

  console.log('NovaWing Work Session UI')
  console.log(`Project: ${app.definition.targetRepo}`)
  console.log(`Branch: ${app.definition.branch}`)
  console.log(`URL: ${address.url}`)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Work Session UI failed to start')
  process.exitCode = 1
}
