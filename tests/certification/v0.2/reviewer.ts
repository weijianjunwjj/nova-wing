/**
 * NovaWing v0.2.4 certification — scripted provider-agnostic reviewer runtimes.
 *
 * The production review path (ReviewDispatcher + ReviewerRuntimeRegistry) stays real;
 * only the reviewer model/transport is scripted, exactly like the existing
 * createV2Dispatcher seam scripts the implementer.
 */
import type {
  ReviewerOutcome,
  ReviewerReviewInput,
  ReviewerRuntime,
} from '../../../packages/development-guardian/work-session/reviewer-runtime.js'

export interface ScriptedReviewerCall {
  provider: string
  agentId: string
  agentProvider: string
  agentRuntimeIdentity: string
  taskId: string
  headSha: string | undefined
  workspaceFingerprint: string | undefined
  implementerRuntimeIdentity: string | undefined
  implementerProviders: readonly string[]
  changedFiles: readonly string[]
  acceptanceCriteria: readonly string[]
}

export interface ScriptedReviewer {
  runtime: ReviewerRuntime
  calls: ScriptedReviewerCall[]
}

export function scriptedReviewerRuntime(
  provider: string,
  handler: (call: ScriptedReviewerCall, input: ReviewerReviewInput) => ReviewerOutcome | Promise<ReviewerOutcome>,
): ScriptedReviewer {
  const calls: ScriptedReviewerCall[] = []
  return {
    calls,
    runtime: {
      provider,
      async review(input) {
        const identity = input.agent.identity ?? { agent: input.agent.id, provider: input.agent.id, runtimeIdentity: input.agent.id }
        const call: ScriptedReviewerCall = {
          provider,
          agentId: input.agent.id,
          agentProvider: identity.provider,
          agentRuntimeIdentity: identity.runtimeIdentity,
          taskId: input.task.taskId,
          headSha: input.task.headSha,
          workspaceFingerprint: input.task.workspaceFingerprint,
          implementerRuntimeIdentity: input.task.implementer?.runtimeIdentity,
          implementerProviders: input.task.implementerProviders,
          changedFiles: input.task.changedFiles,
          acceptanceCriteria: input.task.acceptanceCriteria,
        }
        calls.push(call)
        return handler(call, input)
      },
    },
  }
}

export function passVerdict(provider: string, summary = 'implementation satisfies the task contract'): ReviewerOutcome {
  return { kind: 'VERDICT', passed: true, findings: [], blockingFindings: [], summary, provider }
}

export function failVerdict(provider: string, blockingFinding: string, summary = 'implementation does not satisfy the task contract'): ReviewerOutcome {
  return { kind: 'VERDICT', passed: false, findings: [blockingFinding], blockingFindings: [blockingFinding], summary, provider }
}

export function reviewerProviderFailure(
  provider: string,
  status: 'OFFLINE' | 'QUOTA_EXHAUSTED' | 'TIMEOUT' | 'DEGRADED',
  reason: string,
): ReviewerOutcome {
  return { kind: 'RUNTIME_FAILURE', provider, status, reason }
}
