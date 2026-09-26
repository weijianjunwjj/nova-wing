# NovaWing v0.5 Customer Mode — Phase 1 Spec

## Goal

Turn a customer's natural-language requirement into a traceable Development Plan v1 that can be reviewed, revised, and approved. Planning stops at approval. A future RuntimePlanCompiler may map approved planned tasks and acceptance outcomes into the existing Work Session runtime.

## Required behavior

- Capture the original input and structured RequirementClauses with provenance, priority and ambiguity.
- Produce analysis, product scope, roles, flows, architecture, task DAG, observable acceptance outcomes, risks, assumptions, and only genuine business questions.
- Preserve RequirementClause → PlannedTask → AcceptanceCriterion coverage. Every MUST clause has task and blocking acceptance coverage before approval readiness.
- Deterministically validate references, graph, acceptance, structure, and customer questions before READY_FOR_APPROVAL.
- Offer a simple Customer Mode entry, plan reading, revision, and approval while keeping Advanced Mode available.
- Record minimal durable planning state and redacted events; never store full prompts or responses in telemetry.
- Use Requirement 001 (single-merchant ordering and self-delivery) as the first benchmark.

## Hard boundaries and non-goals

- Customer planning models contain no executor, reviewer, model assignment, shell command, or runtime wiring.
- Do not start Existing Runtime from Phase 1 approval. Do not rewrite the Runtime, expand a generic permission framework, or build a large Desk UI.
- No merge, push, tag, release, unrelated repository edits, user-data deletion, or resumed Laya/JEV/scoped Node verifier work.
- No PlanSnapshot, PlanHash, or PlanChange system in Phase 1; reserve a future freeze field only.

## Definition of done

Requirement 001 produces structured analysis and a readable Development Plan v1; all MUST clauses have task and blocking acceptance coverage; the task graph and deterministic validator pass; customer questions follow policy; the user can revise and approve without executor calls; planning events use the redacted telemetry contract; project checks pass or baseline failures are evidenced.
