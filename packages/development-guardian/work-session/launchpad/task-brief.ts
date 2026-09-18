import {
  CODING_EXECUTOR_DEFAULTS,
  isSupportedCodexConfiguration,
  type CodexReasoningEffort,
  type ExecutorMode,
} from '../../coding-executor-config.js'
import type { AcceptanceEvidenceBinding } from '../risk-evidence.js'
import { parseTaskContractBindingDsl } from './contract-preflight.js'
import { classifyAcceptanceCriterion } from './acceptance-criterion.js'
import { extractAcceptanceVerifier } from './verifier-command-extraction.js'

/**
 * The Launchpad brief is deliberately treated as an untrusted convenience
 * input.  This module only produces values that can be represented by the
 * existing Composer controls; creation still goes through Composer validation.
 */
export interface TaskBriefAnalysis {
  fields: {
    targetRepo?: string
    branch?: string
    taskId?: string
    taskInstructions: string
    tasks?: Array<{ taskId?: string; taskInstructions: string }>
    allowedPaths?: string[]
    forbiddenPaths?: string[]
    constraints?: string[]
    acceptanceCriteria?: string[]
    acceptanceEvidenceBindings?: AcceptanceEvidenceBinding[]
    doNotDo?: string[]
    executorMode?: ExecutorMode
    softMinutes?: number
    hardMinutes?: number
    startMode?: 'immediate' | 'custom'
    customStartAt?: string
    autoCommit?: boolean
    autoPush?: boolean
    emailEnabled?: boolean
  }
  modelRecommendation?: {
    model: string
    reasoningEffort: CodexReasoningEffort
    complexity: 'light' | 'standard' | 'complex'
    reason: string
    signals: string[]
    modelExplicit: boolean
    reasoningExplicit: boolean
  }
  recognized: string[]
  warnings: string[]
  unresolvedFields?: Array<'taskId' | 'allowedPaths'>
}

/** Kept below the 96 KiB JSON request body limit even for multibyte text. */
export const MAX_TASK_BRIEF_CHARS = 20_000
const MAX_TASK_INSTRUCTIONS_CHARS = 8_000
const PATH_SECTION_END = /^(?:目标|task\s*(?:goal|instructions?)|验证|验收|required\s*evidence|所需证据|证据绑定|分支|branch|workspace|项目(?:目录|路径)?|task\s*id|(?:soft|hard)\s*limit|开始(?:时间)?|立即执行|立即开始|模型|model|reasoning|executor|执行器|自动(?:提交|推送)|auto\s*(?:commit|push)|禁止(?:修改)?|forbidden\s*paths?|constraints?|acceptance\s*criteria|do\s*not\s*do)/iu
const PATH_ENTRY_PREFIX = /^(?:[-*•]|\d+[.)、])\s+/u

type BriefField = 'taskId' | 'allowedPaths' | 'forbiddenPaths' | 'taskBlock' | 'other'
interface BriefHeading { field: BriefField; label: string; value: string }
interface BriefSection extends BriefHeading { index: number; lines: string[] }

// One heading grammar is shared by scalar values, path lists and block boundaries.
// Only a complete, labelled field can supply an ID; prose is never searched for tokens.
const BRIEF_LABELS: ReadonlyArray<{ label: string; pattern: RegExp; field?: BriefField }> = [
  { label: 'Task ID', pattern: /^(?:task\s*id|任务\s*id|任务编号)$/iu, field: 'taskId' },
  { label: 'Allowed Paths', pattern: /^(?:只允许(?:修改)?(?:路径)?|允许修改(?:路径)?|allowed\s*paths?)$/iu, field: 'allowedPaths' },
  { label: 'Forbidden Paths', pattern: /^(?:禁止(?:修改)?(?:路径)?|forbidden\s*paths?)$/iu, field: 'forbiddenPaths' },
  { label: '目标', pattern: /^(?:目标|任务目标|task\s*(?:goal|instructions?))$/iu },
  { label: 'Workspace', pattern: /^(?:项目(?:目录|路径)?|workspace|project\s*(?:directory|path)?)$/iu },
  { label: 'Branch', pattern: /^(?:branch|分支)$/iu },
  { label: 'Constraints', pattern: /^(?:constraints?|约束)$/iu },
  { label: 'Acceptance Criteria', pattern: /^(?:acceptance\s*criteria|验收(?:标准|条件)?|验证)$/iu },
  { label: 'Required Evidence', pattern: /^(?:required\s*evidence(?:\s*bindings?)?|所需证据|证据绑定)$/iu },
  { label: 'Do Not Do', pattern: /^(?:do\s*not\s*do|不要做|禁止事项)$/iu },
  ...['Soft Limit', 'Hard Limit', 'Start', 'Start Time', '开始时间', 'Auto Commit', 'Auto Push', '自动提交', '自动推送', 'Model', '模型', 'Reasoning', '推理强度', 'Executor', '执行器', 'Notification', '通知'].map((label) => ({ label, pattern: new RegExp(`^${label.replaceAll(' ', '\\s*')}$`, 'iu') })),
]

