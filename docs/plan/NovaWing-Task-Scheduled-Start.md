# One-time Scheduled Start

Implemented 2026-08-31. Scope: one-time start plus a built-in DeepSeek Off-Peak preset; no recurring jobs or alternate runtime.

## Data and API

The existing Composer creates one Work Session containing an ordered Task batch. A single start-time choice gates that batch before its first Task; it does not independently reorder or schedule later Tasks.

`POST /api/session/create` accepts optional `scheduled_start_at` (ISO instant with explicit timezone, nullable) and `schedule_source` (`immediate`, `custom`, `deepseek_off_peak`). Omitted/null/past/due timestamps retain immediate execution. Invalid calendar dates or missing offsets return `400 INVALID_SCHEDULE`. Canonical request identity includes scheduling fields.

Trusted JSON configs persist `session.scheduledStartAt`, `session.scheduleSource`, and `session.createdAt` in the existing camelCase convention. Timestamps normalize to UTC. A future start creates an idempotent `work_session_scheduled_start` gate row in the existing isolated Work Session DB. No changes to NovaWing core's frozen `nw_*` tables/migrations.

Durable state and the control snapshot distinguish creation, scheduled start, actual workflow start and completion. Old snapshots lacking actual-start evidence display `—` rather than inventing a timestamp. `SCHEDULED` is a normal waiting state, never a Mastra suspension.

## Dispatch and recovery

- Before `runtime.start()` may enter its existing workflow, it checks the gate and atomically claims a due row using SQLite `BEGIN IMMEDIATE` plus a conditional update.
- The existing controller poll observes the persisted start time and invokes the same start path when due. Dependencies are checked at dispatch; pre-dispatch failures leave the gate intact and back off, without execution retries or timeout accounting.
- Launchpad startup reopens scheduled sessions. A lightweight five-second recovery sweep retries unavailable control-app setup. Existing interrupted, suspended and terminal workflows are not automatically replayed.
- Runtime state hydration prefers the existing workflow snapshot. Once a workflow exists, the scheduler never restarts it. Existing manual recovery remains responsible for execution interrupted after dispatch.
- Simultaneous poll/manual/open requests share in-process guards; multiple runtime instances additionally contend on the durable SQLite claim. A dead-process claim with no workflow snapshot may be reclaimed. Live owners are never evicted based on an elapsed lease.
- Waiting creates no Guardian, Executor, Reviewer invocation or execution ledger event. Active elapsed and hard deadlines begin only on actual workflow start.
- The existing stop-after-task control cancels a waiting gate atomically. Existing Launchpad deletion closes the waiting control app and removes only its trusted config, preserving existing deletion semantics.

NovaWing must be running to dispatch. Shutdown does not wake the machine; reopening starts overdue unstarted sessions. The gate is local-machine coordination, not a distributed scheduler. A recycled PID that appears live is conservatively treated as an owner rather than risking duplicate execution; this rare case requires operator inspection. A crash after workflow creation uses existing interrupted-run recovery, not scheduler replay.

## DeepSeek policy and UI

`schedule-policy.ts` contains the only pricing preset and pure `getDeepSeekPricingPeriod(now)` implementation. The same compiled function/config is served to the browser. `Intl.DateTimeFormat` explicitly uses `Asia/Shanghai`; host/browser timezone never defines peak windows. Weekdays `[09:00,12:00)` and `[14:00,18:00)` are peak; all remaining times and weekends are off-peak. Already off-peak resolves to immediate start. No runtime network dependency or price scraping.

Source: [DeepSeek official pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/), verified 2026-08-31. The preset does not select a provider, guarantee savings or stop execution when a peak window begins. Executor model labels are not reliable proof of a DeepSeek backend, so the UI makes no claim about the active provider.

Composer defaults to Immediate and reveals the local datetime picker only for Custom. The DeepSeek option refreshes locally and resolves again on submission. Lists show scheduled state, local planned time and source; detail shows all timestamps and cancellation. List refresh is every ten seconds; the control UI continues using existing SSE. Neither browser timers nor an open tab are required for execution.

Tests: `work-session-scheduled-start.test.ts`, `work-session-scheduled-recovery.test.ts`, and schedule additions to `work-session-launchpad.test.ts` cover boundaries, four host timezones, API compatibility/validation, waiting isolation, due dispatch, restart, cancellation, and concurrent ownership.

## Changed files

Under `packages/development-guardian/work-session/`:

- `model.ts`: additive schedule and actual timestamp contracts.
- `runtime.ts`: execution gate and separate actual start/completion timestamps.
- `scheduled-start-store.ts` (new): durable SQLite gate, claim and cancellation.
- `schedule-policy.ts` (new): shared DeepSeek preset and strict UTC normalization.
- `production.ts`: optional trusted config fields and production wiring.
- `recoverability.ts`: normal Scheduled display state.
- `control-ui/controller.ts`: due polling, dispatch guards and snapshot timestamps.
- `control-ui/events.ts`: schedule snapshot and cancellation event contracts.
- `control-ui/view.ts`: timestamps, Scheduled presentation and cancellation controls.
- `launchpad/server.ts`: creation validation, persistence and startup recovery.
- `launchpad/view.ts`: start-time choices and compact scheduled cards.

Tests and documentation:

- `tests/work-session-launchpad.test.ts`: API compatibility and validation coverage.
- `tests/work-session-scheduled-start.test.ts` (new): policy, runtime, concurrency and shutdown cases.
- `tests/work-session-scheduled-recovery.test.ts` (new): HTTP and restart end-to-end case.
- `tests/scheduled-start-fixture.ts` (new): isolated real-runtime UI fixture without model calls.
- `docs/plan/NovaWing-Task-Scheduled-Start.md` (new): this implementation handoff.

## Verification results (2026-08-31)

- Full regression: 564 tests passed, 0 failed, 0 skipped.
- Final Composer/production-wiring recheck: 43 passed, 0 failed.
- Build, typecheck, unused-symbol check, migration validation and repository boundaries passed.
- Browser smoke: Immediate default, Custom picker visibility/default, DeepSeek Beijing recommendation, Scheduled creation/detail, zero active time/Guardian events, cancellation and cancelled-state restart all verified with an isolated no-model fixture.
- `check:exports` still fails because its existing runtime-export whitelist is behind the repository's existing public exports. Reproduced with an unmodified `git archive HEAD` baseline; baseline and final export sets have the same mismatch. This task adds no public runtime exports and does not change that unrelated whitelist. Consequently the aggregate `npm run check` is not green despite the full regression passing.
- Existing Windows/libSQL temporary-database cleanup can emit EBUSY after close. New tests report this cleanup-only condition separately; functional assertions are not suppressed. Existing regression cases emitted the same cleanup warning.
