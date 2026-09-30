import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ClaudeCodeExecutor } from '../packages/development-guardian/claude-code-executor.js'
import type { ExecutionReport, GuardianTask, VerificationExecutionStep } from '../packages/development-guardian/model.js'
import { assessGoldenVerification } from '../packages/development-guardian/work-session/golden-path.js'
import { planVerification, type VerificationPlan, type VerificationPlanStep } from '../packages/development-guardian/work-session/verification-planner.js'

const TASK: GuardianTask = { id: 'verification-contract', goal: 'verify contract', state: 'EXECUTING', iteration: 0, maxIterations: 2 }

async function withPlannerFixture(run: (repositoryRoot: string) => Promise<void>): Promise<void> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verification-contract-'))
  try {
    await mkdir(join(repositoryRoot, 'apps', 'web', 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ private: true }, null, 2))
    await writeFile(join(repositoryRoot, 'apps', 'web', 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'test:filter-empty': 'node --test tests/filter-empty.test.mjs' },
    }, null, 2))
    await writeFile(join(repositoryRoot, 'apps', 'web', 'tests', 'filter-empty.test.mjs'), 'export {}\n')
    await run(repositoryRoot)
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true })
  }
}

await test('R1 planner safely normalizes a task-local named node --test script', async () => {
  await withPlannerFixture(async (repositoryRoot) => {
    const plan = await planVerification({
      repositoryRoot,
      task: {
        id: 'R1',
        goal: 'Fix filter empty behavior',
        acceptanceCriteria: ['filter empty behavior is covered'],
        allowedPaths: ['apps/web/src/**', 'apps/web/tests/**'],
        forbiddenPaths: [],
      },
      changedAreaHint: ['apps/web/src/filter-empty.ts'],
    })

    const targeted = plan.steps.find((step) => step.id === 'targeted-test')
    assert.ok(targeted)
    assert.equal(targeted.command, 'node --test tests/filter-empty.test.mjs')
    assert.equal(targeted.cwd, 'apps/web')
    assert.equal(plan.approvalRequired, false)
  })
})

