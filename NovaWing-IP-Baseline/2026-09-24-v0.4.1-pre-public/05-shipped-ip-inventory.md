# NovaWing v0.4.1 — Shipped IP Inventory

Audit of the **actual shipped artifacts** of Desktop Build `35870473791`, not a grep of the
source tree.

Method: the three published containers were downloaded from the GitHub Actions artifacts API and
unpacked with standard OS tooling (`7zz` for the NSIS payload, `unzip` for the macOS ZIP,
`hdiutil` for the DMG). Every file list below was produced by walking the **extracted payloads**.
The CI's own `packaged-content-audit.json` / `macos-packaged-content-audit.json` were used only
as a cross-check, and the two agree exactly.

Classification vocabulary: `PUBLIC_OK`, `PATENT_DECISION_REQUIRED`, `KEEP_PRIVATE`,
`THIRD_PARTY`, plus the two conflict markers `CLIENT_REQUIRED_SECRET_CONFLICT` and
`WINDOWS_SHIPPED_CONTENT_AUDIT_INCOMPLETE`.

## 1. What is actually shipped

| | Windows `NovaWing-Setup-0.4.1-x64.exe` | macOS `NovaWing-0.4.1-arm64-mac.zip` / `.dmg` |
| --- | --- | --- |
| Packaged app root | `app/resources/app` | `NovaWing.app/Contents/Resources/app` |
| Total files in app tree | **5,511** | **5,510** |
| NovaWing-authored files | **143** | **143** |
| `node_modules` files | 5,368 | 5,367 |
| App-tree content SHA256 | `48419997…f83945` | `e097e7bd…86cc2e` |
| Independent recount | 5,511 (MATCH) | 5,510 (MATCH) |
| Independent content hash | MATCH | MATCH |

The one-file difference between the platforms is the target-specific libSQL native module
(`@libsql/win32-x64-msvc` vs `@libsql/darwin-arm64`); the NovaWing-authored set is identical on
both, which is expected because it comes from the same `dist/` build.

Additional container-level files:

| Platform | File | Classification | Note |
| --- | --- | --- | --- |
| Windows | `NovaWing.exe`, `*.dll`, `*.pak`, `*.bin` | THIRD_PARTY | Electron/Chromium runtime |
| Windows | `LICENSE.electron.txt` | THIRD_PARTY | Electron MIT license text |
| Windows | `LICENSES.chromium.html` | THIRD_PARTY | Chromium license text (20 MB) |
| Windows | `resources/app-update.yml` | PUBLIC_OK | points at the public feed |
| macOS | `Contents/Frameworks/Electron Framework.framework/…` | THIRD_PARTY | Electron/Chromium runtime |
| macOS | `Contents/Resources/app-update.yml` | PUBLIC_OK | points at the public feed |
| macOS | `Applications` symlink (DMG only) | PUBLIC_OK | DMG layout |

## 2. Source map / debug / test artifact audit (section H)

Run **independently** over both extracted payloads, and cross-checked against the CI file lists.

| Pattern | Windows | macOS | Expected | Verdict |
| --- | --- | --- | --- | --- |
| `*.map` | 0 | 0 | none | **PASS** |
| NovaWing-authored `*.ts` / `*.tsx` | 0 | 0 | none | **PASS** |
| NovaWing-authored `tests/`, `__tests__/`, `fixtures/`, `*.test.*`, `*.spec.*` | 0 | 0 | none | **PASS** |
| `*.pdb` | 0 | 0 | none | **PASS** |
| `.env*` | 0 | 0 | none | **PASS** |
| `*.pem`, `*.p12`, `id_rsa*`, `.npmrc`, `.netrc` | 0 | 0 | none | **PASS** |
| Private baseline (`NovaWing-IP-Baseline`, `pre-public-gate`) | 0 | 0 | none | **PASS** |
| Debug logs, database snapshots | 0 | 0 | none | **PASS** |

Third-party source files that are *not* debug leakage, recorded for completeness:

| Pattern | Count | All inside `node_modules`? | Classification |
| --- | --- | --- | --- |
| `*.ts` | 1,343 (Windows) | **yes** — e.g. `@ai-sdk/provider*/src/**/*.ts` | THIRD_PARTY (upstream publishes its own TS sources) |
| `*.spec.ts` / `spec/*.spec.js` | 21 | **yes** — `@posthog/core/src/**`, `json-schema-traverse/spec` | THIRD_PARTY |
| `*.md` (README/LICENSE/HISTORY) | 74 | **yes** | THIRD_PARTY |

No source map is present, so the question of whether a map would be acceptable "because the code
is minified" does not arise: NovaWing's own shipped code is unminified `tsc` output with no maps.

**Verdict: no debug or development artifact ships on either platform.**

## 3. Secret scan (section I)

Scanner: **gitleaks 8.30.1** (installed via Homebrew), default rule set. No hand-written regex
scanner was used and no content was uploaded to any third-party service. The scan stayed local.

The gitleaks default configuration exempts vendored paths such as `node_modules`. Because the
requirement is to scan the *actual shipped package*, the vendored directory in the scratch copy
was renamed so the same gitleaks rules would run over it too — stricter, not weaker. The scan
therefore covers the full 5,511 / 5,510-file trees, including `node_modules`.

