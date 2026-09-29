import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { CUSTOMER_APP_JS } from '../packages/development-guardian/planning/customer-view.js'

test('Customer Mode keeps the frozen result near approval while generation and recent loads focus the plan', async () => {
  const scrolls: Array<{ id: string; behavior: string | undefined; block: string | undefined }> = []
  class Element {
    children: Element[] = []
    listeners = new Map<string, () => unknown>()
    textContent = ''
    value = ''
    hidden = false
    disabled = false
    type = ''
    className = ''
    dataset: Record<string, string> = {}
    constructor(readonly id: string) {}
    append(...children: Element[]): void { this.children.push(...children) }
    replaceChildren(...children: Element[]): void { this.children = children }
    addEventListener(event: string, listener: () => unknown): void { this.listeners.set(event, listener) }
    scrollIntoView(options: { behavior?: string; block?: string }): void {
      scrolls.push({ id: this.id, behavior: options.behavior, block: options.block })
    }
  }
  const elements = new Map<string, Element>()
  const get = (id: string): Element => {
    let element = elements.get(id)
    if (!element) { element = new Element(id); elements.set(id, element) }
    return element
  }
  get('customer-bootstrap').textContent = JSON.stringify({ token: 'fixture-token' })
  const ready = {
    id: 'fixture-plan', version: 1, status: 'ready_for_approval',
    requirement: { text: '本地任务应用' },
    analysis: { productGoal: '本地任务应用', summary: '任务管理', userRoles: [], businessFlows: [] },
    productScope: { inScope: [], outOfScope: [] },
    architecture: { summary: '本地实现', components: [], decisions: [] },
    clauses: [], tasks: [], acceptancePlan: { strategy: '浏览器验收', criteria: [] },
    risks: [], assumptions: [], customerQuestions: [], coverage: [], semanticReview: { verdict: 'PASS', issues: [] },
  }
  const frozen = { ...ready, status: 'frozen', frozenAt: '2026-09-29T15:05:05.689Z',
    approval: { contentHash: 'a'.repeat(64) } }
  const response = (value: unknown) => ({ ok: true, json: async () => value })
  const fetch = async (url: string) => {
    if (url === '/api/planning/plans') return response([{
      id: ready.id, version: ready.version, status: ready.status, productGoal: ready.analysis.productGoal,
    }])
    if (url === '/api/planning/generate' || url === '/api/planning/plans/fixture-plan')
      return response({ plan: ready, validation: { issues: [] } })
    if (url === '/api/planning/approve') return response(frozen)
    throw new Error(`Unexpected request: ${url}`)
  }
  vm.runInNewContext(CUSTOMER_APP_JS, {
    document: { getElementById: get, createElement: (tag: string) => new Element(tag) },
    fetch, localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    setInterval: () => 1, clearInterval: () => undefined,
  })
  await new Promise(setImmediate)

  await get('generate').listeners.get('click')!()
  assert.equal(scrolls.at(-1)?.id, 'plan')
  const recentButton = get('recent-list').children[0]!.children[0]!
  await recentButton.listeners.get('click')!()
  assert.equal(scrolls.at(-1)?.id, 'plan')
  const planScrollsBeforeApproval = scrolls.filter((item) => item.id === 'plan').length

  await get('approve').listeners.get('click')!()
  assert.deepEqual(scrolls.at(-1), { id: 'freeze-result', behavior: 'smooth', block: 'nearest' })
  assert.equal(scrolls.filter((item) => item.id === 'plan').length, planScrollsBeforeApproval)
  assert.equal(get('freeze-result').hidden, false)
})
