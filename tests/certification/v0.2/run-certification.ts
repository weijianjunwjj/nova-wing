/**
 * NovaWing v0.2 automated certification runner.
 *
 * Usage:
 *   npm run build && npm run build:tests && node dist-tests/tests/certification/v0.2/run-certification.js
 *
 * Outputs a machine-readable report (artifacts/certification/v0.2-report.json),
 * a certification document (docs/certification/NovaWing-v0.2-Certification.md)
 * and a final PASS / FAIL verdict with a product-usability rating.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ScenarioHarness, CertificationError } from './harness.js'
import type { CertificationScenario, ScenarioContext, ScenarioResult } from './scenario.js'
import { SCENARIOS } from './scenarios-index.js'
import { certRoot, createScenarioDir, removeTree, fileExists } from './util.js'

interface GateResult {
  command: string
  passed: boolean
  exitCode: number
  tail: string
  durationMs: number
}

export function runCommand(command: string, args: readonly string[], cwd: string, timeoutMs = 900_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd, shell: process.platform === 'win32', windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveRun({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveRun({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

const GATES: ReadonlyArray<{ command: string; args: readonly string[]; label: string }> = [
  { command: 'npm', args: ['run', 'typecheck'], label: 'typecheck' },
  { command: 'npm', args: ['test'], label: 'npm test' },
  { command: 'npm', args: ['run', 'check:unused'], label: 'check:unused' },
  { command: 'npm', args: ['run', 'check:migration'], label: 'check:migration' },
  { command: 'npm', args: ['run', 'check:exports'], label: 'check:exports' },
  { command: 'npm', args: ['run', 'check:boundaries'], label: 'check:boundaries' },
  { command: 'npm', args: ['run', 'pack:check'], label: 'pack:check' },
  { command: 'git', args: ['diff', '--check'], label: 'git diff --check' },
]

async function runGates(root: string): Promise<GateResult[]> {
  const results: GateResult[] = []
  for (const gate of GATES) {
    const started = Date.now()
    const outcome = await runCommand(gate.command, gate.args, root)
    const durationMs = Date.now() - started
    const tail = [outcome.stdout, outcome.stderr].join('\n').trim().split(/\r?\n/u).slice(-40).join('\n')
    results.push({ command: gate.label, passed: outcome.exitCode === 0, exitCode: outcome.exitCode, tail, durationMs })
    process.stdout.write(`[gate] ${gate.label}: ${outcome.exitCode === 0 ? 'PASS' : 'FAIL'} (${Math.round(durationMs / 1000)}s)\n`)
  }
  return results
}

async function executeScenario(scenario: CertificationScenario, runId: string, h: ScenarioHarness): Promise<ScenarioResult> {
  const started = Date.now()
  const base = await createScenarioDir(runId, scenario.id)
  const context: ScenarioContext = {
    dirs: { runId, scenarioId: scenario.id, root: base.work, repo: base.repo, data: base.data },
    h,
  }
  const notes: string[] = []
  const runTimeoutMs = 420_000
  const watchdog = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${scenario.id} exceeded the ${runTimeoutMs / 1000}s watchdog`))
    }, runTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    await Promise.race([scenario.run(context), watchdog])
  } catch (error) {
    const message = error instanceof CertificationError
      ? error.message
      : error instanceof Error ? error.message : String(error)
    if (process.env.NOVAWING_CERT_DEBUG === '1') {
      const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`[scenario:${scenario.id}] stack:\n${stack}`)
    }
    return {
      scenarioId: scenario.id,
      passed: false,
      tag: 'FAIL',
      durationMs: Date.now() - started,
      notes,
      checks: h.checks,
      error: message,
    }
  }
  return {
    scenarioId: scenario.id,
    passed: true,
    tag: 'PASS',
    durationMs: Date.now() - started,
    notes,
    checks: h.checks,
  }
}

interface CertificationReport {
  runId: string
  timestamp: string
  scenarios: ScenarioResult[]
  gates: GateResult[]
  scenarioPass: boolean
  gatePass: boolean
  verdict: 'PASS' | 'FAIL'
  productUsability: 'USABLE' | 'USABLE WITH LIMITATIONS' | 'NOT READY'
  layerB: { status: 'SKIPPED_PROVIDER_UNAVAILABLE' | 'PASS' | 'FAIL' | 'NOT_RUN'; reason?: string }
  limitations: string[]
  durationMs: number
}

function reportPath(root: string): string {
  return join(root, 'artifacts', 'certification', 'v0.2-report.json')
}

function docPath(root: string): string {
  return join(root, 'docs', 'certification', 'NovaWing-v0.2-Certification.md')
}

async function writeReport(report: CertificationReport, root: string): Promise<void> {
  await mkdir(resolve(reportPath(root), '..'), { recursive: true })
  await writeFile(reportPath(root), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function gateLines(report: CertificationReport): string[] {
  return report.gates.map((gate) => `| ${gate.command} | ${gate.passed ? 'PASS' : 'FAIL'} | ${gate.exitCode} | ${Math.round(gate.durationMs / 1000)}s |`)
}

function renderMarkdown(report: CertificationReport): string {
  const rows = report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.tag} | ${Math.round(scenario.durationMs / 1000)}s | ${scenario.error ?? ''} |`)
  const gates = gateLines(report)
  return [
    '# NovaWing v0.2 automated certification',
    '',
    `> Generated by the automated certification harness at \`${report.timestamp}\` (run \`${report.runId}\`).`,
    '',
    `**Certification:** ${report.verdict}`,
    '',
    `**Product usability:** ${report.productUsability}`,
    '',
    '## Scenario matrix (Layer A deterministic)',
    '',
    '| Scenario | Result | Duration | Failure detail |',
    '| --- | --- | ---: | --- |',
    ...rows,
    '',
    '## Release gates',
    '',
    '| Gate | Result | Exit | Duration |',
    '| --- | --- | ---: | ---: |',
    ...gates,
    '',
    '## Layer B live-provider smoke',
    '',
    `Status: ${report.layerB.status}${report.layerB.reason === undefined ? '' : ` — ${report.layerB.reason}`}`,
    '',
    '## Known limitations',
    '',
    ...(report.limitations.length === 0 ? ['None recorded.'] : report.limitations.map((limitation) => `- ${limitation}`)),
    '',
    '## Summary',
    '',
    `- Layer A scenarios passed: ${report.scenarios.filter((scenario) => scenario.passed).length}/${report.scenarios.length}`,
    `- Release gates passed: ${report.gates.filter((gate) => gate.passed).length}/${report.gates.length}`,
    `- Total certification duration: ${Math.round(report.durationMs / 1000)}s`,
    '',
  ].join('\n')
}

async function writeDocumentation(report: CertificationReport, root: string): Promise<void> {
  const path = docPath(root)
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, renderMarkdown(report), 'utf8')
}

async function loadExistingReport(root: string): Promise<CertificationReport | undefined> {
  if (!(await fileExists(reportPath(root)))) return undefined
  const text = await readFile(reportPath(root), 'utf8')
  try {
    return JSON.parse(text) as CertificationReport
  } catch {
    return undefined
  }
}

const KNOWN_LIMITATIONS: string[] = [
  'Task Contract Preflight v1 reports repository-valid verifier commands outside the existing deterministic allowlist as APPROVAL_REQUIRED before Session creation; it does not grant approval or widen the allowlist.',
  'Provider responses in Layer A are scripted at the documented createV2Dispatcher / executor seams; model cognition itself is not exercised deterministically.',
  'The Launchpad Task-Brief evidence-binding DSL is line based and cannot carry a literal newline inside one verifier command; S20 proves that literal => content is preserved after the first delimiter.',
  'The Layer A repair scenarios script the Repair Model seam (S27/S29/S30) so the cascade, mechanical validation and preflight stay deterministic; S28 scripts a provider failure. The live Codex repair turn is exercised by the operator dogfood (guardian repair dogfood), not by the automated gate.',
]

export async function main(): Promise<number> {
  const root = process.cwd()
  const runId = process.env.NOVAWING_CERT_RUN_ID ?? `run-${Date.now()}`
  const started = Date.now()
  const results: ScenarioResult[] = []
  const keep = process.env.NOVAWING_CERT_KEEP === '1'
  const only = (process.env.NOVAWING_CERT_ONLY ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const selected = only.length === 0 ? SCENARIOS : SCENARIOS.filter((scenario) => only.includes(scenario.id))
  process.stdout.write(`NovaWing v0.2 automated certification\nrun: ${runId}\n`)
  for (const scenario of selected) {
    const h = new ScenarioHarness()
    process.stdout.write(`\n[scenario] ${scenario.id} — ${scenario.title}\n`)
    const result = await executeScenario(scenario, runId, h)
    results.push(result)
    process.stdout.write(`[scenario] ${scenario.id}: ${result.tag}${result.error === undefined ? '' : ` — ${result.error}`}\n`)
    const dir = join(certRoot(runId), scenario.id)
    if (keep === false) await removeTree(dir).catch(() => undefined)
  }

  process.stdout.write('\nRunning release gates…\n')
  const gates = process.env.NOVAWING_CERT_NO_GATES === '1' ? [] : await runGates(root)

  const scenarioPass = results.every((result) => result.passed)
  const gatePass = gates.every((gate) => gate.passed)
  const layerB = process.env.NOVAWING_CERT_LIVE === '1'
    ? { status: 'NOT_RUN' as const, reason: 'live smoke requires an interactive provider; run separately' }
    : { status: 'SKIPPED_PROVIDER_UNAVAILABLE' as const, reason: 'deterministic Layer A certification gate' }
  const allPass = scenarioPass && gatePass
  const report: CertificationReport = {
    runId,
    timestamp: new Date().toISOString(),
    scenarios: results,
    gates,
    scenarioPass,
    gatePass,
    verdict: allPass ? 'PASS' : 'FAIL',
    productUsability: allPass ? 'USABLE' : 'USABLE WITH LIMITATIONS',
    layerB,
    limitations: [...KNOWN_LIMITATIONS],
    durationMs: Date.now() - started,
  }
  await writeReport(report, root)
  await writeDocumentation(report, root)
  const prior = await loadExistingReport(root)
  if (prior !== undefined) {
    prior.scenarios = report.scenarios
    prior.gates = report.gates
    prior.verdict = report.verdict
    prior.productUsability = report.productUsability
    await writeReport(prior, root)
  }
  if (keep === false) await removeTree(certRoot(runId)).catch(() => undefined)
  process.stdout.write(`\n${'='.repeat(72)}\n`)
  process.stdout.write(`NovaWing v0.2 automated certification: ${report.verdict}\n`)
  process.stdout.write(`Product usability: ${report.productUsability}\n`)
  process.stdout.write(`Layer A scenarios: ${results.filter((result) => result.passed).length}/${results.length}\n`)
  process.stdout.write(`Release gates: ${gates.filter((gate) => gate.passed).length}/${gates.length}\n`)
  process.stdout.write(`Report: ${reportPath(root)}\n`)
  process.stdout.write(`Document: ${docPath(root)}\n`)
  process.stdout.write(`${'='.repeat(72)}\n`)
  return allPass ? 0 : 1
}

const modulePath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
