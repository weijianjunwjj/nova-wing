# NovaWing v0.4.1 — Release Artifact Manifest and Hash Verification

This file records the **exact CI artifacts** of Desktop Build `35870473791` and their
independently re-verified hashes. The artifacts were downloaded from the private repository
via the GitHub Actions artifacts API and unpacked with standard OS tooling.

Extraction tooling used (all pre-existing, no custom extractor written):

| Platform | Tool | Purpose |
| --- | --- | --- |
| Windows | `7zz` (7-Zip 26.03) | NSIS outer container → `$PLUGINSDIR/app-64.7z` → sealed app payload |
| macOS ZIP | `unzip` (BSD) | artifact ZIP → `NovaWing-0.4.1-arm64-mac.zip` → `NovaWing.app` |
| macOS DMG | `hdiutil` | read-only mount of `NovaWing-0.4.1-arm64.dmg` |
| Hashing | `shasum -a 256`, `node:crypto` | SHA256 of containers and of packaged content |

All temporary extraction directories were deleted after the audit; this baseline keeps only
inventories, hashes and evidence — not a second copy of the binaries.

## 1. Published artifacts (the three files a user downloads)

| Artifact | Size (bytes) | SHA256 (remote) | SHA256 (locally re-computed) | Result |
| --- | --- | --- | --- | --- |
| `NovaWing-Setup-0.4.1-x64.exe` | 216,555,685 | `b3df92143b8c76e1d7c99542d0eb89dfb40e1f6835db8979e9db825cfef1367f` | `b3df92143b8c76e1d7c99542d0eb89dfb40e1f6835db8979e9db825cfef1367f` | **MATCH** |
| `NovaWing-0.4.1-arm64.dmg` | 258,322,811 | `9b99228511a62d2276524d0116d645933d57271a82505c7bc04f1ecae2bfe2f1` | `9b99228511a62d2276524d0116d645933d57271a82505c7bc04f1ecae2bfe2f1` | **MATCH** |
| `NovaWing-0.4.1-arm64-mac.zip` | 261,540,410 | `ab0f6e97edbc583e8065c8940b5df8753446dd54c23130baf6257625e0637f87` | `ab0f6e97edbc583e8065c8940b5df8753446dd54c23130baf6257625e0637f87` | **MATCH** |

These three hashes are the same values recorded in `release-manifest.json`,
`windows-identity.json` / `macos-identity.json`, `release-notes.md` and the build's own
`ci/windows-installer-identity.txt` / `ci/macos-distribution-identity.txt`.

The local `artifacts/desktop/` files present in this checkout are **not** these artifacts.
They are a different, earlier local build:

| File | Local checkout | CI artifact | Same? |
| --- | --- | --- | --- |
| `NovaWing-0.4.1-arm64.dmg` | 258,322,594 bytes, sha `89cb977a…` | 258,322,811 bytes, sha `9b992285…` | **NO** |
| `NovaWing-0.4.1-arm64-mac.zip` | 261,540,410 bytes, sha `4951797d…` | 261,540,410 bytes, sha `ab0f6e97…` | **NO** (same size, different bytes) |
| `NovaWing-Setup-0.4.1-x64.exe` | not present | 216,555,685 bytes | **NO** |

The local copy is therefore *not* used as evidence anywhere in this baseline.

## 2. Packaged content identity (independently reproduced)

The CI hashes the packaged app tree in `auditPackage()`. That algorithm was read from
`scripts/platform/windows-package.mjs:32-81` and `scripts/platform/macos-package.mjs:59-92`:

```text
sha256 over, for each file sorted by relative path:
    update(relPath).update('\0').update(fileBytes).update('\0')
Windows additionally folds the packaged feed:
    update('app-update.yml').update('\0').update(feedBytes).update('\0')
```

Re-computed independently over the extracted payloads:

| Platform | Files | Computed SHA256 | Manifest SHA256 | Result |
| --- | --- | --- | --- | --- |
| Windows | 5,511 | `484199978e2c125b25a742d1b11d3e19d72a1efc0992c47a47190da9c0f83945` | `484199978e2c125b25a742d1b11d3e19d72a1efc0992c47a47190da9c0f83945` | **MATCH** |
| macOS | 5,510 | `e097e7bd7c0a9cdbe1400fb3b7d0e9a2699aa726ca84ffd54ce267f69486cc2e` | `e097e7bd7c0a9cdbe1400fb3b7d0e9a2699aa726ca84ffd54ce267f69486cc2e` | **MATCH** |

Because the Windows content hash folds the feed, a MATCH also proves the shipped
`app-update.yml` is byte-identical to the one the CI audited:

