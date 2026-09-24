# NovaWing v0.4.4 — Shipped IP Inventory

## Scope and classification

Audited payloads are the extracted CI Windows NSIS app tree and both extracted macOS DMG/ZIP app
trees. NovaWing-authored runtime code under `desktop/main/` and `dist/packages/` is proprietary
source shipped for client execution. Third-party dependencies, Electron, Chromium, bundled Codex,
and native libraries retain their upstream licenses.

The product package metadata remains `UNLICENSED`; no EULA is defined. Under the established gate
policy this is recorded, not treated as an automatic publication blocker.

## v0.4.4 product delta

The complete product delta from the v0.4.3 release branch HEAD is limited to:

- Desktop identity `0.4.3` → `0.4.4`;
- one informational notification through the existing native Notification abstraction when an
  explicit Tray check succeeds with no update;
- regression coverage proving exactly-once feedback and zero false “latest” notices for backend
  errors or available updates;
- packaged public-feed smoke identity updated to v0.4.4.

No second updater state machine, automatic check/download/install path, updater center, settings
page, install-gate change, or silent-update policy was introduced.

## Secret audit

Mature scanner: `gitleaks 8.30.1`, official previously checksum-verified binary, default rules,
local-only, 100% redaction. Vendored dependency directories were temporarily renamed only inside
disposable extraction trees so the complete shipped bytes were scanned, then restored.

Windows and macOS each produced the same three previously known third-party findings:

| Shipped file | Rule | Classification |
| --- | --- | --- |
| `@mastra/core/dist/telemetry/index.js` | `generic-api-key` | upstream PostHog client key |
| `@mastra/core/dist/telemetry/index.cjs` | `generic-api-key` | same upstream client key |
| `dotenv/README-es.md` | `private-key` | documentation example |

NovaWing-origin findings: `0`. New findings versus v0.4.3: `0`. No NovaWing token, authorization
header, authenticated URL, environment secret, credential file, or private-key material was found.

## SBOM, license inventory, and notices

| Evidence | Windows | macOS |
| --- | ---: | ---: |
| CycloneDX spec | 1.6 | 1.6 |
| SBOM components | 255 | 255 |
| license-checker entries | 260 | 260 |
| Third-party packages | 259 | 259 |
| Notice entries | 259 | 259 |
| Shipped packages uncovered by notices | 0 | 0 |
| Unknown third-party licenses | 0 | 0 |
| Copyleft declarations | 0 | 0 |

Tools are `@cyclonedx/cyclonedx-npm 6.0.1`, `license-checker 25.0.1`, and
`generate-license-file 4.2.5`. The sole `UNKNOWN` inventory entry is NovaWing itself
(`UNLICENSED`), not a third-party package. License text was emitted verbatim by the mature tool;
no model wrote or paraphrased it.

Electron 44.4.3 and Chromium distribution notices were verified byte-for-byte. macOS bundle, ZIP,
and DMG carry identical required notice hashes.

## Source maps, debug content, and private material

| Check | Windows | macOS |
| --- | ---: | ---: |
| Source maps | 0 | 0 |
| PDB / debug symbols | 0 | 0 |
| NovaWing tests / fixtures | 0 | 0 |
| `.env` / credential artifacts | 0 | 0 |
| Private baseline files | 0 | 0 |

## Patent status

`candidate-1`, `candidate-2`, and `candidate-3` were Owner-accepted and publicly disclosed with
v0.4.2. v0.4.4 does not reopen those first-disclosure windows.

The new behavior is a standard native informational notification after the existing updater
controller reports no update. No new previously undisclosed specific proprietary mechanism
combination meeting the established decision threshold was identified. This is a gate
classification, not a judgment about patent value.

```text
PATENT_DECISION_REQUIRED = NONE
```
