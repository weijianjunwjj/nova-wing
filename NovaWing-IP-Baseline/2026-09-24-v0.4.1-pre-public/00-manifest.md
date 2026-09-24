# NovaWing v0.4.1 — Pre-Public IP Baseline Manifest

`NOVAWING_PRE_PUBLIC_IP_GATE` evidence snapshot.

| Field | Value |
| --- | --- |
| Baseline directory | `NovaWing-IP-Baseline/2026-09-24-v0.4.1-pre-public/` |
| Baseline created (UTC) | 2026-09-24T01:20:50Z |
| Baseline last revised (UTC) | 2026-09-24T02:52:06Z (gate semantics correction: see §6) |
| Working branch | `feat/v0.4.1-updater` |
| Working tree at snapshot start | clean apart from this change set — the new baseline directory (untracked) and the publish-job guard edit to `.github/workflows/desktop-release.yml` (see `01-repository-state.txt` section A) |
| Source repository | `weijianjunwjj/nova-wing` |
| Source repository private | **true** (machine-verified, `01-repository-state.txt` section H) |
| Feed repository | `weijianjunwjj/nova-wing-releases` |
| Feed repository public | **true** (machine-verified) |
| Public v0.4.1 Release published | **false** (0 releases in the feed repository, machine-verified) |

## 1. Three distinct identities — do not conflate

### 1.1 PRODUCT SOURCE

| Field | Value |
| --- | --- |
| Product version | `0.4.1` |
| Version authority | `desktop/main/identity.mjs` → `DESKTOP_IDENTITY.version = '0.4.1'` (the repository root `package.json` version is `0.1.0` and is intentionally independent) |
| Private source tag | `v0.4.1` |
| Tag object SHA | `ef218a8e71dbb735a0a826160cfb79a1c3be14b8` |
| Tag target SHA | `9c5d0b97972f62e725a38cb853ffbda5ddb54455` |
| Tag type | annotated |
| Tag signed | NO (unsigned annotated tag) |
| Tagger | `weijianjun <2661043132@qq.com>`, 2026-09-23T23:33:35+0800 |

### 1.2 DESKTOP BUILD

| Field | Value |
| --- | --- |
| Workflow | `Desktop Build` (`.github/workflows/desktop-build.yml`, workflow id 364351559) |
| Run ID | `35870473791` |
| Commit | `9c5d0b97972f62e725a38cb853ffbda5ddb54455` |
| Event | `workflow_dispatch` |
| Status | completed / **success** |
| Run started / updated | 2026-09-23T13:55:28Z / 2026-09-23T14:13:15Z |
| Requested tag / mode | `v0.4.1` / `validate` |
| Run URL | https://github.com/weijianjunwjj/nova-wing/actions/runs/35870473791 |

### 1.3 RELEASE VALIDATION

| Field | Value |
| --- | --- |
| Workflow | `Desktop Release` (`.github/workflows/desktop-release.yml`) |
| Run ID | `35881232734` |
| Workflow commit | `74ee7980695f899a665af45c25cffc3e2bcb486a` |
| Event | `workflow_dispatch` |
| Status | completed / **success** |
| Run started / updated | 2026-09-23T15:23:46Z / 2026-09-23T15:24:43Z |
| Mode | `validate` (validation only; no feed publication) |
| Run URL | https://github.com/weijianjunwjj/nova-wing/actions/runs/35881232734 |

The release validation run completed in 57 seconds because it is a **validate** run: it
verifies an already-built, already-validated set of artifacts and performs no compilation.

## 2. Honest timeline note on the source tag

The `v0.4.1` tag **already existed before this Pre-Public IP Gate was introduced**.

```text
2026-09-23T13:53:27Z  product commit 9c5d0b9 authored/committed
2026-09-23T13:55:28Z  Desktop Build run 35870473791 started
2026-09-23T14:13:15Z  Desktop Build run 35870473791 finished (success)
2026-09-23T15:23:46Z  Desktop Release validate run 35881232734 started
2026-09-23T15:24:43Z  Desktop Release validate run 35881232734 finished (success)
2026-09-23T15:33:35Z  annotated tag v0.4.1 created (tagger date 23:33:35+0800)
2026-09-24T01:20:50Z  this baseline snapshot created
```

The tag was created before the gate existed; the public binary has **not** been published.
This ordering is recorded as-is. No tag was deleted, moved, force-updated, recreated, or
re-pointed while producing this baseline, and no product history was rebased or amended.

## 3. Identity provenance chain

```text
private source tag v0.4.1  (ef218a8e…)
        └─ targets ─────────────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455

Desktop Build run 35870473791
        └─ head_sha ────────────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455
        └─ CI checkout ─────────► head_before == head_after == 9c5d0b9…, dirty_files 0/0

Desktop Release validate run 35881232734
        └─ head_sha ────────────► 74ee7980695f899a665af45c25cffc3e2bcb486a
        └─ buildRunId ──────────► 35870473791
        └─ buildCommitSha ──────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455

release manifest → build run → build commit → artifact package-content hashes
        (verified end-to-end in 04-release-artifact-manifest.md)
```

## 4. Contents of this baseline

