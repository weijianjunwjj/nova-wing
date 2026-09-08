/**
 * V2 Controller Observability & Routing Telemetry
 *
 * 统一 Provider Health / Dispatch Explanation / Task Event Log 模型。
 *
 * 设计边界（与既有架构一致）：
 * - TaskStateV2 仍是唯一 canonical semantic authority；
 * - Event Log 是 append-only 历史 / audit trail，Controller 决策永不读取它；
 * - Provider Health 只投影真实 runtime/router observation，不信任 Agent 自报；
 * - Explanation 必须由真实决策输入确定性推导，禁止执行后再编造理由。
 *
 * 本模块只含可 JSON 序列化的纯值模型与纯函数，不引入新的持久化通道。
 */

import type { TaskStateV2 } from './task-state-v2.js'
import type { TaskAction } from './task-controller.js'

/** 第一版 Provider Health 状态。确定性、简单，不做 AI Router。 */
export type ProviderHealthStatus =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'QUOTA_EXHAUSTED'
  | 'TIMEOUT'
  | 'OFFLINE'

/** Provider Health 至少能够表达 provider / runtime 身份 / status / reason / observedAt / retryAfter。 */
export interface ProviderHealthObservation {
  provider: string
  /** runtime / executor identity；区分同 provider 不同 runtime。 */
  executor?: string
  status: ProviderHealthStatus
  reason?: string
  observedAt: string
  /** 若已知限流/冷却可重试时间（ISO）。 */
  retryAfter?: string
  /** 事实来源：'runtime' = router/store 真实观察；'controller' = 控制器输入快照（非自报，仍非新 observation）。 */
  source?: 'runtime' | 'controller'
  metadata?: Record<string, unknown>
}

/** last-known health，按 provider key 索引。 */
export type ProviderHealthMap = Record<string, ProviderHealthObservation>

/**
 * 第一版 Dispatch / Decision reason code。
 *
 * 不用自由文本代替结构化 reason；message 只是 projection，
 * 真正事实来自 reasonCode + structured factors。
 */
export type DecisionReasonCode =
  | 'CONTINUE_CURRENT_AGENT'
  | 'PROVIDER_QUOTA_EXHAUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CAPABILITY_MATCH'
  | 'CAPABILITY_MISMATCH'
  | 'INDEPENDENT_REVIEW_REQUIRED'
  | 'RISK_REQUIRES_REVIEW'
  | 'RISK_REQUIRES_APPROVAL'
  | 'REPOSITORY_RECONCILIATION_REQUIRED'
  | 'VERIFICATION_FAILED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_STALE'
  | 'BLOCKER_PRESENT'
  | 'NO_AVAILABLE_AGENT'
  | 'TASK_NOT_STARTED'
  | 'ACCEPTANCE_ANALYSIS_REQUIRED'
  | 'FAILED_TASK_RECOVERY'
  | 'HUMAN_DECISION_REQUIRED'
  | 'COMPLETION_CRITERIA_SATISFIED'

/** 每次关键派单决策生成的结构化 explanation。 */
export interface DispatchExplanation {
  action: TaskAction
  reasonCode: DecisionReasonCode
  selectedAgent?: string
  selectedProvider?: string
  previousAgent?: string
  previousProvider?: string
  factors: readonly string[]
  alternativesConsidered: readonly string[]
  message?: string
  timestamp: string
}

/** Task Event Log 事件类型。 */
export type TaskEventType =
  | 'TASK_CREATED'
  | 'TASK_STATE_UPDATED'
  | 'CONTROLLER_DECIDED'
  | 'AGENT_DISPATCHED'
  | 'AGENT_COMPLETED'
  | 'AGENT_FAILED'
  | 'PROVIDER_HEALTH_CHANGED'
  | 'PROVIDER_SWITCHED'
  | 'VERIFICATION_STARTED'
  | 'VERIFICATION_PASSED'
  | 'VERIFICATION_FAILED'
  | 'RECONCILIATION_REQUIRED'
  | 'RECONCILIATION_COMPLETED'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_STARTED'
  | 'REVIEW_PASSED'
  | 'REVIEW_FAILED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_GRANTED'
  | 'CHECKPOINT_CREATED'
  | 'TASK_SUSPENDED'
  | 'TASK_RESUMED'
  | 'TASK_COMPLETED'

/** 单个 Task Event。必要字段最少化，不塞完整 TaskStateV2 snapshot。 */
export interface TaskEventV2 {
  eventId: string
  taskId: string
  sessionId: string
  type: TaskEventType
  timestamp: string
  action?: TaskAction
  agent?: string
  provider?: string
  previousProvider?: string
  runtimeIdentity?: string
  reasonCode?: DecisionReasonCode
  explanation?: DispatchExplanation
  repositoryIdentity?: string
  branch?: string
  headSha?: string
  workspaceFingerprint?: string
  evidenceRefs?: readonly string[]
  metadata?: Record<string, unknown>
}

