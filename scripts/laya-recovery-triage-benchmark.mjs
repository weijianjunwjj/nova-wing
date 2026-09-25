import {
  buildRecoveryTriageBenchmarkReport,
  createRecoveryTriageBenchmarkCases,
  observeRecoveryTriage,
  runRecoveryTriageBenchmark,
} from '../dist/packages/development-guardian/decision-shadow/recovery-triage-benchmark.js'

const baseUrl = (process.env.NOVAWING_LAYA_BASE_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/u, '')
const healthResponse = await fetch(`${baseUrl}/health`)
if (!healthResponse.ok) throw new Error(`Laya health check failed: HTTP ${healthResponse.status}`)
const health = await healthResponse.json()
for (const checkpoint of ['english', 'typed-decisions']) {
  if (!Array.isArray(health.loaded) || !health.loaded.includes(checkpoint)) throw new Error(`Laya checkpoint is not preloaded: ${checkpoint}`)
}
if (health.device !== 'cpu') throw new Error(`Benchmark requires the controlled CPU runtime; found: ${String(health.device)}`)

const inputs = createRecoveryTriageBenchmarkCases()
const observe = (model, projection) => observeRecoveryTriage({ baseUrl, model, projection, timeoutMs: 30_000 })

// One unmeasured inference per checkpoint removes first-forward initialization from latency.
await observe('english', inputs[0].projection)
await observe('typed-decisions', inputs[0].projection)

const cases = await runRecoveryTriageBenchmark(inputs, observe, 3)
process.stdout.write(`${JSON.stringify(buildRecoveryTriageBenchmarkReport(cases), null, 2)}\n`)