| Target | Bytes scanned | Findings |
| --- | --- | --- |
| Extracted Windows app payload | ~46.76 MB | 3 |
| Extracted macOS app payload | ~46.75 MB | 3 |
| Windows feed files (`latest.yml`, `*.blockmap`, `installer.json`, `packaged-content-audit.json`) | ~351 KB | 0 |
| macOS feed files (`latest-mac.yml`, `*.blockmap`, `macos-distribution.json`) | scanned | 0 |

The three findings are identical on both platforms (same upstream files ship in both) and none
originates in NovaWing code:

| # | File | Rule | Detail | Classification |
| --- | --- | --- | --- | --- |
| 1 | `node_modules/@mastra/core/dist/telemetry/index.cjs` | generic-api-key | `POSTHOG_API_KEY = "phc_SBLpZVA…"` | THIRD_PARTY, public by design |
| 2 | `node_modules/@mastra/core/dist/telemetry/index.js` | generic-api-key | same value as #1 | THIRD_PARTY, public by design |
| 3 | `node_modules/dotenv/README-es.md` | private-key | `-----BEGIN RSA PRIVATE KEY-----` example in documentation | THIRD_PARTY, documentation sample |

Assessment:

- Findings 1–2 are a **PostHog project key** (`phc_` prefix) belonging to the **Mastra** npm
  package's own telemetry. `phc_` keys are PostHog *client-side ingestion* keys, published inside
  the publicly distributed `@mastra/core` package on npm. It is not a NovaWing credential, it is
  not a secret recovered from NovaWing, and it grants no access to NovaWing systems.
- Finding 3 is a truncated RSA key inside an es/README code fence — a documentation example.

**Zero NovaWing-origin secrets were found in either shipped package.** The three findings are
third-party, upstream-published, and are recorded here rather than silently discarded.

> Residual risk, stated plainly: findings 1–2 are the upstream package's telemetry key shipping
> inside NovaWing's binary. That is a decision about whether to ship `@mastra/core` telemetry at
> all — flagged in §7 — not a NovaWing secret leak.

## 4. `KEEP_PRIVATE` search (section L)

Searched the shipped content for material that would usually be kept as a trade secret: exact
thresholds, ranking rules, risk scoring, retry budgets, provider selection/routing heuristics,
proprietary prompts, recovery policy details, operational playbooks.

Found shipped (in NovaWing-authored `dist/` output):

| Item | Source path | Shipped path | Value / content |
| --- | --- | --- | --- |
| Recovery action budget | `packages/development-guardian/work-session/autonomous-diagnosis.ts` | `dist/packages/development-guardian/work-session/autonomous-diagnosis.js` | `RECOVERY_ACTION_BUDGET = 4` |
| Autonomous diagnosis system prompt | same | same | full instruction text, incl. authority vocabulary |
| Risk scoring rules | `packages/development-guardian/work-session/risk-evidence.ts` | `dist/packages/development-guardian/work-session/risk-evidence.js` | `assessRisk()` heuristics: `files.length >= 10`, `failed >= 2`, security×migration → CRITICAL, sensitive-path signals |
| Reviewer turn budget | `packages/development-guardian/work-session/reviewer-adapters.ts` | `dist/packages/development-guardian/work-session/reviewer-adapters.js` | `REVIEW_DEFAULT_MAX_TURNS = 40` |
| Brain review time budget | `packages/development-guardian/brain-review-budget.ts` | `dist/packages/development-guardian/brain-review-budget.js` | `DEFAULT_BRAIN_REVIEW_TOTAL_BUDGET_MS = 10 * 60 * 1000`, `MINIMUM_BRAIN_REVIEW_ATTEMPT_BUDGET_MS = 15 * 1000` |
| Deterministic verifier allowlist | `packages/development-guardian/verification-command-policy.ts` | `dist/packages/development-guardian/verification-command-policy.js` | exact allowed command set |
| Provider routing / failover | `packages/development-guardian/executor-router.ts` | `dist/packages/development-guardian/executor-router.js` | selection + failover rules |
| Checkpoint summary limit | `packages/development-guardian/work-session/git-checkpoint.ts` | `dist/packages/development-guardian/work-session/git-checkpoint.js` | `CHECKPOINT_SUMMARY_MAX_LENGTH = 80` |

Classification: **`CLIENT_REQUIRED_SECRET_CONFLICT`, not `KEEP_PRIVATE`.**

Rationale: NovaWing runs the Guardian, the verification planner, the risk assessment, the
recovery diagnosis and the reviewer budgets **on the user's own machine**. These values are
executed by the shipped client and cannot be removed from the binary without removing the
feature. None of them is a server-side-only secret and none of them is a stored credential.
They are therefore not `KEEP_PRIVATE` material that was accidentally packaged; they are
client-executed logic whose public exposure is inherent to the local-execution product design.

**Gate semantics for this classification (applied).** This conflict is **recorded but not
blocking**. `CLIENT_REQUIRED_SECRET_CONFLICT` enters `blockingReasons` **only** when a specific
item has been **explicitly classified `KEEP_PRIVATE` by the Owner**. No such classification
exists for v0.4.1, so this conflict does not appear in `blockingReasons`.

