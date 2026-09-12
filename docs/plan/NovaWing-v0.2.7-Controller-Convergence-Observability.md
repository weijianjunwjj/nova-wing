# NovaWing v0.2.7 — Controller Convergence + Execution Observability

## Scope

v0.2.7 fixes the controller convergence failure observed in REAL-002 without changing task-centric execution, repository-reality authority, independent review, Runtime Repair, AI Repair, or v0.2.5 analytics semantics.

## Verification failure semantics

Verifier failures are classified as `CODE_FAILURE`, `ENVIRONMENT_FAILURE`, `VERIFIER_CONFIGURATION_FAILURE`, `UNRELATED_TEST_FAILURE`, `EVIDENCE_MISSING`, or `UNKNOWN`. Structured verifier metadata takes precedence over extensible diagnostic-pattern mapping. A non-zero exit code alone is `UNKNOWN`, not proof of a code defect.

- `CODE_FAILURE` may return to implementation execution, subject to convergence controls.
- `ENVIRONMENT_FAILURE` suspends into the existing environment/runtime-recovery boundary.
- `VERIFIER_CONFIGURATION_FAILURE` suspends for verifier or contract repair.
- `UNRELATED_TEST_FAILURE` requires auditable failing-test identity, task relation, and pre-existing baseline evidence; otherwise classification fails safe to `UNKNOWN`.
- `EVIDENCE_MISSING` identifies missing proof and does not by itself imply that implementation code must change.

## Controller convergence

After a verification-driven `EXECUTE`, the controller compares Inspector-owned repository revision, task fingerprint, changed files, and newly added implementation evidence. A successful Executor response with no repository or evidence progress preserves the original failure context, emits `NO_IMPLEMENTATION_PROGRESS`, and suspends instead of clearing the failure and repeating verification.

Cycle detection stores a bounded history of controller decisions and repository-reality keys. It recognizes repeated decision cycles of length one through three after two complete cycles, but only when revision, fingerprint, semantic/evidence gaps, failing verifier, provider/runtime health, and related reality remain unchanged. Any real repository, evidence, semantic, or runtime-health change breaks the cycle key and protects normal retries.

## Action-budget recovery

The original action budget remains bounded. After `ACTION_BUDGET_EXHAUSTED`, one valid human decision may grant exactly one recovery budget of four actions. Original and recovery limits, consumption, exhaustion, and the grant are persisted and audited. A second grant is rejected; exhausting recovery is terminal for the session. The Launchpad only offers recovery while a grant is genuinely available.

## Execution observability

Launchpad projects three layers:

1. A continuously visible status layer with Executor state, controller phase, provider, elapsed time, last activity, and idle status.
2. A process-local, bounded Activity Feed of up to 30 allowlisted observable facts such as phase transitions, provider dispatch/completion, verifier activity, and repository changes.
3. The existing raw runtime log, retained behind a folded disclosure.

Heartbeat is computed when snapshots are read. It updates elapsed and idle presentation without appending durable events, modifying `TaskState`, or affecting analytics. Idle copy distinguishes normal activity under two minutes, quiet operation between two and five minutes, and longer waits after five minutes.

Activity entries are generated from typed runtime facts. Free-form detail and raw command output are not projected, and provider/verifier labels are allowlisted, preventing hidden reasoning, scratchpads, credentials, tokens, or other sensitive output from entering the feed.

## Audit and persistence

Verification classification, no implementation progress, cyclic no progress, original budget exhaustion, recovery grant, and recovery exhaustion use the existing durable task-event mechanism. Heartbeats and high-frequency runtime activity remain ephemeral. State additions are optional and backward-compatible, so v0.2.7 introduces no database migration.

## REAL-002 regression KPI

| Metric | REAL-002 old | v0.2.7 deterministic regression | Reduction |
| --- | ---: | ---: | ---: |
| Total actions | 20 | 2 | 90% |
| EXECUTE | 10 | 1 | 90% |
| VERIFY | 10 | 1 | 90% |
| Duplicate EXECUTE after implementation | 9 | 0 | 100% |
| Result | Budget exhausted / session failed | `ENVIRONMENT_FAILURE` → `ENVIRONMENT_REQUIRED` | Correct fail-safe routing |

The deterministic regression is intentionally not marked complete: it proves that a PostgreSQL connection refusal no longer causes implementation retries or consumes the full action budget.

## Certification

The v0.2 certification matrix now includes S70–S85 for failure classification, no-change execution, cyclic convergence, false-positive protection, recovery limits, Activity Feed, heartbeat, phase projection, and the canonical REAL-002 regression. The release criterion is 85/85 scenarios, 8/8 release gates, the full test suite, and `git diff --check` all passing.
