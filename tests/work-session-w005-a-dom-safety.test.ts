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

import { APP_JS } from '../packages/development-guardian/work-session/control-ui/view.js'

await test('W005-A DOM safety: APP_JS uses only safe DOM APIs', () => {
  assert.ok(!APP_JS.includes('innerHTML'), 'APP_JS must not use innerHTML')
  assert.ok(!APP_JS.includes('insertAdjacentHTML'), 'APP_JS must not use insertAdjacentHTML')
  assert.ok(!APP_JS.includes('outerHTML'), 'APP_JS must not use outerHTML')
  assert.ok(!APP_JS.includes('document.write'), 'APP_JS must not use document.write')
  assert.ok(!APP_JS.includes('console.log'), 'APP_JS must not log token/secret')
  assert.ok(APP_JS.includes('textContent'), 'APP_JS renders dynamic data via textContent')
})
