/* global console, process */
import { resolve } from 'node:path'

import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
  runGuardianTask,
} from 'nova-wing/development-guardian'

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function optionalInt(name, fallback) {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function optionalList(name) {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return undefined
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}

function resolveGitBashPath(value) {
  if (process.platform === 'win32') {
    const match = value.match(/^\/([a-zA-Z])\/(.*)$/u)
    if (match !== null) {
      return resolve(`${match[1]}:/${match[2]}`)
    }
  }
  return resolve(value)
}

const targetRepo = resolveGitBashPath(requiredEnv('NOVAWING_TARGET_REPO'))
const goalFromArgs = process.argv.slice(2).join(' ').trim()
const goal = goalFromArgs || requiredEnv('NOVAWING_TASK_GOAL')
const timeoutMs = optionalInt('NOVAWING_GUARDIAN_TIMEOUT_MS', 20 * 60 * 1000)
const maxIterations = optionalInt('NOVAWING_GUARDIAN_MAX_ITERATIONS', 3)
const maxClaudeTurns = optionalInt('NOVAWING_CLAUDE_MAX_TURNS', 12)
const constraints = optionalList('NOVAWING_TASK_CONSTRAINTS')
const acceptanceCriteria = optionalList('NOVAWING_ACCEPTANCE_CRITERIA')
const doNotDo = optionalList('NOVAWING_DO_NOT_DO')
const allowedPaths = optionalList('NOVAWING_ALLOWED_PATHS')
const forbiddenPaths = optionalList('NOVAWING_FORBIDDEN_PATHS')
const conversationUrl = process.env.NOVAWING_CHATGPT_CONVERSATION_URL?.trim() || undefined
const claudeModel = process.env.NOVAWING_CLAUDE_MODEL?.trim() || undefined
const chatgptModel = process.env.NOVAWING_CHATGPT_MODEL?.trim() || undefined
const chatgptReasoning = process.env.NOVAWING_CHATGPT_REASONING?.trim() || 'high'

const brain = new AskBridgeBrain({
  ...(conversationUrl === undefined ? {} : { conversationUrl }),
  ...(chatgptModel === undefined ? {} : { model: chatgptModel }),
  reasoning: chatgptReasoning,
  timeoutMs,
})
const executor = new ClaudeCodeExecutor({
  cwd: targetRepo,
  maxTurns: maxClaudeTurns,
  timeoutMs,
  ...(claudeModel === undefined ? {} : { model: claudeModel }),
})

try {
  const result = await runGuardianTask({
    task: {
      id: `guardian-poc-${Date.now()}`,
      goal,
      state: 'READY',
      iteration: 0,
      maxIterations,
      ...(constraints === undefined ? {} : { constraints }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      ...(doNotDo === undefined ? {} : { doNotDo }),
      ...(allowedPaths === undefined ? {} : { allowedPaths }),
      ...(forbiddenPaths === undefined ? {} : { forbiddenPaths }),
    },
    brain,
    executor,
  })

  console.log(
    JSON.stringify(
      {
        targetRepo,
        finalState: result.task.state,
        stopReason: result.task.stopReason ?? null,
        iterations: result.task.iteration,
        reports: result.reports,
      },
      null,
      2,
    ),
  )

  if (result.task.state === 'COMPLETED') {
    process.exitCode = 0
  } else if (result.task.state === 'HUMAN_REQUIRED') {
    process.exitCode = 2
  } else {
    process.exitCode = 1
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        finalState: 'FAILED_TO_START',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}
