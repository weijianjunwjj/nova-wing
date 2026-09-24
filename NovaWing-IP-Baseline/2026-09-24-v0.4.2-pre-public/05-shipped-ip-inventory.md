# NovaWing v0.4.2 — Shipped IP Inventory

This audit is based on the exact artifacts from Desktop Build `35951460301`, not the local
`artifacts/` directory. Windows was extracted with 7-Zip 26.03 (NSIS then `app-64.7z`); macOS
was inspected from the exact CI ZIP and a read-only mounted DMG.

Classification vocabulary: `PUBLIC_OK`, `PATENT_DECISION_REQUIRED`, `KEEP_PRIVATE`,
`THIRD_PARTY`, and `CLIENT_REQUIRED_SECRET_CONFLICT`.

## 1. Actual shipped content

| Platform | App-tree files | NovaWing-owned | `node_modules` | Package content SHA256 |
| --- | ---: | ---: | ---: | --- |
| Windows x64 | 5,511 | 143 | 5,368 | `bfb4af720a8fc478e9ab9bacd54628a2ac6c5abe67cecf9e03f0bc8b1b3785ac` |
| macOS arm64 | 5,510 | 143 | 5,367 | `b68ae261150d96186e1cfbb0aa291bbba3b2238b53f9593a47f3c3fd141e807f` |

The one-file app-tree difference is the Windows packaged `app-update.yml` folded into the
Windows identity. The macOS Electron/Chromium notice files sit at bundle level in
`Contents/Resources/`, outside NovaWing's `Contents/Resources/app` identity.

| Content | Shipped location | Classification |
| --- | --- | --- |
| Compiled NovaWing JS | `resources/app/dist/packages/**` | `PUBLIC_OK` except the three mechanisms below |
| Desktop runtime JS/assets | `resources/app/desktop/main/**`, `resources/app/desktop/assets/**` | `PUBLIC_OK` |
| Generated app manifest/config | `resources/app/package.json`, `Contents/Resources/app-update.yml` or Windows equivalent | `PUBLIC_OK` |
| npm dependencies | `resources/app/node_modules/**` | `THIRD_PARTY` |
| Electron/Chromium runtime and native binaries | Windows payload root / macOS `Contents/Frameworks/**` | `THIRD_PARTY` |
| Electron license | Windows payload `LICENSE.electron.txt`; macOS `Contents/Resources/LICENSE.electron.txt` | `THIRD_PARTY` |
| Chromium license bundle | Windows payload `LICENSES.chromium.html`; macOS `Contents/Resources/LICENSES.chromium.html` | `THIRD_PARTY` |

## 2. Source map / debug / private-evidence audit

Independent checks over the extracted packages found:

| Pattern | Windows | macOS | Result |
| --- | ---: | ---: | --- |
| `*.map` | 0 | 0 | PASS |
| NovaWing-owned `*.ts` / `*.tsx` | 0 | 0 | PASS |
| NovaWing-owned tests/specs/fixtures | 0 | 0 | PASS |
| `*.pdb` | 0 | 0 | PASS |
| `.env*`, private keys, npm/netrc credentials | 0 | 0 | PASS |
| `NovaWing-IP-Baseline` / pre-public gate material | 0 | 0 | PASS |

Third-party packages include upstream TypeScript, specs, README and license files. Those remain
classified `THIRD_PARTY`; no NovaWing source, tests, fixtures, debug database, log, or baseline is
present.

## 3. Secret scan

Mature scanner: `gitleaks 8.30.1`, local-only, default rules, 100% redaction. The vendored
dependency directory was temporarily renamed in the disposable extraction tree so gitleaks would
not skip the conventional `node_modules` path.

Both platforms return the same three redacted third-party findings and zero NovaWing findings:

| Package/path | Rule | Classification |
| --- | --- | --- |
| `@mastra/core/dist/telemetry/index.js` | `generic-api-key` | `THIRD_PARTY`; PostHog client key shipped by upstream package |
| `@mastra/core/dist/telemetry/index.cjs` | `generic-api-key` | same upstream value |
| `dotenv/README-es.md` | `private-key` | `THIRD_PARTY`; documentation example |

No credential or secret belonging to NovaWing was found. `SECRETS=PASS`.

## 4. `KEEP_PRIVATE` and client-required logic

The actual shipped JS contains exact budgets, risk rules, allowlists, routing heuristics, prompts,
and recovery policy details required by local execution, including:

- `RECOVERY_ACTION_BUDGET=4`;
- autonomous-diagnosis system prompt and admission logic;
- `assessRisk()` rules;
- reviewer and recovery budgets;
- deterministic verifier command allowlist;
- executor/provider routing and failover rules.

These are `CLIENT_REQUIRED_SECRET_CONFLICT`, not `KEEP_PRIVATE`: they must execute on the user's
machine and the Owner has not classified any one of them as a trade secret that must not ship.
Accordingly this list is recorded but does not enter `blockingReasons`.

