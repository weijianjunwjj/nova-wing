# NovaWing v0.1 vs v0.2 — Benchmark Report

- Date: 2026-09-08
- Branch: `feat/v0.2-benchmark-cleanup`
- Baseline commit: `648d11c` (feat(v0.2): add provider health and controller observability)
- Machine: Windows 11, Node `v24.x` (see `benchmark/results.json` environment)

## 1. What this benchmark measures (and does NOT)

This benchmark compares the **two control-plane execution paths** of NovaWing with an
**identical, deterministic scripted work provider**:

- **v0.1** — Guardian-centric legacy path: `runGuardianTask` (`GuardianTask` + scripted
  `GuardianBrain` + scripted `GuardianExecutor`). Completion requires the Reviewer to
  return `done` and the executor report to carry passing verification results.
- **v0.2** — TaskStateV2 + TaskController + `V2ControllerTaskRunner`. Completion requires
  the deterministic Evidence Gate: an explicit `VERIFY` action whose results satisfy every
  criterion-specific evidence binding, plus repo reality reconciliation.

Both paths consume the **same task**, the **same acceptance criteria / required evidence**,
the **same allowed/forbidden paths**, and the **same deterministic verification truth**
(each work attempt either passes or fails the required evidence).

> **Explicit scope limitation:** This is a *control-plane mechanics* benchmark. It does
> **not** run live LLM providers. Therefore `llmCallCount`, `tokenUsage`, `quotaUsage`,
> `providerExecutionDurationMs`, and any end-to-end speed/cost measured across providers are
> **UNAVAILABLE** in this environment. Live-provider execution requires Codex/DeepSeek
> credentials and quota that are not available here. Any KPI that depends on LLM quality is
> graded `INSUFFICIENT_DATA` or `UNAVAILABLE`, not fabricated.

## 2. Task set

- Frozen catalog: `benchmark/tasks.json` (schemaVersion 1, frozen 2026-09-08).
- Total tasks: **16**.
- Task sources are real NovaWing git-history refs (README/docs localization, type fixes,
  unit-test additions, bug fixes, multi-file feature, verification-fail→repair, refactor,
  permission enforcement, HIGH review, CRITICAL approval, Codex quota failover, repo drift,
  restart recovery, partial resume, build-failure repair, provider offline).
- Deterministic-executed subset: **9 tasks** (`T01…T08`, `T15`). The remaining 7
  (`T09…T14`, `T16`) are **not executable via a shared deterministic executor** because
  they are v0.2-only semantics (HIGH review / CRITICAL approval), or depend on live
  providers / real repo+restart conditions. Each carries a documented `notRunReason`.

## 3. Methodology

- Harness: `tests/benchmark/harness.ts` (runs `v0.1` and `v0.2` engines).
- CLI: `npm run benchmark:v1v2 -- --all` → writes `benchmark/results.json`.
- Isolation: each run is a fresh in-memory runner invocation over the same immutable task
  spec; no task mutates shared repo state. (Work is scripted; no temp repo files needed for
  this deterministic subset.)
- Provider health snapshot at run start is recorded (scripted `AVAILABLE`); no live quota
  variance applies.
- Repeatability: executions are deterministic (fixed scripted truth), so a single run per
  task/mode is the stable value; wall-clock is measured but is control-plane overhead only.

### First-pass success definition (rule-based)
A task is **first-pass** when it completes **and** `retryCount === 0`, i.e. it reached the
required evidence without any repair/fix cycle (`retryCount` = extra EXECUTE/execute
rounds after the first). No natural-language judgement is used.

## 4. Raw / aggregated metrics (9 executed tasks × 2 modes = 18 valid runs, 0 invalid)

