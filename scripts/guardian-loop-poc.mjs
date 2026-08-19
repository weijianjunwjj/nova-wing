/* global console, process */
import { resolve } from 'node:path'

import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
  runGuardianTask,
} from 'nova-wing/development-guardian'

class GuardianProgressDisplay {
  constructor(targetRepo, goal) {
    this.targetRepo = targetRepo
    this.goal = goal
    this.startedAt = performance.now()
    this.currentPhase = null
    this.heartbeatTimer = null
    this.lastHeartbeat = null
    this.iteration = 0
  }

  start() {
    console.log('\nNovaWing Development Guardian')
    console.log(`Task: ${this.goal}`)
    console.log(`Target: ${this.targetRepo}`)
    console.log('────────────────────────────────\n')
  }

  formatElapsed(ms) {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) {
      return `${seconds}s`
    }
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  formatTimestamp() {
    const now = new Date()
    return now.toTimeString().slice(0, 8)
  }

  clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  startHeartbeat(phase) {
    this.clearHeartbeat()
    this.lastHeartbeat = performance.now()

    this.heartbeatTimer = setInterval(() => {
      const elapsed = performance.now() - this.lastHeartbeat
      console.log(`[${this.formatTimestamp()}] ${phase} elapsed=${this.formatElapsed(elapsed)}`)
    }, 30_000)
  }

  onProgress(event) {
    const { phase, status, iteration, elapsedMs, detail, verification, recovery } = event

    if (iteration > this.iteration) {
      this.iteration = iteration
      if (iteration > 1) {
        console.log(`\niteration: ${iteration} / 3`)
        console.log('↳ reviewer requested revision\n')
      }
    }

    if (recovery !== undefined) {
      console.log(`[${this.formatTimestamp()}] RECOVERING — Claude Code (max_turns, bounded)`)
      console.log(`   session: ${recovery.sessionId}`)
      return
    }

    if (verification !== undefined) {
      if (verification.status === 'running') {
        console.log(`[${this.formatTimestamp()}] ● ${verification.command}`)
      } else if (verification.status === 'passed') {
        const elapsed = verification.durationMs !== undefined ? this.formatElapsed(verification.durationMs) : ''
        console.log(`[${this.formatTimestamp()}] ✓ ${verification.command} ${elapsed}`)
      } else if (verification.status === 'failed') {
        const elapsed = verification.durationMs !== undefined ? this.formatElapsed(verification.durationMs) : ''
        console.log(`[${this.formatTimestamp()}] ✗ ${verification.command} ${elapsed}`)
      }
      return
    }

    if (status === 'active') {
      const phaseLabel = this.getPhaseLabel(phase)
      console.log(`[${this.formatTimestamp()}] ${phaseLabel} started`)

      if (phase === 'REVIEWING' || phase === 'FINAL_REVIEW' || phase === 'EXECUTING') {
        this.startHeartbeat(phaseLabel)
      }
      this.currentPhase = phase

    } else if (status === 'completed') {
      this.clearHeartbeat()

      if (phase === 'PREPARING') {
        console.log(`[${this.formatTimestamp()}] ✓ PREPARING`)
        return
      }

      const phaseLabel = this.getPhaseLabel(phase)
      const elapsed = this.lastHeartbeat !== null
        ? this.formatElapsed(performance.now() - this.lastHeartbeat)
        : this.formatElapsed(elapsedMs)

      console.log(`[${this.formatTimestamp()}] ✓ ${phaseLabel} ${elapsed}`)

      if (phase === 'COMPLETED' || phase === 'HUMAN_REQUIRED' || phase === 'FAILED') {
        console.log(`\nFinal State: ${phase}`)
        if (detail) {
          console.log(`Reason: ${detail}`)
        }
        console.log(`Total: ${this.formatElapsed(performance.now() - this.startedAt)}`)
      }

    } else if (status === 'failed') {
      this.clearHeartbeat()
      const phaseLabel = this.getPhaseLabel(phase)
      console.log(`[${this.formatTimestamp()}] ✗ ${phaseLabel}`)
      if (detail) {
        console.log(`   Error: ${detail}`)
      }
    }
  }

  getPhaseLabel(phase) {
    const labels = {
      PREPARING: 'PREPARING',
      REVIEWING: 'REVIEWING — ChatGPT Web',
      EXECUTING: 'EXECUTING — Claude Code',
      RECOVERING: 'RECOVERING — Claude Code',
      VERIFYING: 'VERIFYING',
      FINAL_REVIEW: 'FINAL REVIEW — ChatGPT Web',
      COMPLETED: 'COMPLETED',
      HUMAN_REQUIRED: 'HUMAN_REQUIRED',
      FAILED: 'FAILED',
    }
    return labels[phase] ?? phase
  }

  cleanup() {
    this.clearHeartbeat()
  }
}

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
const chatgptTimeoutMs = optionalInt('NOVAWING_CHATGPT_TIMEOUT_MS', 180_000)
const claudeTimeoutMs = optionalInt('NOVAWING_CLAUDE_TIMEOUT_MS', 20 * 60 * 1000)
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
const chatgptReasoning = process.env.NOVAWING_CHATGPT_REASONING?.trim() || 'medium'
const allowNpmInstall = process.env.NOVAWING_ALLOW_NPM_INSTALL?.trim() === '1' ||
                         process.env.NOVAWING_ALLOW_NPM_INSTALL?.trim() === 'true'

const brain = new AskBridgeBrain({
  ...(conversationUrl === undefined ? {} : { conversationUrl }),
  ...(chatgptModel === undefined ? {} : { model: chatgptModel }),
  reasoning: chatgptReasoning,
  timeoutMs: chatgptTimeoutMs,
})

const display = new GuardianProgressDisplay(targetRepo, goal)

const executor = new ClaudeCodeExecutor({
  cwd: targetRepo,
  maxTurns: maxClaudeTurns,
  timeoutMs: claudeTimeoutMs,
  ...(claudeModel === undefined ? {} : { model: claudeModel }),
  ...(allowNpmInstall ? { allowNpmInstall: true } : {}),
  onVerification: (result) => {
    display.onProgress({
      phase: 'VERIFYING',
      status: 'active',
      iteration: 0,
      elapsedMs: 0,
      verification: result,
    })
  },
  onRecovery: (recovery) => {
    display.onProgress({
      phase: 'RECOVERING',
      status: 'active',
      iteration: 0,
      elapsedMs: 0,
      recovery,
    })
  },
})

display.start()

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
    onProgress: (event) => display.onProgress(event),
  })

  display.cleanup()

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
  display.cleanup()
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
