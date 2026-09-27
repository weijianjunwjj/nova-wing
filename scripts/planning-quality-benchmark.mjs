import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNovaWingLaunchpad } from '../dist/packages/development-guardian/work-session/launchpad/server.js'
import { createCodexPlanningProvider } from '../dist/packages/development-guardian/planning/provider.js'
import { createCodexPlanningSemanticReviewer } from '../dist/packages/development-guardian/planning/semantic-reviewer.js'
import { PlanningService, PlanningStore } from '../dist/packages/development-guardian/planning/service.js'
import { PlanningEventStore } from '../dist/packages/development-guardian/planning/telemetry.js'

const runs = Number(process.argv[2] ?? 5)
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('runs must be an integer from 1 to 20')
const requirement = await readFile('tests/fixtures/requirement-001.txt', 'utf8')
const root = await mkdtemp(join(tmpdir(), 'novawing-planning-quality-'))
const summary = {
  startedAt: new Date().toISOString(), node: process.version, root,
  inputSha256: createHash('sha256').update(requirement).digest('hex'), runs: [],
}
console.log(JSON.stringify({ type: 'benchmark.started', root, runs, inputSha256: summary.inputSha256 }))

function postPlanning(url, token, text) {
  const body = JSON.stringify({ requirement: text })
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/planning/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url,
        'X-NovaWing-Launchpad-Token': token, 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(body)
  })
}

for (let index = 1; index <= runs; index += 1) {
  const directory = join(root, `run-${index}`)
  const configDirectory = join(directory, 'configs')
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const env = { ...process.env, NOVAWING_DATA_DIR: directory, NOVAWING_CONFIG_DIR: configDirectory }
  const provider = createCodexPlanningProvider({ env })
  let modelAttempt = 0
  const observedProvider = async (input) => {
    const response = await provider(input)
    modelAttempt += 1
    // Isolated benchmark evidence, not telemetry; the model text is passed through unchanged.
    await writeFile(join(directory, `model-attempt-${modelAttempt}.txt`), response.text, { mode: 0o600 })
    return response
  }
  const service = new PlanningService(observedProvider,
    new PlanningStore(join(directory, 'planning', 'plans')),
    new PlanningEventStore(join(directory, 'planning', 'events.jsonl')),
    createCodexPlanningSemanticReviewer({ env }))
  const launchpad = await createNovaWingLaunchpad({ configDirectory, env, dependencies: { planningService: service } })
  let result
  try {
    const address = await launchpad.start()
    const response = await postPlanning(address.url, launchpad.getTokenForTest(), requirement)
    const raw = response.body
    await writeFile(join(directory, 'http-response.json'), raw, { mode: 0o600 })
    const body = JSON.parse(raw)
    const plan = body.plan
    const eventsRaw = await readFile(join(directory, 'planning', 'events.jsonl'), 'utf8').catch(() => '')
    const events = eventsRaw.trim() ? eventsRaw.trim().split('\n').map((line) => JSON.parse(line)) : []
    const issueCodes = plan?.semanticReview?.issues?.map((issue) => issue.code) ?? []
    const reviewed = plan?.semanticReview !== undefined && plan.semanticReview !== null
    result = {
      run: index, httpStatus: response.status, error: body.error,
      planningSessionId: plan?.id,
      status: plan?.status,
      requirementCount: plan?.clauses?.length,
      mustCount: plan?.clauses?.filter((clause) => clause.priority === 'must').length,
      taskCount: plan?.tasks?.length,
      criterionCount: plan?.acceptancePlan?.criteria?.length,
      assertionCount: plan?.acceptancePlan?.criteria?.reduce((count, criterion) => count + criterion.assertions.length, 0),
      blockingAssertionCoverage: body.validation?.mustAcceptanceCoverage,
      deterministicPass: body.validation?.pass ?? false,
      deterministicIssues: body.validation?.issues?.map((issue) => issue.code) ?? [],
      semanticVerdict: plan?.semanticReview?.verdict ?? 'UNAVAILABLE',
      semanticIssues: plan?.semanticReview?.issues ?? [],
      repairCount: events.filter((event) => event.type === 'planning.repair.started').length,
      missingExplicitRequirementCount: reviewed ? issueCodes.filter((code) => code === 'MISSING_EXPLICIT_REQUIREMENT').length : null,
      inventedBusinessScopeCount: reviewed ? issueCodes.filter((code) => code === 'INVENTED_BUSINESS_SCOPE').length : null,
      weakAcceptanceCount: reviewed ? issueCodes.filter((code) => code === 'WEAK_ACCEPTANCE' || code === 'ACCEPTANCE_REQUIREMENT_MISMATCH').length : null,
      silentBusinessAssumptionCount: reviewed ? issueCodes.filter((code) => code === 'UNSUPPORTED_BUSINESS_ASSUMPTION').length : null,
      telemetryContainsFullRequirement: eventsRaw.includes(requirement),
      customerQuestions: plan?.customerQuestions ?? [],
      businessAssumptions: plan?.assumptions ?? [],
    }
  } catch (error) {
    result = { run: index, error: error instanceof Error ? error.message : String(error),
      deterministicPass: false, semanticVerdict: 'UNAVAILABLE' }
  } finally {
    await launchpad.close()
  }
  summary.runs.push(result)
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ type: 'benchmark.run', ...result }))
}
summary.completedAt = new Date().toISOString()
await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ type: 'benchmark.completed', root, completedAt: summary.completedAt }))
