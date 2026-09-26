# NovaWing v0.5 Customer Mode — Phase 1 Status

## Current milestone

Complete — Phase 1 acceptance and self-review passed.

## Baseline

- Date: 2026-09-26, macOS.
- `git fetch origin`: PASS.
- Initial branch: `main`; initial worktree: clean.
- Initial `HEAD` and fetched `origin/main`: `b8edcf55ec1037abf759fc9f6cbab98b226992d0`.
- Created `feat/v0.5-customer-mode` directly from `origin/main`.
- No `CLAUDE.md` found. Repository `AGENTS.md` checked. Its Windows Obsidian path is unavailable on this host; current repository sources and documents govern implementation.
- Node 24 is available at `~/.nvm/versions/node/v24.21.0/bin/node`; shell default is Node 20.
- Baseline `npm run check` with Node 24: PASS (including TypeScript, Node tests, migration, exports, boundaries, platform and 193 desktop tests).

## Completed

- Authorized task and repository rules reviewed.
- Existing Launchpad is local HTTP HTML/JS; its Work Session create path starts the runtime. Customer Mode will use a separate planning route and service.
- M1 planning domain model and read-only model provider complete; `npm run typecheck` PASS.
- M2 validator checks MUST coverage, references, task DAG, orphan acceptance, observable outcomes, and customer question policy. Negative and positive planning tests PASS.
- M3 service persists versioned plans and redacted events. Requirement 001 real model sample: 22 MUST clauses, 8 tasks, 22 acceptance criteria, 100% task and blocking acceptance coverage, no customer questions; deterministic validation PASS after exact-source normalization.
- M4 Customer Mode entry, progress, full plan rendering, recent-plan recovery, revision, and approval are wired to the Launchpad planning API. HTTP tests prove no Work Session creation; live browser navigation, input, generation, and plan display verified. A bounded automatic regeneration now repairs validation failures before exposing a draft.
- M5 redacted `NovaWingEvent` and `ModelInvocation` contracts cover planning events, duration, optional token usage and cost. Event persistence excludes requirement text, prompts, responses and invalid model/provider identifiers. Plans persist separately under the NovaWing data root.
- Browser smoke: a real model generated a plan, revision produced v2, recent-plan reading worked, and an isolated plan passing the current validator was approved in the UI. Approval did not start a Work Session.

## Decisions

- Keep planning domain in a separate module; no runtime task wiring in its product contracts.
- Keep the existing Launchpad Advanced Mode.
- `DevelopmentPlan → future RuntimePlanCompiler → existing WorkSession` is the only intended execution bridge. Phase 1 neither implements nor invokes it.
- Requirement text and revision notes are durable plan data; telemetry stores only closed metadata and invocation aggregates.

## Current issues

- The deterministic validator cannot prove that a model found every implicit business requirement in arbitrary prose. The Requirement 001 benchmark explicitly checks the known MUST scope; other plans still require customer review.

## Tests

- Baseline `npm run check`: PASS.
- Planning focused tests: 8 PASS, including actual Requirement 001 model sample, negative gates, HTTP isolation, business-question blocking, telemetry redaction and revision/approval race.
- Final Node 24 `npm run check`: PASS (1200 Node tests, 193 Desktop tests, typecheck, unused, migration, exports, boundaries and platform). Baseline `npm run check` also passed before implementation.
- Live browser smoke: Customer entry, generation, revision, recent-plan reload and approval verified on isolated temporary planning data. Runtime creation was separately instrumented in HTTP tests and remained at zero calls.
- Final diff hygiene: Requirement 001 fixture EOF whitespace corrected; 8 focused tests rerun and PASS.

## Commits

- M0 baseline/docs: `67347f1`.
- M1 model/provider: `a5a01f7`.
- M2 validator: `5ef3d54`.
- M3 service/benchmark: `0f40d30`.
- M4 UI/API/tests: `69a22b6`.
- M5 telemetry/self-review: `6b28064`.
- M6 acceptance closeout: this status update.
- Fixture diff hygiene: follow-up closeout commit.

## Next

Request product review of the Requirement 001 plan and customer-question policy. Phase 2 can later define Plan Freeze and a separate RuntimePlanCompiler; no Runtime execution bridge is part of this phase.
