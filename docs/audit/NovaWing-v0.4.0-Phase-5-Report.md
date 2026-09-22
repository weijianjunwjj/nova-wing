# NovaWing v0.4.0 Phase 5 — macOS Package & Real-host

日期：2026-09-22。分支 `feat/v0.4-desktop`。

## Final Verdict

```text
Phase 5 — macOS Package & Real-host: PASS WITH SIGNING LIMITATION
```

本文件是 Phase 5 的最终报告。所有结论均来自本阶段实际取得的证据（自动门禁、packaged smoke、
Finder/Dock real-host 运行、真实 Codex 任务、分发产物挂载与解包验证），未以推测代替证据。

限制项**必须与本报告同时引用，不得单独摘取 PASS 而不带限制**：

```text
Developer ID signing:  NOT AVAILABLE
Notarization:          NOT PERFORMED
Native Notification:   NEEDS_SIGNED_VALIDATION
Gatekeeper:            REJECTED for unsigned/ad-hoc distribution artifact
```

**Gatekeeper rejection 不是 Runtime failure。** 未签名/未公证的分发产物被 Gatekeeper 拒绝是预期
结果；同一产物经 Finder/LaunchServices 从 DMG、ZIP 解包目录、`/Applications` 三处启动均 PASS。

## 1. Core Baseline

| 项 | 值 |
| --- | --- |
| Platform | macOS 14.3（Build 23D2057） |
| Architecture | arm64 |
| Electron | 44.4.3（固定，未升级） |
| Node embedded in Electron | 24.21.0 |
| Bundle ID | `io.github.weijianjunwjj.novawing` |
| Product version | 0.4.0 |
| electron-builder | 26.15.3 |

| commit | SHA | 说明 |
| --- | --- | --- |
| Phase 5 core | `00edbe8bbdd341e3c1d7c14ea8e54136a9a156ed` | `feat(desktop): complete macOS real-host runtime support` |
| Phase 5 distribution | `b14630d4c57132a3c8ee9ba49e7d328660de775a` | `feat(desktop): add macOS dmg and zip distribution` |

## 2. Scope

让 NovaWing 以 macOS 桌面产品形态交付并在真实 arm64 主机上端到端可用：

- macOS arm64 `.app` 打包（`Platform.MAC` dir target），bundle 身份与内容审计。
- packaged runtime：Codex / Git / `node:sqlite` / libSQL 在 bundle 内可用且解析隔离。
- Desktop Runtime：Launchpad、owned-origin 控制面、Tray、close→hide→show、single instance、
  background runtime、`powerSaveBlocker`、renderer 恢复、strict shutdown。
- macOS 菜单栏 Tray 的 template image 语义。
- Finder/Dock（LaunchServices）启动下的 GUI child environment。
- 真实 Codex 任务闭环（EXECUTE → npm test → VERIFY → Evidence → checkpoint → COMPLETED）。
- 分发产物：DMG（含 `/Applications` symlink）与 ZIP。

不在本轮范围：Developer ID 签名、notarization、updater、CI release（Phase 6）、Linux Desktop。

## 3. Real-host Evidence — MAC-REALHOST-002

真实任务由 Finder 启动的 packaged 应用完成，**未借助任何 terminal shell 环境**。

```text
Finder cold start
  → minimal GUI PATH
  → POSIX toolchain resolver
  → packaged Codex
  → EXECUTE
  → npm test
  → VERIFY PASS
  → Evidence
  → checkpoint
  → COMPLETED
```

| 项 | 值 |
| --- | --- |
| Session | `mac-realhost-001-202609221404-a4bec7` |
| Task | `MAC-REALHOST-002` |
| completionReason | `ALL_TASKS_COMPLETED` |
| humanRequired | 无 |
| failureReason | 无 |
| checkpoint SHA | `ce5ead2a957c03f56371a12cf0730e66a0e233ca` |
| checkpoint 内容 | 仅 `src/sum.mjs`(+3) 与 `test/sum.test.mjs`(+16) |
| 执行迭代 | `iteration` 恒为 0（单次 EXECUTE / 单次 VERIFY） |
| push | 无（repo 无 remote） |

