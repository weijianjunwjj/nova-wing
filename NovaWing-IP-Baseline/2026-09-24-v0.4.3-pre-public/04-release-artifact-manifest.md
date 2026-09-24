# NovaWing v0.4.3 — Release Artifact Manifest

Source: Desktop Build `35987215152`, final conclusion `success`, head SHA
`dab1aca91417ebdb1caa8d487daa49074d47f16e`. All values below were recomputed from downloaded CI
artifacts; no local installer is included.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `NovaWing-Setup-0.4.3-x64.exe` | 216,557,393 | `99fa8bbfa13c8e4aba642a500e559c20ca4ce0de3c044f97ec89a1306d558d44` |
| `NovaWing-Setup-0.4.3-x64.exe.blockmap` | 227,842 | `5a5c43f3b203a673c118d8a1e5dbcdd016f9826a6c8bd9eba873e0f1482debfd` |
| `latest.yml` | 353 | `0107e8186c86c0c77cccb2cdfc82df89e6d439cab3e637a6e0c17a76b0151707` |
| `NovaWing-0.4.3-arm64.dmg` | 260,422,315 | `0dd95666ffa8e11b210674c4de804aacf03b3cb61572595d2301b47adae2e6c2` |
| `NovaWing-0.4.3-arm64.dmg.blockmap` | 272,990 | `f24288882e2b7f3fe2aecc332538668a04df750ccc6dd2916616398f176756a9` |
| `NovaWing-0.4.3-arm64-mac.zip` | 263,628,665 | `679aac5438219a1afca6de1b9393174054986dd6a44f6b894c5b22a3f559b5bc` |
| `NovaWing-0.4.3-arm64-mac.zip.blockmap` | 274,669 | `78c108c564d97dc8af1efa4778b430f2d7be7bc8bb4c7ff77dc2ad8ef1891161` |
| `latest-mac.yml` | 508 | `b2af8c25faea73f0162725ed5b272dfba3a30b819d7fab3adb4f28c5db132f5b` |

`release-manifest.json` is deliberately absent at this phase; Release Validate generates it from
these exact build containers and binds it to the run ID, product commit, version, and tag.

## Provenance chain

```text
private product commit dab1aca91417ebdb1caa8d487daa49074d47f16e
  → Desktop Build 35987215152
  → immutable CI artifacts
  → installer / DMG / ZIP identity metadata
  → independent container hashes and extracted package-content hashes
  → Release Validate manifest (pending)
  → annotated private source tag (pending)
  → public feed release (pending)
```

The five changed product runtime files in `desktop/main/` are text-identical to their shipped
copies after accounting only for checkout line-ending representation. Both package identities
match the CI smoke identities, so there is no rebuild or local-artifact substitution.
