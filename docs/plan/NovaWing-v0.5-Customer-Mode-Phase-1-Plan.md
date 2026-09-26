# NovaWing v0.5 Customer Mode — Phase 1 Plan

| Milestone | Scope | Acceptance | Validation |
| --- | --- | --- | --- |
| M0 | Baseline and architecture | Clean main, fetched origin, branch and durable docs | Git refs/status; baseline `npm run check` |
| M1 | Planning model and generation boundary | Requirement, analysis, plan structures contain no runtime wiring | Typecheck; domain tests |
| M2 | Coverage, DAG, acceptance, validator | Deterministic gate enforces every MUST clause and graph/reference integrity | Negative and positive validator tests |
| M3 | Requirement 001 benchmark | Full input yields reasonable scope, task and acceptance coverage | Benchmark test |
| M4 | Minimal Customer Mode | Input, progress, plan, revision and approval in Launchpad; Advanced Mode preserved | HTTP and browser smoke |
| M5 | Telemetry and persistence | Redacted planning events and durable plan state, no secrets | Persistence and telemetry tests |
| M6 | Integrated acceptance and review | Phase 1 DoD, runtime isolation, full check | `npm run check`; self-review |

Each milestone is committed after its validation passes. Phase 1 does not compile plans into Work Sessions.