- If the Owner explicitly classifies any of these items as `KEEP_PRIVATE`, that item moves into
  `blockingReasons` and the release is blocked by it.
- Until such a classification is made, these ship as `CLIENT_REQUIRED_SECRET_CONFLICT` and do not
  block the gate on their own. The list is retained in the gate record precisely so that a later
  `KEEP_PRIVATE` decision takes effect without needing a new audit.

No `KEEP_PRIVATE`-and-actually-mis-packaged item was found: the private evidence tree
(`NovaWing-IP-Baseline/`), CI evidence, credentials, and server-side operational material are
**absent** from both packages (§2).

## 5. Core IP mechanism audit (section J)

Factual audit only. No patentability judgement, score, or recommendation is made here, and no
patent value is assessed.

### Candidate 1 — authoritative task facts → typed execution evidence → independent deterministic verification → evidence admission → evidence-bound finalization

- **MECHANISM**: The task carries an acceptance contract. Verification produces *typed* results
  (`VerificationResult` with `status`, `exitCode`, `failureClassification` ∈
  {`CODE_FAILURE`, `ENVIRONMENT_FAILURE`, `VERIFIER_CONFIGURATION_FAILURE`,
  `UNRELATED_TEST_FAILURE`, `UNKNOWN`}). Classification is evidence-derived, not exit-code-derived:
  the code explicitly asserts *"Exit code alone is never code evidence"* and falls back to
  `UNKNOWN`. Acceptance criteria are bound to required evidence, and completion is finalised only
  against admitted evidence. Runtime-owned evidence (`CHECKPOINT_COMMITTED`) is produced during
  finalisation and is deliberately kept out of both executor packets and shell verifiers.
- **SOURCE PATHS**: `packages/development-guardian/verification-evidence.ts`,
  `packages/development-guardian/work-session/completion-criteria.ts`,
  `packages/development-guardian/work-session/execution-ledger.ts`
- **SHIPPED PATHS**: `dist/packages/development-guardian/verification-evidence.js`,
  `dist/packages/development-guardian/work-session/completion-criteria.js`,
  `dist/packages/development-guardian/work-session/execution-ledger.js`
- **SHIPPED**: YES
- **EARLIEST REPOSITORY EVIDENCE**: `0a6f2cb` (2026-08-28) for the verifier-evidence module;
  `6beffd5` (2026-09-18) for runtime acceptance evidence; `2908871` (2026-08-24) for the ledger.
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: NONE_FOUND (see §6)
- **PRIOR_ART STATUS**: NOT_ASSESSED
- **STATUS**: `PATENT_DECISION_REQUIRED`

### Candidate 2 — persisted verification plan → scoped command/cwd admission → source/script fingerprint revalidation → independent verifier truth → completion gate

- **MECHANISM**: A verification plan is produced deterministically from repository facts
  (package manifests, existing test files, existing scripts), persisted with a content
  `fingerprint` (`sha256` over a canonicalised plan) and `planId`. Every step carries an
  `admission` status from a shared policy used by *both* planning and the guarded verifier.
  Admission is exact-match against a small allowlist or a provably-safe single `node --test`
  file. A named npm script is only auto-approved when it normalises to exactly one existing
  scoped `node --test` target with no `pre`/`post` lifecycle hooks, and its
  `sourceFingerprint` (sha256 of the script + its lifecycle hooks) is recorded. After execution
  the plan is revalidated against changed files, allowed/forbidden paths, package boundaries and
  risk-surface expansion; any mismatch invalidates the plan and escalates to the Controller.
  Step identity and command identity are kept distinct so a step id can never reach a shell.
- **SOURCE PATHS**: `packages/development-guardian/work-session/verification-planner.ts`,
  `packages/development-guardian/verification-command-policy.ts`,
  `packages/development-guardian/work-session/worktree-fingerprint.ts`,
  `packages/development-guardian/work-session/completion-criteria.ts`
- **SHIPPED PATHS**: `dist/packages/development-guardian/work-session/verification-planner.js`,
  `dist/packages/development-guardian/verification-command-policy.js`,
  `dist/packages/development-guardian/work-session/worktree-fingerprint.js`,
  `dist/packages/development-guardian/work-session/completion-criteria.js`
