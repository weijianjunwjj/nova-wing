# Retry a suspended Delivery task from EXECUTE

This is an explicit recovery operation for invalid execution-result projections. It neither starts Delivery nor creates or resumes a WorkSession. Frozen plans, RuntimePlans and acceptance semantics are unchanged. It is available only on Delivery's V2 controller route, with direct/golden execution disabled.

## Operation

`POST /api/session/reconcile-task-retry` on the existing WorkSession control server uses the existing control token and same-origin mutation checks. The JSON body must contain every field below; additional fields are rejected:

| Field | Required binding |
| --- | --- |
| `sessionId`, `workflowRunId` | The existing WorkSession and its existing workflow run |
| `taskId` | The current suspended task |
| `expectedGeneration` | Current persisted suspension generation |
| `expectedWorkflowState`, `expectedTaskState` | Both `SUSPENDED` |
| `expectedCurrentAction` | Exact persisted action, such as `REVIEW` |
| `sourceSnapshotId`, `sourcePlanHash` | Approved frozen snapshot identity and hash |
| `runtimePlanHash`, `targetBindingId` | Persisted Delivery binding |
| `targetBaselineCommit` | Full 40-character baseline commit |
| `reasonCode` | `RUNTIME_EXECUTION_RESULT_INVALIDATED` |

Before any projection changes, Runtime requires exclusive session and Executor-workspace ownership, a suspended snapshot, the current task/index and generation, and no target-task completion/checkpoint commit/push. Fresh artifact validation checks frozen integrity, RuntimePlan identity and coverage, Delivery binding, task policy, repository identity, branch and a clean **exact baseline**. Descendant commits are deliberately unsupported in this first version. Existing human constraints and remaining action budget must permit EXECUTE. Ownership is never stolen based on time or PID.

A successful response is a durable receipt containing session/run/task IDs, previous/new attempt IDs, generation, reason code, timestamp and `nextDecision: EXECUTE`. The HTTP operation returns 200 only after the snapshot write. It leaves the workflow SUSPENDED and the task PENDING. Other current-state/binding/ownership conflicts return 409; malformed inputs return 400. No payload or provider continuation is included in the audit event.

## Persistence and audit

One atomic workflow snapshot write appends `TASK_RETRY_RECONCILED` and an internal archive of the previous raw task and workflow projections. Existing task events, HUMAN_REQUIRED records, review failures, mutation refusal evidence and execution ledger remain intact. Legacy attempts receive a deterministic audit identity; their provider metadata remains under its original key.

The new current task projection clears execution/provider/convergence state, verification results, review/approval/completion evidence, blockers and stale continuation checkpoints. Workflow verification/approval/human-action/runtime-repair/failure projections are cleared. Historical recovery instructions remain stored but instructions from the prior generation are excluded from the new attempt.

Task policy, acceptance bindings, verification plan, human constraints, action-budget counters, frozen/runtime identity, WorkSession/run ID, other tasks, completed-task IDs and checkpoint maps are preserved. Recovery does not refund actions or grant a recovery budget. The controller must return EXECUTE before persistence and again before resume. New Executor metadata is keyed by `(sessionId, taskId, attemptId)`, so old thread continuation cannot be reused or overwritten.

Repeated or concurrent reconciliation is explicitly rejected. Cooperative session/workspace leases and a final snapshot comparison reject competing writers; the history and receipt survive reopening the same DB. Old software owners must be quiesced before deploying this operation.

## Separate explicit resume

Only after inspecting the receipt, a separately authorized request to the existing `POST /api/session/resume` may supply:

```json
{"taskRetryReceiptId":"<receiptId>","taskId":"T1","generation":2}
```

The generation must come from the receipt. Decision, approval and diagnosis fields cannot be combined with it. Normal preflight still applies. Runtime revalidates the repository and bindings, policy, budget, receipt identity and EXECUTE decision before atomically claiming the receipt. It then resumes the same workflow run. A duplicate receipt is rejected, including after reopening or from a second runtime owner.

If interrupted after receipt claim but before workflow dispatch, the operation fails closed: `RESUME_CLAIMED` is not automatically replayed or re-reconciled. An operator must establish what actually executed before further recovery. This protects against duplicate execution rather than claiming exactly-once behavior across arbitrary process crashes.

Ordinary resume and `ALLOW REEXECUTE` retain their prior behavior for unreconciled suspensions; neither resets a task from REVIEW to EXECUTE. Reviewer repair/availability is independent and unchanged.

## Requirement 001

Implementation and regression tests use isolated repositories and databases. Applying reconciliation to the real Requirement 001 WorkSession, deploying/reloading its runtime, or resuming it requires a subsequent explicit operation. This change performs none of those actions. Reviewer unavailability remains a separate REVIEW_FAILURE.

## Refresh Reviewer health without resuming

`POST /api/session/refresh-reviewer-health` uses the same protected control token/origin gates. Its exact binding fields are the reconciliation fields above, replacing `reasonCode` with `provider: "deepseek"`. Only a suspended current task at the expected generation/action and unchanged clean baseline/bindings is eligible. An already-pending retry receipt is rejected; refresh before reconciliation.

The operation holds session and workspace ownership while running one isolated health fixture through the formal DeepSeek reviewer adapter. The existing resolved review model and provider environment are used. A private temporary Claude configuration/history directory keeps CLI state separate, and credentials stay in memory. The probe has a 60-second deadline and a three-turn limit; neither changes the real task's action budget or its normal review limit. It must return a parsed assertion PASS citing the freshly generated fixture identity and leave fixture contents unchanged.

A new successful probe records AVAILABLE; failure records its unavailable status and `REVIEWER_PROBE_FAILED`. Raw provider errors/prompts are not copied into the event. `REVIEWER_HEALTH_REFRESHED` plus the previous health observation are persisted atomically in the workflow snapshot; prior task/failed review events remain intact. Only provider-health and append-only audit projections change. Generation, task state/action, budget, contracts, continuation and retry receipt are unchanged. Concurrent resume/reconcile/refresh cannot acquire the same session/workspace locks.

The response reports probe identity, timestamp, requested model and response-metadata model when available. GET `/api/status` exposes the safe current health summary and any pending retry receipt, allowing an operator to inspect an ambiguous response before another action. Initialization and configuration preflight are not successful model probes and do not clear persisted DEGRADED. Existing Runtime AI Repair & Resume retains its behavior; this separate operation never calls it or dispatches workflow REVIEW/EXECUTE.
