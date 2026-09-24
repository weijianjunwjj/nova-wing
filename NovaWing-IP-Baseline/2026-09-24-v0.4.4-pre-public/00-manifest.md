# NovaWing v0.4.4 — Pre-Public IP Evidence Snapshot

This independent snapshot records the exact v0.4.4 product commit and the CI-built release
candidate. It does not modify or supersede the frozen v0.4.1, v0.4.2, or v0.4.3 baselines.

## Product source

| Field | Value |
| --- | --- |
| Version | `0.4.4` |
| Product commit | `9ddbeedfb69b07323e256eaca9a284504e66c1e3` |
| Product branch | `feat/v0.4.4-update-e2e-target` |
| Branch base | `313bee70b5b2182bd18a94c4cb2ebf15895fc742` |
| Private source tag | `v0.4.4` |
| Tag state at initial snapshot | `NOT_CREATED` |
| Final tag state | `CREATED`, annotated, unsigned |
| Tag object | `5f09ae97d8cd8333dc3cb9b30ffa90140df341cf` |
| Required tag target | `9ddbeedfb69b07323e256eaca9a284504e66c1e3` |

The annotated private tag was created only after Desktop Build, Release Validate, and this
Pre-Public Gate passed. It peels to the product commit, never a baseline-only commit.

## Desktop Build

| Field | Value |
| --- | --- |
| Run | `36010798923` |
| Result | `PASS` (attempt 1) |
| Build commit | `9ddbeedfb69b07323e256eaca9a284504e66c1e3` |
| Windows job | `PASS` |
| macOS job | `PASS` |
| Windows installer | `NovaWing-Setup-0.4.4-x64.exe` |
| macOS artifacts | `NovaWing-0.4.4-arm64.dmg`, `NovaWing-0.4.4-arm64-mac.zip` |

## Snapshot context

| Field | Value |
| --- | --- |
| Created UTC | `2026-09-24T15:31:51Z` |
| Created local | `2026-09-24T23:31:51+08:00` |
| Source repository | `weijianjunwjj/nova-wing`, private |
| Feed repository | `weijianjunwjj/nova-wing-releases`, public |
| Public v0.4.4 state | `NOT_PUBLISHED` |
| Release Validate state | `PASS`, run `36021658632`; publish job `skipped` |
| Windows update E2E | `NOT_RUN`; installed public v0.4.3 intentionally preserved |

The validate-only workflow generated `release-manifest.json` with SHA-256
`0056b3ad0d4e16ef2e0b18f8725f0e79c0e5e0f1705af283b70fb396251e4b58`. It binds the release
candidate to Desktop Build `36010798923` and product commit
`9ddbeedfb69b07323e256eaca9a284504e66c1e3`.

## Patent history and gate verdict

`candidate-1`, `candidate-2`, and `candidate-3` were Owner-accepted and publicly disclosed with
v0.4.2. They are historical facts, not renewed first-disclosure blockers.

The v0.4.4 product delta is a version identity change plus one explicit-user-action notification
through the existing native Notification abstraction after the existing updater controller returns
a successful no-update result. No new previously undisclosed proprietary mechanism combination
meeting the established patent-decision threshold was identified.

```text
PREVIOUSLY_PUBLICLY_DISCLOSED = candidate-1, candidate-2, candidate-3
PATENT_DECISION_REQUIRED = NONE
PRE_PUBLIC_GATE = READY
```

Publication now requires an annotated private source tag that peels to the product commit and a
successful publish workflow.

## Handling

- Keep this directory only in the private source repository.
- Do not copy it into the app, installer, DMG, ZIP, public feed, or release notes.
- Do not alter any historical evidence snapshot.
