# v0.4.0 窗口唤醒白屏 Release Blocker

**最终状态（2026-09-22）：RESOLVED。** 白屏修复已在 installed real-host 上人工复验 PASS，见 [Phase 4 Report](NovaWing-v0.4.0-Phase-4-Report.md) 第 5 节。本文件保留为历史过程记录，其 installer SHA 已 OBSOLETE。

日期：2026-09-21。分支 `feat/v0.4-desktop`，HEAD `1ce8111065051a7256d73a2d61d1551ea4fccf37`。Phase 4 仍 **BLOCKED / installed manual pending**。本轮暂停其他人工 Gate，不安装、不执行真实任务、不 commit / push / merge / tag。

## 已读取的安装版证据

首先读取 `%LOCALAPPDATA%/NovaWing/desktop/events.jsonl`，并保存只读快照到 ignored `artifacts/desktop/window-installed-events-before.jsonl`。最近一次 COMPLETED 通知：

- pid 6700，Session `desktop-realhost-20260921-151419-202609211327-353100`。
- 通知 show：`2026-09-21T13:28:52.121Z`。
- activation-unresolved：`2026-09-21T13:28:56.905Z`。
- 有效实例 click：`2026-09-21T13:28:56.914Z`。

旧 JSONL 只有启动、隐藏、通知和 power 事件，没有 load/paint 时序；不能用它断言当时发生 renderer crash。用户观察到的白屏与 Runtime/Task 未丢失按真实人工反馈记录，未冒充自动复现截图。

## 定位与修复

1. 旧 `showSession()` 对同一个健康的当前 Session 也无条件 `loadURL()`。现比较规范化 URL，健康同地址直接 restore/show/focus。
2. 旧 Session 导航与 renderer recovery 分属不同 promise，创建 promise 只约束首次 load；`showWindow()` 未等待恢复/Session 导航。现每个 BrowserWindow 的创建、Session 跳转和恢复共用串行 navigation tail，同地址在队列执行时再次判断，最多一个 Main loadURL 在途。
3. 需要切换 URL 或恢复 renderer 时保持 visible intent，但加载期间隐藏内容窗口；等待 loadURL 和 `did-stop-loading`，新窗口另外等待 `ready-to-show`。不使用固定 sleep，不关闭背景节流。
4. destroyed window 的 Session 点击直接创建到目标 Control URL，不先加载 Launchpad 再跳转。原有 live owned-origin 验证、映射撤销后的 Launchpad fallback、最后已提交可信 URL、安全窗口配置和严格退出语义保留。
5. 实际 Electron 测试确认 `loadURL()` resolve / `did-finish-load` 可以早于 `did-stop-loading`。首轮修复只检查 loading 状态会漏掉稍后的显示；已改成事件驱动等待并加入独立回归。
6. Tray 健康窗口的旧实现本身没有直接 reload；其白屏完整因果链缺少旧诊断证据。新实现对 Tray 和 activation 同样约束页面就绪，真实 Electron A 场景验证不导航及可见内容；安装版仍需真人复验。

仅调整 Desktop 窗口生命周期、Main 诊断接线和 Desktop 测试/smoke。Runtime / Golden Path / Evidence / Checkpoint 业务实现未在本轮修改，之前未提交的 Phase 4 与 Quick Fill 改动保留。

## 新诊断

安装版 JSONL 中增加 `event: window-lifecycle`，`phase` 记录 `show-request`、`session-click`、`navigation-start`、`navigation-reused`、`navigation-ready`、`did-start-loading`、`did-stop-loading`、`did-finish-load`、`did-navigate`、`render-process-gone`、`window-shown` 等事件。

记录时间戳、windowId、currentUrl、适用的 targetUrl、isVisible、isDestroyed、isLoading（主 frame）、Session identity。已有 notification click 事件保留，可按 timestamp 与 Session 对齐。不记录任务正文或凭据。