execution ledger 关键序列：`PHASE_STARTED PLANNING → EXECUTING → completed → VERIFYING → completed
→ FINALIZING → COMPLETED → GIT_COMMIT_COMPLETED(ce5ead2a) → TASK_COMPLETED → SESSION_COMPLETED`。

### 自动验收项

```text
MAC_FINDER_GIT:                PASS
MAC_PACKAGED_CODEX_REALHOST:   PASS
MAC_REAL_CODEX_TASK:           PASS
MAC_BACKGROUND_RUNTIME:        PASS
MAC_POWER:                     PASS
MAC_CHECKPOINT:                PASS
MAC_STRICT_QUIT:               PASS
```

### 人工确认项（真人 GUI 验收）

```text
MAC_CLOSE_HIDE_SHOW:   PASS
MAC_DOCK_ACTIVATE:     PASS
MAC_TRAY_VISIBLE:      PASS
MAC_TRAY_HIDE_SHOW:    PASS
WHITE_SCREEN:          NOT_REPRODUCED
```

`powerSaveBlocker` 实测时间线（activity lease 证据，非 durable state 推断）：

```text
active=0 blocker=false start=0 stop=0   ← 任务前
active=1 blocker=true  start=1 stop=0   ← 任务开始，blocker ON
active=2 blocker=true  start=1 stop=0   ← 执行/验证期间
active=0 blocker=false start=1 stop=1   ← 终态，blocker OFF
```

## 4. Toolchain Issue and Fix

### 现象

Finder 启动的 GUI 应用继承 launchd 最小 PATH：

```text
PATH = /usr/bin:/bin:/usr/sbin:/sbin
git  → /usr/bin/git      （可用，随 Xcode CLT）
node → MISSING
npm  → MISSING
npx  → MISSING
```

真实任务中 Codex EXECUTE **成功**并产出正确文件，但 verifier 失败：

```text
bash: npm: command not found
verification exited with code 127
```

旧构建把它分类为 `UNKNOWN` / “发生未知错误”，掩盖了真实原因。该现象命名为
**`MAC_REAL_HOST_TOOLCHAIN_PATH`**。

### 修复（A：child environment）

新增受控 POSIX toolchain resolver（`packages/development-guardian/platform/posix-toolchain.ts`）：

- **不修改全局 PATH**、不改 `.zshrc` / `.zprofile` / `/etc/paths` / `launchctl`。
- **有边界的 shell probe**：`/bin/zsh -lic` + sentinel，显式 timeout，无 TTY，stderr 丢弃，
  **只解析 sentinel 前缀的绝对路径，绝不 eval**。
- **候选必须逐项验证**：真实存在且 `<tool> --version` 退出码为 0 才可采用。
- 只把「确实供给缺失工具」的目录追加进 child PATH；当前 PATH 已可用时**完全不改动**。
- 支持显式 override（绝对目录、禁止 shell expansion、严格拒绝、不静默 fallback）。
- 在 **唯一的 child environment 注入点**生效，Git / Codex child / verifier / repair 共用。
- **Codex 仍只从 bundle vendor 解析**，不因 PATH 修复而回退全局 codex。

### 修复（C：verifier preflight）

verifier 无法解析自身可执行文件时**不再 spawn bash**，直接产生结构化环境失败
`ENVIRONMENT_REQUIRED`（保留 verifier 身份、command 身份、缺失可执行名与可执行的安全说明），
不再落到 `UNKNOWN`。带路径的命令（`.venv/…`、`./…`）不判定，避免误伤未 bootstrap 的 repo-local venv。

### 结果

同一 real-host 链路上 `npm test` **PASS**，并由 MAC-REALHOST-002 端到端证明。

## 5. Packaged Runtime Evidence

`npm run desktop:package:smoke`（经平台 resolver 自动选中 macOS）：

| 检查 | 结果 |
| --- | --- |
| `node:sqlite`（create/insert/select/close） | PASS |
| libSQL darwin-arm64（真实 addon 从 .app 内加载） | PASS |
| Codex darwin-arm64（bundle vendor `--version`） | PASS |
| Launchpad | PASS |
| owned-origin 控制面 | PASS |
| Tray | PASS |
| single instance | PASS |
| background runtime | PASS |
| `powerSaveBlocker` | PASS |
| renderer recovery | PASS |
| strict shutdown | PASS |

