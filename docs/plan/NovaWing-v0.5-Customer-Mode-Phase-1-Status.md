# NovaWing v0.5 Customer Mode — Phase 1 Status

## Current milestone

M4 minimal Customer Mode UI and HTTP integration.

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

## Decisions

- Keep planning domain in a separate module; no runtime task wiring in its product contracts.
- Keep the existing Launchpad Advanced Mode.

## Current issues

- None.

## Tests

- Baseline `npm run check`: PASS.

## Commits

- M0 baseline/docs: `67347f1`.
- M1 model/provider: `a5a01f7`.
- M2 validator: `5ef3d54`.
- M3 service/benchmark: pending commit.

## Next

Verify Customer Mode UI, approval and revision in a browser, then complete telemetry and integrated checks.
