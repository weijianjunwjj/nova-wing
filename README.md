# NovaWing Core + Desktop

NovaWing 是本地 AI 研发 Harness：接收任务，在限定的仓库范围内调用执行器，由独立的确定性验证决定是否完成，保存工作会话并支持暂停、恢复和人工处理。

当前基线是 `v0.4.4`。Windows 与 macOS Desktop 的窗口、托盘、后台运行、通知、退出排空、更新和安装包构建链路继续保留。此分支去掉独立认知领域内核、V1/AskBridge 执行栈、早期实验及私有 npm 发布链路。

## 开发与验证

需要 Node.js 24+。Windows 使用 Git for Windows；macOS/Linux 需要 Bash 与 Git。普通任务使用本机 Codex SDK 与 ChatGPT 登录，DeepSeek 路由沿用原有配置。

```bash
npm ci
npm run check
npm run guardian:launchpad
```

`npm test` 在临时配置、数据、用户目录和独立 Git 身份下运行。模型入口使用测试替身；测试门禁拒绝启动真实 Codex/Claude 模型进程。测试不读写已有用户会话或数据库。

## 核心执行路径

真实生产会话默认使用 V2 状态与 Golden Path。普通任务先实现，再运行确定性验证；高风险任务自动进入 Controller 的风险、审查和人工批准路径。显式 V1 会话拒绝执行，应重新创建 V2 会话。

保留工作区权限与证据校验、Codex/DeepSeek 路由、持久化暂停和重启恢复、Git checkpoint、限额与执行所有权、人工处理、任务列表和工作会话控制 UI。拒绝的工作区修改直接暂停，不进入自动诊断。

Desktop 的离线 smoke fixture 可注入自己的假 runtime。这是测试入口，不提供真实 V1 执行器。

## Windows 与 macOS Desktop

```bash
npm run desktop:dev
npm run desktop:smoke
npm run check:desktop
```

`desktop:dev` 和 `desktop:smoke` 使用临时配置、仓库和数据，走假任务执行器。安装版使用真实 Launchpad 与本机工作会话。

| 平台 | 本机打包命令 | 产物 |
| --- | --- | --- |
| Windows x64 | `npm run desktop:package:dir`，`npm run desktop:package:smoke`，`npm run desktop:build:win` | NSIS 安装程序 |
| macOS arm64 | `npm run desktop:package:mac`，`npm run desktop:package:smoke`，`npm run desktop:package:mac:dist` | `.app`、DMG、ZIP |

原有 `.github/workflows/desktop-build.yml` 和 `desktop-release.yml` 继续保留。构建流程检查原生依赖、Codex 工具、打包内容、第三方声明、应用身份和更新元数据；发布流程沿用固定构建产物与独立公开更新源。此分支没有创建新版本 tag 或发布安装包。

| 平台 | 默认本机配置与数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/NovaWing` |
| macOS | `~/Library/Application Support/NovaWing` |
| Linux | XDG config/data 根下的 `NovaWing` |

`NOVAWING_CONFIG_DIR` 与 `NOVAWING_DATA_DIR` 可覆盖位置。SMTP 密钥沿用受保护的本机文件；邮件通知由可信配置显式启用。

## 仓库入口

- `packages/development-guardian`：执行器、验证、会话、Launchpad 和平台适配。
- `desktop`：Electron Main、窗口、托盘、通知、更新及对应测试。
- `scripts/platform`：Windows/macOS 打包、内容审计和更新元数据校验。
- `tests`：核心、平台与控制 UI 回归。

本地唯一公共包入口为 `nova-wing/development-guardian`，运行时代码和类型来自 `dist/`。根 npm 包继续保持 private；桌面产品版本独立记录于 `desktop/main/identity.mjs`。

此次基线选择、删除范围、回补修复和验证记录见 [Core Desktop Rebase](docs/plan/NovaWing-Core-Desktop-Rebase.md)。其余旧版本设计文档保留为历史资料；当前行为以本 README、此次记录和源码为准。