await test('R1 planner excludes Python bytecode and generated caches from npm targeted verification', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-polyglot-'))
  try {
    await mkdir(join(repositoryRoot, 'apps', 'api', 'tests', '__pycache__'), { recursive: true })
    await mkdir(join(repositoryRoot, '.cache', 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node scripts/test.mjs', typecheck: 'tsc --noEmit' } }))
    await writeFile(join(repositoryRoot, 'apps', 'api', 'tests', 'test_check_inventory.py'), 'def test_inventory(): pass\n')
    await writeFile(join(repositoryRoot, 'apps', 'api', 'tests', '__pycache__', 'test_check_inventory.cpython-312-pytest-8.3.3.pyc'), 'bytecode')
    await writeFile(join(repositoryRoot, '.cache', 'tests', 'check-inventory.test.js'), 'export {}\n')

    const plan = await planVerification({ repositoryRoot, task: { id: 'polyglot', goal: 'check inventory',
      acceptanceCriteria: ['Run relevant deterministic tests.'], allowedPaths: ['**'], forbiddenPaths: [] } })

    assert.equal(plan.steps.some((step) => step.id === 'targeted-test'), false)
    assert.equal(plan.steps.some((step) => /(?:__pycache__|\.py[co](?:\s|$)|\.cache)/iu.test(step.command)), false)
    assert.equal(plan.confidence, 'INSUFFICIENT')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner does not use generic smoke/test wording to select an unrelated test file', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-generic-test-'))
  try {
    await mkdir(join(repositoryRoot, 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    await writeFile(join(repositoryRoot, 'tests', 'unrelated-overview.test.mjs'), 'export {}\n')

    const plan = await planVerification({ repositoryRoot, task: { id: 'generic', goal: 'Human Smoke Test',
      acceptanceCriteria: ['Run relevant deterministic tests.'], allowedPaths: ['**'], forbiddenPaths: [] } })

    assert.equal(plan.steps.some((step) => step.id === 'targeted-test'), false)
    assert.equal(plan.confidence, 'INSUFFICIENT')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner still selects a relevant legal JavaScript targeted test', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-node-target-'))
  try {
    await mkdir(join(repositoryRoot, 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    await writeFile(join(repositoryRoot, 'tests', 'ticketFilters.test.mjs'), 'export {}\n')
    await writeFile(join(repositoryRoot, 'tests', 'overview.test.mjs'), 'export {}\n')

    const plan = await planVerification({ repositoryRoot, task: { id: 'node-target', goal: 'fix ticket filter count',
      acceptanceCriteria: ['ticket filter count is correct'], allowedPaths: ['src/**'], forbiddenPaths: [] } })

    const targeted = plan.steps.find((step) => step.id === 'targeted-test')
    assert.equal(targeted?.command, 'node --test tests/ticketFilters.test.mjs')
    assert.equal(targeted?.cwd, '.')
    assert.equal(targeted?.admission, 'ALLOWED')
    assert.equal(plan.confidence, 'HIGH')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner accepts a relevant repository-local node test without a package test script', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-new-project-'))
  try {
    await mkdir(join(repositoryRoot, 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(repositoryRoot, 'tests/storage.test.mjs'), "import test from 'node:test'; test('storage', () => {})\n")

    const plan = await planVerification({ repositoryRoot, task: { id: 'storage', goal: 'Implement storage',
      acceptanceCriteria: ['Stored items can be read after restart'], allowedPaths: ['.'], forbiddenPaths: [] },
    changedAreaHint: ['src/storage.mjs', 'tests/storage.test.mjs'] })

    assert.equal(plan.confidence, 'HIGH')
    assert.deepEqual(plan.steps.filter((step) => step.id === 'targeted-test').map((step) => step.command),
      ['node --test tests/storage.test.mjs'])
    assert.ok(plan.mappings.every((mapping) => mapping.evidence.includes('node --test tests/storage.test.mjs')))
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner runs a relevant node test directly when the root npm test script adds runtime flags', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-flagged-script-'))
  try {
    await mkdir(join(repositoryRoot, 'test'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: {
      test: 'node --experimental-strip-types --test test/storage.test.ts',
    } }))
    await writeFile(join(repositoryRoot, 'test/storage.test.ts'), "import test from 'node:test'; test('storage', () => {})\n")

    const plan = await planVerification({ repositoryRoot, task: { id: 'storage', goal: 'Implement storage',
      acceptanceCriteria: ['Stored items can be read after restart'], allowedPaths: ['.'], forbiddenPaths: [] },
    changedAreaHint: ['src/storage.ts', 'test/storage.test.ts'] })

    assert.equal(plan.confidence, 'HIGH')
    assert.equal(plan.approvalRequired, false)
    assert.deepEqual(plan.steps.filter((step) => step.id === 'targeted-test').map((step) => step.command),
      ['node --test test/storage.test.ts'])
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner preserves a package test runner that resolves TypeScript imports', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-ts-runner-'))
  try {
    await mkdir(join(repositoryRoot, 'test'))
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: 'tsx --test test/server-api.test.ts' } }))
    await writeFile(join(repositoryRoot, 'test/server-api.test.ts'), "import '.." + "/src/server.js'\n")
    const plan = await planVerification({ repositoryRoot, task: {
      id: 'foundation', goal: 'Implement server API', constraints: [], acceptanceCriteria: ['server API test passes'],
      allowedPaths: ['src/server.ts', 'test/server-api.test.ts'], forbiddenPaths: [],
    } })
    assert.deepEqual(plan.steps.filter((step) => step.id === 'targeted-test').map((step) => step.command), ['npm test'])
    assert.equal(plan.approvalRequired, false)
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner proves a hook-free package test glob covers the relevant TypeScript test', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-ts-glob-'))
  try {
    await mkdir(join(repositoryRoot, 'test'))
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: 'tsx --test test/**/*.test.ts' } }))
    await writeFile(join(repositoryRoot, 'test/database.test.ts'), "import '.." + "/src/database.js'\n")
    const task = { id: 'foundation', goal: 'Implement SQLite database',
      acceptanceCriteria: ['database retains tasks after restart'], allowedPaths: ['.'], forbiddenPaths: [] }
    const covered = await planVerification({ repositoryRoot, task,
      changedAreaHint: ['src/database.ts', 'test/database.test.ts'] })
    assert.equal(covered.confidence, 'HIGH')
    assert.equal(covered.steps.find((step) => step.id === 'targeted-test')?.command, 'npm test')
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: {
      test: 'tsx --test test/**/*.test.ts', pretest: 'node arbitrary-script.js',
    } }))
    const hooked = await planVerification({ repositoryRoot, task,
      changedAreaHint: ['src/database.ts', 'test/database.test.ts'] })
    assert.equal(hooked.confidence, 'MEDIUM')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 planner proves an explicit multi-file TypeScript package test includes the relevant test', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-planner-ts-list-'))
  try {
    await mkdir(join(repositoryRoot, 'test'))
    for (const name of ['task-store', 'server', 'start-command'])
      await writeFile(join(repositoryRoot, `test/${name}.test.ts`), `import test from 'node:test'; test('${name}', () => {})\n`)
    const script = 'tsx --test test/task-store.test.ts test/server.test.ts test/start-command.test.ts'
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { test: script } }))
    const task = { id: 'foundation', goal: 'Implement task store and server',
      acceptanceCriteria: ['task store and server behavior'], allowedPaths: ['.'], forbiddenPaths: [] }
    const input = { repositoryRoot, task, changedAreaHint: ['src/server.ts', 'test/server.test.ts'] }
    const covered = await planVerification(input)
    assert.equal(covered.confidence, 'HIGH')
    assert.equal(covered.steps.find((step) => step.id === 'targeted-test')?.command, 'npm test')
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: {
      test: script, pretest: 'node arbitrary-script.js',
    } }))
    assert.equal((await planVerification(input)).confidence, 'MEDIUM')
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: {
      test: `${script} && node arbitrary-script.js`,
    } }))
    assert.equal((await planVerification(input)).confidence, 'MEDIUM')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 verifier provisions ignored package tools before running an admitted npm test', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verifier-package-tool-'))
  try {
    await mkdir(join(repositoryRoot, 'tool'))
    await writeFile(join(repositoryRoot, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ private: true,
      scripts: { test: 'local-test', postinstall: "node -e \"require('node:fs').writeFileSync('install-hook-ran', 'bad')\"" },
      devDependencies: { 'local-test': 'file:tool' },
    }))
    await writeFile(join(repositoryRoot, 'tool/package.json'), JSON.stringify({ name: 'local-test', version: '1.0.0', bin: { 'local-test': 'bin.mjs' } }))
    await writeFile(join(repositoryRoot, 'tool/bin.mjs'), '#!/usr/bin/env node\nprocess.stdout.write("test passed\\n")\n')
    await chmod(join(repositoryRoot, 'tool/bin.mjs'), 0o755)
    execFileSync('git', ['init', '-q'], { cwd: repositoryRoot })
    const executor = new ClaudeCodeExecutor({ cwd: repositoryRoot, allowNpmInstall: true })
    const report: ExecutionReport = { summary: 'fixture', changedFiles: [], commandsRun: [], blockers: [],
      verificationResults: [{ name: 'npm test', status: 'failed' }] }
    const result = await executor.retryVerification({ task: TASK, report, verificationSteps: [{ stepId: 'targeted-test', command: 'npm test', cwd: '.' }] })
    assert.equal(result.verificationResults[0]?.status, 'passed', JSON.stringify(result.verificationResults[0]))
    assert.ok(result.commandsRun.some((command) => command.startsWith('npm install --ignore-scripts')))
    await assert.rejects(access(join(repositoryRoot, 'package-lock.json')))
    await assert.rejects(access(join(repositoryRoot, 'install-hook-ran')))
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R1 verifier rebuilds only declared better-sqlite3 while keeping project hooks disabled', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verifier-native-sqlite-'))
  try {
    await mkdir(join(repositoryRoot, 'tool'))
    await writeFile(join(repositoryRoot, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ private: true,
      scripts: { test: "node -e \"require('node:fs').accessSync('node_modules/better-sqlite3/native-ready')\"",
        postinstall: "node -e \"require('node:fs').writeFileSync('root-hook-ran', 'bad')\"" },
      dependencies: { 'better-sqlite3': 'file:tool' },
    }))
    await writeFile(join(repositoryRoot, 'tool/package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.4.1',
      scripts: { install: "node -e \"require('node:fs').writeFileSync('native-ready', 'built')\"" } }))
    execFileSync('git', ['init', '-q'], { cwd: repositoryRoot })
    const executor = new ClaudeCodeExecutor({ cwd: repositoryRoot, allowNpmInstall: true })
    const report: ExecutionReport = { summary: 'fixture', changedFiles: [], commandsRun: [], blockers: [],
      verificationResults: [{ name: 'npm test', status: 'failed' }] }
    const result = await executor.retryVerification({ task: TASK, report,
      verificationSteps: [{ stepId: 'targeted-test', command: 'npm test', cwd: '.' }] })
    assert.equal(result.verificationResults[0]?.status, 'passed', JSON.stringify(result.verificationResults[0]))
    assert.ok(result.commandsRun.some((command) => command.includes('npm rebuild better-sqlite3')))
    await access(join(repositoryRoot, 'node_modules', 'better-sqlite3', 'native-ready'))
    await assert.rejects(access(join(repositoryRoot, 'root-hook-ran')))
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})


