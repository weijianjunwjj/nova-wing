/* global process */
import { spawn } from 'node:child_process'

// Start the test runner outside any inherited node:test worker context.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
})
child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