function briefHeading(rawLine: string): BriefHeading | undefined {
  const raw = rawLine.trim()
  const markdownHeading = /^#{1,6}\s+/u.test(raw)
  const line = raw.replace(/^#{1,6}\s+/u, '')
  const bracket = /^【([^】]+)】\s*[:：]?\s*(.*)$/u.exec(line)
  const label = bracket?.[1]?.trim() ?? line
  if (/^(?:task|任务)\s*\d+(?:\s*[:：].*)?$/iu.test(label)) return { field: 'taskBlock', label, value: '' }
  const assigned = /^([^:：=]+?)\s*[:：=]\s*(.*)$/u.exec(label)
  for (const entry of BRIEF_LABELS) {
    if (bracket !== null && entry.pattern.test(label)) return { field: entry.field ?? 'other', label: entry.label, value: bracket[2]!.trim() }
    if (entry.pattern.test(assigned?.[1]?.trim() ?? label)) return { field: entry.field ?? 'other', label: entry.label, value: assigned?.[2]?.trim() ?? '' }
  }
  // Preserve legacy space-separated fields, e.g. "Soft Limit 10" and "分支 main".
  if (bracket === null) {
    for (let index = 0; index < line.length; index += 1) {
      if (!/\s/u.test(line[index]!)) continue
      const entry = BRIEF_LABELS.find((candidate) => candidate.field !== 'forbiddenPaths' && candidate.pattern.test(line.slice(0, index).trim()))
      if (entry !== undefined) return { field: entry.field ?? 'other', label: entry.label, value: line.slice(index).trim() }
    }
  }
  if (bracket !== null || markdownHeading) return { field: 'other', label, value: bracket?.[2]?.trim() ?? '' }
  return undefined
}

function structuredBrief(lines: readonly string[]): { sections: BriefSection[]; lines: string[] } {
  const sections: BriefSection[] = []
  const normalized = lines.map((line, index) => {
    const heading = briefHeading(line)
    if (heading === undefined) { sections.at(-1)?.lines.push(line); return line }
    sections.push({ ...heading, index, lines: [] })
    return `${heading.label}: ${heading.value}`
  })
  return { sections, lines: normalized }
}

function sectionTaskId(sections: readonly BriefSection[]): string | undefined {
  const section = sections.find((candidate) => candidate.field === 'taskId')
  const value = section?.value || section?.lines.find((line) => line.trim().length > 0)?.trim()
  return value !== undefined && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined
}

export function analyzeTaskBrief(brief: string, now = new Date(), currentExecutorMode?: ExecutorMode): TaskBriefAnalysis {
  const text = brief.trim()
  const sourceLines = text.split(/\r?\n/u)
  const { sections, lines } = structuredBrief(sourceLines)
  const recognized: string[] = []
  const warnings: string[] = []
  const unresolvedFields: NonNullable<TaskBriefAnalysis['unresolvedFields']> = []
  const fields: TaskBriefAnalysis['fields'] = { taskInstructions: '' }
  const mark = (name: string): void => { if (!recognized.includes(name)) recognized.push(name) }

  const taskInstructions = taskInstructionsFromBrief(text, lines)
  if (taskInstructions !== undefined) fields.taskInstructions = taskInstructions
  if (text.length > MAX_TASK_INSTRUCTIONS_CHARS) {
    warnings.push(taskInstructions === undefined
      ? `Task 内容超过 ${MAX_TASK_INSTRUCTIONS_CHARS} 字符；为避免截断，Quick Fill 未复制完整正文。原始 Brief 会保留，请将核心目标精简后手动填入 Task。`
      : `Task 内容超过 ${MAX_TASK_INSTRUCTIONS_CHARS} 字符；Quick Fill 仅填入已识别的核心目标，原始 Brief 会保留。`)
  }

  const normalizedText = lines.join('\n')
  const workspace = firstCapture(normalizedText, [
    /(?:项目(?:目录|路径)?|workspace|project\s*(?:directory|path)?)\s*[:：]\s*([^\r\n]+)/iu,
    /(^|\s)((?:[A-Za-z]:[\\/][^\r\n]+|\/[A-Za-z0-9._~/-]+))(?:\s|$)/u,
  ])
  if (workspace !== undefined && isAbsoluteWorkspacePath(workspace)) {
    fields.targetRepo = workspace
    mark('Workspace')
  }

  const branch = firstCapture(normalizedText, [/(?:branch|分支)\s*[:：]\s*([^\s，。,；;]+)/iu, /(?:分支)\s+([^\s，。,；;]+)/u])
  if (branch !== undefined && isSafeBranch(branch)) { fields.branch = branch; mark('Branch') }

  const taskId = sectionTaskId(sections)
  if (taskId !== undefined) { fields.taskId = taskId; mark('Task ID') }
  else if (sections.some((section) => section.field === 'taskId')) {
    unresolvedFields.push('taskId')
    warnings.push('Task ID 未识别，请确认；仅允许 1–64 个字母、数字、点、下划线和连字符。')
  }

  const explicitBlocks = sections.filter((section) => section.field === 'taskBlock')
  const idBlocks = sections.filter((section) => section.field === 'taskId')
  const blocks = explicitBlocks.length > 0 ? explicitBlocks : idBlocks.length > 1 ? idBlocks : []
  if (blocks.length > 0) {
    fields.tasks = blocks.map((block, index) => {
      const blockLines = sourceLines.slice(block.index + (block.field === 'taskBlock' ? 1 : 0), blocks[index + 1]?.index)
      const parsed = structuredBrief(blockLines)
      const id = sectionTaskId(parsed.sections)
      if (id === undefined && parsed.sections.some((section) => section.field === 'taskId') && !unresolvedFields.includes('taskId')) {
        unresolvedFields.push('taskId')
        warnings.push('部分 Task ID 未识别，请分别确认各 Task 的有效编号。')
      }
      return { ...(id === undefined ? {} : { taskId: id }), taskInstructions: taskInstructionsFromBrief('', parsed.lines) ?? '' }
    })
    // A global ID must never be copied into every task block.
    delete fields.taskId
    mark('Tasks')
  }

  const allowed = extractPathSections(sections, 'allowedPaths')
  const allowedPaths = allowed.valid ? allowed.values : []
  if (allowedPaths.length > 0) { fields.allowedPaths = allowedPaths; mark('Allowed Paths') }
  else if (allowed.found) {
    unresolvedFields.push('allowedPaths')
    warnings.push('允许修改路径：未识别，请确认。请逐行填写有效的仓库相对路径；多个 Task 必须确认共用的修改范围。')
  }

  const forbiddenPaths = extractPathSections(sections, 'forbiddenPaths').values
  if (forbiddenPaths.length > 0) { fields.forbiddenPaths = forbiddenPaths; mark('Forbidden Paths') }

  const constraints = extractTextSection(lines, /^(?:constraints?|约束)\s*[:：]?\s*(.*)$/iu)
  if (constraints.length > 0) { fields.constraints = constraints; mark('Constraints') }
  const acceptanceCriteria = extractTextSection(lines, /^(?:acceptance\s*criteria|验收(?:标准|条件)?|验证)\s*[:：]?\s*(.*)$/iu)
  const inlineAcceptance = acceptanceCriteria.map((criterion) => parseTaskContractBindingDsl(criterion))
  const normalizedAcceptanceCriteria = acceptanceCriteria.map((criterion, index) => inlineAcceptance[index]?.criterionText || criterion)
  if (normalizedAcceptanceCriteria.length > 0) { fields.acceptanceCriteria = normalizedAcceptanceCriteria; mark('Acceptance Criteria') }
  const acceptanceEvidenceBindings = [
    ...extractEvidenceBindings(lines, normalizedAcceptanceCriteria),
    ...inlineAcceptance.flatMap((binding) => binding === undefined || binding.criterionText.length === 0 || binding.verifierCommand.length === 0
      ? []
      : [{ criterion: binding.criterionText, requiredEvidence: [binding.verifierCommand] }]),
  ]
  for (const criterion of normalizedAcceptanceCriteria) {
    if (acceptanceEvidenceBindings.some((binding) => binding.criterion === criterion)) continue
    if (classifyAcceptanceCriterion(criterion) !== 'COMMAND_BEARING') continue
    const extracted = extractAcceptanceVerifier(criterion)
    if (extracted !== undefined) {
      acceptanceEvidenceBindings.push({ criterion, requiredEvidence: [extracted.command],
        ...(extracted.command === criterion ? {} : { commandCanonicalizations: [extracted.canonicalization] }) })
    } else {
      warnings.push(`未能安全识别验证命令，需要确认：${criterion}`)
    }
  }
  if (acceptanceEvidenceBindings.length > 0) { fields.acceptanceEvidenceBindings = acceptanceEvidenceBindings; mark('Required Evidence') }
  const doNotDo = extractTextSection(lines, /^(?:do\s*not\s*do|不要做|禁止事项)\s*[:：]?\s*(.*)$/iu)
  if (doNotDo.length > 0) { fields.doNotDo = doNotDo; mark('Do Not Do') }

  const executor = explicitExecutor(text)
  if (executor !== undefined) { fields.executorMode = executor; mark('Executor') }

  const soft = explicitMinuteLimit(lines, /^(?:soft\s*limit|软(?:时间)?限制)\s*[:：]?\s*(.*)$/iu)
  if (soft.value !== undefined) { fields.softMinutes = soft.value; mark('Soft Limit') }
  if (soft.conflict) warnings.push('Soft Limit 存在冲突的明确值；已采用最先出现的明确值。')
  const hard = explicitMinuteLimit(lines, /^(?:hard\s*limit|硬(?:时间)?限制)\s*[:：]?\s*(.*)$/iu)
  if (hard.value !== undefined) { fields.hardMinutes = hard.value; mark('Hard Limit') }
  if (hard.conflict) warnings.push('Hard Limit 存在冲突的明确值；已采用最先出现的明确值。')

  const start = parseStart(text, lines, now)
  if (start !== undefined) {
    Object.assign(fields, start)
    mark('Start Time')
  } else if (/(?:今晚|明天|tomorrow|tonight|开始时间|scheduled?\s*start)/iu.test(text)) {
    warnings.push('Start Time 未从 Task Brief 中明确识别，请在现有排程控件中确认。')
  }

  const autoCommit = explicitBoolean(lines, 'commit')
  if (autoCommit !== undefined) { fields.autoCommit = autoCommit; mark('Auto Commit') }
  const autoPush = explicitBoolean(lines, 'push')
  if (autoPush !== undefined) { fields.autoPush = autoPush; mark('Auto Push') }
  const emailEnabled = explicitEmailNotification(lines)
  if (emailEnabled !== undefined) { fields.emailEnabled = emailEnabled; mark('Notification') }

  const explicitModel = modelFromText(text)
  const explicitReasoning = reasoningFromText(text)
  const recommendation = recommendCodexModel({
    taskText: text,
    allowedPaths,
    ...(fields.executorMode === undefined && currentExecutorMode === undefined ? {} : { executorMode: fields.executorMode ?? currentExecutorMode }),
    ...(explicitModel === undefined ? {} : { explicitModel }),
    ...(explicitReasoning === undefined ? {} : { explicitReasoning }),
  })
  if (recommendation === 'invalid-explicit-pair') {
    warnings.push('Task Brief 中的 Model / Reasoning 组合不受当前 Codex 支持；请手动选择。')
  } else if (recommendation !== undefined) {
    fields.executorMode ??= currentExecutorMode ?? 'codex'
    if (explicitModel !== undefined) mark('Model')
    if (explicitReasoning !== undefined) mark('Reasoning')
    return { fields, modelRecommendation: recommendation, recognized, warnings, ...(unresolvedFields.length > 0 ? { unresolvedFields } : {}) }
  }

  return { fields, recognized, warnings, ...(unresolvedFields.length > 0 ? { unresolvedFields } : {}) }
}

/**
 * Trusted, deterministic syntax only: one or more lines of
 * `<exact acceptance criterion> => <exact verifier command>` under a
 * Required Evidence / 所需证据 / 证据绑定 heading. Repeated criteria accumulate
 * commands; anything ambiguous remains unmapped and is rejected by V2.
 */
function extractEvidenceBindings(lines: readonly string[], criteria: readonly string[]): AcceptanceEvidenceBinding[] {
  const header = /^(?:required\s*evidence(?:\s*bindings?)?|所需证据|证据绑定)\s*[:：]?\s*(.*)$/iu
  const commands = new Map<string, string[]>()
  let active = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const match = header.exec(line)
    if (match !== null) {
      active = true
      if (match[1]?.trim()) parseEvidenceBindingLine(match[1], criteria, commands)
      continue
    }
    if (!active) continue
    if (PATH_SECTION_END.test(line) && !/^(?:[-*•]|\d+[.)、])\s*/u.test(line)) break
    if (line.length > 0) parseEvidenceBindingLine(line.replace(PATH_ENTRY_PREFIX, '').trim(), criteria, commands)
  }
  return criteria.flatMap((criterion) => {
    const requiredEvidence = commands.get(criterion)
    return requiredEvidence === undefined ? [] : [{ criterion, requiredEvidence }]
  })
}

