# NovaWing v0.4.1 — Real-host Evidence

Recovered from existing reports and fixtures in this repository. No new paid Codex task was run
to produce this file, and no task id or checkpoint SHA was invented. Fields that could not be
recovered from existing evidence are marked `NOT RECOVERED`.

The real-host acceptance evidence available in this repository was produced during **v0.4.0**
Phase 4 (Windows) and Phase 5 (macOS) on branch `feat/v0.4-desktop`, dated 2026-09-22. The
v0.4.1 line is a CI/updater-release line on top of that runtime work; no separate v0.4.1
real-host acceptance campaign exists in this repository.

## 1. Windows v0.4 real-host acceptance

Source: [`docs/audit/NovaWing-v0.4.0-Phase-4-Manual-Acceptance.md`](../../../docs/audit/NovaWing-v0.4.0-Phase-4-Manual-Acceptance.md),
[`docs/audit/NovaWing-v0.4.0-Phase-4-Report.md`](../../../docs/audit/NovaWing-v0.4.0-Phase-4-Report.md),
fixture [`tests/fixtures/desktop-realhost-001.txt`](../../../tests/fixtures/desktop-realhost-001.txt).

| Field | Value |
| --- | --- |
| Date | 2026-09-22 |
| Branch | `feat/v0.4-desktop` |
| Verdict | `Phase 4 installed real-host manual acceptance: PASS` |
| Installer under test | `NovaWing Setup 0.4.0.exe` |
| Installer size | 218,047,037 bytes |
| Installer SHA256 | `09f830ba3d99ad10b29a59052e87659bc0a65c2b59e2d608b6b99b40e9808445` |
| Real host | Windows x64, installed build, launched from Start Menu |
| Real task id | `DESKTOP-REALHOST-001` |
| Real task session | `C:\Users\Administrator\AppData\Local\NovaWingAcceptance\desktop-realhost-20260921-151419` |
| Checkpoint SHA | `NOT RECOVERED` (the Phase 4 manual acceptance records the installer identity and the task id, not a checkpoint commit SHA for this task) |

Confirmed MANUAL / REAL-HOST PASS items: install + Start Menu launch; Tray; close→hide→background
runtime; packaged Codex; Git discovery; packaged SQLite/`node:sqlite` smoke; **Windows Native Toast
displayed for real**; Quick Fill allowed-path parsing (Chinese/English, bullets, commas, 顿号,
backticks), ambiguous-permission fail-closed, partial-parse non-overwrite; acceptance/verification
binding; window wake-from-notification white-screen recovery.

These are v0.4.0 artifacts. The v0.4.1 Windows artifact audited by this gate is a different
(uploader/updater-line) build; see `04-release-artifact-manifest.md`.

## 2. macOS real-host acceptance

Source: [`docs/audit/NovaWing-v0.4.0-Phase-5-Report.md`](../../../docs/audit/NovaWing-v0.4.0-Phase-5-Report.md).

| Field | Value |
| --- | --- |
| Date | 2026-09-22 |
| Branch | `feat/v0.4-desktop` |
| Verdict | `Phase 5 — macOS Package & Real-host: PASS WITH SIGNING LIMITATION` |
| Platform | macOS 14.3 (Build 23D2057), arm64 |
| Product version | 0.4.0 |
| Real task id | `MAC-REALHOST-002` |
| Session | `mac-realhost-001-202609221404-a4bec7` |
| Checkpoint SHA | `ce5ead2a957c03f56371a12cf0730e66a0e233ca` |
| Checkpoint content | only `src/sum.mjs` (+3) and `test/sum.test.mjs` (+16) |
| completionReason | `ALL_TASKS_COMPLETED` |
| humanRequired | none |
| failureReason | none |
| push | none (repo had no remote) |

Automated acceptance recorded as PASS: `MAC_FINDER_GIT`, `MAC_PACKAGED_CODEX_REALHOST`,
`MAC_REAL_CODEX_TASK`, `MAC_BACKGROUND_RUNTIME`, `MAC_POWER`, `MAC_CHECKPOINT`, `MAC_STRICT_QUIT`.

Human GUI acceptance recorded as PASS: `MAC_CLOSE_HIDE_SHOW`, `MAC_DOCK_ACTIVATE`,
`MAC_TRAY_VISIBLE`, `MAC_TRAY_HIDE_SHOW`, `WHITE_SCREEN: NOT_REPRODUCED`.

Limitations attached to the same report (must not be quoted without them):

```text
Developer ID signing:  NOT AVAILABLE
Notarization:          NOT PERFORMED
Native Notification:   NEEDS_SIGNED_VALIDATION
Gatekeeper:            REJECTED for unsigned/ad-hoc distribution artifact
```

Gatekeeper rejection of an unsigned/not-notarized artifact is recorded as expected behaviour, not
a runtime failure; the same artifact launched successfully from DMG, ZIP-extracted directory and
`/Applications` via Finder/LaunchServices.

