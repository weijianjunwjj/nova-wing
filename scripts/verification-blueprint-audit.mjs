/** Generic preparation-only audit. The target repository is inspected, never executed or written. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { verifyPlanSnapshot } from '../dist/packages/development-guardian/planning/freeze.js'
import { DeliveryEventStore, DeliveryService, DeliveryStore } from '../dist/packages/development-guardian/delivery/service.js'
import { conservativeCapabilityResolver, inspectDeliveryTarget } from '../dist/packages/development-guardian/delivery/runtime-plan.js'
import { createClaudeBlueprintReviewer, createClaudeBlueprintRepairer } from '../dist/packages/development-guardian/delivery/verification-blueprint-planner.js'
import { hasClaudeRoute, hasDeepSeekRoute } from '../dist/packages/development-guardian/deepseek-executor.js'
import { runProductionDependencyPreflight } from '../dist/packages/development-guardian/work-session/dependency-health.js'

const [snapshotInput, targetInput, dataInput, reportInput] = process.argv.slice(2)
if (!snapshotInput || !targetInput || !dataInput || !reportInput)
  throw new Error('Usage: node scripts/verification-blueprint-audit.mjs SNAPSHOT TARGET_REPO NOVAWING_DATA_DIR REPORT_JSON')
const snapshot = verifyPlanSnapshot(JSON.parse(await readFile(resolve(snapshotInput), 'utf8')))
const targetPath = resolve(targetInput)
const dataDirectory = resolve(dataInput)
const reportPath = resolve(reportInput)
for (const path of [dataDirectory, reportPath]) if (relative(targetPath, path) === '' ||
  (!relative(targetPath, path).startsWith('..') && !relative(targetPath, path).startsWith('/')))
  throw new Error('Audit artifacts must remain outside the target repository.')
const [preflight, reviewerAvailable] = await Promise.all([
  runProductionDependencyPreflight({ targetRepo: targetPath, controlPlane: 'v2', timeoutMs: 3_000,
    shutdownMode: 'strict' }),
  Promise.all([hasClaudeRoute(targetPath), hasDeepSeekRoute(targetPath)]).then((routes) => routes.some(Boolean)),
])
const adapter = {
  configured: async (target) => target.branch !== null,
  executorAvailable: async () => preflight.canStart,
  reviewerAvailable: async () => reviewerAvailable,
  createAndStart: async () => { throw new Error('Audit must never create a WorkSession.') },
}
const sessionsBefore = (await readdir(join(dataDirectory, 'delivery')).catch(() => []))
  .filter((name) => name.startsWith('session-'))
const service = new DeliveryService(new DeliveryStore(join(dataDirectory, 'delivery')),
  new DeliveryEventStore(join(dataDirectory, 'delivery', 'events.jsonl')),
  adapter, conservativeCapabilityResolver, 'runtime-policy-v1')
const { plan, planning, facts } = await service.prepareWithBlueprintPlanning(snapshot, targetPath,
  createClaudeBlueprintReviewer({ cwd: process.cwd() }), createClaudeBlueprintRepairer({ cwd: process.cwd() }))
const readiness = await service.readiness(snapshot, plan.id)
const inspectedAfter = await inspectDeliveryTarget(targetPath)
if (!inspectedAfter.clean || inspectedAfter.baselineCommit !== plan.targetBaselineCommit ||
  inspectedAfter.canonicalPath !== plan.targetBinding.canonicalPath)
  throw new Error('Target repository changed during read-only audit.')
const sessionsAfter = (await readdir(join(dataDirectory, 'delivery')).catch(() => []))
  .filter((name) => name.startsWith('session-'))
if (JSON.stringify(sessionsBefore) !== JSON.stringify(sessionsAfter)) throw new Error('Audit unexpectedly created a WorkSession artifact.')
const bindingStates = plan.acceptanceBindings.filter((binding) => binding.blocking)
const count = (state) => bindingStates.filter((binding) => binding.stagedVerification.readiness === state).length
const familyCount = (family) => planning.approved.filter((blueprint) => blueprint.family === family).length
const report = {
  snapshotId: snapshot.id, frozenPlanHash: snapshot.planHash.value,
  targetBaselineCommit: plan.targetBaselineCommit, targetClean: plan.targetBinding.clean,
  inspectedFacts: { scannedFileCount: facts.scannedFileCount, routeCount: facts.routes.length,
    routePatternCount: facts.routePatterns.length, testFileCount: facts.testFiles.length,
    explicitContractPresent: facts.contract !== undefined },
  inputUnresolved: planning.inputUnresolved, provisionableAfterPlanning: count('PROVISIONABLE'),
  stillUnresolved: count('UNRESOLVED'), externalDeferred: count('EXTERNAL_DEFERRED'),
  humanDeferred: count('HUMAN_DEFERRED'), httpBlueprints: familyCount('http_api'),
  filesystemBlueprints: familyCount('filesystem'), processBlueprints: familyCount('process'),
  compositeBlueprints: familyCount('composite'), commandBlueprints: familyCount('command'),
  newRuntimePlanId: plan.id, newRuntimePlanHash: plan.runtimePlanHash,
  runtimeAdmission: readiness.admission.status,
  executorReady: preflight.canStart, reviewerReady: reviewerAvailable,
  startDeliveryBlockers: readiness.admission.blockers.map(({ code, assertionId }) => ({ code, assertionId })),
  readyForRealStartDelivery: readiness.admission.status === 'READY' ? 'YES' : 'NO',
  realRequirementRepositoryModified: false, realWorkSessionCreated: false,
  outcomes: planning.outcomes,
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' })
process.stdout.write(`${JSON.stringify({ reportPath, runtimePlanId: plan.id, inputUnresolved: planning.inputUnresolved,
  provisionable: report.provisionableAfterPlanning, unresolved: report.stillUnresolved,
  externalDeferred: report.externalDeferred, admission: report.runtimeAdmission })}\n`)
