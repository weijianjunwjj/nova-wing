# NovaWing v0.4.2 — Pre-Public IP Evidence Snapshot

This directory is the independent private evidence snapshot for the first public-bootstrap
candidate. It does not modify or supersede the frozen v0.4.1 snapshot.

## PRODUCT SOURCE

| Field | Value |
| --- | --- |
| Version | `0.4.2` |
| Product commit | `a712bd15a81004bb981e89b076c445bedce405f4` |
| Private source tag | `v0.4.2` |
| Tag state at snapshot commit | `NOT_CREATED` — policy creates the annotated tag only after Release Validate passes and this baseline is committed and pushed |
| Required tag target | `a712bd15a81004bb981e89b076c445bedce405f4` |
| Tag object SHA | `PENDING_POST_BASELINE_TAG_CREATION` |
| Tag signed state | `PENDING_POST_BASELINE_TAG_CREATION` |

The post-tag metadata is recorded after the baseline commit without moving or amending the
product commit. The tag must point to the product commit, never to a baseline-only commit.

## DESKTOP BUILD

| Field | Value |
| --- | --- |
| Run | `35951460301` |
| Result | `PASS` |
| Commit | `a712bd15a81004bb981e89b076c445bedce405f4` |
| Branch | `feat/v0.4.2-public-bootstrap` |
| Workflow | `Desktop Build` / `.github/workflows/desktop-build.yml` |
| Windows job | `PASS` |
| macOS job | `PASS` |
| macOS distribution-notice gate | `PASS` |

## RELEASE VALIDATION

| Field | Value |
| --- | --- |
| Run | `35955424307` |
| Result | `PASS` |
| Workflow commit | `a712bd15a81004bb981e89b076c445bedce405f4` |
| Requested tag | `v0.4.2` |
| Requested build run | `35951460301` |
| Mode | `validate` |
| Validate job | `PASS` |
| Publish job | `SKIPPED` |

## SNAPSHOT CONTEXT

| Field | Value |
| --- | --- |
| Baseline creation UTC | `2026-09-24T04:30:12Z` |
| Baseline creation local | `2026-09-24T12:30:12+0800` |
| Working branch | `feat/v0.4.2-public-bootstrap` |
| Working tree at snapshot start | `DIRTY` — only the version-driven release guard change was present; the product commit itself was clean and already pushed |
| Private repository | `weijianjunwjj/nova-wing`, `private=true` (GitHub API verified) |
| Public feed repository | `weijianjunwjj/nova-wing-releases`, `private=false` (GitHub API verified) |
| Public v0.4.2 release | `NOT PUBLISHED` (feed release count `0`) |
| v0.4.1 frozen milestone | tag object `ef218a8e71dbb735a0a826160cfb79a1c3be14b8`, target `9c5d0b97972f62e725a38cb853ffbda5ddb54455`; unchanged |

## GATE VERDICT

The shipped-content, secret, SBOM, notice, and third-party-license checks pass. The specific
mechanisms recorded as `candidate-1`, `candidate-2`, and `candidate-3` remain
`PATENT_DECISION_REQUIRED`; this engineering closure does not decide patent value or waive the
pre-publication window.

`CLIENT_REQUIRED_SECRET_CONFLICT` is recorded but does not block because the Owner has not
classified any listed client-required item as `KEEP_PRIVATE`. `EULA_STATUS=NOT_DEFINED` and
ordinary proprietary JavaScript are also non-blocking under the supplied gate policy.

Therefore:

```text
PUBLIC RELEASE = HUMAN_REQUIRED
blockingReasons = [PATENT_DECISION_REQUIRED]
```

## HANDLING

- Keep this directory only in the private source repository.
- Do not copy it into the app, installer, DMG, ZIP, public feed, release assets, or release notes.
- Do not change the frozen `2026-09-24-v0.4.1-pre-public/` directory.
- Do not publish while the gate is `HUMAN_REQUIRED`.
