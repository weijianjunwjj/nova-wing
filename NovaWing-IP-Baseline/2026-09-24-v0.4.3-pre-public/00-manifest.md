# NovaWing v0.4.3 — Pre-Public IP Evidence Snapshot

This independent snapshot records the exact v0.4.3 product commit and the CI-built release
candidate. It does not modify or supersede the frozen v0.4.1 or v0.4.2 baselines.

## Product source

| Field | Value |
| --- | --- |
| Version | `0.4.3` |
| Product commit | `dab1aca91417ebdb1caa8d487daa49074d47f16e` |
| Product branch | `fix/v0.4.3-windows-tray-white-screen` |
| Private source tag | `v0.4.3` |
| Tag state at initial snapshot | `NOT_CREATED` |
| Required tag target | `dab1aca91417ebdb1caa8d487daa49074d47f16e` |

The annotated private tag is intentionally deferred until Desktop Build, Release Validate, and
this Pre-Public Gate all pass. It must target the product commit, never a baseline-only commit.

## Desktop Build

| Field | Value |
| --- | --- |
| Run | `35987215152` |
| Final result | `PASS` (attempt 2) |
| Build commit | `dab1aca91417ebdb1caa8d487daa49074d47f16e` |
| Windows job | `PASS` |
| macOS job | `PASS` |
| Windows installer | `NovaWing-Setup-0.4.3-x64.exe` |
| macOS artifacts | `NovaWing-0.4.3-arm64.dmg`, `NovaWing-0.4.3-arm64-mac.zip` |

Attempt 1 retained a macOS runner-native visibility race in packaged smoke. The failed job was
rerun without changing source; attempt 2 passed the same hide/show and close/show checks and all
distribution gates. The final workflow conclusion is `success` at the same immutable commit.

## Snapshot context

| Field | Value |
| --- | --- |
| Created UTC | `2026-09-24T11:22:33Z` |
| Created local | `2026-09-24T19:22:33+08:00` |
| Source repository | `weijianjunwjj/nova-wing`, private |
| Feed repository | `weijianjunwjj/nova-wing-releases`, public |
| Public v0.4.3 state | `NOT_PUBLISHED` |
| Release Validate state | `PASS`, run `35993337053`; publish job `skipped` |

The validate-only workflow generated `release-manifest.json` with SHA-256
`a55c8187e260d9a419aa8f8794c4d54420cd6dc33f412fd265e6940d9b9c8b42`. It binds the release
candidate to Desktop Build `35987215152` and product commit
`dab1aca91417ebdb1caa8d487daa49074d47f16e`.

## Patent history and gate verdict

`candidate-1`, `candidate-2`, and `candidate-3` were explicitly accepted for public disclosure by
the Owner and publicly disclosed with v0.4.2. They are historical facts, not renewed
pre-publication blockers for v0.4.3.

The v0.4.3 delta consists of standard Electron/Chromium presentation primitives
(`beginFrameSubscription`, `invalidate`, bounded retry), Tray presentation of the existing updater
controller, and downgrade/channel ordering. No new previously undisclosed proprietary mechanism
combination meeting the established patent-decision threshold was identified.

```text
PREVIOUSLY_PUBLICLY_DISCLOSED = candidate-1, candidate-2, candidate-3
PATENT_DECISION_REQUIRED = NONE
PUBLIC RELEASE = READY
```

## Handling

- Keep this directory only in the private source repository.
- Do not copy it into the app, installer, DMG, ZIP, public feed, or release notes.
- Do not alter the v0.4.1 or v0.4.2 evidence snapshots.
