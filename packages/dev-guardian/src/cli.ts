import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DevelopmentGuardian } from './guardian.js'
import type { TaskSpec } from './types.js'

async function main(): Promise<void> {
  const taskFile = process.argv[2]
  if (!taskFile) {
    throw new Error('Usage: npm run guardian:mvp -- <task.json>')
  }

  const absoluteTaskFile = resolve(taskFile)
  const task = JSON.parse(await readFile(absoluteTaskFile, 'utf8')) as TaskSpec
  const guardian = new DevelopmentGuardian()

  try {
    const result = await guardian.run(task)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.state === 'COMPLETED' ? 0 : 2
  } finally {
    await guardian.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
