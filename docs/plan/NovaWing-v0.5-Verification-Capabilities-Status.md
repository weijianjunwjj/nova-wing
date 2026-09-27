# NovaWing v0.5 Phase 4 — verification capability status

## Contract

Capability schema version 1 defines nine families: `command`, `http_api`, `browser_ui`, `filesystem`, `git`, `process`, `desktop_ui`, `external_platform`, and `human`. Each registry entry states its provider ID/version, trust level, required inputs, target and environment needs, evidence type, deterministic character, availability and diagnostic reason. The independent resolver records a classification rule for each frozen AcceptanceAssertion binding. Classification identifies an evidence channel; it does not mean that a trusted verifier is bound or that the assertion passed.

The fixed trusted collection registry executes only bounded repository-scoped filesystem reads, read-only Git facts and loopback GET observations. Each produces an assertion-bound evidence ID, provider and collector identity, evidence type and observed facts. A bounded content read returns a digest and match fact, not raw file content. HTTP returns status, body length and digest, not response contents. The existing guarded Runtime remains the command execution provider. A command can mark a business assertion `SUPPORTED` only through an explicitly trusted resolver that names the exact assertion ID and a scoped `node --test` file accepted by the existing command policy and verification planner. A generic root test suite cannot establish business verification support. No assertion text is converted to shell or HTTP requests.

`browser_ui`, `desktop_ui`, `external_platform` and `human` have explicit contracts but no automatic delivery provider. A process contract exists, but its runtime-owned process harness is unavailable. Customer Mode blocks blocking human-only assertions. The local collectors are callable and their evidence can be persisted against an exact RuntimePlan. Filesystem, Git and HTTP observations cannot yet be automatically scheduled as delivery verifiers, so an assertion requiring one remains `UNSUPPORTED` until an exact trusted mapping and Runtime adapter exist.

The RuntimePlan hash binds capability schema, the stable registry contract fingerprint, classification rule, family, provider identity/version and exact verifier contract. Current provider availability is excluded from the semantic hash and is checked again at readiness. Readiness compares every binding with the current trusted resolver; policy drift requires a fresh compile from the same verified Frozen Snapshot. Evidence and admission times do not enter the hash. Persisted evidence is checked for content identity and RuntimePlan association on readback. Telemetry keeps its closed count/hash-prefix projection; neither paths nor HTTP response content are added.

For admitted delivery tasks, each Reviewer PASS now needs the planned family/provider/version, collector and actual passed verification step IDs, as well as a separate evidence-based judgment of the expected outcome. Missing, duplicate or mismatched IDs block completion. The collection result `OBSERVED` and HTTP 200 never independently become an assertion PASS.

## Requirement 001 read-only audit

The audit used frozen snapshot `080d2835-5f35-4311-acb5-7424b5a17607`, plan hash `bdacb10272bbf5512fd9e9d113796c75b1f600440a45e95924aaf664d18cec3a`, and the existing customer repository. It did not save a plan, change the target or create a WorkSession. RuntimePlan hash: `225c112c78ed5ecb01cfb509266a8c531921faf0a98cf66783d6cce2f4926d3a`.

| Measure | Phase 3 | Phase 4 |
| --- | ---: | ---: |
| Blocking assertion bindings | 141 | 141 |
| Classified family | 58 broad UI/platform, 83 unresolved | 141 / 141 |
| Trusted provider bound to assertion | 0 | 0 |
| Executable on current host for assertion | 0 | 0 |
| `SUPPORTED` | 0 | 0 |
| `UNSUPPORTED` | 83 | 78 |
| `REQUIRES_EXTERNAL_ENVIRONMENT` | 58 | 63 |
| `REQUIRES_HUMAN` | 0 | 0 |
| Unclassified family | 83 | 0 |

Phase 4 family distribution: `http_api` 56, `external_platform` 40, `browser_ui` 23, `filesystem` 19, `process` 3. The `http_api` integration classification is a proposed evidence channel; no endpoint or business predicate is inferred. Similarly, a file artifact classification is not proof that the artifact satisfies the customer outcome. The five bindings shifted from `UNSUPPORTED` to `REQUIRES_EXTERNAL_ENVIRONMENT` because their assertion text names a mini-program/platform interaction even though the enclosing criterion is broader.

`RUNTIME_ADMISSION = ADMISSION_BLOCKED`. All 141 bindings still lack an exact trusted assertion verifier. The target also has uncommitted changes. The one-shot audit deliberately marked Runtime, Executor and Reviewer availability unverified, so those three audit blockers are not claims about their live state. Real Start Delivery conditions are **not met**. The actual capability blockers are mini-program/external-platform interaction, browser interaction, missing explicit API or persisted-state contracts, artifact checks not yet wired to delivery, and a runtime-owned process harness. No real Requirement 001 delivery was started.
