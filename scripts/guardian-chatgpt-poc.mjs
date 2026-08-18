/* global console, process */
import {
  TenXChatBrain,
  createTenXChatProcessTransport,
} from 'nova-wing/development-guardian'

const timeoutMs = Number(process.env.NOVAWING_GUARDIAN_TIMEOUT_MS ?? 300_000)
const conversationUrl = process.env.NOVAWING_CHATGPT_CONVERSATION_URL
const transport = createTenXChatProcessTransport({ timeoutMs })
const brain = new TenXChatBrain({
  transport,
  ...(conversationUrl === undefined ? {} : { conversationUrl }),
  timeoutMs,
})

try {
  const packet = await brain.review({
    task: {
      id: 'guardian-chatgpt-poc',
      goal: '验证 ChatGPT Web 能作为 NovaWing Development Guardian 的 Brain，并返回合法 Delegation Packet。不要执行真实代码修改。',
      state: 'READY',
      iteration: 0,
      maxIterations: 1,
    },
  })

  console.log(JSON.stringify({ status: 'ok', packet }, null, 2))
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
} finally {
  await brain.close().catch(() => {})
}
