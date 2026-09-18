import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assessVerificationCommand } from '../packages/development-guardian/verification-command-policy.js'
import { preflightTaskContract } from '../packages/development-guardian/work-session/launchpad/contract-preflight.js'
import { analyzeTaskBrief } from '../packages/development-guardian/work-session/launchpad/task-brief.js'
import { classifyAcceptanceCriterion } from '../packages/development-guardian/work-session/launchpad/acceptance-criterion.js'
import { extractAcceptanceVerifier } from '../packages/development-guardian/work-session/launchpad/verifier-command-extraction.js'
import type { AcceptanceEvidenceBinding } from '../packages/development-guardian/work-session/risk-evidence.js'
import { createTaskStateV2, loadTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { bindingsFromVerificationPlan, planVerification } from '../packages/development-guardian/work-session/verification-planner.js'

const COMMAND_CASES = [
  ['git diff --check 通过。', 'git diff --check'],
  ['npm run typecheck 必须通过。', 'npm run typecheck'],
  ['运行 npm run build 并确保成功', 'npm run build'],
  ['node --test tests/ticket-status.test.js 应通过。', 'node --test tests/ticket-status.test.js'],
  ['npm test -- tests/foo.test.js must pass', 'npm test -- tests/foo.test.js'],
  ['git diff --check', 'git diff --check'],
  ['npm  run typecheck 必须通过', 'npm run typecheck'],
  ['git  diff --check 通过。', 'git diff --check'],
] as const

const NON_COMMAND_CRITERIA = [
  '成功生成 Git checkpoint。',
  '不存在 unresolved blocker。',
  '代码实际完成。',
  '功能满足验收标准。',
  '不得修改 tests/**。',
  '保持现有行为不变。',
  '运行适合当前项目的测试并确保通过',
  'Run the appropriate tests and ensure they pass',
  '保留 Git 历史和 npm 配置。',
  'Git checkpoint 已保存。',
  '使用 pytest 的测试保持通过。',
] as const

async function verifierRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-verifier-parsing-'))
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc', pass: 'node --test',
  } }), 'utf8')
  for (const path of ['ticket-status.test.js', 'foo.test.js', 'should pass.test.js', 'pass.test.js']) {
    await writeFile(join(root, 'tests', path), '', 'utf8')
  }
  return root
}