function parseEvidenceBindingLine(line: string, criteria: readonly string[], commands: Map<string, string[]>): void {
  const parsed = parseTaskContractBindingDsl(line)
  if (parsed === undefined) return
  const { criterionText: criterion, verifierCommand: evidence } = parsed
  if (!criteria.includes(criterion) || evidence.length === 0 || evidence.length > 500) return
  const existing = commands.get(criterion) ?? []
  if (!existing.includes(evidence)) existing.push(evidence)
  commands.set(criterion, existing)
}

function firstCapture(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const value = match?.at(-1)?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/u.test(value) && !/[\u0000-\u001f]/u.test(value) && value.length <= 1_024
}

function isSafeBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value) && !value.includes('..') && !value.endsWith('.lock') && !value.includes('@{')
}

function isSafeGuardianPath(value: string): boolean {
  return value.length > 0 && value.length <= 500 &&
    !/^[A-Za-z]:[\\/]|^\//u.test(value) &&
    !value.split(/[\\/]/u).includes('..') &&
    !/[\s:\u0000-\u001f]/u.test(value) &&
    /^[\w.@+*?{}[\],!()$=\\/-]+$/u.test(value)
}

function extractPathSections(sections: readonly BriefSection[], field: 'allowedPaths' | 'forbiddenPaths'): { values: string[]; found: boolean; valid: boolean } {
  const matching = sections.filter((section) => section.field === field)
  const groups: string[][] = []
  let valid = true
  for (const section of matching) {
    const values: string[] = []
    let blank = false
    for (const raw of [section.value, ...section.lines]) {
      const line = raw.trim()
      if (line.length === 0) { blank = true; continue }
      const path = line.replace(PATH_ENTRY_PREFIX, '').trim()
      if (!isSafeGuardianPath(path)) {
        // An unlabelled prose paragraph after a complete list ends that list.
        if (!(blank && values.length > 0 && /\s|\p{Script=Han}/u.test(path))) valid = false
        break
      }
      blank = false
      if (!values.includes(path)) values.push(path)
    }
    if (values.length === 0) valid = false
    groups.push(values)
  }
  // Composer has one shared Guardian. Do not union differing task permissions.
  if (field === 'allowedPaths' && groups.some((group) => JSON.stringify([...group].sort()) !== JSON.stringify([...(groups[0] ?? [])].sort()))) valid = false
  return { values: [...new Set(groups.flat())], found: matching.length > 0, valid }
}