| Item | Value |
| --- | --- |
| `app-update.yml` SHA256 | `57a65b9e7de5c62c1546633d3464a9cad64bb6d63c5530634d374afc9fe8978a` |
| Recorded `updateConfigSha256` | `57a65b9e7de5c62c1546633d3464a9cad64bb6d63c5530634d374afc9fe8978a` |
| Result | **MATCH** |

This is the strongest available check that the bytes a user will download are the bytes the
CI validated: the container was unpacked independently and the content hash recomputed from
scratch.

## 3. CI artifact inventory (Desktop Build 35870473791)

| Artifact | ID | ZIP size (bytes) | Expired | Contains |
| --- | --- | --- | --- | --- |
| `novawing-windows-x64-nsis` | 10754629234 | 216,360,015 | false | `NovaWing-Setup-0.4.1-x64.exe`, `.exe.blockmap`, `installer.json`, `latest.yml`, `packaged-content-audit.json` |
| `novawing-windows-x64-evidence` | 10754828953 | 32,302 | false | `ci/checkout-state.txt`, `ci/windows-git-diagnostics.txt`, `ci/windows-installer-identity.txt`, `desktop/package-smoke/*` |
| `novawing-macos-arm64-dmg` | 10755351399 | 258,114,763 | false | `NovaWing-0.4.1-arm64.dmg`, `.dmg.blockmap`, `macos-distribution.json` |
| `novawing-macos-arm64-zip` | 10754991813 | 259,475,818 | false | `NovaWing-0.4.1-arm64-mac.zip`, `-mac.zip.blockmap`, `latest-mac.yml`, `macos-distribution.json` |
| `novawing-macos-arm64-evidence` | 10754926944 | 63,405 | false | `ci/checkout-state.txt`, `ci/macos-distribution-identity.txt`, `desktop/macos-packaged-content-audit.json`, `desktop/package-smoke/*` |

Note: the artifacts API `size_in_bytes` is the size of the **ZIP that wraps** the artifact,
not the size of the file inside it. The Windows NSIS ZIP (216,360,015) is smaller than the
installer it contains (216,555,685) because it is compressed.

## 4. Release validation run 35881232734

| Artifact | ID | Contains |
| --- | --- | --- |
| `novawing-release-validation` | 10760717323 | `release-manifest.json`, `release-notes.md`, `build-run.json`, `windows-identity.json`, `macos-identity.json` |

## 5. Feed files that will become public

| File | SHA256 | Notes |
| --- | --- | --- |
| `latest.yml` | `0e83a5e295a6254e8a5167a3115fd4fc3622a4994f680dbea2d698438ccd7975` | Windows update feed |
| `NovaWing-Setup-0.4.1-x64.exe.blockmap` | `b4a7d1892c7775f42d1b821e9a6efb68b46e30aaae65f11a519c8f58fb064fdf` | |
| `latest-mac.yml` | `d589460a3b006792fc82c34121d8ac770bdf6a72a488c6ab401dd177d1f15db6` | macOS update feed |
| `NovaWing-0.4.1-arm64.dmg.blockmap` | `f63957ee4df2e5faf8d64ca6b02064778469aa03f0745fa9e924f06bcaef7f66` | |
| `NovaWing-0.4.1-arm64-mac.zip.blockmap` | `239457f41833b2cb69fb96405d9c02dc769cf1c229a94d7f29429e6f9254cf3c` | |
| `release-manifest.json` | see §4 | |
| `release-notes.md` | see §4 | audited in `05-shipped-ip-inventory.md` §7 |

## 6. Provenance chain — every link closed

```text
private source tag v0.4.1 (ef218a8e…)
    └─ target ──────────────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455
Desktop Build 35870473791
    └─ head_sha ────────────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455   MATCH
    └─ CI checkout ─────────► head_before == head_after, 0 dirty files   MATCH
artifacts (exe/dmg/zip)
    └─ container SHA256 ────► matches manifest / identities / notes      MATCH
    └─ content SHA256 ──────► recomputed from unpacked payloads          MATCH
    └─ packaged app-update.yml ─► folded into Windows content hash       MATCH
release validation 35881232734
    └─ buildRunId ──────────► 35870473791                                MATCH
    └─ buildCommitSha ──────► 9c5d0b97972f62e725a38cb853ffbda5ddb54455   MATCH
    └─ manifest ────────────► exact build run / commit                   MATCH
```

No link in this chain is broken.

## 7. Signing status of the audited artifacts

| Platform | signed | Authority | Notarized |
| --- | --- | --- | --- |
| Windows | **false** | none | n/a |
| macOS | ad-hoc only (`signedForDistribution: false`) | `null` | **false** |
