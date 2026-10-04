# Four historical failures: before/after

Compared against specified main a827f91. Old blocked worktree was read only. All four protected tests pass in correction-focused.log and the final full-check.log. Core assertions and expected results unchanged.

## durable contributor T1 then T2 advances the Runtime DAG only after each proof survives reopen

```diff
--- main/tests/delivery-obligation.test.ts
+++ worktree/tests/delivery-obligation.test.ts
@@ -93,7 +93,7 @@
     assert.equal((await f.store.customerAssessment(f.plan.id)).status, 'CUSTOMER_DELIVERY_BLOCKED')
   } finally { await final.close() }
   const accepted = await f.store.recordExternalAcceptance(f.plan.id, {
-    assertionId: 'A1', kind: 'EXTERNAL', reviewerVerdict: 'PASS', reviewerIdentity: 'independent-browser-fixture',
+    assertionId: 'A1', kind: 'EXTERNAL', reviewerVerdict: 'PASS', acceptedBy: testOperator(),
     evidence: [{ kind: 'browser_trace', content: 'Opened the delivered app in a browser and observed the persisted order after restart.' }],
   })
   assert.equal(accepted.evidenceIds.length, 1)

```

## owned checkpoint local obligation binds exact reviewed blueprint and collected evidence to C

No test-body change.

## delivery vertical: T1 finalizes and persists, then reopened Runtime executes dependent deferred T2

No test-body change.

## completion transition rejects verifier substitution, missing artifact, and unreviewed evidence

```diff
--- main/tests/delivery-runtime-plan.test.ts
+++ worktree/tests/delivery-runtime-plan.test.ts
@@ -32,7 +32,7 @@
   assert.equal(observed.facts.observedMatch, true)
   const baseEvidence = { assertionId: 'A1', runtimeTaskId: 'T1', transitionId: transition.id,
     providerId: observed.providerId, collector: observed.collector, verificationStep: 'node --test tests/cart.test.js',
-    expectedOutcome: plan.acceptanceBindings[0]!.expectedOutcome, evidenceId: observed.id,
+    expectedOutcome: plan.acceptanceBindings[0]!.expectedOutcome, evidenceId: observed.id, executionId: observed.executionId,
     implementationCommit: commit, blueprintHash: approved.blueprintHash, artifactHashes: transition.artifactHashes,
     executed: true, observedMatch: true, reviewerVerdict: 'PASS' as const,
     reviewerEvidenceIds: [observed.id] }

```

## Other test adaptations

- Existing token headers become Cookie, and legitimate read/SSE clients bootstrap sessions. Negative requests remain unauthenticated.
- HTML/view tests remove secret bootstrap arguments; tests now assert secrets are absent.
- The old arbitrary saveCapabilityEvidence persistence test changes to assert that the public writer is absent and arbitrary evidence cannot be read back. This is the explicitly requested API removal, not one of the four protected core tests.
- Browser delete mock now carries a cookie obtained through the real /bootstrap endpoint. Its card removal / empty state assertions remain unchanged; it passes.
- Full changes are in implementation.patch; this correction round is separately reviewable in correction-only.patch.

## Addendum-1 correction adapters

- `tests/runtime-ui-view.test.ts`: raw legacy token-header expectations become `credentials ?? 'same-origin'` expectations. This is the Fetch default used for HttpOnly session cookies. Endpoint, method, task/generation/body, rendered controls and recovery-result assertions are unchanged. Real cookie authorization is tested separately via real HTTP, not claimed from the VM.
- `tests/v040-human-decision-control.test.ts`: legitimate POST helper adds its listener Origin; explicitly hostile Origin and unauthorized tests stay negative. All response codes and no-recovery assertions are unchanged.
- `tests/work-session-launchpad-strict-lifecycle.test.ts`: reuse the real bootstrap cookie obtained before shutdown. No bootstrap request is made during shutdown. All admission/drain/rejection assertions stay unchanged.
- `tests/work-session-strict-control-lifecycle.test.ts`: obtain cookie before registering the partial-request observer or beginning shutdown; add the exact listener Origin. The observer now observes the intended POST rather than the bootstrap GET. All 503 / stream / pending-close assertions remain unchanged.
- `tests/work-session-production-legacy-adoption.test.ts`: authenticated cookie + Origin allow the test to reach the missing adoption endpoint; its 404 and zero Runtime actions remain unchanged.
- `tests/work-session-scheduled-recovery.test.ts`: bootstrap the newly created Control listener before reading status. Scheduled/restart/dispatch assertions remain unchanged.
- `tests/delivery-obligation.test.ts`: restore the old DEFERRED ancestry regression verbatim except the test title; a fabricated nonexistent commit is rejected after reopen. No production ancestry change.
- `package.json`, `scripts/run-isolated-tests.mjs`, `tests/test-isolation.canary.mjs`: isolate default paths and Git identity for npm test and check:desktop; run canary before application tests, fail closed on canary failure.

The first isolated full run had 22 auth-pipeline failures. Its strict-control worker retained an unfinished fake Runtime after failure and was terminated (owned PID 16887) so the suite could finish; this is preserved in full-check-correction-baseline.log. The first corrective patch passed all 144 targeted regressions. No same failure required two unsuccessful repairs.

## Final desktop compatibility corrections

The first desktop run could not parse the bootstrap-redaction regex (164 pass / 1 file failure). Removing the invalid Unicode-regex quote escape let all tests load and exposed three distinct existing lifecycle regressions (190 pass / 3 fail): serialization removed undefined diagnostic fields, and non-bootstrap load errors lost their identity/message. The production correction preserves field topology and the original non-bootstrap errors while continuing to suppress bootstrap-bearing load errors. Existing desktop assertions are unchanged. A new real lifecycle-unit regression verifies bootstrap navigation, diagnostic redaction, and safe load errors; final desktop result is recorded in desktop-check.log.

The new test initially needed an explicit `error instanceof Error` narrowing for checkJs; check:unused passes after that typing fix. `scripts/check-platform-boundaries.mjs` registers only the new isolated test entrypoint with a rationale in its existing exact adapter allowlist; detection rules and test assertions are unchanged. Every distinct failure passed after its first targeted repair; later failures were different diagnostics, not repeated unsuccessful repairs of the same failure.