`KEEP_PRIVATE accidentally shipped`: **NONE**. The private baseline, CI operational evidence,
credentials, and server-side playbooks are absent from both packages.

## 5. Core mechanism audit

Factual classification only. This audit does not judge patentability, score patent value, or make
the Owner's file/disclose decision.

### candidate-1

- **MECHANISM**: authoritative task facts → typed execution evidence → independent deterministic
  verification → evidence admission → evidence-bound finalization.
- **SOURCE PATHS**: `packages/development-guardian/verification-evidence.ts`,
  `packages/development-guardian/work-session/completion-criteria.ts`,
  `packages/development-guardian/work-session/execution-ledger.ts`.
- **SHIPPED PATHS**: `dist/packages/development-guardian/verification-evidence.js`,
  `dist/packages/development-guardian/work-session/completion-criteria.js`,
  `dist/packages/development-guardian/work-session/execution-ledger.js`.
- **SHIPPED**: YES on Windows and macOS (confirmed in both CI inventories).
- **EARLIEST REPOSITORY EVIDENCE**: `0a6f2cb` (2026-08-28), `6beffd5`
  (2026-09-18), `2908871` (2026-08-24).
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: `NONE_FOUND` in the checked public GitHub/npm channels.
- **PRIOR_ART STATUS**: `NOT_ASSESSED`.
- **STATUS**: `PATENT_DECISION_REQUIRED`.

### candidate-2

- **MECHANISM**: persisted verification plan → scoped command/cwd admission → source/script
  fingerprint revalidation → independent verifier truth → completion gate.
- **SOURCE PATHS**: `packages/development-guardian/work-session/verification-planner.ts`,
  `packages/development-guardian/verification-command-policy.ts`,
  `packages/development-guardian/work-session/worktree-fingerprint.ts`,
  `packages/development-guardian/work-session/completion-criteria.ts`.
- **SHIPPED PATHS**: `dist/packages/development-guardian/work-session/verification-planner.js`,
  `dist/packages/development-guardian/verification-command-policy.js`,
  `dist/packages/development-guardian/work-session/worktree-fingerprint.js`,
  `dist/packages/development-guardian/work-session/completion-criteria.js`.
- **SHIPPED**: YES on Windows and macOS.
- **EARLIEST REPOSITORY EVIDENCE**: `e2ea7a2` (2026-09-13), `38a125c`
  (2026-09-14), `c4d16b2` (2026-08-21).
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: `NONE_FOUND` in the checked public GitHub/npm channels.
- **PRIOR_ART STATUS**: `NOT_ASSESSED`.
- **STATUS**: `PATENT_DECISION_REQUIRED`.

### candidate-3

- **MECHANISM**: bounded recovery → authority-preserving diagnosis → deterministic recovery
  admission → re-verification → fail-closed `HUMAN_REQUIRED`.
- **SOURCE PATHS**: `packages/development-guardian/work-session/autonomous-diagnosis.ts`,
  `packages/development-guardian/work-session/autonomous-recovery-evidence.ts`,
  `packages/development-guardian/work-session/golden-path.ts`.
- **SHIPPED PATHS**: `dist/packages/development-guardian/work-session/autonomous-diagnosis.js`,
  `dist/packages/development-guardian/work-session/autonomous-recovery-evidence.js`,
  `dist/packages/development-guardian/work-session/golden-path.js`.
- **SHIPPED**: YES on Windows and macOS.
- **EARLIEST REPOSITORY EVIDENCE**: `b0f4e16` (2026-09-18).
- **KNOWN HISTORICAL PUBLIC DISCLOSURE**: `NONE_FOUND` in the checked public GitHub/npm channels.
- **PRIOR_ART STATUS**: `NOT_ASSESSED`.
- **STATUS**: `PATENT_DECISION_REQUIRED`.

### candidate-4

Provider routing, reviewer adapters, JSONL delegate transport, and provenance-bearing evidence are
shipped, but no distinct cohesive authority-continuity/task-truth-continuity mechanism was found.
`SHIPPED=PARTIAL`, `PRIOR_ART_STATUS=NOT_ASSESSED`, `STATUS=PUBLIC_OK` as currently implemented.

Broad concepts such as agent orchestration, multi-agent, Reviewer, checkpoint, retry, Electron,
updater, Tray, and cross-platform remain `PUBLIC_OK`; they are not patent candidates here.

## 6. Third-party inventory, notices, and licenses

Mature tools run against each extracted shipped app:

- `@cyclonedx/cyclonedx-npm 6.0.1` → CycloneDX 1.6 SBOM, 255 components;
- `license-checker 25.0.1` → 259 third-party package entries plus the NovaWing root;
- `generate-license-file 4.2.5` → 259 verbatim dependency-license entries;
- notice coverage: 259/259 third-party packages, 0 missing;
- unknown third-party license declarations: 0 (the sole `UNKNOWN` entry is NovaWing itself,
  whose package metadata is deliberately `UNLICENSED`);
