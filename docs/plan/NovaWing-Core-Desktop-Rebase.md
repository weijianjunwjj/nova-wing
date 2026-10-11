# Core + Desktop：v0.4.4 基线裁剪

## 目标与基线

从 `v0.4.4`（`9ddbeedfb69b07323e256eaca9a284504e66c1e3`）创建独立分支 `codex/core-desktop-v044`。以该版本已有的研发任务闭环和 Windows/macOS Desktop 为工程边界。原 `main`（`1bbd0748356ee9db3df70e197a6093064bb6e934`）及用户本机未提交的裁剪修改不被重置。

这次处理不是把 main 的全部后续提交重新搬回来。Planning、Delivery、Requirement、父子执行图和 v0.5 工作流不进入本分支。产品方向保持冻结。

## 保留

- Codex/DeepSeek 执行器、限额切换、工作区范围与执行所有权。
- Golden Path 的实现、独立确定性验证、证据绑定、受限修复与高风险 Controller 路径。
- V2 任务状态、SQLite/libSQL 持久化、暂停、重启恢复、人工处理、Git checkpoint。
- Launchpad、任务创建与会话控制 UI、定时开始、通知和已有任务展示。
- Electron 窗口与导航隔离、托盘、后台运行、防睡眠、单实例、严格退出排空。
- 原生通知、更新检查及安装准入、稳定应用身份、更新源和第三方声明。
- Windows x64 NSIS 与 macOS arm64 .app/DMG/ZIP 打包脚本，以及 Desktop build/release 工作流。

桌面产品身份仍为 0.4.4。本分支不创建 release tag、不覆盖旧安装包或更新源。

## 删除

- V1 Guardian 编排、GuardianWorkSessionTaskRunner、AskBridge/ChatGPT 与 10x Brain 适配器、委派传输。
- Bridge 安装/登录、早期 PoC、旧 dogfood/canary/benchmark/certification 运行入口及仅服务这些入口的测试。
- 独立认知主线的 `core`、`sqlite`、`testing`、`host-snapshot` 包及其专用测试。
- 该认知包的私有 npm 发布、consumer、migration 和 tarball 发布检查链路。
- 只服务旧 V1 dirty-worktree 会话的 production legacy adoption 命令。

工作会话自身使用的数据库、验证批准、执行账本与恢复代码继续保留。旧设计文档作为历史资料留存；不作为当前可执行功能说明。

## 定向回补

| 范围 | 来源与行为 |
| --- | --- |
| Codex SDK | `8ebce4e`：0.151.0 → 0.157.0 |
| 本地代理 | `b8edcf5`：保留既有 proxy/no-proxy，同时添加 localhost、127.0.0.1、::1 绕过 |
| 工作区范围与证据 | `681f183` 及其后续主线修正：绝对仓库权限规范化、路径越界拒绝、结构化 mutation failure、真实已有实现证据 |
| Codex 流终态 | 主线 Codex executor 修正：重连错误后的 completed 可用，真实失败、未检查工作区和拒绝修改保持阻断 |
| 无检查重试 | 主线 ExecutorRouter 修正：确认 no-op 后最多更换一次旧线程 |
| 测试隔离 | 主线临时目录与 Git 身份隔离；本分支再隔离 CODEX_HOME、移除继承模型凭证、拒绝启动真实模型进程 |

不回补 v0.5 的工作流依赖或专属会话权限设计。控制面沿用 v0.4.4 的 loopback、origin 与临时 token 保护。

## 收敛与边界

真实生产工厂默认采用 V2 和 Golden Path；高风险或不适用任务自动进入 Controller。显式 V1 配置在创建执行器和会话数据库之前拒绝执行。Desktop smoke 允许注入自有假 runtime，不提供真实 V1 运行入口。

被拒绝的工作区修改直接停止为 SAFETY_BLOCKED，不调用自动诊断、不运行 verifier，也不能被成功的读取或 completed 事件覆盖。Golden 初次执行和单次修复均执行该检查。事件日志保留结构化工作区失败证据。

注入执行器或 dispatcher 的测试不会隐式启动默认自动诊断模型；需要测试恢复时显式注入诊断替身。测试在临时配置、数据、用户目录与模型目录下运行。

## 验证

原 v0.4.4 基线：1180 个测试，1179 通过；1 个测试的固定时间使用 +08:00、断言却依赖主机本地时区。本分支将该测试的“明天上午”输入改为固定本地时间，保持其原有断言意义。

最终 `npm run check` 在 Linux/Node.js 24、主机默认时区下通过：

- 核心测试 959/959，Desktop 测试 195/195，测试隔离 canary 6/6。
- Typecheck、源码与 Desktop unused 检查、公共导出与深层导入拒绝、仓库与平台边界检查通过。
- 核心集成覆盖连续两任务完成与持久化、进程重启恢复、Golden/高风险 Controller、限额切换及其健康/原因事件、MCP 修改拒绝、Git 实际字节/暂存内容与 checkpoint 授权。
- Windows/macOS 打包适配器、资产和 Desktop Host/Updater 保留 v0.4.4 实现；离线 fixture 只移除已退休的 Brain 注入。后续原生 CI 修复见下节。

首次回归中，一个注入执行器的用例意外走入默认真实 Codex 自动诊断入口，检查已中止。随后隔离 CODEX_HOME 与继承模型凭证，加入真实模型进程阻断和 Promise 返回格式 canary，并禁止修改拒绝进入自动诊断。最终回归通过全部上述隔离门禁。

本次环境未运行 Electron 原生 smoke、NSIS、.app/DMG/ZIP 构建或实际安装验收；这些仍需在对应宿主或现有 CI 运行。没有覆盖任何旧安装包、release tag 或更新源。

## 原生 CI 修复（2026-10-11）

[首次双端构建](https://github.com/weijianjunwjj/nova-wing/actions/runs/38104059841)使用本分支提交 `7314099`。Windows 因新测试入口把盘符路径传给 ESM `--import` 而在核心测试前失败；现改为 file URL，并以真实测试子进程验证预加载和模型调用阻断。

macOS 的核心检查和 .app 构建通过。原生 smoke 暴露快速隐藏/显示时复用旧展示 Promise 的竞态；已先复现失败，再修正为重新展示同一窗口。初次展示还出现帧超时，macOS 适配器在明确展示意图下先激活应用；继续保留真实帧、可见性、截图和退出检查。未签名原生通知仍为 `NEEDS_SIGNED_VALIDATION`，不声明通知验收通过。

此分支推送自动运行原有 Desktop Build；Desktop Release 和更新源不变。原生验收结果以修复提交的 Actions 为准。

[第二轮双端构建](https://github.com/weijianjunwjj/nova-wing/actions/runs/38105835314)使用提交 `8153f1e`。macOS 完整检查、打包后窗口/托盘/严格退出 smoke、DMG/ZIP 与产物身份检查均通过；原生通知保持上述未签名限制。Windows 已通过 ESM 入口和隔离 canary，随后暴露 Git 识别兼容问题：运行器为 Git `2.56.0.windows.1`，Bash 身份为 `5.3.15(2)-release|UCRT64|cygwin`。旧门禁只接受 MINGW，导致 Git 依赖用例连带失败。

按 [Git for Windows 2.56 官方迁移说明](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1)，现接受 UCRT64 身份及 `ucrt64/bin` 自动发现，并让 shell 预检复用安装解析器的身份规则。仍要求完整安装布局、`msys-2.0.dll` 与 `.windows.` Git 版本；不接受普通 Cygwin 或 WSL。回归覆盖运行器原始身份、注册表与新 PATH 布局、缺失 DLL 和非 Windows Git 拒绝。
