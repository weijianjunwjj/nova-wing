/* global console, process */
import { resolveHostArgumentPath } from 'nova-wing/development-guardian'

import {
  createProductionWorkSessionUi,
  loadTrustedWorkSessionConfig,
  resolveProductionSmtpEnvironment,
} from 'nova-wing/development-guardian'

function configPathFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--config' || args[1].trim().length === 0) {
    throw new Error('用法：npm run guardian:work-session:ui -- --config <path>')
  }
  const value = args[1]
  return resolveHostArgumentPath(value)
}

try {
  const config = await loadTrustedWorkSessionConfig(configPathFromArgs(process.argv.slice(2)))
  const app = await createProductionWorkSessionUi(config, {
    env: await resolveProductionSmtpEnvironment(config),
  })
  await app.start()

  console.log('NovaWing Work Session 控制台')
  console.log(`项目：${app.definition.targetRepo}`)
  console.log(`分支：${app.definition.branch}`)
  console.log(`地址：${app.server.mintBootstrapUrl()}`)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
} catch (error) {
  console.error(error instanceof Error ? error.message : 'NovaWing Work Session 控制台启动失败')
  process.exitCode = 1
}
