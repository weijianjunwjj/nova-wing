/** Read-only audit of the exact frozen Requirement 001 snapshot and target. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bindDeliveryTarget, compileRuntimePlan } from '../dist/packages/development-guardian/delivery/runtime-plan.js'
import { CAPABILITY_REGISTRY } from '../dist/packages/development-guardian/delivery/capability-layer.js'

const [snapshotPath, targetPath] = process.argv.slice(2)
if (!snapshotPath || !targetPath) throw new Error('Usage: node scripts/requirement-001-capability-audit.mjs SNAPSHOT TARGET_REPO')
const snapshot = JSON.parse(await readFile(resolve(snapshotPath), 'utf8'))
if (snapshot.id !== '080d2835-5f35-4311-acb5-7424b5a17607' ||
  snapshot.planHash?.value !== 'bdacb10272bbf5512fd9e9d113796c75b1f600440a45e95924aaf664d18cec3a') {
  throw new Error('The input is not the approved frozen Requirement 001 snapshot.')
}
const target = await bindDeliveryTarget(snapshot, resolve(targetPath), 'trusted_test')
const plan = await compileRuntimePlan(snapshot, target, { runtimePolicyVersion: 'runtime-policy-v1',
  runtimeConfigured: false, executorAvailable: false, reviewerAvailable: false })
const blocking = plan.acceptanceBindings.filter((binding) => binding.blocking)
const countBy = (selector) => Object.fromEntries([...new Set(blocking.map(selector))].sort()
  .map((key) => [key, blocking.filter((binding) => selector(binding) === key).length]))
const result = {
  snapshotId: snapshot.id, snapshotHash: snapshot.planHash.value, runtimePlanHash: plan.runtimePlanHash,
  capabilitySchemaVersion: plan.capabilitySchemaVersion, compilerVersion: plan.compilerImplementationVersion,
  targetClean: target.clean, admission: plan.admission.status,
  totalBlockingBindings: blocking.length,
  capabilityFamilies: countBy((binding) => binding.verificationCapability.family),
  supportStates: countBy((binding) => binding.verificationCapability.capability),
  providerAvailability: countBy((binding) => CAPABILITY_REGISTRY[binding.verificationCapability.family].availability),
  coverage: plan.admission.capabilityCoverage,
  blockerTypes: Object.fromEntries([...new Set(plan.admission.blockers.map((blocker) => blocker.code))].sort()
    .map((code) => [code, plan.admission.blockers.filter((blocker) => blocker.code === code).length])),
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
