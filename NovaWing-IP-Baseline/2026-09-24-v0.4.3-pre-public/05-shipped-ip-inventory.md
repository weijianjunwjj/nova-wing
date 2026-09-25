# NovaWing v0.4.3 — Shipped IP Inventory

## Scope and classification

Audited payloads are the extracted CI Windows NSIS app tree and both extracted macOS DMG/ZIP app
trees. NovaWing-authored runtime code under `desktop/main/` and `dist/packages/` is proprietary
source shipped for client execution. Third-party dependencies, Electron, Chromium, bundled Codex,
and native libraries retain their upstream licenses.

The product package metadata remains `UNLICENSED`; no EULA is defined. Under the established gate
policy this is recorded, not treated as an automatic publication blocker.

## v0.4.3 product delta

The product delta from the v0.4.2 publication branch tip is limited to:

- deterministic BrowserWindow presentation evidence and bounded state-preserving repaint retry;
- structured hide/show diagnostics without prompts or secrets;
- Tray presentation of the existing Main-owned updater controller;
- exact candidate-bound restart/install intent;
- downgrade policy ordering after the electron-updater channel setter;
- version identity and regression/packaged-smoke coverage.

No second updater state machine, automatic install path, blind reload, routine BrowserWindow
recreation, duplicate Host, duplicate Runtime, or database reinitialization was introduced.

## Secret audit

Mature scanner: `gitleaks 8.30.1`, official archive checksum verified, default rules, local-only,
100% redaction. Vendored dependency directories were temporarily renamed only inside disposable
extraction trees so the complete shipped bytes were scanned; the original names were restored.

Windows and macOS each produced the same three previously known third-party findings:

| Shipped file | Rule | Classification |
| --- | --- | --- |
| `@mastra/core/dist/telemetry/index.js` | `generic-api-key` | upstream PostHog client key |
| `@mastra/core/dist/telemetry/index.cjs` | `generic-api-key` | same upstream client key |
| `dotenv/README-es.md` | `private-key` | documentation example |

NovaWing-origin findings: `0`. New findings versus v0.4.2: `0`. No token, authorization header,
authenticated URL, environment secret, credential file, or private-key material owned by NovaWing
was found.

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

The sole `UNKNOWN` inventory entry is NovaWing itself (`UNLICENSED`), not a third-party package.
License text in `THIRD_PARTY_NOTICES-*.txt` was emitted verbatim by `generate-license-file 4.2.5`;
no model wrote or paraphrased license text.

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

Historical public disclosure:

- `candidate-1`
- `candidate-2`
- `candidate-3`

The Owner accepted their public disclosure before v0.4.2 publication. v0.4.3 does not reopen that
first-disclosure window. Standard Electron repaint/presentation primitives, a Tray updater menu,
and electron-updater channel policy are not elevated into new candidates by themselves.

No new, previously undisclosed specific proprietary mechanism combination meeting the established
decision threshold was identified. This is a gate classification, not a judgment about patent
value.

```text
PATENT_DECISION_REQUIRED = NONE
```
