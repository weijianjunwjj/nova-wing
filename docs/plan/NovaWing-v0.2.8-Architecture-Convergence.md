# NovaWing v0.2.8 Architecture Convergence

## Decision

NovaWing v0.2.8 converges the ordinary execution path to a fixed protocol while retaining the v0.2.7 Controller as an exception safety net. It does not create a second task engine: both paths use the same Task Contract, `TaskStateV2`, repository authority, evidence and completion gates, risk policy, event log, production runtime, analytics/notification projection, and Git checkpoint finalizer.

New Launchpad-created sessions enable Direct Path by default after the release criteria passed. Persisted configurations and API requests that omit `directPath.enabled` remain Controller-only for compatibility. Setting `directPath.enabled=false` is the kill switch.

```text
Task Contract
  -> Contract Preflight
  -> Verification Planner
  -> Risk / Permission / Reality fast gate
  -> START inspection
  -> sticky Executor (once)
  -> END inspection + plan validation
  -> minimal deterministic verification
  -> shared completion gate
  -> shared safe Git checkpoint
  -> COMPLETE

Any abnormal condition
  -> preserved TaskStateV2 + checkpoint + plan + evidence + provider history
  -> v0.2.7 Controller safety net
```

## Verification Planner

The Planner runs after structural preflight and before any Executor dispatch. Preflight continues to own schema, path, command allowlist, permission, approval, and contract-shape checks. The Planner owns relevance and sufficiency.

Inputs are optional where repository facts are unavailable: task goal, acceptance criteria, constraints, allowed/forbidden paths, explicit bindings, declared risk, repository root, changed-area hints, package ownership, discovered manifests/scripts, existing source/test/fixture files, naming/proximity evidence, and known environment availability. Explicit bindings always win. Import-graph and historical-success ranking are not yet automatic inputs; neither is guessed.

`VerificationPlan` records a SHA-256 `planId`/fingerprint, AC-to-evidence mappings, ordered commands and working directories, file/package/workspace/repository scope, reasons, expected coverage, prerequisites, expected failure classes, cost/confidence, approval requirement, escalation sequence, package roots, and invalidation conditions.

Selection is deterministic-first:

1. matching named targeted test or nearest existing test;
2. owning-package tests;
3. owning-package typecheck or lint;
4. repository patch-integrity check;
5. broader evidence only when explicitly bound or justified outside Direct Path.

There is no ungrounded root `npm test` fallback. If no local/package behavioral verifier exists, or a known prerequisite is unavailable, confidence is `INSUFFICIENT` and the task stops as `PLANNING_REQUIRED` before execution. REAL-002/003 fixtures therefore choose the `apps/web` targeted test, package typecheck, and `git diff --check`, not the PostgreSQL-dependent root suite.

After execution, changed paths, forbidden/allowed scope, package boundaries, risk expansion, and the stored fingerprint are checked. Any mismatch emits `PLAN_INVALIDATED`/`DIRECT_PATH_ESCALATED` and hands the same durable state to the Controller.

## Direct eligibility and protocol

Direct Path is fail-closed. Eligibility requires a valid mapped plan with sufficient confidence, LOW/MEDIUM risk, no approval/destructive/review requirement, sufficient permissions, consistent repository identity/branch/workspace, no pre-existing unowned dirty files, no known environment blocker, and one available coding+verification runtime. HIGH/CRITICAL work enters the Controller path; HIGH still requires independent review and CRITICAL retains approval policy.

The normal protocol selects the implementer once and keeps its runtime identity sticky. It performs exactly two repository boundary inspections inside the runner, one EXECUTE, one VERIFY phase using the planned deterministic commands, zero Controller decisions, zero review, and zero human decisions. Provider/runtime failures, drift, permission/scope expansion, failed verification, no progress, pause, review/approval needs, or checkpoint failure leave Direct Path.

## Resume and human constraints

| Failure | Resume target |
| --- | --- |
| `CODE_FAILURE` | `EXECUTE` |
| `ENVIRONMENT_FAILURE` | `VERIFY` after environment repair |
| `VERIFIER_CONFIGURATION_FAILURE` | `VERIFY` after verifier repair |
| `UNRELATED_TEST_FAILURE` | `COMPLETE_OR_VERIFY` with sufficient local evidence |
| `EVIDENCE_MISSING` | `COMPLETE_OR_VERIFY` |
| provider runtime failure during EXECUTE | retry/fail over `EXECUTE` |
| provider runtime failure during VERIFY | retry `VERIFY` |
| `UNKNOWN` | suspend for a decision |

`VERIFY ONLY` / `NO RE-EXECUTE` is persisted in `TaskStateV2.humanConstraints`. A later Controller decision cannot select EXECUTE until the user explicitly revokes that constraint.

