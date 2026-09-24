# NovaWing v0.4.4 — Release Artifact Manifest

Source: Desktop Build `36010798923`, attempt `1`, conclusion `success`, head SHA
`9ddbeedfb69b07323e256eaca9a284504e66c1e3`. Values were recomputed from independently downloaded
CI artifacts; no local installer is included.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `NovaWing-Setup-0.4.4-x64.exe` | 216,557,708 | `59d37eaeb1e155ca6e9804116de394c0bf683ba937e923860133f68e1e39892e` |
| `NovaWing-Setup-0.4.4-x64.exe.blockmap` | 227,841 | `27aba3158f782f9ea60f0ba69e3059cdbe47a84b11299d6000c7b79a920e875f` |
| `latest.yml` | 353 | `cc7955aabc5eb42d616746a81197bd6b13f2855d66a98a7624522bc5cd1a6e6a` |
| `NovaWing-0.4.4-arm64.dmg` | 260,422,564 | `fdf83e6838c5878e3731369c433196c0a2cf3483fbfba32dd5b7349676da9adf` |
| `NovaWing-0.4.4-arm64.dmg.blockmap` | 272,935 | `e440df203537126bc698b4b1759092168a1ea9730da6fe297be973060abc2d2a` |
| `NovaWing-0.4.4-arm64-mac.zip` | 263,628,992 | `87144b153f236245f377ffef8c95b1d430ffee887893db0573c841bcc006a815` |
| `NovaWing-0.4.4-arm64-mac.zip.blockmap` | 274,526 | `3fac0070485df371e4b67063b06f3daea137e5e745cbccd412b307ac7221bef3` |
| `latest-mac.yml` | 508 | `d1e04f1595a355a0cd070b0a86a069b0ffff0a0b23f4e7858db55da81b461b5e` |

Release Validate run `36021658632` generated `release-manifest.json` from these exact build
containers and bound it to the run ID, product commit, version, and tag. Its SHA-256 is
`0056b3ad0d4e16ef2e0b18f8725f0e79c0e5e0f1705af283b70fb396251e4b58`; a copy is retained in this
private baseline.

## Provenance chain

```text
private product commit 9ddbeedfb69b07323e256eaca9a284504e66c1e3
  → Desktop Build 36010798923
  → immutable CI artifacts
  → installer / DMG / ZIP identity metadata
  → independent container hashes and extracted package-content hashes
  → Release Validate 36021658632 / manifest 0056b3ad0d4… (PASS; publish skipped)
  → annotated private source tag (pending)
  → public feed release (pending)
```
