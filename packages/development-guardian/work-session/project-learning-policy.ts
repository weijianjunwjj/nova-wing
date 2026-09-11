import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PROJECT_LEARNING_POLICY_RELATIVE_PATH = '.novawing/learning-policy.json'

export interface ProjectLearningPolicy {
  mode: 'strict'
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Repository policy is a project-level trust boundary. Absence means normal
 * NovaWing behavior; presence must be valid and is never silently ignored.
 */
export async function loadProjectLearningPolicy(targetRepo: string): Promise<ProjectLearningPolicy | undefined> {
  const path = join(targetRepo, PROJECT_LEARNING_POLICY_RELATIVE_PATH)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error(`${PROJECT_LEARNING_POLICY_RELATIVE_PATH} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${PROJECT_LEARNING_POLICY_RELATIVE_PATH} must be an object`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== 1 || entries[0]?.[0] !== 'mode' || entries[0]?.[1] !== 'strict') {
    throw new Error(`${PROJECT_LEARNING_POLICY_RELATIVE_PATH} must contain exactly { "mode": "strict" }`)
  }
  return { mode: 'strict' }
}
