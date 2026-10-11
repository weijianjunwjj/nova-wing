import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

// Unit/integration tests must inject model runtimes. Discovery and --version
// remain available; a missing test seam fails before any live model process.
function requireOfflineModel(command, args = []) {
  const name = String(command).replaceAll('\\', '/').split('/').at(-1)
  if (/^(?:codex|claude)(?:\.exe|\.cmd)?$/iu.test(name ?? '') && !args.includes('--version')) {
    const error = new Error('OFFLINE_MODEL_CALL_BLOCKED: inject the model runtime in this test.')
    error.code = 'OFFLINE_MODEL_CALL_BLOCKED'
    throw error
  }
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name]
  const wrapped = function (command, args, ...options) {
    requireOfflineModel(command, Array.isArray(args) ? args : [])
    return original.call(this, command, args, ...options)
  }
  if (original[promisify.custom]) wrapped[promisify.custom] = function (command, args, ...options) {
    requireOfflineModel(command, Array.isArray(args) ? args : [])
    return original[promisify.custom].call(this, command, args, ...options)
  }
  childProcess[name] = wrapped
}
syncBuiltinESMExports()
