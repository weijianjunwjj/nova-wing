import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { analyzeTaskBrief } from '../packages/development-guardian/work-session/launchpad/task-brief.js'
import { LAUNCHPAD_APP_JS } from '../packages/development-guardian/work-session/launchpad/view.js'

test('structured Quick Fill parses complete labelled Task IDs without extracting prose or truncating invalid values', () => {
  for (const brief of [
    'Task ID: UAT-V031-001', 'TaskID: UAT-V031-001',
    '【Task ID】\nUAT-V031-001', '【Task ID】 UAT-V031-001',
    '任务 ID: UAT-V031-001', '【任务 ID】\nUAT-V031-001',
    '## Task ID\nUAT-V031-001',
  ]) assert.equal(analyzeTaskBrief(brief).fields.taskId, 'UAT-V031-001', brief)

  for (const brief of [
    '请修复 UAT-V031-001 中的问题。', 'The previous Task ID: UAT-001 is only background.',
    'Task ID: UAT/001', `Task ID: ${'A'.repeat(65)}`, 'Task ID: UAT-001 extra',
    '【Task ID】\n【目标】\n修复问题',
  ]) assert.equal(analyzeTaskBrief(brief).fields.taskId, undefined, brief)
})

test('structured Quick Fill parses path lists and respects known and unknown section boundaries', () => {
  for (const label of ['【允许修改路径】', '允许修改路径:', 'Allowed Paths:', '【Allowed Paths】', 'allowedPaths:', '## Allowed Paths']) {
    const brief = `${label}\n- src/**\n\n* tests/**\napps/web/**\n【约束】\n不要改动依赖\n【验收标准】\nnpm test\n【禁止修改路径】\npackage.json`
    const original = brief
    const result = analyzeTaskBrief(brief)
    assert.deepEqual(result.fields.allowedPaths, ['src/**', 'tests/**', 'apps/web/**'], label)
    assert.deepEqual(result.fields.forbiddenPaths, ['package.json'])
    assert.deepEqual(result.fields.constraints, ['不要改动依赖'])
    assert.deepEqual(result.fields.acceptanceCriteria, ['npm test'])
    assert.equal(brief, original)
  }
  assert.deepEqual(analyzeTaskBrief('Allowed Paths:\nsrc/**\n【补充信息】\ntests/**').fields.allowedPaths, ['src/**'])
  assert.deepEqual(analyzeTaskBrief('Allowed Paths:\n**').fields.allowedPaths, ['**'], 'an explicit whole-repo pattern is preserved exactly')
  assert.deepEqual(analyzeTaskBrief('Allowed Paths:\n-src/**\n**/*.ts').fields.allowedPaths, ['-src/**', '**/*.ts'], 'only bullet prefixes followed by whitespace are removed')
})

test('explicit unsafe or unparseable allowedPaths stays unresolved instead of becoming whole-repo authorization', () => {
  for (const value of ['', '../outside/**', '/absolute/**', 'D:\\outside\\**', '请自行决定', 'src/**\n../outside/**', '**\n不允许修改任何文件']) {
    const result = analyzeTaskBrief(`【允许修改路径】\n${value}\n【约束】\n保持原有授权`)
    assert.equal(result.fields.allowedPaths, undefined, value)
    assert.ok(result.unresolvedFields?.includes('allowedPaths'))
    assert.match(result.warnings.join(' '), /允许修改路径：未识别，请确认/u)
  }
})