## 3. Finder / cold-start real task

Covered by `MAC-REALHOST-002` above. The task was performed by the packaged app launched **from
Finder**, with no terminal shell environment, exercising the launchd-minimal GUI `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`) and therefore the POSIX toolchain resolver.

Real observed chain (from the Phase 5 report):

```text
Finder cold start
  → minimal GUI PATH
  → POSIX toolchain resolver
  → packaged Codex
  → EXECUTE → npm test → VERIFY PASS → Evidence → checkpoint → COMPLETED
```

A transient, non-blocking observation is also recorded in the source report: a missing-in-GUI-PATH
toolchain initially produced `bash: npm: command not found` / `verification exited with code 127`
until the resolver fix. It is retained here as recorded, not as a current defect claim.

## 4. `BUSINESS_DECISION` real task

Source: Phase 4 manual acceptance, section 4.

| Field | Value |
| --- | --- |
| Task id | `DESKTOP-BUSINESS-DECISION-004` |
| Session | `desktop-business-decision-001-202609220448-3f4d96` |
| Checkpoint SHA | `74324c695e18afa3040c38643a529661e3b7a787` |

Recorded real event chain:

```text
BUSINESS_DECISION
→ HUMAN_REQUIRED
→ Desktop notification
→ user input staging
→ submitHumanDecision
→ resume
→ autonomous diagnosis / recovery
→ Executor re-execution
→ git diff --check PASS
→ npm test PASS
→ checkpoint
→ COMPLETED
→ Desktop completion notification
```

## 5. DeepSeek independent reviewer real task

Source: Phase 4 manual acceptance, section 5.

| Field | Value |
| --- | --- |
| Task id | `DESKTOP-DEEPSEEK-REVIEW-003` |
| Session | `desktop-review-001-202609220836-7398d3` |
| Checkpoint SHA | `f414ac7dc0f55909432f70471d246c6b5aa66412` |

Recorded real event chain:

```text
Codex EXECUTE
→ VERIFY → git diff --check PASS → npm test PASS
→ CONTROLLER_DECIDED REVIEW → REVIEW_REQUIRED
→ REVIEW_STARTED   agent=deepseek-reviewer provider=deepseek
→ AGENT_DISPATCHED action=REVIEW agent=deepseek-reviewer provider=deepseek
→ REVIEW_PASSED
→ CONTROLLER_DECIDED action=COMPLETE reasonCode=COMPLETION_CRITERIA_SATISFIED
→ checkpoint → TASK_COMPLETED
→ SESSION_COMPLETED completionReason=ALL_TASKS_COMPLETED
→ Desktop COMPLETED notification
```

A related observed transient (section 7 of the same report), recorded as non-blocking:
`DESKTOP-DEEPSEEK-REVIEW-002` hit
`NO_OP_EXECUTION: Codex completed without workspace inspection; execution evidence is missing`
and failed closed at the EXECUTE stage. It never reached VERIFY/REVIEW. The next task in the same
session family (`-003`) completed fully. This is retained as recorded.

## 6. Real task id index (every id found in this repository)

| Task id | Where recorded | Checkpoint SHA |
| --- | --- | --- |
| `DESKTOP-REALHOST-001` | `tests/fixtures/desktop-realhost-001.txt`, Phase 4 | `NOT RECOVERED` |
| `DESKTOP-BUSINESS-DECISION-004` | Phase 4 manual acceptance §4 | `74324c695e18afa3040c38643a529661e3b7a787` |
| `DESKTOP-DEEPSEEK-REVIEW-002` | Phase 4 manual acceptance §7, Phase 4 report §9 | `NOT RECOVERED` (failed closed before checkpoint) |
| `DESKTOP-DEEPSEEK-REVIEW-003` | Phase 4 manual acceptance §5 | `f414ac7dc0f55909432f70471d246c6b5aa66412` |
| `MAC-REALHOST-002` | Phase 5 report §3 | `ce5ead2a957c03f56371a12cf0730e66a0e233ca` |

## 7. Explicit gaps

- **No v0.4.1-specific real-host acceptance run** exists in this repository. The real-host
  evidence above is v0.4.0.
- The Windows v0.4.1 installer has **no** real-host installation acceptance record.
- The macOS v0.4.1 artifacts have **no** real-host acceptance record.
- The stored local evidence directory `.tmp/realhost/` is **empty** (created 2026-09-22, no
  files), so no local real-host artifacts could be recovered from it.
- Per-installer evidence files referenced by the Phase 4 report
  (`artifacts/desktop/realhost-task.json`, `window-final-gates.json`,
  `quick-fill-final-gates.json`, `WINDOWS_PACKAGED_REALHOST.json`) are git-ignored build outputs
  and are **NOT RECOVERED** from this checkout.