function extractTextSection(lines: readonly string[], header: RegExp): string[] {
  const values: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!.trim())
    if (match === null) continue
    const add = (value: string): void => {
      const item = value.replace(PATH_ENTRY_PREFIX, '').trim()
      if (item.length > 0 && !values.includes(item)) values.push(item)
    }
    add(match[1] ?? '')
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!.trim()
      if (line.length === 0) { if (values.length > 0) break; continue }
      if (PATH_SECTION_END.test(line)) break
      add(line)
    }
    break
  }
  return values
}

function explicitExecutor(text: string): ExecutorMode | undefined {
  const match = /(?:executor|执行器)\s*(?:使用|use|[:：])\s*(codex|deepseek|auto)/iu.exec(text)
  if (match === null) return undefined
  return match[1]!.toLowerCase() as ExecutorMode
}

function explicitMinuteLimit(lines: readonly string[], header: RegExp): { value?: number; conflict: boolean } {
  const values: number[] = []
  const parseValue = (value: string): number | undefined => {
    const match = /^(\d{1,4})(?:\s*(?:m|min|mins|minute|minutes|分钟))?$/iu.exec(value.trim())
    const minutes = match === null ? undefined : Number(match[1])
    return minutes !== undefined && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1_440 ? minutes : undefined
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!.trim())
    if (match === null) continue
    let value = parseValue(match[1] ?? '')
    if (value === undefined && (match[1] ?? '').trim().length === 0) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next]!.trim()
        if (candidate.length === 0) continue
        value = parseValue(candidate)
        break
      }
    }
    if (value !== undefined) values.push(value)
  }
  if (values.length === 0) return { conflict: false }
  return { value: values[0]!, conflict: new Set(values).size > 1 }
}