function pendingReport(steps: readonly VerificationExecutionStep[]): ExecutionReport {
  return { summary: 'verification requested', changedFiles: [], commandsRun: [], blockers: [],
    verificationResults: steps.map((step) => ({ name: step.command, stepId: step.stepId, command: step.command, cwd: step.cwd, status: 'failed' })) }
}

function planWithSteps(steps: readonly VerificationPlanStep[]): VerificationPlan {
  return { planId: 'contract-plan', fingerprint: 'test-only', mappings: [{ criterion: 'criterion', evidence: steps.map((step) => step.command), scope: 'PACKAGE', reason: 'test' }],
    steps, escalationSequence: [], estimatedScope: 'PACKAGE', estimatedCost: 'LOW', confidence: 'HIGH', approvalRequired: false,
    invalidationConditions: [], packageRoots: [], explicitBindings: false, rationale: [] }
}

function planStep(id: string, command: string, cwd = '.'): VerificationPlanStep {
  return { id, command, cwd, scope: 'PACKAGE', reason: 'test', expectedCoverage: ['criterion'], environmentPrerequisites: [],
    failureClassifications: ['CODE_FAILURE', 'ENVIRONMENT_FAILURE', 'VERIFIER_CONFIGURATION_FAILURE', 'UNKNOWN'] }
}

