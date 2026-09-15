# NovaWing v0.3.0 Verification Contract Evidence

This document records the sanitized evidence for the bounded v0.3.0 verification-contract repair. It is not a claim of global product stability.

## Code under test

- Branch: `feat/v0.3.0-golden-path-reset`
- Base commit: `7df8611978f3c33f1d250bcf46b31af78c77fe0b`
- Working-tree patch fingerprint used by the Launchpad build: `4d614c8782101d559d952cab384912b1737878d3`
- Build time: `2026-09-14T22:30:40.3163293+08:00`

## Real Launchpad smoke

- Session: `novawing-v030-contract-smoke-001-202609141434-a41ec6`
- Task: `REAL-006-V030-CONTRACT`
- Fixture branch: `feat/v030-contract-smoke`
- Initial fixture commit: `cd73c1f5b2255781ae5cd25d87f9b003bdd2c81d`
- Final checkpoint commit: `2a229d2d059b7f56fa61faf59fbe9c4c0806f2a6`
- Runtime: Codex, `gpt-5.6-sol`, high reasoning
- Result: `COMPLETED`
- Phase sequence: `PLANNING -> EXECUTING -> VERIFYING -> FINALIZING -> COMPLETED`
- EXECUTE count: 1
- VERIFY count: 1
- Controller decisions: 0
- Human Required: 0

The Executor changed only `apps/web/src/filter-empty.js`. Golden VERIFY then executed the persisted Verification Plan independently and the Session committed the verified change.

## Persisted verifier evidence

| Step | Command | Working directory | Admission | Result |
| --- | --- | --- | --- | --- |
| `verify-1` | `git diff --check` | `apps/web` | `ALLOWED` | `passed` |
| `targeted-test` | `node --test tests/filter-empty.test.js` | `apps/web` | `ALLOWED` | `passed` |
| `package-typecheck` | `npm run typecheck` | `apps/web` | `ALLOWED` | `passed` |
| `diff-check` | `git diff --check` | `.` | `ALLOWED` | `passed` |

The planner preserved `npm run test:filter-empty` as `originalCommand` and normalized it to the single existing package-local test file. The persisted source-script fingerprint was revalidated before execution. The root trap script was not used by Golden VERIFY.

## Scope of the conclusion

This smoke establishes the repaired planner/executor admission contract, step identity and working-directory transport, Golden result semantics, and production VERIFY execution for this bounded fixture. Final repository gates are recorded separately in the integration result; this document does not certify unrelated NovaWing behavior.

## Final repository validation

- Targeted contract, Golden, production, Direct/Controller compatibility, persistence, and recovery tests: `118/118` passed.
- Typecheck: passed.
- Unused-symbol check: passed.
- Package export check: passed.
- Architecture boundary check: passed.
- `git diff --check`: passed.
- First v0.2 certification run (`run-1789397023796`): failed (`99/111`, release gates `7/8`) and exposed a command-vs-step identity compatibility regression. The implementation was corrected so only Golden uses step identity; legacy Direct/Controller retains command identity.
- Final permitted v0.2 certification run (`run-1789398291130`): failed (`110/111`, release gates `7/8`). S01-S110 passed. S111 retained an outdated assertion requiring a repository-relative test argument instead of the repaired `cwd=apps/web` plus cwd-local path contract. Its embedded `npm test` failed for the same assertion.

No third certification run was attempted. The final snapshot is therefore a WIP audit checkpoint, not merge-ready, despite the real Golden smoke and targeted suite passing.
