/* global console, process */
import { AskBridgeBrain } from 'nova-wing/development-guardian'

const timeoutMs = Number(process.env.NOVAWING_GUARDIAN_TIMEOUT_MS ?? 300_000)
const conversationUrl = process.env.NOVAWING_CHATGPT_CONVERSATION_URL?.trim() || undefined
const model = process.env.NOVAWING_CHATGPT_MODEL?.trim() || undefined
const reasoning = process.env.NOVAWING_CHATGPT_REASONING?.trim() || 'high'

const brain = new AskBridgeBrain({
  ...(conversationUrl === undefined ? {} : { conversationUrl }),
  ...(model === undefined ? {} : { model }),
  reasoning,
  timeoutMs,
})

const baseTask = {
  id: 'guardian-chatgpt-poc',
  goal: '验证 ChatGPT Web 能作为 NovaWing Development Guardian 的 Brain，并在同一个 task 的多轮 review 中持续使用同一个 ChatGPT 会话。不要执行真实代码修改。',
  state: 'READY',
  iteration: 0,
  maxIterations: 2,
}

try {
  const firstPacket = await brain.review({ task: baseTask })
  const secondPacket = await brain.review({
    task: {
      ...baseTask,
      state: 'REVIEWING',
      iteration: 1,
    },
  })

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        sameTaskReviews: 2,
        packets: [firstPacket, secondPacket],
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}