/** Task Event Log 读接口。历史记录永不反向驱动语义。 */
export interface TaskEventLogReader {
  readonly events: readonly TaskEventV2[]
  has(type: TaskEventType): boolean
  count(type: TaskEventType): number
  last(type: TaskEventType): TaskEventV2 | undefined
}

/**
 * 一个 Task 的 append-only 事件日志。
 *
 * 纯内存累加器；持久化由所在持久化边界（session snapshot）负责。
 * eventId 为 per-task 单调递增序号，restart 后从既有最大序号继续，避免冲突。
 */
export class TaskEventLogV2 implements TaskEventLogReader {
  private sequence: number
  private readonly items: TaskEventV2[]

  constructor(initial: readonly TaskEventV2[] = [], private readonly now: () => string = () => new Date().toISOString()) {
    this.items = initial.map((event) => ({ ...event }))
    this.sequence = this.items.reduce((max, event) => {
      const parsed = Number.parseInt(event.eventId, 10)
      return Number.isSafeInteger(parsed) && parsed > max ? parsed : max
    }, 0) + 1
  }

  get events(): readonly TaskEventV2[] {
    return this.items
  }

  has(type: TaskEventType): boolean {
    return this.items.some((event) => event.type === type)
  }

  count(type: TaskEventType): number {
    return this.items.reduce((count, event) => count + (event.type === type ? 1 : 0), 0)
  }

  last(type: TaskEventType): TaskEventV2 | undefined {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index]!.type === type) return this.items[index]
    }
    return undefined
  }

  /** Append 一个事件并返回它（含分配的 eventId 与默认 timestamp）。 */
  append(event: Omit<TaskEventV2, 'eventId' | 'timestamp'> & { timestamp?: string }): TaskEventV2 {
    const complete: TaskEventV2 = { ...event, eventId: String(this.sequence++), timestamp: event.timestamp ?? this.now() }
    this.items.push(complete)
    return complete
  }
}

/** 从 agent profile 推导 provider 名。transport 层无独立 provider 时回落 agent id。 */
export function providerOf(agent: { id: string; identity?: { provider?: string | undefined } | undefined }): string {
  return agent.identity?.provider ?? agent.id
}

function healthStatusOf(profile: {
  available: boolean
  quotaExhausted: boolean
  degraded: boolean
}): ProviderHealthStatus {
  if (profile.quotaExhausted) return 'QUOTA_EXHAUSTED'
  if (profile.degraded) return 'DEGRADED'
  if (!profile.available) return 'OFFLINE'
  return 'AVAILABLE'
}

/**
 * Provider Health registry：last-known，按 provider key 投影真实 observation。
 * 新 observation 必须带更新的 observedAt 才能覆盖旧值，保证 persisted
 * last-known 不会被更早的 runtime 观察降级。
 */
export class ProviderHealthRegistry {
  private readonly map: ProviderHealthMap

  constructor(initial: ProviderHealthMap = {}) {
    this.map = { ...initial }
  }

  get(provider: string): ProviderHealthObservation | undefined {
    return this.map[provider]
  }

  /** 覆盖条件：同 provider 无旧值，或新 observation 的 observedAt 不早于旧值。 */
  record(observation: ProviderHealthObservation): ProviderHealthObservation {
    const existing = this.map[observation.provider]
    if (existing === undefined || Date.parse(observation.observedAt) >= Date.parse(existing.observedAt)) {
      this.map[observation.provider] = observation
      return observation
    }
    return existing
  }

  /**
   * 用当前 agent profiles 补齐没有 observation 的 provider。
   * 已有（可能来自持久化 last-known 或更早真实观察）的 provider 不会被 profile 覆盖，
   * 因为 profile 只是控制器输入快照，不是新的 runtime observation。
   */
  seedFromProfiles(agents: readonly { id: string; identity?: { provider?: string | undefined } | undefined; available: boolean; quotaExhausted: boolean; degraded: boolean }[], now = new Date().toISOString()): void {
    for (const agent of agents) {
      const provider = providerOf(agent)
      if (this.map[provider] === undefined) {
        const status = healthStatusOf(agent)
        this.map[provider] = {
          provider,
          ...(agent.identity?.provider !== undefined ? { executor: agent.id } : {}),
          status,
          ...(status === 'QUOTA_EXHAUSTED'
            ? { reason: 'quota exhausted' }
            : status === 'OFFLINE'
              ? { reason: 'provider unavailable' }
              : {}),
          observedAt: now,
          source: 'controller',
        }
      }
    }
  }

  entries(): ProviderHealthMap {
    return { ...this.map }
  }
}

/**
 * 派生"为什么选这个 agent / provider"的 reason code。
 * 确定性、基于真实决策输入（profile health + capability），不编造。
 */