function parseStart(text: string, lines: readonly string[], now: Date): Pick<TaskBriefAnalysis['fields'], 'startMode' | 'customStartAt'> | undefined {
  const explicit = explicitFieldValue(lines, /^(?:start(?:\s*time)?|开始(?:时间)?)\s*[:：]\s*(.*)$/iu)
  const candidate = explicit ?? text
  if (/(?:立即执行|立即开始|immediately|start\s*[:：]?\s*immediately)/iu.test(candidate)) return { startMode: 'immediate' }
  const time = /(?:今晚|tonight|明天|tomorrow)(?:\s*(上午|下午|晚上|morning|afternoon|evening))?(?:\s*(\d{1,2})(?::(\d{2}))?)?/iu.exec(candidate)
  if (time === null) return undefined
  if (time[1] === undefined && time[2] === undefined) return undefined
  const date = new Date(now)
  const tomorrow = /^(?:明天|tomorrow)/iu.test(time[0])
  if (tomorrow) date.setDate(date.getDate() + 1)
  let hour = time[2] === undefined ? 20 : Number(time[2])
  const period = time[1]?.toLowerCase()
  if ((period === '下午' || period === '晚上' || period === 'afternoon' || period === 'evening') && hour < 12) hour += 12
  if ((period === '上午' || period === 'morning') && time[2] === undefined) hour = 9
  const minute = Number(time[3] ?? 0)
  if (hour > 23 || minute > 59) return undefined
  date.setHours(hour, minute, 0, 0)
  return { startMode: 'custom', customStartAt: localDateTimeValue(date) }
}

