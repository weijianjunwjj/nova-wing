/**
 * W005-A DOM-Safety Closure
 *
 * 锁死动态 UI 数据的 DOM 注入边界：
 * - 所有动态字段必须经 textContent（或等价安全 API）渲染；
 * - 禁止 innerHTML / outerHTML / insertAdjacentHTML / document.write；
 * - bootstrap control token 不复制进 UI、不写 console；
 * - 恶意文本（img onerror / script / svg onload）作为纯文本展示，不生成可执行节点。
 *
 * 测试环境不跑真实浏览器，故用：
 * 1. 静态源码断言（APP_JS 不含危险 API）；
 * 2. vm + mock DOM 结构化 renderer 测试（恶意文本经 textContent 落地）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { APP_JS } from '../packages/development-guardian/work-session/control-ui/view.js'

const MALICIOUS_REASON = '<img src=x onerror="globalThis.__PWNED__=true">choose database'
const MALICIOUS_GOAL = '</div><script>globalThis.__PWNED__=true</script>'
const MALICIOUS_MESSAGE = '<svg onload="globalThis.__PWNED__=true"></svg>'
const CONTROL_TOKEN = 'SECRET_CTRL_TOKEN'

await test('W005-A DOM safety: APP_JS uses only safe DOM APIs', () => {
  assert.ok(!APP_JS.includes('innerHTML'), 'APP_JS must not use innerHTML')
  assert.ok(!APP_JS.includes('insertAdjacentHTML'), 'APP_JS must not use insertAdjacentHTML')
  assert.ok(!APP_JS.includes('outerHTML'), 'APP_JS must not use outerHTML')
  assert.ok(!APP_JS.includes('document.write'), 'APP_JS must not use document.write')
  assert.ok(!APP_JS.includes('console.log'), 'APP_JS must not log token/secret')
  assert.ok(APP_JS.includes('textContent'), 'APP_JS renders dynamic data via textContent')
})

await test('W005-A DOM safety: malicious text rendered as inert text, no executable nodes', () => {
  const createdTags: string[] = []
  const innerHtmlSets: string[] = []
  const elements = new Map<string, Record<string, unknown>>()

  function makeElement(id: string): Record<string, unknown> {
    const el: Record<string, unknown> & { children: unknown[] } = {
      id,
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      children: [],
      appendChild(child: unknown): unknown {
        el.children.push(child)
        return child
      },
      addEventListener(): void {},
    }
    // 记录任何 innerHTML / outerHTML 赋值（render path 不应触发）
    Object.defineProperty(el, 'innerHTML', {
      set(): void {
        innerHtmlSets.push(id)
      },
      get(): string {
        return ''
      },
    })
    Object.defineProperty(el, 'outerHTML', {
      set(): void {
        innerHtmlSets.push(id)
      },
      get(): string {
        return ''
      },
    })
    return el
  }

  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) {
        elements.set(id, makeElement(id))
      }
      return elements.get(id)
    },
    createElement(tag: string) {
      createdTags.push(tag)
      return makeElement(`<${tag}>`)
    },
  }

  // bootstrap 只经 application/json 标签注入一次
  document.getElementById('novawing-bootstrap')!.textContent = JSON.stringify({
    controlToken: CONTROL_TOKEN,
    serverOrigin: 'http://127.0.0.1:4317',
  })

  const context: Record<string, unknown> = {
    document,
    fetch: async () => ({ ok: false }),
    EventSource: function MockEventSource(this: { addEventListener: () => void }) {
      this.addEventListener = () => {}
    },
  }

  vm.runInNewContext(APP_JS, context)

  const render = context.render as (snapshot: Record<string, unknown>) => void
  render({
    configuredSession: {
      id: 's1',
      targetRepo: '/repo/example',
      branch: 'feat/x',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 5 },
      tasks: [{ id: 'T1', goal: MALICIOUS_GOAL }],
    },
    runtime: {
      started: true,
      running: true,
      state: 'SUSPENDED',
      currentTaskId: 'T1',
      completedTaskIds: [],
      humanRequired: { category: 'DECISION_REQUIRED', reason: MALICIOUS_REASON },
    },
    guardian: { phase: 'REVIEWING', status: 'active', iteration: 1, elapsedMs: 0 },
    recentEvents: [
      {
        id: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'TASK_STARTED',
        data: { message: MALICIOUS_MESSAGE },
      },
    ],
  })

  // 1. decision reason 原样文本落地
  const decisionReason = elements.get('decision-reason')
  assert.equal(decisionReason?.textContent, MALICIOUS_REASON)

  // 2. task goal 原样文本落地
  const taskList = elements.get('task-list') as unknown as {
    children: Array<{ children: Array<{ textContent: string }> }>
  }
  const firstLi = taskList.children[0]!
  const label = firstLi.children[1]!
  assert.equal(label.textContent, `T1 ${MALICIOUS_GOAL}`)

  // 3. recent event message 原样文本落地
  const recentList = elements.get('recent-list') as unknown as {
    children: Array<{ children: Array<{ textContent: string }> }>
  }
  const recentData = recentList.children[0]!.children[1]!
  assert.equal(recentData.textContent, `Task 已开始 · ${MALICIOUS_MESSAGE}`)

  // 4. 未创建任何可执行节点
  assert.ok(!createdTags.includes('img'), 'must not create <img>')
  assert.ok(!createdTags.includes('script'), 'must not create <script>')
  assert.ok(!createdTags.includes('svg'), 'must not create <svg>')

  // 5. 未触发任何 innerHTML / outerHTML 赋值
  assert.equal(innerHtmlSets.length, 0)

  // 6. __PWNED__ 未被执行
  assert.notEqual(context.__PWNED__, true)

  // 7. control token 不出现在任何可见 DOM 文本
  const allText: string[] = []
  const collectText = (el: Record<string, unknown>): void => {
    allText.push(String(el.textContent ?? ''))
    for (const child of (el.children as unknown[]) ?? []) {
      collectText(child as Record<string, unknown>)
    }
  }
  for (const [id, el] of elements.entries()) {
    // bootstrap 标签本身是 token 的唯一合法位置，不属于可见 UI 内容。
    if (id === 'novawing-bootstrap') continue
    collectText(el)
  }
  assert.ok(!allText.some((text) => text.includes(CONTROL_TOKEN)))
})
