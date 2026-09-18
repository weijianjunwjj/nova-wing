/* global console */
import { spawn } from 'node:child_process'
import { resolveAskBridgeExecutable } from 'nova-wing/development-guardian'

const command = resolveAskBridgeExecutable(process.env)

const child = spawn(command, ['--provider', 'chatgpt', 'login'], {
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
})

child.once('error', (error) => {
  console.error(`Failed to start ask-bridge: ${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
