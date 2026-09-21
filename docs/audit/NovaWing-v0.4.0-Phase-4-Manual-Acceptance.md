# Phase 4：安装版人工验收

**当前暂停全部人工 Gate**：新发现 Tray/COMPLETED Toast 唤醒白屏。先完成 [窗口修复及新安装包](NovaWing-v0.4.0-Window-White-Screen-Blocker.md)，本轮自动工作结束后停止；之后由用户验证新安装版窗口唤醒，再恢复下面尚未完成的清单。Quick Fill 修复包已被窗口修复包替代，勿使用旧 installer。

自动化结果与人工结果分开保存。2026-09-21 用户已确认旧安装包安装、开始菜单启动、close→hide、真实 Codex Task COMPLETED、Verification / Evidence / Checkpoint 通过（checkpoint `888a2e5`）及 Windows Desktop Notification 出现。下文原流程保留作为清单；不要重新执行已完成的付费任务。

## 当前等待点：新安装包 Quick Fill 人工验证

Phase 4 仍为 **BLOCKED**。本轮只修复 Quick Fill 并重建 0.4.0 安装包，停止 HUMAN_REQUIRED / uninstall / reinstall 等后续验收。旧安装包 obsolete，历史人工结果不等于新安装包结果；新 SHA 和自动门禁见 [Quick Fill 修复报告](NovaWing-v0.4.0-Quick-Fill-Blocker.md)。

用户后续安装新包后，首先只验证 Quick Fill，不创建或启动任务：

1. 将 [用户提供的完整原文 fixture](../../tests/fixtures/desktop-realhost-001.txt) 粘贴到 Task Brief 并点击 Quick Fill。
2. 确认 Workspace、Branch、Task ID、Codex、Auto Commit 开启、Auto Push 关闭、Reasoning High、邮件通知关闭。
3. 确认 Allowed Paths 实际为两行 `src/sum.mjs` / `test/sum.test.mjs`。
4. 确认 Acceptance Criteria 为 `npm test passes.`，现有 Required Evidence bindings 输入框为 `npm test passes. => npm test`（Verification Command 为 `npm test`）。
5. 只有这一项人工 PASS 后，才恢复下面尚未完成的 real-host 验收。当前不宣称新安装版人工 PASS。

## 1. 安装与真正 GUI 启动（历史流程）

1. 在 Explorer 双击 `D:\VSCode\nova-wing\artifacts\desktop\NovaWing Setup 0.4.0.exe`，完成安装。安装包未签名；记录 SmartScreen 是否出现，不关闭 Windows 安全功能。
2. 关闭开发 Electron、VS Code 和用于开发的 PowerShell/npm 窗口。在 Windows **开始菜单**点击 **NovaWing**。不设置 Git Bash 环境变量。
3. 确认 Launchpad 显示、托盘图标存在。回复“已从开始菜单启动”，或报告错误文字。此时先不要创建重复任务。

本轮在 Codex 中运行的门禁可能仍需几分钟；等报告确认自动门禁结束后再关闭终端。

## 2. 单次真实 Codex Task

已创建专用仓库；本机完整参数见 `artifacts/desktop/realhost-task.json`。仓库没有 remote，初始提交仅包含 package.json。

在 Launchpad 新建 Work Session：

- 项目目录：`C:\Users\Administrator\AppData\Local\NovaWingAcceptance\desktop-realhost-20260921-151419`
- 分支：`desktop-realhost-smoke`
- Task ID：`DESKTOP-REALHOST-001`
- Executor：Codex；使用产品默认 Auto 模型/High；保留当前 V2/Golden Path。
- Auto Commit：开；Auto Push：关；邮件通知：关。
- 允许修改路径（每行一条）：`src/sum.mjs`、`test/sum.test.mjs`。
- Acceptance criteria：`npm test passes.`
- Required evidence bindings：`npm test passes. => npm test`

任务原文：

```text
在当前测试仓库新增 src/sum.mjs，导出 sum(a, b)。
新增 test/sum.test.mjs，使用 node:test，覆盖正数、负数和 0。
运行 node --test。
只能修改 src/sum.mjs 和 test/sum.test.mjs。
不得修改 package.json，不得 push。
```

点击“创建并启动”后，确认 RUNNING，立即点窗口 X，让任务在后台继续。等待 COMPLETED 系统 Toast，亲眼检查 NovaWing 名称/图标，**真人点击 Toast**。确认窗口恢复并打开该 Session 的 COMPLETED 状态。不要用测试脚本 click handler 代替此步骤。

后续由代理读取 installed 诊断、执行账本、V2 Evidence、checkpoint SHA、git status/log/changed files，验证执行与提交次数、限定路径及 no push。用户无需手抄全部数据。

## 3. 其余人工硬门禁

- 安装版保持运行，将通知留在 Windows 通知中心后真人点击，验证对应 Session（当前对象保留窗口为 15 分钟）。
- HUMAN_REQUIRED 的真实业务通知仍需单独验收；不能用 USER_PAUSED 冒充，也不能把自动化 fake 通知结果记成人工 PASS。FAILED 为建议附加项。
- 再点击开始菜单 NovaWing，确认恢复原窗口，只有一个托盘/Runtime。
- 托盘 → 退出；从开始菜单重新打开，确认同一 Session 恢复，没有再次执行、checkpoint 或完成通知。
- Windows 设置中卸载 NovaWing，确认安装目录/快捷方式清理；再次运行同一安装器并从开始菜单启动，确认快捷方式正常、业务数据保留。

运行中通知中心点击是硬门禁。超出对象保留期及退出后 cold-start persisted click 尚未支持可靠 Session 关联，记录 DEFERRED。

## 自动取证位置

- 安装版本地事件：`%LOCALAPPDATA%\NovaWing\desktop\events.jsonl`（显式 data override 时在该目录下）。
- 自动 package smoke：`artifacts/desktop/package-smoke/result.json`。
- 安装包 size/SHA256/版本：`artifacts/desktop/installer.json`。
- 真实任务参数：`artifacts/desktop/realhost-task.json`。

只有安装、开始菜单、真人 Toast、真实 Codex、checkpoint、恢复及卸载等全部证据齐全后，Phase 4 才能 PASS 并提交；不 push、merge 或 tag。
