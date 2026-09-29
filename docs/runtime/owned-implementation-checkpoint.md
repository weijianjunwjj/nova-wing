# Runtime implementation checkpoint handoff

An implementation checkpoint is a repository transition during VERIFY. It is not verification evidence, a completed Task, or customer acceptance. The frozen delivery baseline and RuntimePlan remain immutable; only the Controller's current trusted repository observation advances.

## Existing boundary

The Controller supplies a fresh dispatch identity and a host callback to the Delivery dispatcher for VERIFY. The checkpoint helper captures the expected complete Git tree from the action's observed HEAD plus the exact changed files' blobs and modes. It validates relative/legacy absolute task scopes, forbidden paths and linked-path restrictions, then performs the existing precise Git staging and commit.

The staged tree must match the captured content. After commit, repository identity and branch must match, the worktree must be clean, the commit must have exactly the observed HEAD as its sole parent, and its tree must equal the staged tree. Hooks that inject files/content, change branches or add commits fail closed; an ambiguous commit is retained for investigation, never reset or adopted.

Only this successful host path issues an in-process capability. A model-provided SHA, result field, copied JSON object, commit message or ancestor relation cannot issue or revive it. The Controller validates session, task, attempt (when present), dispatch, exact starting observation and independently inspected ending observation, and rechecks HEAD, branch, tree, content and scope before consuming the capability once.

Before any subsequent verifier runs, the Controller persists the accepted transition in `TaskStateV2.ownedCheckpoints` together with its current observation. Previous verification/completion projections are archived in the transition; current evidence, review and approval are invalidated. `IMPLEMENTATION_CHECKPOINT_ACCEPTED` records the transition in the Task event log. The adapter then passes the updated observation to existing blueprint/evidence machinery. The ordinary post-action drift check still runs against this observation.

No-op execution does not make an empty commit or issue a transition. Existing ALREADY_SATISFIED, Phase 6.1, exact blueprint review, evidenceId linkage, independent Runtime Review, external DEFERRED and Customer Delivery gates are unchanged.

## Failure and reopen

A verifier or reviewer failure after the handoff keeps the implementation commit and accepted transition. Reloading the normal WorkSession DB retains the trusted observation, preventing comparison against the obsolete pre-commit HEAD. A permitted VERIFY-only continuation checks the same clean commit and creates no duplicate checkpoint.

If commit succeeds but durable acknowledgement is interrupted, the prior observation remains authoritative. A descendant commit without an accepted transition is not auto-adopted; recovery remains fail-closed. The capability is deliberately not reconstructed from persisted JSON. Changed repository facts after acknowledgement are still rejected by the normal drift guard.

## Historical Requirement 001 session: assessment only

The historical generation-3 suspension has commit C and a consumed retry receipt, but predates this handoff and has no `ownedCheckpoints` record. Existing RECONCILE is a repository mismatch detector and human-required gate; it is not an operation that proves checkpoint ownership. Existing `VERIFY ONLY` can clear blockers and continue from an observed HEAD, but does not supply that missing ownership proof. It is not a validated recovery path for this incident.

Do not use retry-from-EXECUTE (which requires the original exact baseline), rewind C, reuse the consumed receipt, or manually edit state. Preserve the incident evidence and implementation commit C. Historical session recovery is no longer a prerequisite for validating the normal path, and no historical checkpoint-claim API is planned. After the normal path is validated, the default is an explicit successor execution with a recorded link to C as new, unaccepted input; it must pass its own verification and customer gates. This round does not open that successor or alter the historical session.

An offline 2026-09-29 reconstruction in a temporary clone checked out B (`4b0b9bf535d3aab909b67561d5a24953cf925a2e`), applied C's eight file changes as unstaged modifications, and left the index diff empty. The strict worktree fingerprint plus the empty index diff produced `bf9006f0a5b969a96d926bf48a2e95dec4303301a06fe6534ce335ad0295bc6d`, matching the archived EXECUTE fingerprint. This is a MATCH under those status/index assumptions and supports content equivalence; the original transient status and index were not independently captured, so it does not by itself prove historical ownership.

## Submitted review scope

The Runtime captures each Task's starting HEAD before it begins. Independent Review receives that Task base, the current review HEAD, and the actual `git diff --no-renames --name-only <task-base> <review-head> --` files, plus any current uncommitted files. Repeated implementation checkpoints remain within the same Task range; the preceding Task's commits are outside the next Task's range. `gitState.changedFiles` continues to describe only the current worktree. The review prompt gives the Reviewer the explicit base-to-head diff command, and ReviewEvidence records the same base/head and reviewed file scope. A genuine ALREADY_SATISFIED path may have an empty diff but still requires the existing assertion and evidence contracts.