## Completion and truthful projection

An unchanged repository is a valid `ALREADY_SATISFIED` outcome when every planned verifier passes and the shared completion gate accepts the evidence. The shared Git finalizer returns `ALREADY_SATISFIED`, skips commit, and does not manufacture a diff or report `GIT_COMMIT_FAILED`.

Route profile, eligible providers, selected runtime, and actual provider are distinct facts. `codex-or-deepseek` and `executor-router` remain debug/router metadata; user-facing provider projection begins only when a concrete runtime reports, for example `codex`. Reviewer UI stays `WAITING` after `REVIEW_REQUIRED` and becomes `REVIEWING` only after `REVIEW_STARTED`.

Explicit phase projection is: ANALYZE→PLANNING, EXECUTE→EXECUTING, VERIFY→VERIFYING, dispatched REVIEW→REVIEWING, pending REVIEW→WAITING, COMPLETE→FINALIZING, SUSPEND→WAITING, approval→WAITING_FOR_APPROVAL, and reconcile→RECONCILING. Unknown actions remain UNKNOWN. Direct Path publishes PLANNING, EXECUTING, VERIFYING, FINALIZING, and COMPLETED through the existing Activity Feed without model reasoning.

## Production-style A/B benchmark

The existing benchmark harness now runs categories A–H through the same V2 runner, state, event, dispatcher, repository, and verifier seams. Only the Direct flag changes. Provider answers are scripted so the comparison is deterministic; counters are derived from emitted events and invoked repository/verifier/state seams.

For simple A/B/C/H tasks in the 2026-09-13 run:

| Metric (mean) | Controller | Direct | Change |
| --- | ---: | ---: | ---: |
| completion rate | 100% | 100% | equal |
| first-pass rate | 100% | 100% | equal |
| Controller decisions | 3 | 0 | 100% reduction |
| agent/provider dispatches | 2 | 1 | 50% reduction |
| repository inspections | 5 | 2 | 60% reduction |
| Git processes attributed to inspections | 20 | 8 | 60% reduction |
| verifier processes | 2.5 | 2.5 | unchanged |
| state writes | 7 | 4 | 42.86% reduction |
| model/provider calls | 1 | 1 | unchanged |
| harness wall clock | 3.47 ms | 4.49 ms | 29.27% slower |

The microbenchmark does **not** prove lower wall-clock latency: filesystem planning dominates these millisecond scripted runs. It does prove the intended structural reduction without lowering completion or first-pass rate. The machine-readable source, including EXECUTE/VERIFY/REVIEW/human/failure-surface counters for every A–H run, is `benchmark/v028-results.json`.

Category D proves `CODE_FAILURE → Controller → repair EXECUTE → VERIFY → COMPLETE`. Category F proves explicit HIGH risk bypasses Direct and performs independent review. Categories G/H prove the REAL-002/003 planner regressions.

## Isolated dogfood

`npm run dogfood:v028` creates a temporary real Git repository with an intentionally failing root environment suite and a usable `apps/web` targeted test/typecheck. It runs the real Planner, Direct runner, verifier subprocesses, repository fingerprinting, completion authority, and Git finalizer. The implementer response is deterministically scripted, which is recorded rather than presented as a live-model run.

The accepted run completed with one model seam call, one EXECUTE, one VERIFY phase containing three real verifier processes, zero Controller decisions, zero review, zero human intervention, and a real `COMMITTED` checkpoint. The root suite was separately proven failing but was not selected by the Planner. Evidence is in `artifacts/v0.2.8-direct-dogfood.json`.

## Compatibility, retained safety, and limitations

The Controller-only baseline, reconciliation, failover, review, approval, preflight/AI repair, runtime repair, recovery/action budgets, no-progress/cycle detection, Human Required, analytics, notifications, and safe checkpoint remain intact. Legacy Launchpad/API payloads keep v0.2.7 missing-binding repair behavior; new UI payloads explicitly opt into Planner semantics.

No database migration or analytics schema migration was introduced. Existing zero-human, human-action, human-decision, and first-pass meanings remain event-derived; execution path, plan scope, escalation, decisions, inspections, and process counts are benchmark projections rather than a new persisted schema.

Known limitations:

- automatic import/dependency-graph and historical-evidence ranking are not implemented; explicit evidence remains authoritative;
- automatic script discovery currently targets `package.json` and invokes discovered scripts through npm;
- unknown environment availability is permitted and classified during VERIFY; only known-unavailable prerequisites stop planning;
- the deterministic A/B harness is production-shaped but not a live-provider latency benchmark;
- the Windows temporary SQLite `EBUSY` cleanup warning remains existing non-blocking debt when tests pass and no corruption occurs.