function localDateTimeValue(date: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function explicitBoolean(lines: readonly string[], kind: 'commit' | 'push'): boolean | undefined {
  const label = kind === 'commit' ? '(?:auto\\s*commit|自动提交)' : '(?:auto\\s*push|自动推送)'
  const action = kind === 'commit' ? '(?:commit|提交)' : '(?:push|推送)'
  const falseValues = new Set(['off', 'false', 'no', 'disabled', '关闭', '禁止', '不允许'])
  const trueValues = new Set(['on', 'true', 'yes', 'enabled', '开启', '允许'])
  const values: boolean[] = []
  const addValue = (value: string): void => {
    const normalized = value.trim().toLowerCase()
    if (falseValues.has(normalized)) values.push(false)
    if (trueValues.has(normalized)) values.push(true)
  }
  const assignment = new RegExp(`^${label}\\s*[:：=]\\s*(.*)$`, 'iu')
  const labelOnly = new RegExp(`^${label}\\s*$`, 'iu')
  const negative = new RegExp(`^(?:不要|禁止|不允许|无需|关闭|off|no|do\\s+not|don't)\\s*(?:auto\\s*)?${action}.*$`, 'iu')
  const positive = kind === 'commit'
    ? new RegExp(`^(?:明确允许|允许|可以|启用|开启)\\s*(?:auto\\s*)?${action}.*$|^完成后\\s*(?:auto\\s*)?${action}.*$`, 'iu')
    : new RegExp(`^(?:明确允许|允许|可以|启用|开启)\\s*(?:auto\\s*)?${action}.*$|^推送到(?:远端|origin).*?$|^提交并推送.*$`, 'iu')
  const addExplicitValue = (value: string): void => {
    addValue(value)
    if (negative.test(value)) values.push(false)
    else if (positive.test(value)) values.push(true)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    const assigned = assignment.exec(line)
    if (assigned !== null) {
      const value = assigned[1]!.trim()
      if (value.length > 0) addExplicitValue(value)
      else {
        const next = nextNonEmptyLine(lines, index + 1)
        if (next !== undefined) addExplicitValue(next)
      }
      continue
    }
    if (labelOnly.test(line)) {
      const next = nextNonEmptyLine(lines, index + 1)
      if (next !== undefined) addExplicitValue(next)
      continue
    }
    if (negative.test(line)) values.push(false)
    else if (positive.test(line)) values.push(true)
  }
  // An explicit denial or disagreement must never grant a repository mutation.
  if (values.includes(false)) return false
  return values.includes(true) ? true : undefined
}

function nextNonEmptyLine(lines: readonly string[], start: number): string | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const candidate = lines[index]!.trim()
    if (candidate.length > 0) return candidate
  }
  return undefined
}

function explicitFieldValue(lines: readonly string[], header: RegExp): string | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!.trim())
    if (match === null) continue
    const inline = match[1]!.trim()
    return inline.length > 0 ? inline : nextNonEmptyLine(lines, index + 1)
  }
  return undefined
}

function explicitEmailNotification(lines: readonly string[]): boolean | undefined {
  const text = lines.join('\n')
  const terms = ['email(?:\\s*notification)?', '邮件通知', '通知我']
  for (const term of terms) {
    if (new RegExp(`(?:不要|不|禁止|关闭|off|no)\\s*(?:auto\\s*)?${term}`, 'iu').test(text)) return false
  }
  for (const term of terms) {
    if (new RegExp(`(?:允许|可以|启用|开启|on|完成后)?\\s*(?:auto\\s*)?${term}`, 'iu').test(text)) return true
  }
  return undefined
}