环境指纹：`packaged:true`、Electron 44.4.3、Node 24.21.0、**darwin / arm64**、11 项 compat 全 PASS。

### 已发现并修复：.app 复制破坏 framework symlink

macOS `.app` 复制到临时目录后启动立即失败：

```text
icudtl.dat not found in bundle → GPU process isn't usable. Goodbye.
```

根因：Node `fs.cp` 默认会把 framework 内的**相对**符号链接改写成指向**源 app 的绝对路径**，
破坏 bundle 完整性。修复：macOS 侧使用 **`verbatimSymlinks: true`**。

回归验证（对分发产物同样执行）：

```text
absolute symlinks anywhere             = 0
symlinks pointing back at build source = 0
icudtl.dat resolves through symlinks   = present
```

## 6. Tray

原 `desktop/assets/tray.png` 是 **32×32 满画布不透明彩色方块**（1024 像素中 1008 不透明，
仅 16 透明；2 种颜色；从未 `setTemplateImage`）。作为 macOS status item 它既不是 template image、
又远超菜单栏尺寸，真人实测**菜单栏完全不可见**。

修复后的 macOS 语义：

| 资产 | 尺寸 | 说明 |
| --- | --- | --- |
| `trayTemplate.png` | 18×18 | 单色 template（复用原有白色笔画，黑 + alpha） |
| `trayTemplate@2x.png` | 36×36 | Retina 变体 |

- 平台适配器 `desktop/main/tray-icon.mjs`（唯一平台分支点），shared Tray lifecycle 保持无平台分支。
- `setTemplateImage(true)` 仅在 darwin 生效。
- `ready` evidence 新增可观测字段：`platform` / `asset` / `imageEmpty` / `imageWidth` /
  `imageHeight` / `templateImage`（不记录任何绝对用户路径），使 `tray:true` 不再是唯一证据。
- **Windows 保持原 `tray.png` 行为**，不设 template（有专门单测断言）。

真人确认菜单栏图标可见。

## 7. Distribution

| 产物 | filename | size | SHA256 |
| --- | --- | --- | --- |
| DMG | `NovaWing-0.4.0-arm64.dmg` | 246M | `2d2bec9e7124cc4a0c67ecf31e31deaa0dd988ded8cbe49ec45662bbe9af3596` |
| ZIP | `NovaWing-0.4.0-arm64-mac.zip` | 249M | `996b36d9ce6b49d7af1fc1bd24a193007ed185503a963faed1f89cb44c4f3072` |

```text
hdiutil verify:            PASS（checksum VALID）
DMG mount layout:          NovaWing.app + Applications -> /Applications
DMG app launch:            PASS（Finder/LaunchServices）
ZIP extracted app launch:  PASS（ditto -x -k 解包）
/Applications install:     PASS（ditto，未覆盖既有安装）
/Applications Finder launch: PASS
```

核心 bundle 内容哈希：

```text
bundleContentSha256 = 2ff8a1bdf976e82ded81cba20f9aa1f842e02e455ab79c5bc8885e698df40f46
```

该哈希在 **源码构建 / DMG 内 / ZIP 内** 三处一致；Codex 与 libSQL 二进制 SHA256 亦一致
（`98491713ffb19606…` / `3fd9e58190311b5e…`）。即**分发包装没有改变应用核心内容**。

**未宣称 DMG/ZIP container 可复现**：两次构建的容器哈希不同（首次 `8c44bb76…` / `64dba845…`），
仅应用内容哈希一致。未做 byte-for-byte reproducibility 验证。

## 8. Signing Limitation

```text
codesign -dv --verbose=4:
  Identifier=Electron
  flags=0x20002(adhoc,linker-signed)
  Signature=adhoc
  TeamIdentifier=not set

codesign --verify --deep --strict:  FAIL（exit 1）
  "code has no resources but signature indicates they must be present"

spctl -a -vv:                       REJECTED（exit 1）

valid Developer ID identities:      0
```