- **SHIPPED**: YES
- **EARLIEST REPOSITORY EVIDENCE**: `e2ea7a2` (2026-09-13, "引入 Verification Planner 与 Direct
  Path 核心"); command policy `38a125c` (2026-09-14); fingerprint `c4d16b2` (2026-08-21).
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: NONE_FOUND (see §6)
- **PRIOR_ART STATUS**: NOT_ASSESSED
- **STATUS**: `PATENT_DECISION_REQUIRED`

### Candidate 3 — bounded recovery → authority-preserving diagnosis → deterministic recovery admission → re-verification → fail-closed HUMAN_REQUIRED

- **MECHANISM**: After the bounded path fails, a diagnosis step proposes a structured recovery
  decision (`recoverable`, `strategy` ∈ {`FIX_IMPLEMENTATION`, `REVERIFY`, `REPLAN_VERIFICATION`,
  `NONE`}, `requiredAuthority[]`, `paths[]`, `commands[]`). The decision is admitted only by a
  deterministic validator which: rejects any decision requesting authority; re-checks proposed
  paths against the task's allowed/forbidden scope using the same scope-blocker used during
  execution; requires a concrete in-scope path for fix/replan strategies; and requires every
  proposed command to already exist in the admitted verification plan. Recovery is bounded by
  `RECOVERY_ACTION_BUDGET` shared with the Controller's own grant. An already-answered
  `BUSINESS_DECISION` can never be re-requested (explicit protocol-violation fail-closed), and a
  permission-class authority is never laundered through the business-decision input. Exhaustion
  stops with `ACTION_BUDGET_EXHAUSTED` and `HUMAN_REQUIRED`. Recovery evidence is read
  read-only with `--no-ext-diff --no-textconv`, escapes the repository fail closed, and rejects
  files over 256,000 bytes or containing NUL as requiring human inspection.
- **SOURCE PATHS**: `packages/development-guardian/work-session/autonomous-diagnosis.ts`,
  `packages/development-guardian/work-session/autonomous-recovery-evidence.ts`,
  `packages/development-guardian/work-session/golden-path.ts`
- **SHIPPED PATHS**: `dist/packages/development-guardian/work-session/autonomous-diagnosis.js`,
  `dist/packages/development-guardian/work-session/autonomous-recovery-evidence.js`,
  `dist/packages/development-guardian/work-session/golden-path.js`
- **SHIPPED**: YES
- **EARLIEST REPOSITORY EVIDENCE**: `b0f4e16` (2026-09-18, "repair brief parsing and bounded task
  recovery") for the diagnosis and recovery-evidence modules.
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: NONE_FOUND (see §6)
- **PRIOR_ART STATUS**: NOT_ASSESSED
- **STATUS**: `PATENT_DECISION_REQUIRED`

### Candidate 4 — cross harness/provider handoff → authority continuity → provenance preservation → evidence validity → task truth continuity

- **MECHANISM**: PARTIAL. The repository ships a provider-agnostic execution and review layer:
  an executor router that selects/routes between Codex, DeepSeek and Claude Code executors and
  fails over on quota exhaustion; a provider-agnostic review runtime with reviewer adapters; a
  structured delegate transport to an external `10x-chat` process over a JSON-lines protocol
  with request/response correlation, readiness handshake and timeouts. Provenance fields
  (`repositoryIdentity`, `branch`, `headSha`, `workspaceIdentity`, `timestamp`) are carried on
  evidence records. However, the *authority-continuity* and *task-truth-continuity* half of this
  candidate — a formal mechanism proving that switching harness/provider cannot widen authority
  or invalidate previously admitted evidence — was **not identified as a distinct, cohesive
  shipped mechanism** during this audit. What ships is provider routing plus a per-provider
  executor/reviewer, with provenance fields on evidence.
- **SOURCE PATHS**: `packages/development-guardian/executor-router.ts`,
  `packages/development-guardian/work-session/reviewer-adapters.ts`,
  `packages/development-guardian/delegate-transport.ts`,
  `packages/development-guardian/work-session/risk-evidence.ts`
- **SHIPPED PATHS**: `dist/packages/development-guardian/executor-router.js`,
  `dist/packages/development-guardian/work-session/reviewer-adapters.js`,
  `dist/packages/development-guardian/delegate-transport.js`,
  `dist/packages/development-guardian/work-session/risk-evidence.js`
- **SHIPPED**: PARTIAL
- **EARLIEST REPOSITORY EVIDENCE**: `4409273` (2026-08-31, "Codex local runtime with DeepSeek
  failover"); `556fc65` (2026-09-11, provider-agnostic production review runtime);
  `c1fec4e` (2026-08-18, 10x-chat JSONL transport).
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: NONE_FOUND (see §6)
- **PRIOR_ART STATUS**: NOT_ASSESSED
- **STATUS**: `PUBLIC_OK` (as currently shipped: provider routing + provenance-carrying evidence,
  without a distinct authority-continuity mechanism)

### Explicitly not treated as patent candidates

Per the audit brief, the following broad concepts were **not** escalated, even though they are
shipped and prominent: "agent orchestration", "multi-agent", "Reviewer", "checkpoint", "retry",
"Electron desktop", "updater", "Tray", "cross-platform". They are `PUBLIC_OK`.

## 6. Historical public disclosure check

| Channel | Result |
| --- | --- |
| Public feed repository `weijianjunwjj/nova-wing-releases` releases | **0** |
| Public feed repository tags | **0** |
| Private source repo release for tag `v0.4.1` | none (`404 Not Found`) |
| Public npm packages under scope `weijianjunwjj` | **0** |
| Public npm package `nova-wing` / `novawing` | **404 (absent)** |
| Source repository visibility | **private** (machine-verified) |

`KNOWN HISTORICAL PUBLIC DISCLOSURE` for every candidate is therefore **`NONE_FOUND`**.

Scope limitation, stated honestly: this checked the release channels reachable programmatically
(GitHub releases/tags on both repositories, public npm). It does **not** prove that no disclosure
occurred through other channels — private GitHub Packages consumption is governed by
`docs/adr/0003-private-github-packages-and-immutable-consumption.md`, and this audit did not
enumerate every historical consumer, blog post, demo, or third-party conversation. The field for
the pre-publication window is recorded as `NONE_FOUND`, not as `CONFIRMED_NO_DISCLOSURE`.

## 7. Third-party / SBOM / licenses (section M)

SBOM tool: **`@cyclonedx/cyclonedx-npm` 6.0.1** (CycloneDX), run against the shipped
`package.json` + `node_modules` of the extracted packages. Output: CycloneDX **1.6**, **255
components**, identical count on both platforms.

| Property | Result |
| --- | --- |
| Components | 255 |
| All 7 declared direct dependencies present | YES (`@mastra/core`, `@mastra/libsql`, `@modelcontextprotocol/sdk`, `@openai/codex-sdk`, `electron-updater`, `nodemailer`, `zod`) |
| Components with no license declaration | **0** |
| Copyleft licenses (GPL/AGPL/LGPL/MPL/EUPL/SSPL/CC-BY-SA…) | **0** |

License distribution across the 255 components:

| License | Count |
| --- | --- |
| MIT | 210 |
| Apache-2.0 | 19 |
| ISC | 13 |
| BSD-3-Clause | 5 |
| BlueOak-1.0.0 | 3 |
| BSD-2-Clause | 3 |
| MIT-0 | 1 |
| `(AFL-2.1 OR BSD-3-Clause)` | 1 (`json-schema`) |

### Obligation checks

| Obligation | Result |
| --- | --- |
| Copyleft redistribution obligation | **NONE** — no copyleft license in the shipped set |
| NOTICE obligation (Apache-2.0 §4(d)) | **NONE TRIGGERED** — 0 `NOTICE` files exist in the source `node_modules` for any shipped package, so §4(d)'s precondition (the upstream work includes a NOTICE file) is not met |
| License text inclusion | **SATISFIED on Windows, NOT SATISFIED on macOS** — see below |
| Binary redistribution conditions | Electron/Chromium covered on Windows only — see below |
| Dual-license with a permissive option | `json-schema` is `(AFL-2.1 OR BSD-3-Clause)`; the BSD-3-Clause option is permissive |

### Third-party license text inclusion — a real macOS gap

| Artifact | `LICENSE.electron.txt` | `LICENSES.chromium.html` |
| --- | --- | --- |
| Windows `NovaWing-Setup-0.4.1-x64.exe` payload | **present** (1,096 bytes) | **present** (20,472,830 bytes) |
| macOS `NovaWing-0.4.1-arm64-mac.zip` → `NovaWing.app` | **absent** | **absent** |
| macOS `NovaWing-0.4.1-arm64.dmg` → `NovaWing.app` | **absent** | **absent** |

Verified two ways: a `find` over the extracted ZIP app bundle, and a read-only `hdiutil` mount of
the DMG (both report 0 matches outside `Contents/Resources/app`). Electron is MIT and Chromium is
BSD-3-Clause; both require reproducing the copyright notice and license text in redistributions.
Windows reproduces them; **macOS does not**.

Consequence: `THIRD_PARTY_LICENSES` is **FAIL** for the macOS artifacts. This is a concrete,
verifiable packaging/compliance gap, not an inference. It does not affect the Windows artifact's
own packaging, but the release publishes all three files together.

`THIRD_PARTY_NOTICES` is **not defined** in this repository, so no notice document accompanies
the release on either platform.

### Additional third-party observation (not a license issue)

`@posthog/core` (PostHog analytics/telemetry SDK) is bundled and shipped inside both packages,
and `@mastra/core` ships a PostHog telemetry key (§3). Whether an analytics SDK should ship in
the desktop binary is a product/privacy decision recorded here for the Owner; it is not an IP
finding and is not counted as a gate failure.

## 8. Proprietary license / EULA (section N)

| Fact | Value |
| --- | --- |
| Root `package.json` `license` | `UNLICENSED` (machine-read) |
| Shipped app `package.json` `license` | `UNLICENSED` |
| `LICENSE` file at repository root | none |
| EULA / binary redistribution terms | none found |
| `EULA_STATUS` | **`NOT_DEFINED`** |

Per the audit brief this alone is **not** a blocker: the Owner has not defined that publishing
requires an EULA. It is recorded as an observed fact. No legal terms were authored by this audit.

The shipped `package.json` is not a verbatim copy of a repository file — it is synthesised at
packaging time by `scripts/platform/macos-package.mjs:122-123` and
`scripts/platform/windows-package.mjs:99` from the root manifest plus `DESKTOP_IDENTITY`.

## 9. Release notes audit (section O)

File: `release-notes.md` from release-validation run `35881232734` (the exact text that publish
would ship).

It contains: the source commit, the source run link, a file/size/SHA256 table, a
signing/notarization status section, a short "verified identity" section, and the limitation
list.

Checked for prohibited disclosure — **none present**:

| Prohibited content | Present? |
| --- | --- |
| Complete checkpoint schema | NO |
| Exact evidence-admission algorithm | NO |
| Risk score / threshold values | NO |
| Full recovery decision tree | NO |
| Complete verifier ranking | NO |
| Proprietary prompt / policy text | NO |
| State sequence sufficient to replicate the core mechanism | NO |

**Verdict: PASS.** The notes describe what shipped and how it is signed, not how the mechanism
works. No content was added to them by this audit — in particular, the shipped-IP inventory and
the mechanism analysis in this file were deliberately **not** propagated into the release notes.

## 10. Private-evidence containment (section T)

| Check | Result |
| --- | --- |
| `NovaWing-IP-Baseline/` present in either shipped package | **NO** (0 matches) |
| `06-pre-public-gate.json` present in either shipped package | **NO** |
| Baseline files in the release-validation artifact | **NO** |
| Baseline files in the publish asset set | **NO** — publish resolves exactly `*.exe`, `latest.yml`, `*.exe.blockmap`, `*.dmg`, `*.dmg.blockmap`, `*-mac.zip`, `*-mac.zip.blockmap`, `latest-mac.yml`, plus `release-manifest.json` and `release-notes.md` |
| Baseline in public release notes | **NO** (§9) |

## 11. SOURCE PATH → SHIPPED PATH map

Complete map for all 143 NovaWing-authored shipped files. Every mapped source path was verified
to exist in this checkout.

| SHIPPED PATH | SOURCE PATH | KIND | SOURCE EXISTS |
| --- | --- | --- | --- |
| `desktop/assets/app.ico` | `desktop/assets/app.ico` | verbatim | yes |
| `desktop/assets/tray.png` | `desktop/assets/tray.png` | verbatim | yes |
| `desktop/assets/trayTemplate.png` | `desktop/assets/trayTemplate.png` | verbatim | yes |
| `desktop/assets/trayTemplate@2x.png` | `desktop/assets/trayTemplate@2x.png` | verbatim | yes |
| `desktop/main/electron-updater-adapter.mjs` | `desktop/main/electron-updater-adapter.mjs` | verbatim | yes |
| `desktop/main/evidence.mjs` | `desktop/main/evidence.mjs` | verbatim | yes |
| `desktop/main/host.mjs` | `desktop/main/host.mjs` | verbatim | yes |
| `desktop/main/identity.mjs` | `desktop/main/identity.mjs` | verbatim | yes |
| `desktop/main/index.mjs` | `desktop/main/index.mjs` | verbatim | yes |
| `desktop/main/isolation.mjs` | `desktop/main/isolation.mjs` | verbatim | yes |
| `desktop/main/navigation.mjs` | `desktop/main/navigation.mjs` | verbatim | yes |
| `desktop/main/notifications.mjs` | `desktop/main/notifications.mjs` | verbatim | yes |
| `desktop/main/platform.mjs` | `desktop/main/platform.mjs` | verbatim | yes |
| `desktop/main/power.mjs` | `desktop/main/power.mjs` | verbatim | yes |
| `desktop/main/shutdown.mjs` | `desktop/main/shutdown.mjs` | verbatim | yes |
| `desktop/main/tray-icon.mjs` | `desktop/main/tray-icon.mjs` | verbatim | yes |
| `desktop/main/tray.mjs` | `desktop/main/tray.mjs` | verbatim | yes |
| `desktop/main/updater-lifecycle.mjs` | `desktop/main/updater-lifecycle.mjs` | verbatim | yes |
| `desktop/main/updater.mjs` | `desktop/main/updater.mjs` | verbatim | yes |
| `desktop/main/window-lifecycle.mjs` | `desktop/main/window-lifecycle.mjs` | verbatim | yes |
| `desktop/main/window.mjs` | `desktop/main/window.mjs` | verbatim | yes |
| `dist/packages/core/src/domain/errors.js` | `packages/core/src/domain/errors.ts` | compiled | yes |
| `dist/packages/core/src/domain/model.js` | `packages/core/src/domain/model.ts` | compiled | yes |
| `dist/packages/core/src/domain/validation.js` | `packages/core/src/domain/validation.ts` | compiled | yes |
| `dist/packages/core/src/facade.js` | `packages/core/src/facade.ts` | compiled | yes |
| `dist/packages/core/src/index.js` | `packages/core/src/index.ts` | compiled | yes |
| `dist/packages/core/src/ports/store.js` | `packages/core/src/ports/store.ts` | compiled | yes |
| `dist/packages/development-guardian/ask-bridge-brain.js` | `packages/development-guardian/ask-bridge-brain.ts` | compiled | yes |
| `dist/packages/development-guardian/brain-error.js` | `packages/development-guardian/brain-error.ts` | compiled | yes |
| `dist/packages/development-guardian/brain-review-budget.js` | `packages/development-guardian/brain-review-budget.ts` | compiled | yes |
| `dist/packages/development-guardian/claude-code-executor.js` | `packages/development-guardian/claude-code-executor.ts` | compiled | yes |
| `dist/packages/development-guardian/codex-error.js` | `packages/development-guardian/codex-error.ts` | compiled | yes |
| `dist/packages/development-guardian/codex-executor.js` | `packages/development-guardian/codex-executor.ts` | compiled | yes |
| `dist/packages/development-guardian/codex-runtime.js` | `packages/development-guardian/codex-runtime.ts` | compiled | yes |
| `dist/packages/development-guardian/codex-workspace-tools.js` | `packages/development-guardian/codex-workspace-tools.ts` | compiled | yes |
| `dist/packages/development-guardian/coding-executor-config.js` | `packages/development-guardian/coding-executor-config.ts` | compiled | yes |
| `dist/packages/development-guardian/deepseek-executor.js` | `packages/development-guardian/deepseek-executor.ts` | compiled | yes |
| `dist/packages/development-guardian/delegate-transport.js` | `packages/development-guardian/delegate-transport.ts` | compiled | yes |
| `dist/packages/development-guardian/executor-router.js` | `packages/development-guardian/executor-router.ts` | compiled | yes |
| `dist/packages/development-guardian/guardian.js` | `packages/development-guardian/guardian.ts` | compiled | yes |
| `dist/packages/development-guardian/index.js` | `packages/development-guardian/index.ts` | compiled | yes |
| `dist/packages/development-guardian/model.js` | `packages/development-guardian/model.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/browser.js` | `packages/development-guardian/platform/browser.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/codex-development-runtime.js` | `packages/development-guardian/platform/codex-development-runtime.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/codex-runtime.js` | `packages/development-guardian/platform/codex-runtime.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/environment.js` | `packages/development-guardian/platform/environment.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/executables.js` | `packages/development-guardian/platform/executables.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/paths.js` | `packages/development-guardian/platform/paths.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/posix-toolchain.js` | `packages/development-guardian/platform/posix-toolchain.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/process.js` | `packages/development-guardian/platform/process.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/secret-protection.js` | `packages/development-guardian/platform/secret-protection.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/shell.js` | `packages/development-guardian/platform/shell.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/windows-git.js` | `packages/development-guardian/platform/windows-git.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/windows-repair-notifier.js` | `packages/development-guardian/platform/windows-repair-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/windows-runtime-repair-notifier.js` | `packages/development-guardian/platform/windows-runtime-repair-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/platform/windows-task-run-notifier.js` | `packages/development-guardian/platform/windows-task-run-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/ports.js` | `packages/development-guardian/ports.ts` | compiled | yes |
| `dist/packages/development-guardian/progress.js` | `packages/development-guardian/progress.ts` | compiled | yes |
| `dist/packages/development-guardian/shell-contract.js` | `packages/development-guardian/shell-contract.ts` | compiled | yes |
| `dist/packages/development-guardian/tenx-chat-brain.js` | `packages/development-guardian/tenx-chat-brain.ts` | compiled | yes |
| `dist/packages/development-guardian/verification-command-policy.js` | `packages/development-guardian/verification-command-policy.ts` | compiled | yes |
| `dist/packages/development-guardian/verification-evidence.js` | `packages/development-guardian/verification-evidence.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/activity.js` | `packages/development-guardian/work-session/activity.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/autonomous-diagnosis.js` | `packages/development-guardian/work-session/autonomous-diagnosis.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/autonomous-recovery-evidence.js` | `packages/development-guardian/work-session/autonomous-recovery-evidence.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/checkpoint.js` | `packages/development-guardian/work-session/checkpoint.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/coding-execution-store.js` | `packages/development-guardian/work-session/coding-execution-store.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/completion-criteria.js` | `packages/development-guardian/work-session/completion-criteria.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/activity-projection.js` | `packages/development-guardian/work-session/control-ui/activity-projection.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/controller.js` | `packages/development-guardian/work-session/control-ui/controller.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/events.js` | `packages/development-guardian/work-session/control-ui/events.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/runtime-overview.js` | `packages/development-guardian/work-session/control-ui/runtime-overview.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/server.js` | `packages/development-guardian/work-session/control-ui/server.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/task-eta.js` | `packages/development-guardian/work-session/control-ui/task-eta.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/control-ui/view.js` | `packages/development-guardian/work-session/control-ui/view.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/controlled-quota-injection.js` | `packages/development-guardian/work-session/controlled-quota-injection.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/dependency-health.js` | `packages/development-guardian/work-session/dependency-health.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/direct-path.js` | `packages/development-guardian/work-session/direct-path.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/execution-ledger.js` | `packages/development-guardian/work-session/execution-ledger.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/failure-classification.js` | `packages/development-guardian/work-session/failure-classification.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/fake-task-runner.js` | `packages/development-guardian/work-session/fake-task-runner.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/git-checkpoint.js` | `packages/development-guardian/work-session/git-checkpoint.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/golden-path.js` | `packages/development-guardian/work-session/golden-path.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/guardian-task-runner.js` | `packages/development-guardian/work-session/guardian-task-runner.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/http-preconnections.js` | `packages/development-guardian/work-session/http-preconnections.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/index.js` | `packages/development-guardian/work-session/index.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/acceptance-criterion.js` | `packages/development-guardian/work-session/launchpad/acceptance-criterion.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/browser-launcher.js` | `packages/development-guardian/work-session/launchpad/browser-launcher.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/contract-preflight.js` | `packages/development-guardian/work-session/launchpad/contract-preflight.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair-agent-llm.js` | `packages/development-guardian/work-session/launchpad/repair-agent-llm.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair-agent.js` | `packages/development-guardian/work-session/launchpad/repair-agent.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair-audit.js` | `packages/development-guardian/work-session/launchpad/repair-audit.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair-model.js` | `packages/development-guardian/work-session/launchpad/repair-model.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair-notifier.js` | `packages/development-guardian/work-session/launchpad/repair-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/repair.js` | `packages/development-guardian/work-session/launchpad/repair.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/server.js` | `packages/development-guardian/work-session/launchpad/server.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/task-brief.js` | `packages/development-guardian/work-session/launchpad/task-brief.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/verifier-command-extraction.js` | `packages/development-guardian/work-session/launchpad/verifier-command-extraction.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/launchpad/view.js` | `packages/development-guardian/work-session/launchpad/view.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/legacy-recovery.js` | `packages/development-guardian/work-session/legacy-recovery.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/local-smtp-secrets.js` | `packages/development-guardian/work-session/local-smtp-secrets.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/model.js` | `packages/development-guardian/work-session/model.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/notifier.js` | `packages/development-guardian/work-session/notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/production-legacy-adoption.js` | `packages/development-guardian/work-session/production-legacy-adoption.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/production-lifecycle-errors.js` | `packages/development-guardian/work-session/production-lifecycle-errors.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/production.js` | `packages/development-guardian/work-session/production.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/reconciliation.js` | `packages/development-guardian/work-session/reconciliation.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/recoverability.js` | `packages/development-guardian/work-session/recoverability.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/review-dispatcher.js` | `packages/development-guardian/work-session/review-dispatcher.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/reviewer-adapters.js` | `packages/development-guardian/work-session/reviewer-adapters.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/reviewer-runtime.js` | `packages/development-guardian/work-session/reviewer-runtime.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/risk-evidence.js` | `packages/development-guardian/work-session/risk-evidence.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/runtime-repair-audit.js` | `packages/development-guardian/work-session/runtime-repair-audit.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/runtime-repair-engine.js` | `packages/development-guardian/work-session/runtime-repair-engine.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/runtime-repair-notifier.js` | `packages/development-guardian/work-session/runtime-repair-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/runtime-repair.js` | `packages/development-guardian/work-session/runtime-repair.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/runtime.js` | `packages/development-guardian/work-session/runtime.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/schedule-policy.js` | `packages/development-guardian/work-session/schedule-policy.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/scheduled-start-store.js` | `packages/development-guardian/work-session/scheduled-start-store.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/smtp-notifier.js` | `packages/development-guardian/work-session/smtp-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-controller.js` | `packages/development-guardian/work-session/task-controller.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-observability.js` | `packages/development-guardian/work-session/task-observability.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-run-analytics.js` | `packages/development-guardian/work-session/task-run-analytics.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-run-notifier.js` | `packages/development-guardian/work-session/task-run-notifier.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-runner.js` | `packages/development-guardian/work-session/task-runner.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/task-state-v2.js` | `packages/development-guardian/work-session/task-state-v2.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/v2-controller-task-runner.js` | `packages/development-guardian/work-session/v2-controller-task-runner.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/verification-approval.js` | `packages/development-guardian/work-session/verification-approval.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/verification-planner.js` | `packages/development-guardian/work-session/verification-planner.ts` | compiled | yes |
| `dist/packages/development-guardian/work-session/worktree-fingerprint.js` | `packages/development-guardian/work-session/worktree-fingerprint.ts` | compiled | yes |
| `dist/packages/host-snapshot/src/contract.js` | `packages/host-snapshot/src/contract.ts` | compiled | yes |
| `dist/packages/host-snapshot/src/index.js` | `packages/host-snapshot/src/index.ts` | compiled | yes |
| `dist/packages/host-snapshot/src/lifecycle.js` | `packages/host-snapshot/src/lifecycle.ts` | compiled | yes |
| `dist/packages/host-snapshot/src/registry.js` | `packages/host-snapshot/src/registry.ts` | compiled | yes |
| `dist/packages/sqlite/src/index.js` | `packages/sqlite/src/index.ts` | compiled | yes |
| `dist/packages/sqlite/src/migrations/001-initial.js` | `packages/sqlite/src/migrations/001-initial.ts` | compiled | yes |
| `dist/packages/sqlite/src/migrations/index.js` | `packages/sqlite/src/migrations/index.ts` | compiled | yes |
| `dist/packages/sqlite/src/snapshot/contract.js` | `packages/sqlite/src/snapshot/contract.ts` | compiled | yes |
| `dist/packages/sqlite/src/snapshot/registry.js` | `packages/sqlite/src/snapshot/registry.ts` | compiled | yes |
| `dist/packages/sqlite/src/sqlite-nova-wing-store.js` | `packages/sqlite/src/sqlite-nova-wing-store.ts` | compiled | yes |
| `dist/packages/testing/src/fake-offerflow-host.js` | `packages/testing/src/fake-offerflow-host.ts` | compiled | yes |
| `dist/packages/testing/src/index.js` | `packages/testing/src/index.ts` | compiled | yes |

UNMAPPED OR MISSING SOURCE:
  package.json -> UNMAPPED

_Unmapped:  (app root) — synthesised at packaging time by `scripts/platform/macos-package.mjs` / `scripts/platform/windows-package.mjs` from the root manifest plus `DESKTOP_IDENTITY`, so it maps to a generator rather than to a copied file._