| metric (mean)                      | v0.1 | v0.2 |
|------------------------------------|------|------|
| completionRate                     | 0.889 (8/9) | 0.889 (8/9) |
| firstPassRate (retryCount 0)       | 0.667 (6/9) | 0.667 (6/9) |
| controllerDecisionCount            | 2.11 (reviews) | 3.33 (decisions) |
| agentDispatchCount (work steps)    | 1.22 (executes) | 2.33 (EXECUTE+VERIFY dispatches) |
| verificationRunCount               | 1.22 (folded into execute) | 1.11 (explicit VERIFY) |
| verificationFailureCount           | 0.22 | 0.22 |
| retryCount                         | 0.22 | 0.22 |
| reviewCount                        | 2.11 (each brain round) | 0.00 (no HIGH tasks in subset) |
| taskEventCount (audit events)      | 8.67 (progress events) | 12.22 (decision log events) |
| providerSwitchCount / handoffCount | 0 / 0 | 0 / 0 |
| totalDurationMs (control-plane)    | 0.267 ms mean | 0.480 ms mean |

Full per-run metrics, min/median/max, deltas and verdict objects are in
`benchmark/results.json`.

The only non-completing task in the subset is `T08` (forbidden path): **both** paths refuse
to complete and enter `HUMAN_REQUIRED` — the permission gate holds in v0.1 and v0.2.

## 5. Interpretation

### 5.1 Where the two paths agree (deterministic subset)
On identical, honest scripted work, both control planes:
- complete the same task set;
- refuse the same forbidden-path task;
- require the same number of real repair steps (`retryCount` identical);
- report the same verification-failure rate.

This is expected: when the executor reports verification truthfully, both frameworks
converge. It also confirms v0.2 does **not** add spurious work steps on normal paths.

### 5.2 Where they differ structurally (by design)
- v0.2 runs an **explicit, separate VERIFY action** with a per-criterion evidence binding;
  v0.1 folds verification into the executor report and relies on the Reviewer verdict
  (`done`) to stop. v0.2 therefore emits more controller decisions (3.3 vs 2.1) and more
  audit events (12.2 vs 8.7) for the same effective work.
- v0.2 control-plane wall overhead is ~0.21 ms higher per task (mean). This is
  **sub-millisecond and not an end-to-end speed driver**; it is the price of the evidence
  gate, repo reconciliation and decision telemetry.
- v0.1 counts every brain round as a “review” (2.1); v0.2 only records `REVIEW_REQUIRED`
  for HIGH-risk review (0 in this subset).

### 5.3 Reliability / non-fabrication (structural, not measured by a deterministic run)
v0.1 can complete when the Reviewer says `done` and the executor report *claims* passing
verification; it has no independent second verifier and no criterion-scoped evidence store.
v0.2 cannot complete until a `VERIFY` action returns passing deterministic evidence bound to
every acceptance criterion, and until repo reality reconciles. This non-fabrication
guarantee is enforced by architecture and covered by dedicated tests
(risk-evidence / task-state-v2 / v2-controller-observability / v2-repository-reality),
not by a live-LLM sample.

## 6. KPI verdicts

Targets from the prior phase: **Speed +30%, Cost −30%, Handoff/rework −50%.**

| KPI | Delta (measured) | Verdict |
|-----|------------------|---------|
| Speed (end-to-end, live providers) | not measurable here | **INSUFFICIENT_DATA** |
| Cost (token/quota, live providers) | UNAVAILABLE | **UNAVAILABLE** |
| Handoff / unnecessary handoff | 0 switches in both; not exercised | **INSUFFICIENT_DATA** |
| Completion reliability | equal completion on honest work; v0.2 evidence gate structurally prevents false completion | **PARTIALLY_SUPPORTED** |

No KPI target is claimed to be met from this data. A live-provider benchmark with the same
frozen task set is required for a statistical Speed/Cost/Handoff verdict and is **explicitly
deferred** (requires provider credentials/quota).

## 7. Limitations

- Deterministic scripted work, not live LLM behaviour; LLM/token/quota metrics
  `UNAVAILABLE` (no fabrication).
- Sample size: 9 deterministic tasks × 2 modes. Not a statistical claim.
- Durations measure control-plane overhead only.
- v0.2-only semantics (HIGH review, CRITICAL approval) and provider/repo lifecycle tasks are
  not in the shared executed subset; they are covered by dedicated integration tests.
- The frozen catalog is committed for a future live-provider run.

## 8. Reproduction

```bash
npm run build:tests
npm run benchmark:v1v2 -- --all      # writes benchmark/results.json
node --test dist-tests/tests/benchmark-harness.test.js
```