含义：`identity: null` 使 electron-builder 跳过签名，Electron 二进制自带的 linker ad-hoc 签名与
被改写过的 bundle 不再匹配，因此**结构验证失败**；同时**没有任何分发信任**。

**当前产物适合本地/开发验收，不代表正式 macOS trusted distribution。**
不得描述为 signed release / production-signed / notarized。

## 9. Gates

```text
npm run check:        PASS
  core:            1149 / 1149
  desktop:           74 / 74
  total:           1223 / 1223, 0 fail
git diff --check:     PASS（exit 0）
Platform boundaries:  PASS（197 files，adapter allowlist 精确登记）
```

新增测试：`tests/posix-toolchain.test.ts`（toolchain resolver A–K）、
`tests/verifier-toolchain-preflight.test.ts`、`desktop/tests/tray-icon.test.mjs`。

Windows 兼容性：`windows-package.mjs` 与 `windows-git.ts` 的改动为**纯新增 seam**
（+29 / −0），`auditPackage` / `prepareStage` / `packageWindows` / Git 发现逻辑一行未改；
Windows 分支的 `nativeNotificationGate` 恒为 `REQUIRED`，未放宽。
**本机无法运行 Windows 真机**，该结论是静态审查 + 全量单测的结论，非 Windows 执行结论。

## 10. Phase 1–5 Status

| Phase | 状态 |
| --- | --- |
| Phase 1 | PASS |
| Phase 1B | PASS |
| Phase 2A | PASS |
| Phase 2B | PASS |
| Phase 3 | PASS WITH FIXES（相关 fixes 已在 Phase 4 / 5 收口） |
| Phase 4 | PASS — Windows Package & Real-host |
| Phase 5 | PASS WITH SIGNING LIMITATION — macOS Package & Real-host |

> 溯源说明：Phase 1–4 的状态取自其已归档报告（`docs/audit/NovaWing-v0.4.0-Phase-*.md`），
> 本阶段未重新执行其验收。Phase 5 的状态由本报告所列证据直接支撑。

## 11. Phase 6 Readiness

```text
READY FOR PHASE 6
```

Phase 6 scope（本阶段只记录，未实现）：

- Windows GitHub Actions build / package
- macOS arm64 GitHub Actions build / package
- artifact upload
- full `npm run check` gate
- packaged smoke
- release workflow
- manual / tag publishing control

Phase 6 当前**不要求**：Apple signing、notarization、updater、Linux Desktop。

已知需在 Phase 6 解决的前提（见 §12）。

## 12. Known Constraints Handed to Phase 6

| # | 项 | 说明 |
| --- | --- | --- |
| P1 | 签名/公证凭据缺失 | 无 Developer ID 证书与 Apple 凭据。Phase 6 要么发布**未签名**产物并在 release notes 明示，要么先取得证书。**必须明确记录 unsigned macOS limitation。** |
| P2 | 需要 macOS 与 Windows 双 runner | DMG 只能在 macOS 构建（`hdiutil`）；Windows NSIS 只能在 Windows 构建（脚本硬断言 `win32/x64`）。需 matrix。 |
| P3 | electron-builder 二进制下载可靠性 | 本机构建首次遭遇 TLS 断连，改用 `ELECTRON_BUILDER_BINARIES_MIRROR` 才成功。CI 需固定 mirror 或预热缓存；**该 mirror 未固化进仓库**。 |
| P4 | `npm ci` 后需补 Electron 运行时 | npm 11 不执行 Electron postinstall；`requireInstalledElectron()` 会 fail closed，CI 必须显式运行 `node node_modules/electron/install.js`。 |
| P5 | Node 24 与全量门禁 | `engines` 要求 `>=24`；CI 需 `npm run check` 作为 gate，并跑 packaging 与 packaged smoke。 |

打包本身**不需要 Codex 凭据**（Codex 仅真实任务使用），Release pipeline 无付费/密钥依赖。

## 13. 未做（明确排除）

dmg 之外的安装器、Developer ID 签名、notarization、updater、CI release（Phase 6）、
Linux Desktop、公共 API cleanup、无关重构。
