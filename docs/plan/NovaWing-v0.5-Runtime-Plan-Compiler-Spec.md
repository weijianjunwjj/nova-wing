# NovaWing v0.5 — Frozen Plan to existing Runtime

## Contract

Phase 3 reads one `verifyPlanSnapshot`-verified `PlanSnapshot`. Compilation never reads a mutable `DevelopmentPlan` and never creates a WorkSession. The frozen plan stays frozen. Delivery artifacts have their own lifecycle and live under the NovaWing data root's `delivery` directory.

`PlanSnapshot → DeliveryTargetBinding → CompiledRuntimePlan → RuntimeAdmission → explicit Start Delivery → existing WorkSession Runtime`.

The target binding records the canonical Git root and Git directory identity, exact HEAD, branch or detached state, clean/dirty state, platform, selection source and binding time. Paths and Git state are outside the frozen semantic hash. The binding ID is stable for the same snapshot and target Git state. `new_project` is represented but is not admitted in this phase. An existing repository must be clean and on the bound branch and commit before Start Delivery.

## Lossless mapping

Every PlannedTask becomes one RuntimeTaskBinding with title, complexity, requirement IDs, objective, outputs, dependencies, criterion IDs and assertion IDs. Every source AcceptanceAssertion receives one AcceptanceBinding for each owning task, including its exact observable behavior, expected outcome, expected evidence and effective blocking value. Full RequirementClause, AcceptanceCriterion and customer decision copies remain in the compiled plan. Admission recomputes the complete binding set against the verified snapshot and rejects missing, extra or changed task, requirement, criterion, assertion, decision or baseline facts. The WorkSession definition gives the Executor and Reviewer the frozen plan hash, relevant RequirementClause and AcceptanceCriterion content, customer decisions and exact blocking assertion IDs and outcomes. Tasks are sent to the existing Runtime in dependency order.

An assertion is `SUPPORTED` only when a trusted resolver supplies an exact verifier command accepted by the existing command policy and the existing verification planner resolves it in the target repository. A command is an evidence collection method; the assertion still names the customer behavior and outcome. The default resolver classifies UI and platform assertions as `REQUIRES_EXTERNAL_ENVIRONMENT` and other assertions as `UNSUPPORTED`, so Customer Mode cannot invent acceptance coverage. A trusted resolver can also declare `REQUIRES_HUMAN`. Blocking gaps produce `ADMISSION_BLOCKED`, not a compilation error. The existing scoped Node verifier is not restored.

For staged verification, `UNSUPPORTED` becomes `PROVISIONABLE` only when a trusted resolver supplies an exact assertion-scoped verifier blueprint. The blueprint fixes its provider and predicate; a loopback HTTP port may be filled in when the owned service starts. A list of future input names or a capability family alone is `UNRESOLVED` and blocks Start Delivery. Binding the eventual verifier must match the blueprint, and completion still requires observed evidence and independent review. This keeps write-driven business outcomes from being admitted on the strength of a read-only GET template with no setup or expected predicate.

All delivery tasks are HIGH risk in the existing V2 Runtime. Independent Reviewer output must include one evidence-backed verdict for each `AcceptanceAssertion` ID before a task-level PASS can satisfy the completion gate. Missing, duplicate, unexpected or failed assertion verdicts block PASS. Existing verification, repair, re-review and checkpoint mechanisms remain authoritative. The separate WorkSession binding and compiled task map connect a checkpoint's session/task IDs back to the frozen source.

## Identity and persistence

`runtimePlanHash` is SHA-256 over canonical semantic content: source snapshot and plan hash, target Git identity and baseline, compiler schema and implementation version, runtime policy version, task and acceptance mappings, requirements and customer decisions. Audit timestamps and randomly generated event IDs are excluded. Binding, compiled plan, admission result and WorkSession source binding are persisted as private local JSON artifacts. On read, hashes and source coverage are checked again; readiness rechecks the current target and capabilities without silently recompiling.

Start Delivery requires exact snapshot ID and plan hash, RuntimePlan ID/hash and target binding ID. It rechecks admission and claims a deterministic WorkSession ID with an exclusive persisted marker before calling the existing Launchpad WorkSession creation path. A duplicate completed request returns the same session. An interrupted `STARTING` claim refuses another creation until explicit reconciliation, avoiding duplicate execution. The trusted WorkSession configuration is persisted separately for the existing Runtime's restart path. The target baseline is checked before configuration creation and again just before the WorkSession controller starts.

## Customer and telemetry boundary

The frozen Customer page offers a project folder path, readiness check, plain-language blockers and an explicit Start Delivery button only when ready. The current local web surface has no safe cross-platform folder picker, so the path input is the bounded fallback; Desktop can later supply a picker through the same binding API. No model, Reviewer or shell options are shown to the customer. The server accepts the same local authenticated mutation token as planning writes.

Delivery telemetry emits only event name, snapshot ID, short RuntimePlan hash and bounded counts/duration. It never records target paths, raw requirements, customer answer text, prompts, responses, source code or secrets.

## Limits

The real Requirement 001 repository is not an execution fixture. This phase only compiles it in memory and reports admission. No general business verifier is inferred from `npm test`; a trusted exact assertion-to-verifier capability mapping must be supplied before a supported business plan can be ready. The web folder input and `new_project` target type need future product work. A final customer delivery acceptance gate and dashboard are outside this phase; task completion alone is not labeled customer delivery completion.