| File | Purpose |
| --- | --- |
| `00-manifest.md` | This file. Identities, timestamps, timeline. |
| `01-repository-state.txt` | Machine-generated git/runtime/version/visibility evidence. |
| `02-v0.4.1-validation-evidence.md` | Windows + macOS validation evidence from runs 35870473791 / 35881232734. |
| `02-npm-run-check.txt` | `npm run check` result under the engine-required Node 24. |
| `03-real-host-evidence.md` | Recovered real-host acceptance evidence; `NOT RECOVERED` where absent. |
| `04-release-artifact-manifest.md` | Exact CI artifact inventory + independent hash verification. |
| `05-shipped-ip-inventory.md` | Shipped-content classification, mechanism audit, SOURCE→SHIPPED path map. |
| `06-pre-public-gate.json` | Machine-readable gate verdict. Read by the publish-job guard. |
| `sbom-shipped-windows.json` | CycloneDX 1.6 SBOM of the shipped Windows app (255 components). |
| `sbom-shipped-macos.json` | CycloneDX 1.6 SBOM of the shipped macOS app (255 components). |
| `gitleaks-macos-full.json` | Raw gitleaks 8.30.1 report over the extracted macOS payload. |
| `gitleaks-windows-full.json` | Raw gitleaks 8.30.1 report over the extracted Windows payload. |
| `SHA256SUMS.txt` | SHA256 of every evidence file in this directory (excluding itself). |

## 5. Publish-job guard

`.github/workflows/desktop-release.yml` gained one step, `Pre-public IP gate`, in the `publish`
job (step 4 of 13). It reads `06-pre-public-gate.json` from this repository at the workflow ref
and re-checks it against the exact build about to be published. It runs **before** the
confirmation check, before any artifact download, and before any feed upload. On any mismatch,
or if the gate file is missing or unparseable, it prints the stable marker

```text
PRE_PUBLIC_IP_GATE HUMAN_REQUIRED
```

and exits non-zero. `validate` mode is unaffected; the private source tag is unaffected.

Verified against this exact gate record: the guard **blocks** (exit 1), because
`thirdPartyLicenses` is `FAIL`, `publicRelease` is `HUMAN_REQUIRED`, `patentDecisionRequired` is
non-empty, and `blockingReasons` is non-empty.

The gate verdict at this baseline is `HUMAN_REQUIRED` with exactly two blocking reasons:

1. `PATENT_DECISION_REQUIRED` — candidate-1, candidate-2, candidate-3.
2. `THIRD_PARTY_LICENSES FAIL` — the macOS DMG/ZIP ship no Electron/Chromium license text.

`CLIENT_REQUIRED_SECRET_CONFLICT` is **recorded but is not a blocking reason**: it enters
`blockingReasons` only for an item the Owner has explicitly classified `KEEP_PRIVATE`, and no
such classification exists for v0.4.1. See `05-shipped-ip-inventory.md` §4 and
`06-pre-public-gate.json` (`clientRequiredSecretConflictBlocking: false`).

## 5. Handling rules for this directory

- This directory is **private evidence**. It is committed **only** to the private source
  repository `weijianjunwjj/nova-wing`.
- It must **not** be copied into any Desktop installer, DMG, ZIP, or app bundle.
- It must **not** be uploaded to the public feed repository, attached to a public Release,
  or included in public release notes.
- `05-shipped-ip-inventory.md` records a packaging check that confirms these files are
  absent from both shipped packages.
- Existing baselines and amendments were not modified by this snapshot.

## 6. Revision log

### 2026-09-24T02:52:06Z — gate semantics correction (Owner-directed)

`CLIENT_REQUIRED_SECRET_CONFLICT` was recorded but had also been listed as a third
`blockingReasons` entry. That was wrong. Applied rule:

> `CLIENT_REQUIRED_SECRET_CONFLICT` enters `blockingReasons` **only** for an item the Owner has
> explicitly classified `KEEP_PRIVATE`. No shipped v0.4.1 item carries such a classification.

Changes:

| File | Change |
| --- | --- |
| `06-pre-public-gate.json` | `blockingReasons` reduced to the two real blockers; added `clientRequiredSecretConflictBlocking: false` and `clientRequiredSecretConflictRule`; the conflict list is retained; the conflict moved into `nonBlockingObservations` |
| `05-shipped-ip-inventory.md` | §4 rewritten: the conflict is recorded, not blocking, and only becomes blocking on an explicit `KEEP_PRIVATE` classification |
| `00-manifest.md` | This section; verdict statement now names exactly two blocking reasons; working-tree wording corrected to match the regenerated snapshot |

`publicRelease` was **not** changed: it remains `HUMAN_REQUIRED`. The guard was **not** weakened —
it still fails closed on `thirdPartyLicenses`, `publicRelease`, `blockingReasons` and
`patentDecisionRequired`, re-verified after this correction.

Also corrected in this revision: the first generation of `01-repository-state.txt` had captured
a transient GitHub API SSL failure in section H and the staged-index state in section A.
Section H was regenerated with retries (now shows the verified visibility and release values with
zero `API_ERROR`), and section A now records the pre-commit working state.

Current verdict, unchanged in substance:

```text
validation           PASS
evidenceSnapshot     PASS
shippedIpAudit       PASS
secrets              PASS
thirdPartyLicenses   FAIL
publicRelease        HUMAN_REQUIRED
blockingReasons      [PATENT_DECISION_REQUIRED, THIRD_PARTY_LICENSES FAIL]
```
