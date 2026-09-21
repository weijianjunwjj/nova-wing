import { randomUUID } from 'node:crypto'

/** Process-local work, independent of durable Session state and UI presence. */
export type WorkSessionActivityOperation =
  | 'execution'
  | 'scheduled-execution'
  | 'resume'
  | 'verification'
  | 'runtime-repair'
  | 'checkpoint-recovery'
  | 'model-repair'
  | 'model-runner'

export interface WorkSessionActivityEvent {
  readonly phase: 'started' | 'ended'
  readonly activityId: string
  readonly operation: WorkSessionActivityOperation
  readonly sessionId?: string
}

/** Observers must not control, delay, or change the outcome of accepted work. */
export type WorkSessionActivityObserver = (event: WorkSessionActivityEvent) => void | Promise<void>

function notify(observer: WorkSessionActivityObserver, event: WorkSessionActivityEvent): void {
  try {
    // A caller may provide an async observer despite the synchronous lifecycle
    // contract. Own rejection without making it part of business work/drain.
    void Promise.resolve(observer(Object.freeze(event))).catch(() => {})
  } catch { /* Optional host observation cannot alter business work. */ }
}

/** Internal lease boundary; every dispatch result, including sync throw, releases. */
export async function observeWorkSessionActivity<T>(
  observer: WorkSessionActivityObserver | undefined,
  activity: Pick<WorkSessionActivityEvent, 'operation' | 'sessionId'>,
  dispatch: () => T | Promise<T>,
): Promise<T> {
  if (observer === undefined) return dispatch()
  const identity = { ...activity, activityId: randomUUID() }
  notify(observer, { ...identity, phase: 'started' })
  try { return await dispatch() } finally { notify(observer, { ...identity, phase: 'ended' }) }
}
