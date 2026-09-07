/** Isolated HTTP fixture: real persistence/controller, no Guardian or model calls. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { WorkSessionRuntime } from '../packages/development-guardian/work-session/runtime.js'
import { WorkSessionControlController } from '../packages/development-guardian/work-session/control-ui/controller.js'
import { WorkSessionControlServer } from '../packages/development-guardian/work-session/control-ui/server.js'
import { deriveDisplayState } from '../packages/development-guardian/work-session/recoverability.js'
import type { TrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'

export async function createScheduledFixture(directory: string, clock = { now: () => Date.now() }) {
  let calls = 0
  const runtimeFor = (config: TrustedWorkSessionConfig) => new WorkSessionRuntime({
    definition: {
      id: config.session.id, targetRepo: config.session.targetRepo, branch: config.session.branch,
      limits: config.session.limits, tasks: config.tasks,
      scheduledStartAt: config.session.scheduledStartAt ?? null,
      scheduleSource: config.session.scheduleSource ?? 'immediate',
      ...(config.session.createdAt === undefined ? {} : { createdAt: config.session.createdAt }),
    },
    storageUrl: pathToFileURL(join(directory, `${config.session.id}.db`)).href,
    clock, taskRunner: { async run() { calls++; return { status: 'COMPLETED' } } },
  })
  const apps: Array<{ runtime: WorkSessionRuntime; controller: WorkSessionControlController; server: WorkSessionControlServer }> = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      resolveEnvironment: async () => ({}),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      async readSessionStatus(config) {
        const runtime = runtimeFor(config)
        try { return deriveDisplayState(await runtime.loadPersistedState(), false) } finally { await runtime.close() }
      },
      async createWorkSession(config) {
        const runtime = runtimeFor(config)
        const controller = new WorkSessionControlController({ createRuntime: () => runtime, pollIntervalMs: 10, clock })
        await controller.loadPersistedState()
        const server = new WorkSessionControlServer({ controller, port: 0 })
        apps.push({ runtime, controller, server })
        return {
          controller, start: () => server.start(), isLive: () => server.isListening(),
          hasActiveSession: () => controller.hasActiveOperation(),
          async close() { await server.close(); await runtime.close() },
        }
      },
    },
  })
  return { launchpad, apps, calls: () => calls }
}