function taskInstructionsFromBrief(_text: string, lines: readonly string[]): string | undefined {
  const core: string[] = []
  let skipNextValue = false
  let skipBlock = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) {
      if (!skipBlock && core.at(-1) !== '') core.push('')
      continue
    }
    const kind = taskBriefLineKind(line)
    if (skipNextValue) {
      if (kind !== undefined) skipNextValue = false
      else { skipNextValue = false; continue }
    }
    if (skipBlock) {
      if (kind === undefined) continue
      skipBlock = false
    }
    if (kind === 'goal') {
      const goal = /^(?:目标|任务目标|task\s*(?:goal|instructions?))\s*[:：]\s*(.*)$/iu.exec(line)?.[1]?.trim()
      if (goal) core.push(goal)
      continue
    }
    if (kind === 'scalar') {
      skipNextValue = /[:：]\s*$/u.test(line)
      continue
    }
    if (kind === 'block') {
      skipBlock = true
      continue
    }
    core.push(line)
  }
  const value = core.join('\n').replaceAll(/\n{3,}/gu, '\n\n').trim()
  if (value.length === 0) return undefined
  return value.length <= MAX_TASK_INSTRUCTIONS_CHARS ? value : value.slice(0, MAX_TASK_INSTRUCTIONS_CHARS).trim()
}

/** Identifies source-contract fields which belong in Composer controls, not Task. */
function taskBriefLineKind(line: string): 'goal' | 'scalar' | 'block' | undefined {
  if (/^(?:目标|任务目标|task\s*(?:goal|instructions?))\s*[:：]/iu.test(line)) return 'goal'
  if (/^(?:只允许(?:修改)?|允许修改|allowed\s*paths?|禁止(?:修改)?|forbidden\s*paths?|constraints?|约束|acceptance\s*criteria|验收(?:标准|条件)?|验证|required\s*evidence(?:\s*bindings?)?|所需证据|证据绑定|do\s*not\s*do|不要做|禁止事项)\s*(?::|：|$)/iu.test(line)) return 'block'
  if (/^(?:项目(?:目录|路径)?|workspace|project\s*(?:directory|path)?)\s*(?::|：|=|(?:[A-Za-z]:[\\/]|\/)|$)/iu.test(line)) return 'scalar'
  if (/^(?:branch|分支|task\s*id|任务\s*id|任务编号|(?:soft|hard)\s*limit|软(?:时间)?限制|硬(?:时间)?限制|start(?:\s*time)?|开始(?:时间)?|auto\s*(?:commit|push)|自动(?:提交|推送)|model|模型|reasoning|推理(?:强度)?|思考强度|executor|执行器|notification|通知)\s*(?::|：|=|使用\b|use\b|\d|$)/iu.test(line)) return 'scalar'
  if (/^(?:立即执行|立即开始)\p{P}?$/u.test(line)) return 'scalar'
  return undefined
}

function modelFromText(text: string): string | undefined {
  const match = /(?:model|模型)\s*(?:[:：=]|使用)?\s*(?:gpt[-\s]?)?(6\s*astra|5[.]?6\s*(?:sol|terra|luna)|5[.]?5|5[.]?4\s*mini)/iu.exec(text)
  if (match === null) return undefined
  const normalized = match[1]!.toLowerCase().replaceAll(/\s+/gu, '')
  const aliases: Record<string, string> = {
    '6astra': 'gpt-6-astra', '5.6sol': 'gpt-5.6-sol', '5.6terra': 'gpt-5.6-terra',
    '5.6luna': 'gpt-5.6-luna', '5.5': 'gpt-5.5', '5.4mini': 'gpt-5.4-mini',
  }
  return aliases[normalized]
}

function reasoningFromText(text: string): CodexReasoningEffort | undefined {
  const match = /(?:reasoning|推理(?:强度)?|思考强度)\s*(?:[:：=]|使用)?\s*(low|medium|high|xhigh|max|ultra)/iu.exec(text)
  return match?.[1]?.toLowerCase() as CodexReasoningEffort | undefined
}

