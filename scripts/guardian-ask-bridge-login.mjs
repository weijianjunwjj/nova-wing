/* global console */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const command = process.platform === 'win32'
  ? join(homedir(), '.local', 'bin', 'ask-bridge.exe')
  : 'ask-bridge'

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