test('structured task blocks keep IDs and goals local, and do not union differing task authorizations', () => {
  const result = analyzeTaskBrief(`【项目目录】\nD:\\repo\n【分支】 main\n【允许修改路径】\nsrc/**\n【Task 1】\n【Task ID】 UAT-001\n【目标】修复第一个问题\n【Task 2】\nTaskID: UAT-002\n目标: 修复第二个问题`)
  assert.equal(result.fields.targetRepo, 'D:\\repo')
  assert.equal(result.fields.branch, 'main')
  assert.equal(result.fields.taskId, undefined)
  assert.deepEqual(result.fields.tasks, [
    { taskId: 'UAT-001', taskInstructions: '修复第一个问题' },
    { taskId: 'UAT-002', taskInstructions: '修复第二个问题' },
  ])
  assert.deepEqual(result.fields.allowedPaths, ['src/**'])
  const repeated = analyzeTaskBrief('Task ID: UAT-001\n目标: first\nTask ID: UAT-002\n目标: second')
  assert.deepEqual(repeated.fields.tasks?.map((task) => task.taskId), ['UAT-001', 'UAT-002'])
  const missing = analyzeTaskBrief('Task ID: GLOBAL\n## Task 1\nTask ID: UAT-001\n目标: first\n## Task 2\n目标: second')
  assert.deepEqual(missing.fields.tasks?.map((task) => task.taskId), ['UAT-001', undefined], 'global ID does not leak into a task without its own ID')
  const invalid = analyzeTaskBrief('## Task 1\nTask ID: UAT-001\n目标: first\n## Task 2\nTask ID: bad/id\n目标: second')
  assert.ok(invalid.unresolvedFields?.includes('taskId'))
  const scoped = analyzeTaskBrief('## Task 1\nTask ID: UAT-001\nAllowed Paths:\nsrc/**\n## Task 2\nTask ID: UAT-002\nAllowed Paths:\ntests/**')
  assert.equal(scoped.fields.allowedPaths, undefined)
  assert.ok(scoped.unresolvedFields?.includes('allowedPaths'))
})

function input(value = '') {
  const attributes = new Map<string, string>()
  return {
    value, attributes, dispatchEvent() {}, focus() {},
    setAttribute(name: string, content: string) { attributes.set(name, content) },
    removeAttribute(name: string) { attributes.delete(name) },
  }
}

function quickFillHarness() {
  const rows: ReturnType<typeof taskRow>[] = []
  function taskRow() {
    const id = input('OLD-ID')
    const goal = input('old goal')
    const row = {
      id, goal,
      querySelector(selector: string) { return selector === '[data-task-id]' ? id : goal },
      cloneNode() { return taskRow() },
      remove() { rows.splice(rows.indexOf(row), 1) },
    }
    return row
  }
  rows.push(taskRow())
  const elements = Object.fromEntries(['allowedPaths', 'forbiddenPaths', 'constraints', 'acceptanceCriteria', 'acceptanceEvidenceBindings', 'doNotDo', 'executorMode'].map((key) => [key, input('**')]))
  const context = vm.createContext({
    targetRepo: input(), branch: input(), form: { elements }, briefResult: { textContent: '' }, Event,
    taskRows: () => rows, taskContainer: { appendChild(row: ReturnType<typeof taskRow>) { rows.push(row) } },
    attachTaskRow() {}, updateTaskRows() {}, discoverTargetRepo() {}, updatePushRemote() {}, updateSchedule() {},
  })
  const start = LAUNCHPAD_APP_JS.indexOf('const applyBriefAnalysis =')
  const end = LAUNCHPAD_APP_JS.indexOf('briefFill.addEventListener', start)
  vm.runInContext(LAUNCHPAD_APP_JS.slice(start, end) + ';globalThis.apply = applyBriefAnalysis', context)
  const apply = (brief: string) => {
    const { modelRecommendation: _recommendation, ...result } = analyzeTaskBrief(brief)
    context.result = result
    vm.runInContext('apply(result, true)', context)
  }
  return { rows, elements, apply }
}

test('Quick Fill applies parsed IDs to real row inputs with the established replacement convention', () => {
  const harness = quickFillHarness()
  harness.apply('【Task ID】\nUAT-001\n【目标】\n修复问题\n【允许修改路径】\nsrc/**')
  assert.equal(harness.rows[0]!.id.value, 'UAT-001')
  assert.equal(harness.rows[0]!.goal.value, '修复问题')
  assert.equal(harness.elements.allowedPaths!.value, 'src/**')
  harness.apply('## Task 1\nTask ID: UAT-002\n目标: first\n## Task 2\nTask ID: UAT-003\n目标: second')
  assert.deepEqual(harness.rows.map((row) => row.id.value), ['UAT-002', 'UAT-003'])
  assert.deepEqual(harness.rows.map((row) => row.goal.value), ['first', 'second'])
})

test('Quick Fill clears a previous whole-repo value when explicit allowedPaths cannot be parsed', () => {
  const harness = quickFillHarness()
  harness.apply('Task ID: UAT-001\n目标: 修复问题\n【允许修改路径】\n无法确定')
  assert.equal(harness.elements.allowedPaths!.value, '')
  assert.equal(harness.elements.allowedPaths!.attributes.get('aria-invalid'), 'true')
  assert.match(LAUNCHPAD_APP_JS, /if \(allowedPaths.length === 0\) \{[\s\S]*?请填写至少一个允许修改路径/u)
})
