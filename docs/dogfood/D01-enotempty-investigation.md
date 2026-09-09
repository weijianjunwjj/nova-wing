# D01 Windows ENOTEMPTY investigation

## Root-cause classification (revised)

Best-supported classification: `WINDOWS_FILESYSTEM_OR_JUNCTION_BEHAVIOR`.

This is a **best-supported classification, not a proven root cause**. The affected
test was the only inspected Codex executor case that deliberately creates a Windows
directory junction inside a temporary repository; its original teardown left
`src/junction` nested below the directory passed to recursive `rm`. The reported
intermittent `ENOTEMPTY` occurs at the Windows recursive-removal boundary that must
classify and remove the nested reparse point. As of this revision **no failure has
been reproduced**: the previously observed intermittent symptom is not observed in
any attempt below, so the causal link remains the best-supported hypothesis rather
than a demonstrated fact.

The production-call-path evidence that supports this classification is unchanged:

- `codexTestRepo()` creates `%TEMP%\novawing-codex-*`, initializes Git synchronously, and returns the root.
- The scoped-workspace test creates `outside`, then creates `src/junction` targeting that directory.
- That test does not start an MCP listener or a Codex child process. It calls `tools.revoke()`, which sets the tool host closed and awaits its serialized operation queue.
- The old `finally` called `rm(root, { recursive: true, force: true })` while the junction was still nested.
- Production `CodexExecutor.preflight()` and `CodexExecutor.run()` await `bridge.close()`; `CodexWorkspaceTools.listen().close()` revokes the queue, closes transports, and closes server connections. Neither production path creates or recursively removes the supplied workspace root.

## Reproduction evidence (2026-09-09 automated certification)

Deterministic commands were executed in this repository state. The affected test was
run **10 consecutive times**; no `ENOTEMPTY` (and no failure of any kind) occurred.
Because the original symptom could not be reproduced, the classification above is
reported as best-supported rather than confirmed.

| Purpose | Command | Samples | Pass | Fail | Status |
| --- | --- | ---: | ---: | ---: | --- |
| Affected test (built once) | `npm run build:tests` | 1 | 1 | 0 | Pass |
| Affected test (repeated) | `node --test dist-tests/tests/codex-executor.test.js` | 10 | 10 | 0 | Pass |
| Type correctness | `npm run typecheck` | 1 | 1 | 0 | Pass |
| Whitespace | `git diff --check` | 1 | 1 | 0 | Pass |
| Full suite | `npm test` | 1 | 1 (685/685 tests) | 0 | Pass |

No failure was reproduced across the 10 targeted runs or within the full-suite run
(685 tests). If `ENOTEMPTY` is observed in a future run, the full failing path and a
repeated-run sample are required before the classification may be upgraded to
confirmed or changed.

## Minimal repair

The junction-owning test now stores its junction path and removes that exact junction
before recursively removing the fixture root:

1. `rm(junction, { force: true })`
2. `rm(root, { recursive: true, force: true })`

This changes test teardown only. It adds no sleep or retry and catches no error.
`force` makes an absent junction harmless when setup fails early; an `ENOTEMPTY`,
permission error, or any other unexpected cleanup failure still rejects the test.
Production workspace cleanup and control-plane semantics are unchanged.
