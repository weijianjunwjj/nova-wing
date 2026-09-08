# NovaWing v0.2 control-plane final architecture audit

Audit baseline: `5fd9c6a`, including the complete implementation introduced by
`a031495`, `1945bc4`, and `acd493d`. Scope: production control ownership,
correctness, recovery, evidence, provider handoff and existing execution safeguards.
No host integration, UI feature, provider-health subsystem or new event-log system.

## Authority matrix

| Concern | Authority |
| --- | --- |
| Task lifecycle facts | TaskStateV2 |
| Next action | TaskController.decide |
| Semantic completion | TaskController.decide through its internal completion gate |
| Recovery semantics | Repository reconciliation followed by TaskController.decide |
| Repository truth | Production Git inspection, realpath, strict worktree fingerprint and index diff |
| Verification evidence | Existing deterministic verifier through ExecutorRouter.retryVerification |
| Review evidence | Selected runtime identity checked by V2 runner; policy checked by controller |
| Approval evidence | Explicit runtime human-resume input bound to the persisted request |
| Provider routing | Existing ExecutorRouter and CodingExecutionStore |
| Transport and persistence | WorkSessionRuntime, Mastra snapshots, Git checkpoint infrastructure |

## Findings repaired

### HIGH

- Acceptance bindings were checked by count without proving criterion identity.
  Completion now requires unique, exact criterion coverage and every mapped verifier.
- Runtime wrote legacy result status/blockers/verification back into V2 state.
  V2 now persists the runner's canonical result without those legacy patches;
  conflicting legacy completed IDs are corrected as projections.
- Legacy task index could skip canonical tasks. V2 examines tasks from the start,
  validates persisted state and skips only already authorized, transported completion.
  Missing, malformed or mismatched state cannot be rebuilt from Guardian checkpoints.
- V2 transitions inside a runner call were not durable. Before-dispatch and
  after-result states now share the runtime's durable snapshot boundary.
- VERIFY could launch a coding turn. It now invokes the existing router/verifier
  retry port with the explicit required commands, without invoking the model.
  EXECUTE reports cannot mint completion evidence.
- Review checking omitted reviewed-file coverage and disagreed about implementer
  identity. Both decision and completion use the same identity/file policy;
  selected reviewer runtime must differ from implementer runtime. Dispatcher input
  objects are cloned so mutation cannot rewrite canonical policy or selected identity.
- Dispatcher approval was trusted, explicit criterion approval was ignored, and
  runtime suspension overwrote the request with a permanent blocker. Human approval
  now binds the persisted repository, branch, HEAD, workspace, risk and policy context.
  Repository drift prevents reuse, including after a real runtime restart.
- Post-action repository observations could silently bless changed repository identity
  or evidence produced across VERIFY/REVIEW writes. Such drift now suspends;
  observed permissions are checked independently of reported changed files.
- Workspace identity did not distinguish binary bytes or staged content and used
  display-quoted paths. V2 uses NUL-delimited paths, strict byte hashing, realpath and
  the staged binary diff; unreadable required content fails closed. V1 fingerprint
  behavior is retained by the default compatibility mode.
- Git push recovery could manufacture V2 completion from legacy transport state.
  It now requires persisted Controller-authorized completion before any recovery push.
  Git finalization also rechecks the exact V2 repository authorization before staging.

### MEDIUM

- User pause poisoned canonical lifecycle state and hard deadlines were ignored by
  the V2 action loop. Pause now preserves semantic state and deadlines stop new actions.
- Failed adapter output with passed evidence and empty blockers could advance.
  Failed actions without a deterministic repairable verification failure now block.
- Fresh executor adapters lacked the existing dirty-workspace continuation checkpoint.
  Production now supplies inspected repository facts to that existing port.
- Production Git inspection resolved on process exit before stdout necessarily drained;
  it now waits for stream closure.

## Final architecture questions

1. Production V2 runner: V2ControllerTaskRunner, selected in production.ts.
2. Next-action authority: TaskController.decide.
3. Completion authority: that same controller gate; runtime verifies its authorization.
4. Recovery semantic authority: reconciliation plus that same controller.
5. TaskStateV2 is canonical; persisted JSON and trusted task policy are validated.
6. Legacy runtime owns session transport, timing, persistence and Git lifecycle only.
7. completedTaskIds cannot override a blocked/missing canonical task.
8. Guardian checkpoints cannot create or advance V2 semantic state.
9. Execution success and reports cannot replace explicit current verification evidence.
10. HIGH review requires trusted selected identity, distinct runtime and observed-file coverage.
11. CRITICAL approval is scoped to the persisted state and current policy context.
12. Codex quota handoff uses the production ExecutorRouter and CodingExecutionStore.
13. Acceptance evidence is criterion-specific, unique and explicitly configured.
14. Repository observations outrank reports; evidence drift and scope violations block.
15. Provider scoped tools, router writer leases, verifier approval, checkpoint gates,
    pause and process restart persistence remain in the execution path.

## Integration evidence and operational limits

Regression coverage exercises production runner selection, real Git inspection,
real SQLite-backed runtime restart, invalid/missing state, legacy index/completion
conflicts, human approval across restart, deterministic-only VERIFY, permissions,
review identity spoofing, canonical-input mutation, action-boundary persistence,
Codex-to-DeepSeek handoff/provider history, and authorized/unauthorized push recovery.
Provider calls are injected test doubles; this audit does not claim a live paid-model
quota-exhaustion experiment.

The default production agent profile intentionally has no independent reviewer.
HIGH work stops until a trusted independent reviewer/dispatcher is configured;
it cannot fall back to self-review. Missing acceptance configuration and externally
drifted repositories also stop for operator resolution. Old persisted evidence using
the previous fingerprint format fails closed rather than silently migrating proof.
These are explicit operational limits, not completion bypasses.

Verification command results are recorded in the task's final delivery report.