await test('R2 complex named scripts and explicit bindings remain unapproved and unmodified', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verification-policy-'))
  try {
    await mkdir(join(repositoryRoot, 'apps', 'web', 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(join(repositoryRoot, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: {
      'pretest:filter-empty': 'node -e "process.exit(0)"',
      'test:filter-empty': 'node --test tests/filter-empty.test.mjs && node extra.mjs',
    } }))
    await writeFile(join(repositoryRoot, 'apps', 'web', 'tests', 'filter-empty.test.mjs'), 'export {}\n')
    const automatic = await planVerification({ repositoryRoot, task: { id: 'R2-auto', goal: 'filter empty', acceptanceCriteria: ['filter empty'],
      allowedPaths: ['apps/web/src/**'], forbiddenPaths: [] }, changedAreaHint: ['apps/web/src/filter.ts'] })
    assert.equal(automatic.approvalRequired, true)
    assert.equal(automatic.steps[0]?.command, 'npm run test:filter-empty')
    assert.equal(automatic.steps[0]?.admission, 'APPROVAL_REQUIRED')

    const explicitCommand = 'npm run test:filter-empty'
    const explicit = await planVerification({ repositoryRoot, task: { id: 'R2-explicit', goal: 'filter empty', acceptanceCriteria: ['filter empty'],
      acceptanceEvidenceBindings: [{ criterion: 'filter empty', requiredEvidence: [explicitCommand] }], allowedPaths: ['apps/web/**'], forbiddenPaths: [] },
    changedAreaHint: ['apps/web/src/filter.ts'] })
    assert.equal(explicit.steps[0]?.command, explicitCommand)
    assert.equal(explicit.steps[0]?.originalCommand, undefined)
    assert.equal(explicit.approvalRequired, true)
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R3/R4 real guarded verifier preserves package cwd, spaces, and same-command step identity', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verifier-cwd-'))
  try {
    await mkdir(join(repositoryRoot, 'apps', 'package one'), { recursive: true })
    await mkdir(join(repositoryRoot, 'apps', 'package two'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(31)"' } }))
    for (const name of ['package one', 'package two']) {
      await writeFile(join(repositoryRoot, 'apps', name, 'package.json'), JSON.stringify({ scripts: {
        typecheck: `node -e "if(require('node:path').basename(process.cwd())!=='${name}')process.exit(32)"`,
      } }))
    }
    const steps: VerificationExecutionStep[] = [
      { stepId: 'typecheck-one', command: 'npm run typecheck', cwd: 'apps/package one' },
      { stepId: 'typecheck-two', command: 'npm run typecheck', cwd: 'apps/package two' },
    ]
    const executor = new ClaudeCodeExecutor({ cwd: repositoryRoot })
    const report = await executor.retryVerification({ task: TASK, report: pendingReport(steps), verificationSteps: steps })
    assert.deepEqual(report.verificationResults.map((result) => [result.stepId, result.command, result.cwd, result.status]), [
      ['typecheck-one', 'npm run typecheck', 'apps/package one', 'passed'],
      ['typecheck-two', 'npm run typecheck', 'apps/package two', 'passed'],
    ])
    assert.equal(report.commandsRun.filter((command) => command === 'npm run typecheck').length, 2)
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R2/R4 real guarded verifier rejects cwd escape and invalidates changed normalization source', async () => {
  await withPlannerFixture(async (repositoryRoot) => {
    const plan = await planVerification({ repositoryRoot, task: { id: 'R4', goal: 'filter empty', acceptanceCriteria: ['filter empty'],
      allowedPaths: ['apps/web/**'], forbiddenPaths: [] }, changedAreaHint: ['apps/web/src/filter.ts'] })
    const targeted = plan.steps.find((step) => step.id === 'targeted-test')!
    const executor = new ClaudeCodeExecutor({ cwd: repositoryRoot })
    const escaped: VerificationExecutionStep = { stepId: 'escape', command: 'npm run typecheck', cwd: '../outside' }
    const escapedReport = await executor.retryVerification({ task: TASK, report: pendingReport([escaped]), verificationSteps: [escaped] })
    assert.equal(escapedReport.verificationResults[0]?.status, 'skipped')
    assert.equal(escapedReport.verificationResults[0]?.classification, 'VERIFIER_CONFIGURATION_FAILURE')
    assert.match(escapedReport.blockers[0] ?? '', /cwd/u)

    const manifest = join(repositoryRoot, 'apps', 'web', 'package.json')
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { scripts: Record<string, string> }
    parsed.scripts['test:filter-empty'] = 'node --test tests/changed.test.mjs'
    await writeFile(manifest, JSON.stringify(parsed))
    const scoped: VerificationExecutionStep = { stepId: targeted.id, command: targeted.command, cwd: targeted.cwd,
      sourceManifest: targeted.sourceManifest!, sourceScript: targeted.sourceScript!, sourceFingerprint: targeted.sourceFingerprint! }
    const stale = await executor.retryVerification({ task: TASK, report: pendingReport([scoped]), verificationSteps: [scoped] })
    assert.equal(stale.verificationResults[0]?.status, 'skipped')
    assert.match(stale.verificationResults[0]?.details ?? '', /source changed/u)
  })
})

await test('R4 planner and real verifier preserve a quoted test path inside a package with spaces', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verifier-spaces-'))
  try {
    await mkdir(join(repositoryRoot, 'apps', 'web space', 'tests'), { recursive: true })
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(join(repositoryRoot, 'apps', 'web space', 'package.json'), JSON.stringify({ scripts: {
      'test:filter-empty': 'node --test "tests/filter empty.test.mjs"',
    } }))
    await writeFile(join(repositoryRoot, 'apps', 'web space', 'tests', 'filter empty.test.mjs'), [
      'import test from "node:test"',
      'import assert from "node:assert/strict"',
      'test("cwd and quoted path", () => assert.equal(process.cwd().endsWith("web space"), true))',
      '',
    ].join('\n'))
    const plan = await planVerification({ repositoryRoot, task: { id: 'spaces', goal: 'filter empty', acceptanceCriteria: ['filter empty'],
      allowedPaths: ['apps/web space/**'], forbiddenPaths: [] }, changedAreaHint: ['apps/web space/src/filter.ts'] })
    const targeted = plan.steps.find((step) => step.id === 'targeted-test')!
    assert.equal(targeted.command, 'node --test "tests/filter empty.test.mjs"')
    const scoped: VerificationExecutionStep = { stepId: targeted.id, command: targeted.command, cwd: targeted.cwd,
      sourceManifest: targeted.sourceManifest!, sourceScript: targeted.sourceScript!, sourceFingerprint: targeted.sourceFingerprint! }
    const report = await new ClaudeCodeExecutor({ cwd: repositoryRoot }).retryVerification({ task: TASK, report: pendingReport([scoped]), verificationSteps: [scoped] })
    assert.equal(report.verificationResults[0]?.status, 'passed')
    assert.equal(report.verificationResults[0]?.cwd, 'apps/web space')
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})

await test('R5/R6 Golden preserves approval blockers and cannot complete BLOCKED passed results', () => {
  const step = planStep('targeted-test', 'npm run test:custom', 'apps/web')
  const plan = planWithSteps([step])
  const approval = assessGoldenVerification(plan, { status: 'BLOCKED', blockers: ['verification command requires human approval: npm run test:custom'],
    verificationResults: [{ name: step.command, stepId: step.id, command: step.command, cwd: step.cwd, status: 'skipped', classification: 'PERMISSION_REQUIRED' }] })
  assert.equal(approval.category, 'APPROVAL_REQUIRED')
  assert.match(approval.reason ?? '', /npm run test:custom/u)

  const blockedPassed = assessGoldenVerification(plan, { status: 'BLOCKED', blockers: ['workspace ownership unresolved'],
    verificationResults: [{ name: step.command, stepId: step.id, command: step.command, cwd: step.cwd, status: 'passed' }] })
  assert.equal(blockedPassed.passed, false)
  assert.equal(blockedPassed.category, 'SAFETY_BLOCKED')
  assert.match(blockedPassed.reason ?? '', /workspace ownership unresolved/u)
})

await test('R8 Golden fails closed for missing, duplicate, environment, and mixed approval results', () => {
  const first = planStep('first', 'node --test tests/first.test.mjs', 'apps/web')
  const second = planStep('second', 'npm run typecheck', 'apps/web')
  const plan = planWithSteps([first, second])
  assert.equal(assessGoldenVerification(plan, { status: 'SUCCESS', verificationResults: [], blockers: [] }).category, 'EVIDENCE_MISSING')
  const duplicate = { name: first.command, stepId: first.id, command: first.command, cwd: first.cwd, status: 'passed' as const }
  assert.equal(assessGoldenVerification(planWithSteps([first]), { status: 'SUCCESS', verificationResults: [duplicate, duplicate], blockers: [] }).category, 'VERIFIER_CONFIGURATION_REQUIRED')
  assert.equal(assessGoldenVerification(planWithSteps([first]), { status: 'SUCCESS', blockers: [], verificationResults: [
    { ...duplicate, status: 'failed', classification: 'ENVIRONMENT_FAILURE' },
  ] }).category, 'ENVIRONMENT_REQUIRED')
  const mixed = assessGoldenVerification(plan, { status: 'BLOCKED', blockers: ['verification command requires human approval: npm run typecheck'], verificationResults: [
    { ...duplicate, status: 'failed', classification: 'CODE_FAILURE' },
    { name: second.command, stepId: second.id, command: second.command, cwd: second.cwd, status: 'skipped', classification: 'PERMISSION_REQUIRED' },
  ] })
  assert.equal(mixed.category, 'APPROVAL_REQUIRED')
})

await test('R9 legacy repo-root retry and exact one-shot approval remain compatible', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'novawing-verifier-legacy-'))
  try {
    await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ scripts: {
      typecheck: 'node -e "process.exit(0)"',
      'test:custom': 'node -e "process.exit(0)"',
    } }))
    const root = new ClaudeCodeExecutor({ cwd: repositoryRoot })
    const rootReport: ExecutionReport = { summary: 'legacy', changedFiles: [], commandsRun: [], blockers: [],
      verificationResults: [{ name: 'npm run typecheck', status: 'failed' }] }
    const passed = await root.retryVerification({ task: TASK, report: rootReport })
    assert.equal(passed.verificationResults[0]?.status, 'passed')
    assert.equal(passed.verificationResults[0]?.cwd, undefined)

    const approved = new ClaudeCodeExecutor({ cwd: repositoryRoot, approvedVerificationCommand: 'npm run test:custom' })
    const customReport: ExecutionReport = { summary: 'legacy approved', changedFiles: [], commandsRun: [], blockers: [],
      verificationResults: [{ name: 'npm run test:custom', status: 'failed' }] }
    const approvedResult = await approved.retryVerification({ task: TASK, report: customReport })
    assert.equal(approvedResult.verificationResults[0]?.status, 'passed')
    assert.ok(approvedResult.commandsRun.includes('npm run test:custom'))
  } finally { await rm(repositoryRoot, { recursive: true, force: true }) }
})
