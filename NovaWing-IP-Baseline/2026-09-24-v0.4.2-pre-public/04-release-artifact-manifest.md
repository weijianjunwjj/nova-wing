# NovaWing v0.4.2 — Release Artifact Manifest and Hash Verification

This file records the **exact CI artifacts** of Desktop Build `35951460301` and their
independently re-verified hashes. The artifacts were downloaded from the private repository
through the GitHub Actions artifacts API. No local product rebuild was used as evidence.

Extraction tooling used (all mature, pre-existing tooling):

| Platform | Tool | Purpose |
| --- | --- | --- |
| Windows | `7zz` (7-Zip 26.03) | NSIS outer container → `$PLUGINSDIR/app-64.7z` → sealed app payload |
| macOS artifact/ZIP | macOS `ditto` | artifact ZIP → release ZIP → `NovaWing.app` |
| macOS DMG | macOS `hdiutil` | read-only mount of `NovaWing-0.4.2-arm64.dmg` |
| Hashing | `shasum -a 256`, `node:crypto` | SHA256 of containers, notices, and packaged content |

Disposable downloads, extraction trees, and mounts are not part of this baseline or Git. This
directory keeps only inventories, hashes, and evidence.

## 1. Release artifacts

| Artifact | Size (bytes) | Manifest SHA256 | Locally re-computed SHA256 | Result |
| --- | ---: | --- | --- | --- |
| `NovaWing-Setup-0.4.2-x64.exe` | 216,555,731 | `e2f0cef2bcd6d0df3c21255d67d14b1eed2615d0e5243fc3f5aa8dbb6475e820` | `e2f0cef2bcd6d0df3c21255d67d14b1eed2615d0e5243fc3f5aa8dbb6475e820` | **MATCH** |
| `NovaWing-0.4.2-arm64.dmg` | 260,433,106 | `02a8453911135b345a1ecfb5f42ca1840e9e3a79dbf3a9543fdaa47e8cb08467` | `02a8453911135b345a1ecfb5f42ca1840e9e3a79dbf3a9543fdaa47e8cb08467` | **MATCH** |
| `NovaWing-0.4.2-arm64-mac.zip` | 263,626,939 | `b9f7def8b15bde04eeccf5cd13109443a2f9191a535139343a19ee6708b5a296` | `b9f7def8b15bde04eeccf5cd13109443a2f9191a535139343a19ee6708b5a296` | **MATCH** |

## 2. Packaged-content identity

The CI `auditPackage()` identity is SHA256 over each file, sorted by relative path, with a NUL
separator before and after the file bytes. Windows additionally folds in packaged
`app-update.yml`. Recomputing that algorithm over independently extracted payloads produced:

| Platform/container | App-tree files | Recomputed SHA256 | Manifest SHA256 | Result |
| --- | ---: | --- | --- | --- |
| Windows installer payload | 5,511 | `bfb4af720a8fc478e9ab9bacd54628a2ac6c5abe67cecf9e03f0bc8b1b3785ac` | `bfb4af720a8fc478e9ab9bacd54628a2ac6c5abe67cecf9e03f0bc8b1b3785ac` | **MATCH** |
| macOS release ZIP app | 5,510 | `b68ae261150d96186e1cfbb0aa291bbba3b2238b53f9593a47f3c3fd141e807f` | `b68ae261150d96186e1cfbb0aa291bbba3b2238b53f9593a47f3c3fd141e807f` | **MATCH** |
| macOS read-only mounted DMG app | 5,510 | `b68ae261150d96186e1cfbb0aa291bbba3b2238b53f9593a47f3c3fd141e807f` | `b68ae261150d96186e1cfbb0aa291bbba3b2238b53f9593a47f3c3fd141e807f` | **MATCH** |

## 3. Electron 44.4.3 distribution notices

