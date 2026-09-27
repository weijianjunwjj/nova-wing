# NovaWing v0.5 — Plan Freeze specification

## Boundary

Customer Mode owns planning facts. A customer approves one exact `planId` and `version`; approval immediately creates a frozen snapshot. Phase 2 does not compile Runtime plans, create Work Sessions, or call Executor or Runtime Reviewer. A future RuntimePlanCompiler must read a verified frozen snapshot, never a mutable DevelopmentPlan draft.

## Lifecycle

`draft → needs_customer_input → customer answers → revised draft → ready_for_approval → approval → frozen`.

`planning_failed` blocks approval. The deterministic validator and independent Planning Semantic Quality Gate run again for every revision. Blocking CustomerQuestions block approval. Customer answers are exact option selections against the current blocking questions and current plan version. They are persisted as customer decisions with question and selected option copies, before a new plan is generated. The new version carries those decisions and revision notes. The deterministic gate rejects a revision that only deletes answered questions and stores answers while leaving the substantive business planning contract unchanged. The independent semantic gate checks whether the actual decisions are correctly reflected in the new content. Both gates must pass and no blocking question may remain before approval.

Approval is an exact version operation. A stale version is rejected. Repeating approval of the current frozen version returns the same plan and snapshot. The approval record binds plan ID, version, customer actor, source, timestamp, and the exact content hash. The `approved` status is retained for legacy compatibility; the new service performs approval and freeze as one product operation and returns `frozen`.

## Snapshot and identity

The immutable snapshot copies the full planning contract: original requirement text, customer revision notes, requirement clauses and provenance, customer decisions, analysis, scope, architecture, tasks, dependency DAG, acceptance plan and assertions, risks, assumptions, questions, coverage, and passing semantic review. It records the source plan ID/version, approval, freeze time and optional predecessor snapshot ID.

Canonical schema version 1 uses SHA-256 over the domain prefix `novawing-plan-content-v1\0` and an explicit content projection. Object keys are sorted by Unicode code-unit order; array order is meaningful and retained. Optional undefined values are forbidden in canonical serialization. `createdAt`, `updatedAt`, `approvedAt`, `frozenAt`, answer timestamps, source answer version, provider usage and runtime metadata are audit context and do not enter semantic content identity. Full answer audit records live outside the canonical content; their semantic decision fields are copied into the content. The source plan ID/version and snapshot ID are also audit context. A changed task, assertion, dependency or customer decision changes the hash. Identical semantic content has the same hash across timestamps and source identifiers.

`verifyPlanSnapshot` validates the schema, recomputes the hash, checks approval ID/version/hash binding, verifies customer answer option provenance, runs the deterministic planning validator against the copied content, requires a passing semantic review and no blocking question, and checks the copied DAG against task dependencies. Frozen reads fail with an integrity error on mismatch. Hashing detects accidental or unauthorized content changes when the expected hash is preserved; it is not a signature against an attacker who can rewrite both content and hash.

## Persistence and change

Planning storage keeps the current plan, versioned plan records, versioned answer records, immutable snapshot files and change requests under the NovaWing data root. Snapshot creation uses an exclusive create and normal service operations cannot overwrite it. Old snapshots remain readable when a change request generates and freezes a successor. The successor names the snapshot it supersedes; version reads derive `superseded` for the predecessor without rewriting its artifact. A change request is required to revise a frozen plan. A pre-Phase-2 plan file continues to load; old ready plans that fail current gates are downgraded to `planning_failed` on read.

The Customer UI shows blocking questions and option controls, regenerates a new version after answers, and shows the frozen version, timestamp and short fingerprint. Full canonical JSON stays out of the Customer view. Planning telemetry records lifecycle events and safe IDs/counts without requirement, answer text, prompts, model responses or snapshot payloads.

## Limits

The snapshot is a local append-only product artifact, not a signed or remote notarized record. The per-process planning guard prevents concurrent operations in one service instance; a separate process writing the same data root is outside this Phase 2 contract. The change request path covers the minimal versioned happy path; detailed review and change-management UI belong to later product work. Requirement 001 real customer decisions remain unanswered. Fixture selections are test-only and are never written into real benchmark evidence.

## Phase 3 boundary

Only after a separate Phase 3 decision may a RuntimePlanCompiler consume a verified `PlanSnapshot`. Phase 2 creates no Work Session and leaves the existing Runtime unchanged.