export function selectionReasonCode(input: {
  action: TaskAction
  selected?: { id: string; identity?: { provider?: string | undefined } | undefined }
  previousAgent?: string
  previousProfile?: { available: boolean; quotaExhausted: boolean; degraded: boolean }
}): DecisionReasonCode {
  const { action, selected, previousAgent, previousProfile } = input
  if (action === 'REVIEW') return 'INDEPENDENT_REVIEW_REQUIRED'
  if (selected === undefined) return 'NO_AVAILABLE_AGENT'
  const sameAgent = previousAgent !== undefined && selected.id === previousAgent
  if (sameAgent) return 'CONTINUE_CURRENT_AGENT'
  if (previousProfile !== undefined) {
    const previousStatus = healthStatusOf(previousProfile)
    if (previousStatus === 'QUOTA_EXHAUSTED') return 'PROVIDER_QUOTA_EXHAUSTED'
    if (previousStatus !== 'AVAILABLE') return 'PROVIDER_UNAVAILABLE'
  }
  return previousAgent === undefined ? 'CAPABILITY_MATCH' : 'CAPABILITY_MISMATCH'
}

/**
 * 派生 provider 切换（switch）的 reason code。
 * previousProvider 的真实 Health 是唯一事实依据；不解释 Router 的潜在原因。
 */
export function providerSwitchReasonCode(health: ProviderHealthObservation | undefined): DecisionReasonCode {
  if (health === undefined) return 'CAPABILITY_MISMATCH'
  if (health.status === 'QUOTA_EXHAUSTED') return 'PROVIDER_QUOTA_EXHAUSTED'
  if (health.status !== 'AVAILABLE') return 'PROVIDER_UNAVAILABLE'
  return 'CAPABILITY_MISMATCH'
}

/**
 * 从 provider history 的真实增量推导应记录的 provider 切换事件。
 *
 * 只看真实历史 delta：保留与上一 history 公共的前缀，只把新执行的 provider
 * 序列与前一 provider 比较；连续相同 provider 不产生 switch，历史不增长则无 switch。
 */
export function deriveProviderSwitches(previous: readonly string[], next: readonly string[]): ReadonlyArray<readonly [string, string]> {
  const common = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < common && previous[prefix] === next[prefix]) prefix += 1
  const additions = next.slice(prefix)
  if (additions.length === 0) return []
  const changes: Array<readonly [string, string]> = []
  const chain: string[] = [...previous.slice(0, prefix)]
  for (const provider of additions) {
    if (chain.length === 0 || chain[chain.length - 1] !== provider) {
      if (chain.length > 0) changes.push([chain[chain.length - 1]!, provider])
      chain.push(provider)
    }
  }
  return changes
}

/** 结构化 human-readable message；仅 projection，真正事实是 reasonCode + factors。 */
export function dispatchMessage(input: { reasonCode: DecisionReasonCode; action: TaskAction; selectedAgent?: string; previousAgent?: string; selectedProvider?: string; previousProvider?: string }): string {
  const { reasonCode, action, selectedAgent, previousAgent, selectedProvider, previousProvider } = input
  if (reasonCode === 'CONTINUE_CURRENT_AGENT') {
    return `Continued ${selectedAgent} because it remains available and satisfies ${action} capability.`
  }
  if (reasonCode === 'PROVIDER_QUOTA_EXHAUSTED') {
    return `Switched ${previousAgent ?? previousProvider ?? 'provider'} to ${selectedAgent ?? selectedProvider} because its provider quota is exhausted.`
  }
  if (reasonCode === 'INDEPENDENT_REVIEW_REQUIRED') {
    return `${action} requires an independent reviewer distinct from the implementer.`
  }
  if (reasonCode === 'RISK_REQUIRES_REVIEW') {
    return `${action} required because HIGH risk requires independent review.`
  }
  if (reasonCode === 'RISK_REQUIRES_APPROVAL') {
    return `${action} required because CRITICAL risk requires human approval.`
  }
  if (reasonCode === 'REPOSITORY_RECONCILIATION_REQUIRED') {
    return `${action} required because repository reality drifted from persisted task facts.`
  }
  if (reasonCode === 'NO_AVAILABLE_AGENT') {
    return `No available agent satisfies ${action}.`
  }
  return `${action} selected ${selectedAgent ?? 'an agent'} (${reasonCode}).`
}

/** 从 TaskStateV2 抽取稳定的仓库事实字段，供事件复用。 */
export function repositoryFacts(task: TaskStateV2): Pick<TaskEventV2, 'repositoryIdentity' | 'branch' | 'headSha' | 'workspaceFingerprint'> {
  return {
    ...(task.gitState.repositoryIdentity === undefined ? {} : { repositoryIdentity: task.gitState.repositoryIdentity }),
    ...(task.gitState.branch === undefined ? {} : { branch: task.gitState.branch }),
    ...(task.gitState.headSha === undefined ? {} : { headSha: task.gitState.headSha }),
    ...(task.gitState.worktreeFingerprint === undefined ? {} : { workspaceFingerprint: task.gitState.worktreeFingerprint }),
  }
}

/** Task Event Log 持久化结构：per task 的 append-only 数组。 */
export type TaskEventLogProjection = Record<string, readonly TaskEventV2[]>