| Container | Electron SHA256 | Chromium SHA256 | Result |
| --- | --- | --- | --- |
| Windows installer payload | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` | `7b328b8c7463ac9bfc7dc648c751533517c8441a0b5b21047d6c0b2620e60d70` | **MATCH pinned Windows Electron distribution** |
| macOS release ZIP `.app` | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` | **MATCH pinned macOS Electron distribution** |
| macOS read-only mounted DMG `.app` | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` | **MATCH pinned macOS Electron distribution** |

The platform-specific Chromium license bundles differ by design. Each shipped file was compared
to the corresponding pinned Electron 44.4.3 platform distribution, without modifying its text.

## 4. Desktop Build artifact inventory

| Artifact | ID | Artifact ZIP size (bytes) | Contains |
| --- | ---: | ---: | --- |
| `novawing-windows-x64-nsis` | `10789371433` | 216,360,037 | installer, blockmap, `latest.yml`, identity and content audit |
| `novawing-windows-x64-evidence` | `10789177024` | 32,341 | checkout, smoke, strict-shutdown and identity evidence |
| `novawing-macos-arm64-dmg` | `10789290137` | 260,140,528 | DMG, blockmap, `macos-distribution.json` |
| `novawing-macos-arm64-zip` | `10789210409` | 261,481,070 | release ZIP, blockmap, `latest-mac.yml`, `macos-distribution.json` |
| `novawing-macos-arm64-evidence` | `10788724094` | 64,596 | checkout, smoke, content and bundled-license evidence |

## 5. Release validation

Desktop Release validate run `35955424307` succeeded at workflow commit
`a712bd15a81004bb981e89b076c445bedce405f4`. Its validation artifact
`10790541178` contains `release-manifest.json`, `release-notes.md`, `build-run.json`, and both
platform identity records. The publish job was skipped.

## 6. Feed and validation files

| File | SHA256 |
| --- | --- |
| `latest.yml` | `53f0fb87d9d7d2c33792b10202196d80d7d01e3470dcf06e3dd88625f2d69a70` |
| `NovaWing-Setup-0.4.2-x64.exe.blockmap` | `1b76c3e4cff8170dc3f8b3bd2e33a0d879aedf9a9cbcd133e9b05748065957aa` |
| `latest-mac.yml` | `9b3e75ba3c9d7721c31dc89483c53ce9bfa185b2ef3f143ecd4a0de7585e0042` |
| `NovaWing-0.4.2-arm64.dmg.blockmap` | `21dfb6c8fd22f9db5afb9ebaa21286e72bd0d2b08a98ee0d3460c475dc324946` |
| `NovaWing-0.4.2-arm64-mac.zip.blockmap` | `5a0132d112490ecd9c4fb803d0e63a68a85f7c74de00b32310e70416d337e3a7` |
| `release-manifest.json` | `47244115f2c5594b83ecd12ca91301a53cfe3c1aad23fc8702d9a42595e36968` |
| `release-notes.md` | `415dcd02cc78f7ac4a557a9b6d2ab019679f1fbd79a76505c3d3f2aa15fb1e9e` |

## 7. Provenance chain

```text
intended private source tag v0.4.2
    └─ required target ─────► a712bd15a81004bb981e89b076c445bedce405f4
Desktop Build 35951460301
    └─ head_sha ────────────► a712bd15a81004bb981e89b076c445bedce405f4   MATCH
artifacts (exe/dmg/zip)
    └─ container SHA256 ────► manifest / identity records                MATCH
    └─ content SHA256 ──────► independently extracted payloads           MATCH
    └─ distribution notices ► pinned Electron 44.4.3 bytes              MATCH
Desktop Release validate 35955424307
    └─ buildRunId ──────────► 35951460301                                MATCH
    └─ buildCommitSha ──────► a712bd15a81004bb981e89b076c445bedce405f4   MATCH
    └─ publish job ─────────► SKIPPED
```

The tag object is deliberately created only after the baseline commit. Its object and peeled
SHAs are then recorded in this snapshot without changing the product commit.

## 8. Signing status

| Platform | Signed for distribution | Notarized | Native notification |
| --- | --- | --- | --- |
| Windows | `false` | n/a | `PASS` in CI |
| macOS | `false` (ad-hoc only) | `false` | `NEEDS_SIGNED_VALIDATION` |
