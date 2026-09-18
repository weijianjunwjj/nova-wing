/* global console, process */
import { resolveHostArgumentPath } from 'nova-wing/development-guardian'

import {
  adoptProductionLegacyWorkSession,
  createProductionWorkSessionUi,
  loadTrustedWorkSessionConfig,
  resolveProductionSmtpEnvironment,
} from 'nova-wing/development-guardian'

function configPathFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--config' || args[1].trim().length === 0) {
    throw new Error('Usage: npm run guardian:work-session:adopt -- --config <path>')
  }
  const value = args[1]
  return resolveHostArgumentPath(value)
}

let app
try {
  const config = await loadTrustedWorkSessionConfig(configPathFromArgs(process.argv.slice(2)))
  app = await createProductionWorkSessionUi(config, {
    env: await resolveProductionSmtpEnvironment(config),
  })

  console.log('NovaWing Legacy Adoption')
  console.log(`Session: ${config.session.id}`)
  const result = await adoptProductionLegacyWorkSession(config, app.runtime, {
    onAdopted(summary) {
      console.log(`Task: ${summary.taskId}`)
      console.log(`Repository: ${summary.repoPath}`)
      console.log(`Adopted files: ${summary.adoptedFiles}`)
    },
    onRecoveryStarted() {
      console.log('Recovery started')
    },
  })
  console.log(`Final state: ${result.finalState.state}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Legacy adoption failed')
  process.exitCode = 1
} finally {
  if (app !== undefined) {
    try {
      await app.close()
    } catch {
      console.error('Legacy adoption cleanup failed')
      process.exitCode = 1
    }
  }
}
