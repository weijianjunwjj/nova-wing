/** Read-only Phase 6.1 obligation recompile. Never starts Runtime or writes to the target. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { verifyPlanSnapshot } from '../dist/packages/development-guardian/planning/freeze.js'
import { bindDeliveryTarget, compileRuntimePlan, conservativeCapabilityResolver, inspectDeliveryTarget } from '../dist/packages/development-guardian/delivery/runtime-plan.js'
import { inspectRepoCapabilities } from '../dist/packages/development-guardian/delivery/repo-capability-inspector.js'
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
const before = await inspectDeliveryTarget(targetPath)
const sessionsBefore = (await readdir(join(dataDirectory, 'delivery')).catch(() => []))
  .filter((name) => name.startsWith('session-'))
const [preflight, reviewerAvailable] = await Promise.all([
  runProductionDependencyPreflight({ targetRepo: targetPath, controlPlane: 'v2', timeoutMs: 3_000,
    shutdownMode: 'strict' }),
  Promise.all([hasClaudeRoute(targetPath), hasDeepSeekRoute(targetPath)]).then((routes) => routes.some(Boolean)),
])
const target = await bindDeliveryTarget(snapshot, targetPath)
const facts = await inspectRepoCapabilities(target)
const plan = await compileRuntimePlan(snapshot, target, { resolver: conservativeCapabilityResolver,
  runtimePolicyVersion: 'runtime-policy-v1', runtimeConfigured: target.branch !== null,
  executorAvailable: preflight.canStart, reviewerAvailable })
const after = await inspectDeliveryTarget(targetPath)
if (!after.clean || before.baselineCommit !== after.baselineCommit ||
  before.canonicalPath !== after.canonicalPath || before.gitRepositoryIdentity !== after.gitRepositoryIdentity)
  throw new Error('Target repository changed during read-only audit.')
const sessionsAfter = (await readdir(join(dataDirectory, 'delivery')).catch(() => []))
  .filter((name) => name.startsWith('session-'))
if (JSON.stringify(sessionsBefore) !== JSON.stringify(sessionsAfter)) throw new Error('Audit unexpectedly created a WorkSession artifact.')
const owners = plan.acceptanceBindings.filter((binding) => binding.blocking && binding.ownership === 'OWNER')
const byState = (state) => owners.filter((binding) => binding.stagedVerification.readiness === state)
const report = {
  snapshotId: snapshot.id, frozenPlanHash: snapshot.planHash.value,
  targetBaselineCommit: plan.targetBaselineCommit, targetClean: target.clean,
  inspectedFacts: { scannedFileCount: facts.scannedFileCount, routeCount: facts.routes.length,
    routePatternCount: facts.routePatterns.length, testFileCount: facts.testFiles.length,
    explicitContractPresent: facts.contract !== undefined },
  uniqueAssertions: new Set(plan.acceptanceBindings.filter((binding) => binding.blocking).map((binding) => binding.assertionId)).size,
  uniqueObligations: owners.filter((binding) => binding.stagedVerification.obligation).length,
  provisionableDuringExecution: byState('PROVISIONABLE_DURING_EXECUTION').length,
  unresolved: byState('UNRESOLVED').length,
  ownershipAmbiguous: plan.admission.blockers.filter((item) => item.code === 'OWNERSHIP_AMBIGUOUS').length,
  externalDeferred: byState('EXTERNAL_DEFERRED').length,
  humanDeferred: byState('HUMAN_DEFERRED').length,
  runtimePlanId: plan.id, runtimePlanHash: plan.runtimePlanHash, obligationSetHash: plan.obligationSetHash,
  runtimeAdmission: plan.admission.status, executorReady: preflight.canStart, reviewerReady: reviewerAvailable,
  blockers: plan.admission.blockers.map(({ code, assertionId, message }) => ({ code, assertionId, message })),
  readyForRealStartDelivery: plan.admission.status === 'READY' ? 'YES' : 'NO',
  realRequirementRepositoryModified: false, realWorkSessionCreated: false,
  outcomes: owners.map((binding) => ({ assertionId: binding.assertionId,
    ownerTaskId: binding.runtimeTaskId, readiness: binding.stagedVerification.readiness,
    policy: binding.stagedVerification.policy, obligationId: binding.stagedVerification.obligation?.obligationId,
    strategy: binding.stagedVerification.obligation?.strategy,
    externalResidual: binding.stagedVerification.obligation?.externalResidual })),
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' })
process.stdout.write(`${JSON.stringify({ reportPath, runtimePlanId: plan.id,
  obligations: report.uniqueObligations, unresolved: report.unresolved,
  externalDeferred: report.externalDeferred, admission: report.runtimeAdmission })}\n`)
