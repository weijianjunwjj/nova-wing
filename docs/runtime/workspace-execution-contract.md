# Workspace execution contract

The Codex workspace guard and post-execution scope guards compare **workspace-relative** paths. `.` is repository-root scope. Delivery's WorkSession definition now emits that root rule. At the guard boundary, legacy absolute configuration rules are converted relative to the trusted repository root; outside-root configuration fails closed. Persisted legacy task policy does not need to be rewritten for this conversion.

Operation arguments are always relative: `server/domain.js` is valid under root scope. Absolute operation paths, parent traversal, protected directories, linked paths and forbidden paths remain denied. Allowed and forbidden rules use the same conversion. Conversion of configuration is never applied to operation arguments.

## Execution outcomes

- `IMPLEMENTED`: the host observes legal changed files and no execution blocker.
- `ALREADY_SATISFIED`: no changed files, no mutation refusal, and an explicit final JSON declaration with a reason and file evidence. The host requires a successful `git_status`, successful reads of each cited file in this turn, exact nonempty quoted excerpts, and unchanged SHA-256 file contents. The durable execution event stores the reason and file hashes, not quoted file contents.
- `EXECUTION_BLOCKED`: a mutation was refused, execution failed, or zero-change completion lacks the explicit satisfied evidence.

No-op final response shape:

```json
{"outcome":"ALREADY_SATISFIED","reason":"Explain why the requested task needs no change","evidence":[{"path":"relative/file","quote":"Exact excerpt read this turn"}]}
```

Every mutation refusal is sticky for the turn, including scope errors, invalid arguments, unavailable file operations, ownership revocation and unsupported mutation tools. It is recorded before returning MCP `isError`, propagated as `EXECUTION_BLOCKED` in Executor blockers, and preserved in the V2 failure event. Earlier successful reads, later successful writes, or a model's satisfied declaration cannot erase it. No new mutation tools are exposed.

These are execution facts, not acceptance verdicts. Deterministic verification and independent review retain their existing gates. Completion-only EXTERNAL_DEFERRED does not acquire a local commit requirement.

## Existing Requirement 001 suspension

The observed real T1 is SUSPENDED at REVIEW after an independent reviewer runtime failure. Ordinary resume restores the persisted task; ALLOW REEXECUTE only removes a prohibition on re-execution; reviewer repair resumes REVIEW. None is an explicit retry-from-EXECUTE operation. The failed-executor checkpoint recovery API requires a failed workflow and a supported transient Executor transport failure, so it does not apply to this suspension. Interrupted-run recovery rejects a suspended workflow.

The formal recovery API is documented in [Task retry reconciliation](task-retry-reconciliation.md). It archives the invalid attempt, requeues the same task in the same WorkSession/run, proves the next decision is EXECUTE, and requires a separate receipt-bound resume. Ordinary resume retains its prior behavior.

The real Requirement 001 session has not been reconciled or resumed by this bugfix. Reviewer availability remains independent.