- copyleft license declarations: 0.

Electron 44.4.3 distribution notices:

| Platform | Electron notice SHA256 | Chromium notice SHA256 | Result |
| --- | --- | --- | --- |
| Windows | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` | `7b328b8c7463ac9bfc7dc648c751533517c8441a0b5b21047d6c0b2620e60d70` | PASS |
| macOS `.app` / ZIP / DMG | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` | PASS |

The different Chromium hash is expected because Electron's upstream platform distributions carry
platform-specific Chromium license bundles. On each platform, shipped bytes match that platform's
pinned Electron 44.4.3 distribution.

Results: `SBOM=PASS`, `THIRD_PARTY_NOTICES=PASS`, `THIRD_PARTY_LICENSES=PASS`.

## 7. Proprietary license / EULA

Root and shipped package metadata remain `license=UNLICENSED`. No EULA or proprietary binary
redistribution terms were found, so `EULA_STATUS=NOT_DEFINED`. Per the supplied policy this does
not block an ordinary proprietary-software release.

## 8. Release notes and private-evidence containment

The generated v0.4.2 release notes describe artifact provenance, signing/notarization limits and
hashes. They do not disclose full checkpoint schemas, exact evidence-admission algorithms, risk
thresholds, recovery decision trees, verifier rankings, prompts, or a reconstructable mechanism
state sequence. Result: `PASS`.

The extracted app trees contain zero `NovaWing-IP-Baseline` or pre-public gate files. The release
workflow uploads binary/update assets and the release manifest; it does not upload this directory.

## 9. SOURCE PATH → SHIPPED PATH map

| Source path | Shipped path | Classification |
| --- | --- | --- |
| `desktop/main/*.mjs` | `resources/app/desktop/main/*.mjs` | `PUBLIC_OK` |
| `desktop/assets/*` | `resources/app/desktop/assets/*` | `PUBLIC_OK` |
| `packages/core/**/*.ts` | `resources/app/dist/packages/core/**/*.js` | `PUBLIC_OK` |
| `packages/sqlite/**/*.ts` | `resources/app/dist/packages/sqlite/**/*.js` | `PUBLIC_OK` |
| `packages/host-snapshot/**/*.ts` | `resources/app/dist/packages/host-snapshot/**/*.js` | `PUBLIC_OK` |
| `packages/development-guardian/verification-evidence.ts` | `resources/app/dist/packages/development-guardian/verification-evidence.js` | `PATENT_DECISION_REQUIRED` candidate-1 |
| `packages/development-guardian/work-session/completion-criteria.ts` | `resources/app/dist/packages/development-guardian/work-session/completion-criteria.js` | candidate-1/2 |
| `packages/development-guardian/work-session/execution-ledger.ts` | `resources/app/dist/packages/development-guardian/work-session/execution-ledger.js` | candidate-1 |
| `packages/development-guardian/work-session/verification-planner.ts` | `resources/app/dist/packages/development-guardian/work-session/verification-planner.js` | candidate-2 |
| `packages/development-guardian/verification-command-policy.ts` | `resources/app/dist/packages/development-guardian/verification-command-policy.js` | candidate-2 / client-required allowlist |
| `packages/development-guardian/work-session/worktree-fingerprint.ts` | `resources/app/dist/packages/development-guardian/work-session/worktree-fingerprint.js` | candidate-2 |
| `packages/development-guardian/work-session/autonomous-diagnosis.ts` | `resources/app/dist/packages/development-guardian/work-session/autonomous-diagnosis.js` | candidate-3 / client-required prompt and policy |
| `packages/development-guardian/work-session/autonomous-recovery-evidence.ts` | `resources/app/dist/packages/development-guardian/work-session/autonomous-recovery-evidence.js` | candidate-3 |
| `packages/development-guardian/work-session/golden-path.ts` | `resources/app/dist/packages/development-guardian/work-session/golden-path.js` | candidate-3 |
| `packages/development-guardian/executor-router.ts` | `resources/app/dist/packages/development-guardian/executor-router.js` | `PUBLIC_OK` / client-required routing |
| `packages/development-guardian/work-session/risk-evidence.ts` | `resources/app/dist/packages/development-guardian/work-session/risk-evidence.js` | client-required risk rules |
| `node_modules/electron/dist/LICENSE` | Windows payload `LICENSE.electron.txt`; macOS `Contents/Resources/LICENSE.electron.txt` | `THIRD_PARTY` |
| platform-specific `node_modules/electron/dist/LICENSES.chromium.html` | Windows payload `LICENSES.chromium.html`; macOS `Contents/Resources/LICENSES.chromium.html` | `THIRD_PARTY` |
| shipped dependency package | `resources/app/node_modules/<package>/**` | `THIRD_PARTY` |
