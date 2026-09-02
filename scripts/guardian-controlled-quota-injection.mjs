/* global console, process */
import { resolve } from 'node:path'

import {
  createProductionWorkSessionUi,
  loadTrustedWorkSessionConfig,
  requestControlledCodexQuotaExhaustion,
  resolveProductionSmtpEnvironment,
} from 'nova-wing/development-guardian'

function parseArgs(args) {
  const values = new Map()
  const enableIndex = args.indexOf('--enable-development-injection')
  if (enableIndex >= 0) args.splice(enableIndex, 1)
  for (let i = 0; i < args.length; i += 2) values.set(args[i], args[i + 1])
  const config = values.get('--config')
  const task = values.get('--task')
  const confirm = values.get('--confirm')
  if (!config || !task || !confirm || values.size !== 3 || enableIndex < 0) {
    throw new Error('Usage: npm run guardian:quota-inject -- --enable-development-injection --config <path> --task <id> --confirm "INJECT <id> codex_quota_exhausted"')
  }
  return { config: resolve(config), task, confirm }
}

let app
try {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadTrustedWorkSessionConfig(args.config)
  const env = { ...await resolveProductionSmtpEnvironment(config),
    NOVAWING_ENABLE_CONTROLLED_QUOTA_INJECTION: '1', NODE_ENV: 'development' }
  app = await createProductionWorkSessionUi(config, { env })
  const injection = await requestControlledCodexQuotaExhaustion({
    definition: app.definition,
    state: app.runtime.getDurableState(),
    taskId: args.task,
    confirmation: args.confirm,
    env,
  })
  console.log(`Controlled injection armed once: ${injection.injectionId}`)
  console.log(`Task: ${injection.taskId}`)
  console.log('Kind: codex_quota_exhausted')
  console.log('The next explicit resume will consume it through the production ExecutorRouter path.')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'controlled quota injection failed')
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
}
