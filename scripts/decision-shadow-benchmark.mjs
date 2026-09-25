import {
  buildDecisionBenchmarkReport,
  createDecisionBenchmarkCases,
  runDecisionBenchmark,
} from '../dist/packages/development-guardian/decision-shadow/benchmark.js'
import { LayaClient } from '../dist/packages/development-guardian/decision-shadow/providers/laya-client.js'

const baseUrl = (process.env.NOVAWING_LAYA_BASE_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/u, '')
const healthResponse = await fetch(`${baseUrl}/health`)
if (!healthResponse.ok) throw new Error(`Laya health check failed: HTTP ${healthResponse.status}`)
const health = await healthResponse.json()
for (const checkpoint of ['english', 'typed-decisions']) {
  if (!Array.isArray(health.loaded) || !health.loaded.includes(checkpoint)) throw new Error(`Laya checkpoint is not preloaded: ${checkpoint}`)
}

const clients = {
  english: new LayaClient({ baseUrl, model: 'english', timeoutMs: 30_000 }),
  'typed-decisions': new LayaClient({ baseUrl, model: 'typed-decisions', timeoutMs: 30_000 }),
}
const inputs = createDecisionBenchmarkCases()
// One unmeasured inference per checkpoint removes first-forward initialization from latency.
await clients.english.decide(inputs[0].projection)
await clients['typed-decisions'].decide(inputs[0].projection)
const cases = await runDecisionBenchmark(inputs, clients)
process.stdout.write(`${JSON.stringify(buildDecisionBenchmarkReport(cases), null, 2)}\n`)