for (const criterion of NON_COMMAND_CRITERIA) {
  test(`non-command criterion never produces an extracted verifier or extraction issue: ${criterion}`, async () => {
    assert.equal(classifyAcceptanceCriterion(criterion), 'NON_COMMAND')
    assert.equal(extractAcceptanceVerifier(criterion), undefined)
    const analysis = analyzeTaskBrief(`【验收标准】\n${criterion}`)
    assert.deepEqual(analysis.fields.acceptanceCriteria, [criterion])
    assert.deepEqual(analysis.fields.acceptanceEvidenceBindings ?? [], [])
    assert.deepEqual(analysis.warnings, [])
    const root = await verifierRepository()
    try {
      for (const verificationPlannerEnabled of [false, true]) {
        const result = await preflightTaskContract({
          targetRepo: root, acceptanceCriteria: [criterion], acceptanceEvidenceBindings: [], verificationPlannerEnabled,
        })
        assert.deepEqual(result.verifiers, [])
        if (!result.ok) assert.ok(result.issues.every((issue) => issue.issueCode !== 'UNSAFE_VERIFIER_EXTRACTION'), JSON.stringify(result))
        if (verificationPlannerEnabled || criterion === NON_COMMAND_CRITERIA[0]) {
          assert.equal(result.ok, true, JSON.stringify(result))
          if (result.ok) {
            assert.deepEqual(result.acceptanceCriteria, [criterion])
            assert.deepEqual(result.acceptanceEvidenceBindings, [])
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('mixed acceptance criteria extract only executable command syntax and preserve semantic requirements', async () => {
  const criteria = [...NON_COMMAND_CRITERIA, 'git diff --check 通过。', 'npm run typecheck 必须通过。']
  const analysis = analyzeTaskBrief(`【验收标准】\n${criteria.map((criterion) => `- ${criterion}`).join('\n')}`)
  const expected = [
    { criterion: criteria.at(-2), requiredEvidence: ['git diff --check'] },
    { criterion: criteria.at(-1), requiredEvidence: ['npm run typecheck'] },
  ]
  assert.deepEqual(analysis.fields.acceptanceCriteria, criteria)
  assert.deepEqual(analysis.warnings, [])
  assert.deepEqual(analysis.fields.acceptanceEvidenceBindings?.map(({ criterion, requiredEvidence }) => ({ criterion, requiredEvidence })), expected)
  const root = await verifierRepository()
  try {
    for (const bindings of [[], analysis.fields.acceptanceEvidenceBindings ?? []]) {
      const result = await preflightTaskContract({ targetRepo: root, acceptanceCriteria: criteria, acceptanceEvidenceBindings: bindings, verificationPlannerEnabled: true })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(result.verifiers.map(({ command }) => command), ['git diff --check', 'npm run typecheck'])
      if (result.ok) {
        assert.deepEqual(result.acceptanceCriteria, criteria)
        assert.deepEqual(result.acceptanceEvidenceBindings.map(({ criterion, requiredEvidence }) => ({ criterion, requiredEvidence })), expected)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Quick Fill and repository preflight canonicalize acceptance command cases A-E and preserve pure command I', async () => {
  const root = await verifierRepository()
  try {
    for (const [criterion, command] of COMMAND_CASES) {
      assert.equal(classifyAcceptanceCriterion(criterion), 'COMMAND_BEARING')
      const analysis = analyzeTaskBrief(`【验收标准】\n1. ${criterion}`)
      assert.deepEqual(analysis.fields.acceptanceCriteria, [criterion])
      assert.deepEqual(analysis.fields.acceptanceEvidenceBindings?.map((binding) => ({
        criterion: binding.criterion, requiredEvidence: binding.requiredEvidence,
      })), [{ criterion, requiredEvidence: [command] }], criterion)
      const admission = assessVerificationCommand(command)
      if (criterion !== command) {
        assert.deepEqual(analysis.fields.acceptanceEvidenceBindings?.[0]?.commandCanonicalizations, [{
          sourceText: criterion, command, grammar: 'acceptance-command-v1', assessment: admission.status,
        }])
      }
      // Exercise both Quick Fill's structured binding and the direct Composer path.
      for (const bindings of [[], analysis.fields.acceptanceEvidenceBindings ?? []]) {
        const result = await preflightTaskContract({
          targetRepo: root, acceptanceCriteria: [criterion], acceptanceEvidenceBindings: bindings,
        })
        assert.deepEqual(result.verifiers.map((verifier) => verifier.command), [command], criterion)
        if (admission.status === 'ALLOWED') {
          assert.equal(result.ok, true, JSON.stringify(result))
          assert.deepEqual(result.verifiers.map((verifier) => verifier.classification), ['TRUSTED'])
          if (result.ok && criterion !== command) {
            assert.deepEqual(result.acceptanceEvidenceBindings[0]?.commandCanonicalizations, [{
              sourceText: criterion, command, grammar: 'acceptance-command-v1', assessment: admission.status,
            }])
          }
        } else {
          assert.equal(result.ok, false, 'Canonicalization does not grant a new verifier permission.')
          if (!result.ok) assert.deepEqual(result.issues.map((issue) => issue.issueCode), ['VERIFIER_APPROVAL_REQUIRED'])
          assert.deepEqual(result.verifiers.map((verifier) => verifier.classification), ['APPROVAL_REQUIRED'])
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acceptance extraction recognizes bounded result phrases and punctuation without copying prose', () => {
  const suffixes = ['通过', '成功', '应通过', '必须通过', '确保通过', '确保成功', 'pass', 'passes', 'should pass', 'must pass', 'succeeds']
  const punctuation = ['', '。', '.', '，', ',', ';', '：', ':']
  for (const suffix of suffixes) {
    for (const ending of punctuation) {
      const criterion = `npm run typecheck ${suffix}${ending}`
      const extracted = extractAcceptanceVerifier(criterion)
      assert.equal(extracted?.command, 'npm run typecheck', criterion)
      assert.equal(extracted?.canonicalization.sourceText, criterion)
      assert.equal(extracted?.canonicalization.command, 'npm run typecheck')
      assert.equal(extracted?.canonicalization.grammar, 'acceptance-command-v1')
      assert.equal(extracted?.canonicalization.assessment, 'ALLOWED')
    }
  }
})

test('explicit evidence binding case F preserves the criterion and uses only its authoritative RHS', async () => {
  const root = await verifierRepository()
  try {
    const criterion = 'git diff --check 通过。'
    const expected = [{ criterion, requiredEvidence: ['git diff --check'] }]
    for (const brief of [
      `【验收标准】\n${criterion} => git diff --check`,
      `【验收标准】\n${criterion}\n【Required Evidence Binding】\n${criterion} => git diff --check`,
    ]) {
      const analysis = analyzeTaskBrief(brief)
      assert.deepEqual(analysis.fields.acceptanceCriteria, [criterion])
      assert.deepEqual(analysis.fields.acceptanceEvidenceBindings?.map((binding) => ({
        criterion: binding.criterion, requiredEvidence: binding.requiredEvidence,
      })), expected)
      const result = await preflightTaskContract({
        targetRepo: root, acceptanceCriteria: analysis.fields.acceptanceCriteria ?? [],
        acceptanceEvidenceBindings: analysis.fields.acceptanceEvidenceBindings ?? [],
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (result.ok) {
        assert.deepEqual(result.acceptanceCriteria, [criterion])
        assert.deepEqual(result.acceptanceEvidenceBindings.map((binding) => ({
          criterion: binding.criterion, requiredEvidence: binding.requiredEvidence,
        })), expected)
      }
    }
    const authoritative = analyzeTaskBrief(`【验收标准】\n${criterion}\n【Required Evidence Binding】\n${criterion} => npm test`)
    assert.deepEqual(authoritative.fields.acceptanceEvidenceBindings?.map((binding) => ({
      criterion: binding.criterion, requiredEvidence: binding.requiredEvidence,
    })), [{ criterion, requiredEvidence: ['npm test'] }],
      'An explicit verifier overrides an inferred command rather than accumulating both.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ambiguous or merely mentioned commands G-H cannot become executable bindings or approval requests', async () => {
  const root = await verifierRepository()
  try {
    for (const criterion of [
      '如果需要可以考虑运行 npm test，但不要执行全量测试',
      'npm test and inspect the logs',
      'npm test 必须通过然后部署',
      'If needed, consider running "npm test", but do not execute the full suite',
      '如果需要可以考虑运行“npm test”，但不要执行全量测试',
      'node.exe --test tests/foo.test.js must pass then report',
      'npm test -- --grep must pass',
      'npm test -- "tests/a.js""tests/b.js" must pass',
      'npm test; node -e "process.exit(0)"',
      'npm test&&echo done',
      'npm test|tee results.log',
      'npm test>output.txt',
      'npm run',
    ]) {
      const analysis = analyzeTaskBrief(`【验收标准】\n${criterion}`)
      assert.deepEqual(analysis.fields.acceptanceCriteria, [criterion])
      assert.deepEqual(analysis.fields.acceptanceEvidenceBindings ?? [], [], criterion)
      assert.match(analysis.warnings.join(' '), /未能安全识别验证命令，需要确认/u, criterion)
      for (const verificationPlannerEnabled of [false, true]) {
        const result = await preflightTaskContract({
          targetRepo: root, acceptanceCriteria: [criterion], acceptanceEvidenceBindings: [], verificationPlannerEnabled,
        })
        assert.equal(result.ok, false, criterion)
        assert.deepEqual(result.verifiers, [], criterion)
        if (!result.ok) {
          assert.ok(result.issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION'), JSON.stringify(result))
          assert.ok(result.issues.every((issue) => issue.issueCode !== 'VERIFIER_APPROVAL_REQUIRED'), criterion)
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('result words inside legal command arguments are never treated as prose boundaries', () => {
  for (const command of [
    'git diff --check',
    'npm run pass',
    'npm test -- tests/pass.test.js',
    'node --test tests/pass.test.js',
    'node --test "tests/should pass.test.js"',
    'pytest "tests/should pass.py"',
    'npm run "typecheck"',
    "npm run 'typecheck'",
  ]) {
    assert.equal(extractAcceptanceVerifier(command)?.command, command, command)
    assert.equal(extractAcceptanceVerifier(`${command} must pass`)?.command, command, command)
  }
})

test('explicit verifier prose is rejected before approval classification without rewriting the RHS', async () => {
  const root = await verifierRepository()
  try {
    for (const command of [
      'git diff --check 通过。', 'npm test 必须通过', 'npm run typecheck 应成功',
      '运行 npm run build 并确保成功', 'pytest tests/test_api.py 应该通过',
      'npm test 必须通过然后部署', 'npm test must pass, then publish',
      'npm test must pass; npm run deploy', '通过 git diff --check',
    ]) {
      const result = await preflightTaskContract({
        targetRepo: root, acceptanceCriteria: ['proof'],
        acceptanceEvidenceBindings: [{ criterion: 'proof', requiredEvidence: [command] }],
      })
      assert.equal(result.ok, false, command)
      assert.ok(result.verifiers.every((verifier) => verifier.classification !== 'APPROVAL_REQUIRED'), command)
      if (!result.ok) assert.ok(result.issues.every((issue) => issue.issueCode !== 'VERIFIER_APPROVAL_REQUIRED'), command)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an explicit command option value remains authoritative rather than being truncated as a result phrase', async () => {
  const root = await verifierRepository()
  try {
    const command = 'npm test -- --grep must pass'
    const result = await preflightTaskContract({
      targetRepo: root, acceptanceCriteria: ['the selected test passes'],
      acceptanceEvidenceBindings: [{ criterion: 'the selected test passes', requiredEvidence: [command] }],
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.verifiers.map((verifier) => ({ command: verifier.command, classification: verifier.classification })),
      [{ command, classification: 'APPROVAL_REQUIRED' }], 'The existing exact-command approval policy still applies.')
    if (!result.ok) assert.deepEqual(result.issues.map((issue) => issue.issueCode), ['VERIFIER_APPROVAL_REQUIRED'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid natural-language canonicalization evidence fails parsing before the approval pipeline', async () => {
  const root = await verifierRepository()
  try {
    const sourceText = 'npm test -- tests/foo.test.js must pass'
    const command = 'npm test -- tests/foo.test.js'
    const validProof = { sourceText, command, grammar: 'acceptance-command-v1', assessment: 'APPROVAL_REQUIRED' }
    for (const proof of [
      { ...validProof, sourceText: 'npm test must pass' },
      { ...validProof, command: 'npm test' },
      { ...validProof, grammar: 'acceptance-command-v2' },
      { ...validProof, assessment: 'ALLOWED' },
    ]) {
      const binding = { criterion: sourceText, requiredEvidence: [command], commandCanonicalizations: [proof] } as unknown as AcceptanceEvidenceBinding
      const result = await preflightTaskContract({ targetRepo: root, acceptanceCriteria: [sourceText], acceptanceEvidenceBindings: [binding] })
      assert.equal(result.ok, false)
      assert.ok(result.verifiers.every((verifier) => verifier.classification !== 'APPROVAL_REQUIRED'), JSON.stringify(proof))
      if (!result.ok) {
        assert.ok(result.issues.some((issue) => issue.issueCode === 'UNSAFE_VERIFIER_EXTRACTION'), JSON.stringify(result))
        assert.ok(result.issues.every((issue) => issue.issueCode !== 'VERIFIER_APPROVAL_REQUIRED'), JSON.stringify(proof))
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('canonicalization evidence survives structured Task state persistence and explicit Verification Plan round trips', async () => {
  const root = await verifierRepository()
  try {
    const acceptanceCriteria = ['npm run typecheck 必须通过', 'node --test tests/ticket-status.test.js 应通过。']
    const contract = await preflightTaskContract({ targetRepo: root, acceptanceCriteria, acceptanceEvidenceBindings: [] })
    assert.equal(contract.ok, true, JSON.stringify(contract))
    if (!contract.ok) return
    const task = {
      id: 'UAT-V031-001', goal: 'Keep canonical verifier evidence through persistence.',
      allowedPaths: ['tests/**'], acceptanceCriteria, acceptanceEvidenceBindings: contract.acceptanceEvidenceBindings,
    }
    const plan = await planVerification({ repositoryRoot: root, task })
    assert.equal(plan.explicitBindings, true)
    assert.equal(plan.approvalRequired, false)
    assert.deepEqual(bindingsFromVerificationPlan(plan), contract.acceptanceEvidenceBindings)
    const state = createTaskStateV2({ id: 'verifier-parsing', branch: 'main' }, task)
    state.verificationPlan = plan
    const restored = loadTaskStateV2(JSON.parse(JSON.stringify(state)))
    assert.deepEqual(restored.completion.bindings, contract.acceptanceEvidenceBindings)
    assert.deepEqual(restored.verificationPlan?.mappings, plan.mappings)
    assert.deepEqual(bindingsFromVerificationPlan(restored.verificationPlan!), contract.acceptanceEvidenceBindings)
    const stepBindings = bindingsFromVerificationPlan(restored.verificationPlan!, { identity: 'step' })
    for (const binding of stepBindings) {
      assert.deepEqual(binding.commandCanonicalizations,
        contract.acceptanceEvidenceBindings.find((original) => original.criterion === binding.criterion)?.commandCanonicalizations)
      assert.ok(binding.requiredEvidence.every((evidence) => plan.steps.some((step) => step.id === evidence)))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