function recommendCodexModel(input: {
  taskText: string
  allowedPaths: readonly string[]
  executorMode?: ExecutorMode | undefined
  explicitModel?: string
  explicitReasoning?: CodexReasoningEffort
}): TaskBriefAnalysis['modelRecommendation'] | 'invalid-explicit-pair' | undefined {
  if (input.executorMode === 'deepseek') return undefined
  const lower = input.taskText.toLowerCase()
  // Sol is for an affirmative architecture decision, not merely an audit that
  // mentions architecture or explicitly rules a redesign out.
  const architectureWorkDeclined = /(?:不(?:进行|做|需要|要求|涉及)?|无需|不要|避免|禁止).{0,16}(?:大规模\s*)?(?:架构(?:重构|重新设计)|(?:重新设计|重构).{0,12}架构|核心状态模型|职责边界重构|系统边界调整)/iu.test(lower)
  const architectureRedesignRequested = /(?:重新设计|重构).{0,24}(?:架构|系统|状态模型|职责边界)|(?:架构|系统|核心状态模型|职责边界).{0,24}(?:重新设计|重构)|(?:比较|评估|权衡|取舍|trade-?off).{0,24}(?:多个|多种)?(?:架构|设计)?方案|(?:设计|建立).{0,16}(?:新的|全新|核心).{0,20}(?:架构|状态模型|职责边界)|大规模.*(?:状态模型|迁移)|高风险.*迁移/iu.test(lower)
  const architectureRedesign = architectureRedesignRequested && !architectureWorkDeclined
  const deepConcurrency = /(?:并发|竞态|race\s*condition|deadlock|多线程|多进程)/iu.test(lower) && /(?:深层|根因|诊断|设计|难以复现|复杂)/iu.test(lower)
  const ambiguous = /(?:任务定义|需求|问题定义).{0,12}(?:模糊|不明确)|(?:探索|评估).{0,12}(?:方案|取舍)|terra.{0,24}(?:失败|无效|不足)/iu.test(lower)
  const complexSignals = [
    ...(architectureRedesign ? ['architecture-redesign'] : []),
    ...(deepConcurrency ? ['deep-concurrency'] : []),
    ...(ambiguous ? ['ambiguity-or-escalation'] : []),
  ]
  const standardSignalMatchers: Array<[string, boolean]> = [
    ['cross-file', input.allowedPaths.length > 1 || /跨文件|多个文件|multi[- ]file/iu.test(lower)],
    ['tests', /测试|tests?|验证|verify/iu.test(lower)],
    ['integration', /api|sdk|persistence|数据库|ui|接口/iu.test(lower)],
    ['debugging', /修复|bug|debug|排查/iu.test(lower)],
  ]
  const standardSignals = standardSignalMatchers.filter(([, present]) => present).map(([signal]) => signal)
  const investigation = /(?:审计|调查|风险报告|audit|investigat|不进行大规模修复|不做架构重构)/iu.test(lower)
  const light = /readme|文案|typo|拼写|css|样式|rename|重命名|格式化|format/iu.test(lower) && complexSignals.length === 0 && standardSignals.length <= 1
  const complexity: 'light' | 'standard' | 'complex' = complexSignals.length > 0
    ? 'complex' : light ? 'light' : 'standard'
  const automatic = complexity === 'light'
    ? { model: 'gpt-5.6-luna', reasoningEffort: 'medium' as CodexReasoningEffort, reason: '任务范围小且机械性高，低成本模型已足够。', signals: ['mechanical'] }
    : complexity === 'complex'
      ? { model: 'gpt-5.6-sol', reasoningEffort: 'high' as CodexReasoningEffort, reason: `涉及 ${complexSignals.slice(0, 2).join('、')}，需要更高基础推理能力。`, signals: complexSignals }
      : { model: CODING_EXECUTOR_DEFAULTS.codex.model, reasoningEffort: CODING_EXECUTOR_DEFAULTS.codex.reasoningEffort, reason: investigation
        ? '任务涉及多个运行链路和状态恢复，需要较完整的跨文件分析，但目标明确且以审计为主，Terra High 在可靠性与成本间更均衡。'
        : `任务包含 ${(standardSignals.length === 0 ? ['工程修改'] : standardSignals).slice(0, 3).join('、')}，Terra High 在可靠性和成本间更均衡。`, signals: standardSignals }
  const model = input.explicitModel ?? automatic.model
  const reasoningEffort = input.explicitReasoning ?? automatic.reasoningEffort
  if (!isSupportedCodexConfiguration(model, reasoningEffort)) return 'invalid-explicit-pair'
  return {
    model, reasoningEffort, complexity, reason: input.explicitModel !== undefined || input.explicitReasoning !== undefined
      ? '已保留 Task Brief 中明确指定的 Model / Reasoning。' : automatic.reason,
    signals: automatic.signals,
    modelExplicit: input.explicitModel !== undefined,
    reasoningExplicit: input.explicitReasoning !== undefined,
  }
}
