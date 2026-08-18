import { ChatGptWebAdapter } from './chatgpt-web-adapter.js'
import { ClaudeCodeAdapter, verifyCommands } from './execution.js'
import type {
  DelegationPacket,
  ExecutionReport,
  GuardianResult,
  TaskSpec,
  VerificationReport,
} from './types.js'

const DEFAULT_MAX_ITERATIONS = 6

function stripCodeFence(input: string): string {
  const trimmed = input.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() ?? trimmed
}

function parseDelegationPacket(input: string): DelegationPacket {
  const parsed = JSON.parse(stripCodeFence(input)) as Partial<DelegationPacket>
  if (
    !parsed ||
    !['proceed', 'revise', 'blocked', 'done'].includes(String(parsed.verdict)) ||
    typeof parsed.goal !== 'string' ||
    !Array.isArray(parsed.instructions) ||
    !Array.isArray(parsed.issues) ||
    !Array.isArray(parsed.verification) ||
    !Array.isArray(parsed.doNotDo)
  ) {
    throw new Error('Invalid delegation packet from ChatGPT')
  }
  return parsed as DelegationPacket
}

function buildPlannerPrompt(task: TaskSpec): string {
  return [
    '你是 NovaWing Development Guardian 的大脑与 Reviewer。',
    '你负责判断下一步，不直接执行代码。',
    '必须只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON schema:',
    '{"verdict":"proceed|revise|blocked|done","goal":"string","instructions":["string"],"issues":["string"],"verification":["string"],"doNotDo":["string"],"reason":"string optional"}',
    '',
    `TASK_ID: ${task.id}`,
    `GOAL: ${task.goal}`,
    `ACCEPTANCE: ${JSON.stringify(task.acceptance)}`,
    `ALLOWED_SCOPE: ${JSON.stringify(task.allowedScope ?? [])}`,
    `FORBIDDEN_SCOPE: ${JSON.stringify(task.forbiddenScope ?? [])}`,
    `DEFAULT_VERIFICATION: ${JSON.stringify(task.verificationCommands ?? [])}`,
    '',
    '如果信息足够，verdict=proceed，并给 Claude Code 一次可执行的最小任务。',
    '如果缺少必须由用户决定的信息或存在高风险歧义，verdict=blocked。',
  ].join('\n')
}

function buildExecutionPrompt(task: TaskSpec, packet: DelegationPacket): string {
  return [
    `NovaWing Guardian Task: ${task.id}`,
    `Goal: ${packet.goal}`,
    '',
    'Instructions:',
    ...packet.instructions.map((item, index) => `${index + 1}. ${item}`),
    '',
    'Do not do:',
    ...packet.doNotDo.map((item, index) => `${index + 1}. ${item}`),
    '',
    `Task acceptance: ${JSON.stringify(task.acceptance)}`,
    `Allowed scope: ${JSON.stringify(task.allowedScope ?? [])}`,
    `Forbidden scope: ${JSON.stringify(task.forbiddenScope ?? [])}`,
    '',
    '完成后请输出简洁执行报告，包含修改、验证、剩余风险。不要自行宣布产品最终验收完成。',
  ].join('\n')
}

function buildReviewPrompt(
  task: TaskSpec,
  previous: DelegationPacket,
  execution: ExecutionReport,
  verification: VerificationReport,
): string {
  return [
    '继续作为 NovaWing Development Guardian 的大脑与 Reviewer。',
    '根据 Claude Code 执行结果和确定性验证，判断下一步。',
    '必须只输出一个 JSON 对象，不要 Markdown，不要解释。',
    'JSON schema:',
    '{"verdict":"proceed|revise|blocked|done","goal":"string","instructions":["string"],"issues":["string"],"verification":["string"],"doNotDo":["string"],"reason":"string optional"}',
    '',
    `TASK: ${JSON.stringify(task)}`,
    `PREVIOUS_DELEGATION: ${JSON.stringify(previous)}`,
    `CLAUDE_EXIT_CODE: ${String(execution.exitCode)}`,
    `CLAUDE_STDOUT: ${execution.stdout.slice(-20_000)}`,
    `CLAUDE_STDERR: ${execution.stderr.slice(-10_000)}`,
    `VERIFICATION: ${JSON.stringify(verification)}`,
    '',
    '规则：',
    '- deterministic verification 失败时不得 done。',
    '- 需要继续修复时 verdict=revise。',
    '- 已满足任务目标和验收条件时 verdict=done。',
    '- 需要架构/产品/权限决策时 verdict=blocked。',
  ].join('\n')
}

export interface DevelopmentGuardianOptions {
  brain?: ChatGptWebAdapter
  executor?: ClaudeCodeAdapter
}

export class DevelopmentGuardian {
  readonly #brain: ChatGptWebAdapter
  readonly #executor: ClaudeCodeAdapter

  constructor(options: DevelopmentGuardianOptions = {}) {
    this.#brain = options.brain ?? new ChatGptWebAdapter()
    this.#executor = options.executor ?? new ClaudeCodeAdapter()
  }

  async run(task: TaskSpec): Promise<GuardianResult> {
    const maxIterations = task.maxIterations ?? DEFAULT_MAX_ITERATIONS
    let iterations = 0
    let packet: DelegationPacket

    try {
      packet = parseDelegationPacket((await this.#brain.chat(buildPlannerPrompt(task))).markdown)
    } catch (error) {
      return {
        state: 'NEED_HUMAN',
        iterations,
        reason: `Planner output could not be trusted: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    while (iterations < maxIterations) {
      if (packet.verdict === 'blocked') {
        return {
          state: 'NEED_HUMAN',
          iterations,
          lastReview: packet,
          ...(packet.reason ? { reason: packet.reason } : {}),
        }
      }
      if (packet.verdict === 'done') {
        return { state: 'COMPLETED', iterations, lastReview: packet }
      }

      iterations += 1
      const execution = await this.#executor.execute(buildExecutionPrompt(task, packet), task.workspace)
      const commands = packet.verification.length > 0 ? packet.verification : task.verificationCommands ?? []
      const verification = await verifyCommands(commands, task.workspace)

      try {
        packet = parseDelegationPacket(
          (await this.#brain.chat(buildReviewPrompt(task, packet, execution, verification))).markdown,
        )
      } catch (error) {
        return {
          state: 'NEED_HUMAN',
          iterations,
          reason: `Reviewer output could not be trusted: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    return {
      state: 'NEED_HUMAN',
      iterations,
      lastReview: packet,
      reason: `Reached max iterations (${String(maxIterations)})`,
    }
  }

  async close(): Promise<void> {
    await this.#brain.close()
  }
}
