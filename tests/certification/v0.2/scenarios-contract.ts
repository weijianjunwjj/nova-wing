import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createNovaWingLaunchpad,
  discoverTrustedWorkSessionConfigs,
} from '../../../packages/development-guardian/work-session/launchpad/server.js'
import {
  parseTaskContractBindingDsl,
  preflightTaskContract,
} from '../../../packages/development-guardian/work-session/launchpad/contract-preflight.js'
import { analyzeTaskBrief } from '../../../packages/development-guardian/work-session/launchpad/task-brief.js'
import type { TrustedWorkSessionConfig } from '../../../packages/development-guardian/work-session/production.js'
import type { CertificationScenario } from './scenario.js'
import { initFixtureRepo, removeTree } from './util.js'

function fakeApp(onCreate: (config: TrustedWorkSessionConfig) => void) {
  return async (config: TrustedWorkSessionConfig) => {
    onCreate(config)
    return {
      controller: { start: () => ({ started: true }) },
      start: async () => ({ url: 'http://127.0.0.1:54321' }),
      isLive: () => true,
      hasActiveSession: () => true,
      close: async () => undefined,
    }
  }
}

async function postCreate(launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(), Origin: address.url },
    body: JSON.stringify(body),
  })
}

function request(requestId: string, repo: string, guardian: Record<string, unknown>) {
  return {
    requestId,
    targetRepo: repo,
    tasks: [{ id: 'FW-001', goal: '为用户创建接口补充输入参数校验。' }],
    autoCommit: false,
    guardian: { allowedPaths: ['apps/api/**'], ...guardian },
  }
}

export const s17: CertificationScenario = {
  id: 'S17', title: 'Contract placeholder auto-repair', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, {
      'package.json': JSON.stringify({ name: 'fly-weave-like', scripts: { test: 'node scripts/test.mjs' } }),
      'scripts/test.mjs': "spawn(python, ['-m', 'pytest', ...process.argv.slice(2)])\n",
      'pytest.ini': '[pytest]\ntestpaths = apps/api/tests\n',
      'apps/api/main.py': 'customer_email: str\n',
      'apps/api/tests/test_ticket_intake.py': 'def test_ticket_intake(): pass\n',
    })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let created: TrustedWorkSessionConfig | undefined
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created = config }),
    } })
    try {
      await launchpad.start()
      const brief = analyzeTaskBrief(`Goal:\n为用户创建接口补充输入参数校验。\n\nAcceptance Criteria:\nAC1 Invalid email is rejected with HTTP 400 => npm test -- --runInBand <对应测试>\n\nAllowed Paths:\napps/api/**`)
      h.check(brief.fields.acceptanceCriteria?.[0] === 'AC1 Invalid email is rejected with HTTP 400', 'natural-language brief composes the criterion independently from its verifier')
      const response = await postCreate(launchpad, request(`cert-s17-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: brief.fields.acceptanceCriteria,
        acceptanceEvidenceBindings: brief.fields.acceptanceEvidenceBindings,
      }))
      h.check(response.status === 202, `repaired contract creates Session (got ${response.status} ${await response.text()})`)
      h.check(created !== undefined, 'Work Session construction occurs only after preflight PASS')
      h.check(created?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === 'AC1 Invalid email is rejected with HTTP 400' && binding.requiredEvidence.length === 1 && binding.requiredEvidence[0] === 'npm test') === true,
        'placeholder and incompatible --runInBand are replaced by repository-authoritative npm test entry')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 1, 'only the repaired valid contract is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s18: CertificationScenario = {
  id: 'S18', title: 'Unresolvable contract blocked before Session', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'README.md': '# no deterministic test entry\n' })
    const configs = join(ctx.dirs.root, 'configs')
    let createCalls = 0
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
    } })
    try {
      await launchpad.start()
      const response = await postCreate(launchpad, request(`cert-s18-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['AC1 Invalid email is rejected with HTTP 400 => npm test -- <对应测试>'],
      }))
      const body = await response.json() as { error?: string; issues?: Array<{ issueCode?: string }> }
      h.check(response.status === 400 && body.error === 'TASK_CONTRACT_INVALID', 'Launchpad returns structured TASK_CONTRACT_INVALID')
      h.check(body.issues?.some((issue) => issue.issueCode === 'UNRESOLVED_PLACEHOLDER') === true, 'response identifies the unresolved placeholder')
      h.check(createCalls === 0, 'no Work Session is constructed')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 0, 'no invalid config is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s19: CertificationScenario = {
  id: 'S19', title: 'Verifier approval discovered before EXECUTE', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const result = await preflightTaskContract({ targetRepo: repo, acceptanceCriteria: ['custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }] })
    h.check(!result.ok, 'approval-required contract does not pass creation preflight')
    h.check(result.verifiers[0]?.classification === 'APPROVAL_REQUIRED', 'verifier is classified APPROVAL_REQUIRED before runtime')
    h.check(!result.ok && result.issues.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED'), 'required exact command is surfaced as a structured preflight issue')
  },
}

export const s20: CertificationScenario = {
  id: 'S20', title: 'Verifier containing => parses correctly', group: 'compatibility',
  run(ctx) {
    const parsed = parseTaskContractBindingDsl('mapping remains exact => node -e "console.log(\'x => y\')"')
    ctx.h.check(parsed?.criterionText === 'mapping remains exact', 'criterion uses only the first delimiter')
    ctx.h.check(parsed?.verifierCommand === 'node -e "console.log(\'x => y\')"', 'literal => remains inside the structured verifier command')
    return Promise.resolve()
  },
}
