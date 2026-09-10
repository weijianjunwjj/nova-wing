import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  parseTaskContractBindingDsl,
  preflightTaskContract,
} from '../packages/development-guardian/work-session/launchpad/contract-preflight.js'

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-contract-preflight-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

test('Fly-weave-like inline placeholder is repaired from repository test reality', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node scripts/test.mjs' } }),
    'scripts/test.mjs': "spawn(python, ['-m', 'pytest', ...process.argv.slice(2)])\n",
    'pytest.ini': '[pytest]\ntestpaths = apps/api/tests\n',
    'apps/api/main.py': 'customer_email: str\n',
    'apps/api/tests/test_ticket_intake.py': 'def test_ticket_intake(): pass\n',
  })
  try {
    const result = await preflightTaskContract({
      targetRepo: root,
      acceptanceCriteria: ['AC1 Invalid email is rejected with HTTP 400 => npm test -- --runInBand <对应测试>'],
      acceptanceEvidenceBindings: [],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.acceptanceCriteria, ['AC1 Invalid email is rejected with HTTP 400'])
    assert.deepEqual(result.acceptanceEvidenceBindings, [{
      criterion: 'AC1 Invalid email is rejected with HTTP 400',
      requiredEvidence: ['npm test'],
    }])
    assert.deepEqual(result.verifiers.map((item) => item.classification), ['TRUSTED'])
    assert.ok(result.repairs.some((repair) => repair.includes('repository test entry')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mechanical duplicate criteria and bindings normalize without weakening semantics', async () => {
  const root = await fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  try {
    const result = await preflightTaskContract({
      targetRepo: root,
      acceptanceCriteria: ['Tests pass', '  tests   pass  '],
      acceptanceEvidenceBindings: [
        { criterion: 'Tests pass', requiredEvidence: ['npm test', 'npm test'] },
        { criterion: 'tests pass', requiredEvidence: ['npm test'] },
      ],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.acceptanceCriteria, ['Tests pass'])
    assert.deepEqual(result.acceptanceEvidenceBindings, [{ criterion: 'Tests pass', requiredEvidence: ['npm test'] }])
    assert.ok(result.repairs.some((repair) => repair.includes('duplicate mechanical criterion')))
    assert.ok(result.repairs.some((repair) => repair.includes('duplicate mechanical evidence binding')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid contracts return stable issue codes instead of entering runtime', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'tests/present.test.js': 'test("ok", () => {})\n',
  })
  try {
    const cases = [
      { criteria: ['missing'], bindings: [], code: 'MISSING_EVIDENCE_BINDING' },
      { criteria: ['known'], bindings: [{ criterion: 'unknown', requiredEvidence: ['npm test'] }], code: 'BINDING_IDENTITY_MISMATCH' },
      { criteria: ['known'], bindings: [{ criterion: 'known', requiredEvidence: [''] }], code: 'EMPTY_VERIFIER_COMMAND' },
      { criteria: ['known'], bindings: [{ criterion: 'known', requiredEvidence: ['npm run absent'] }], code: 'PACKAGE_SCRIPT_NOT_FOUND' },
      { criteria: ['known'], bindings: [{ criterion: 'known', requiredEvidence: ['node --test tests/missing.test.js'] }], code: 'TEST_PATH_NOT_FOUND' },
    ] as const
    for (const item of cases) {
      const result = await preflightTaskContract({ targetRepo: root, acceptanceCriteria: item.criteria, acceptanceEvidenceBindings: item.bindings })
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.ok(result.issues.some((issue) => issue.issueCode === item.code), JSON.stringify(result.issues))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unresolvable placeholder and approval-required verifier fail before Session creation', async () => {
  const root = await fixture({ 'README.md': '# no test entry\n' })
  try {
    const unresolved = await preflightTaskContract({
      targetRepo: root,
      acceptanceCriteria: ['proof => npm test -- <对应测试>'],
      acceptanceEvidenceBindings: [],
    })
    assert.equal(unresolved.ok, false)
    if (!unresolved.ok) assert.ok(unresolved.issues.some((issue) => issue.issueCode === 'UNRESOLVED_PLACEHOLDER'))

    const approval = await preflightTaskContract({
      targetRepo: root,
      acceptanceCriteria: ['proof'],
      acceptanceEvidenceBindings: [{ criterion: 'proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
    })
    assert.equal(approval.ok, false)
    if (!approval.ok) {
      assert.equal(approval.verifiers[0]?.classification, 'APPROVAL_REQUIRED')
      assert.ok(approval.issues.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('binding DSL splits only the first delimiter when verifier contains =>', () => {
  assert.deepEqual(parseTaskContractBindingDsl('output is mapped => node -e "console.log(\'x => y\')"'), {
    criterionText: 'output is mapped',
    verifierCommand: 'node -e "console.log(\'x => y\')"',
  })
})