## 回归

27 项 deterministic window tests 覆盖原安全/退出/撤销行为、A–E、反向竞争、did-stop-loading 延后及首次绘制门禁。

真实 Electron 使用现有 Production Control UI 和离线 fake task，仅新增 Main 窗口观测；通知路由调用保留的真实通知 identity，不伪装真人点击 Windows 通知中心。截图在 Chromium 绘制帧后采集，并断言 document 完成、实际 Session 正确、正文存在且不是全白帧。

| 场景 | 期望及开发 Electron 结果 |
| --- | --- |
| A：hidden Control → Tray handler | 0 loadURL，0 did-start-loading，PASS |
| B：hidden same Session → notification route | 0 loadURL，0 did-start-loading，PASS |
| C：hidden different Session → notification route | 1 loadURL，PASS |
| D：destroyed window → notification route | 重建，直接目标页，1 loadURL，完成后显示，PASS |
| E：renderer crash + 同 Session click + show | 合并为 1 loadURL，最大并发 1，PASS |

全部 show 事件 `isLoadingMainFrame=false` 且已经出现 did-finish-load；截图非白比例约 0.99。Runtime 和 Task 计数保持不变。真实 smoke 的旧轮次失败记录保留：先定位 loading 事件顺序，再修复同步 show 截图的 Viz surface 探针问题；原有 crash 测试也改为先 await pendingRecovery，避免对已销毁的 frame 发起 executeJavaScript 而挂起。最终结果必须来自完整成功的 smoke。

## 门禁与新安装包

最终自动结果：**PASS**；安装版真人复验 **NOT_RUN**。

| 门禁 | 结果 |
| --- | --- |
| Window deterministic tests | 27/27 PASS |
| `npx tsc -p tsconfig.desktop.json` | PASS |
| `npm run check:desktop` | 70/70 PASS |
| `npm run check:platform` | PASS |
| `npm run desktop:smoke` | PASS；包括实际 Control UI A–E 回归 |
| `npm run desktop:package:dir` | PASS；5309 files 内容审计 |
| `npm run desktop:package:smoke` | PASS；新包 A–E 均通过，loads 依次 0/0/1/1/1，最大并发 1 |
| `npm run desktop:build:win` | PASS |
| `git diff --check` | PASS |
| installer hash / package hash / Main 源文件对照 | PASS |

新安装包：`artifacts/desktop/NovaWing Setup 0.4.0.exe`，218041745 bytes，仍为 0.4.0。

```text
installer SHA256:
def42c52fb09cc71874739b5d5b9b6a5822affa184bc00dd6325e2db25025da2

package content SHA256:
92756b8c02f2bedc11eea95133d559e0facc53e71a8833abf8b0ae52bda4de88
```

Quick Fill 安装包 SHA `2ec3f06a44cca3733ffd712ecf946f8b6e0c080def10e76ee1ba63be825e1e41` 对本白屏修复已 **OBSOLETE**。旧 installer/package 元数据保存在 `*-obsolete-before-window-fix.json`，未复用其 smoke 作为新包证据。

证据索引：`artifacts/desktop/window-final-gates.json`、`window-targeted-final.log`、`window-desktop-smoke-final.log`、`window-final-*.log`、`package-smoke/native-notification-result.json`、`window-package-evidence.json`。最后一项包含 installer 复算 SHA、package smoke 与审计 hash 匹配、两份 Main 文件与源码 hash 对照，以及新包 A–E 实测结果。HEAD 未变，全部改动保持未提交。

## 人工等待点

本轮只完成修复、自动验证和新 installer，随后停止。新安装版需真人重复 Tray hide/show、同 Session COMPLETED Toast 点击、不同 Session 跳转；核对新 JSONL 是否复用正确窗口、无重复导航、显示时不在加载。通过之前不恢复其他 Phase 4 人工 Gate，不宣称 Phase 4 PASS。
