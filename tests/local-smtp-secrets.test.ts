import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  loadLocalSmtpSecrets,
  resolveProductionSmtpEnvironment,
  saveLocalSmtpSecrets,
  smtpEnvironmentFrom,
  validateSmtpSecrets,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'

const secrets = {
  NOVAWING_SMTP_HOST: 'smtp.example.test',
  NOVAWING_SMTP_PORT: '465',
  NOVAWING_SMTP_SECURE: 'true',
  NOVAWING_SMTP_USER: 'owner@example.test',
  NOVAWING_SMTP_PASS: 'TEST_PASSWORD_NEVER_LOGGED',
  NOVAWING_NOTIFY_FROM: 'owner@example.test',
  NOVAWING_NOTIFY_TO: 'notify@example.test',
}

function config(enabled: boolean): TrustedWorkSessionConfig {
  return {
    session: { id: 'secret-test', targetRepo: process.cwd(), branch: 'feat/work-session-mvp', limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'one', guardian: { constraints: [], acceptanceCriteria: [], doNotDo: [], allowedPaths: ['packages/**'], forbiddenPaths: [] } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false },
    notification: { email: { enabled } },
  }
}

async function withTemp(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-smtp-secret-'))
  try { await run(join(directory, 'smtp.json')) } finally { await rm(directory, { recursive: true, force: true }) }
}

await test('SECRET-A/B/C/D/E/F: local SMTP source resolution is strict and fail-closed', async () => {
  await withTemp(async (path) => {
    assert.equal((await resolveProductionSmtpEnvironment(config(false), {}, path)).NOVAWING_SMTP_HOST, undefined)
    assert.equal((await resolveProductionSmtpEnvironment(config(true), secrets, path)).NOVAWING_SMTP_HOST, secrets.NOVAWING_SMTP_HOST)

    await writeFile(path, JSON.stringify(secrets))
    assert.equal((await resolveProductionSmtpEnvironment(config(true), {}, path)).NOVAWING_SMTP_PASS, secrets.NOVAWING_SMTP_PASS)
    await assert.rejects(
      resolveProductionSmtpEnvironment(config(true), { NOVAWING_SMTP_HOST: secrets.NOVAWING_SMTP_HOST }, path),
      /all 7 notification values or none/u,
    )
    await assert.rejects(
      resolveProductionSmtpEnvironment(config(true), { NOVAWING_SMTP_HOST: '' }, path),
      /all 7 notification values or none/u,
    )
    await assert.rejects(resolveProductionSmtpEnvironment(config(true), {}, join(dirname(path), 'missing.json')), /not configured/u)
    await writeFile(path, JSON.stringify({ ...secrets, unexpected: 'x' }))
    await assert.rejects(loadLocalSmtpSecrets(path), /unsupported or missing keys/u)
  })
})

await test('SECRET-G/H/I: setup saves atomically, rejects partial env, and preserves prior secrets on failure', async () => {
  await withTemp(async (path) => {
    let aclCalls = 0
    await saveLocalSmtpSecrets(secrets, { path, restrictAcl: async () => { aclCalls++ } })
    assert.equal(aclCalls, 1)
    assert.equal((await loadLocalSmtpSecrets(path)).NOVAWING_SMTP_PASS, secrets.NOVAWING_SMTP_PASS)
    assert.throws(() => smtpEnvironmentFrom({ NOVAWING_SMTP_HOST: 'only-one' }), /all 7 notification values or none/u)

    await assert.rejects(
      saveLocalSmtpSecrets({ ...secrets, NOVAWING_SMTP_PASS: 'replacement' }, {
        path,
        restrictAcl: async () => { throw new Error('ACL unavailable') },
      }),
      /ACL unavailable/u,
    )
    assert.equal((await loadLocalSmtpSecrets(path)).NOVAWING_SMTP_PASS, secrets.NOVAWING_SMTP_PASS)
    assert.deepEqual((await readdir(dirname(path))).filter((name) => name.endsWith('.tmp')), [])
  })
})

await test('SECRET-F: malformed values never expose their contents', () => {
  assert.throws(
    () => validateSmtpSecrets({ ...secrets, NOVAWING_SMTP_PORT: 'not-a-port' }),
    (error: Error) => !error.message.includes('not-a-port'),
  )
  assert.throws(
    () => validateSmtpSecrets({ ...secrets, NOVAWING_NOTIFY_TO: 'bad\naddress' }),
    (error: Error) => !error.message.includes('bad'),
  )
})
