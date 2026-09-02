# Codex Local Executor 与额度接力

## 范围与入口

2026-08-31。Scheduler 已先单独提交为 `968afd1`（`feat: add durable scheduled task starts`）。本适配不改变 Scheduler 状态机，不执行 Flyweave T026，不创建下一任务。

复用现有 `GuardianRecoverableExecutor`、`ExecutionReport`、Guardian review/revise、独立 verification 和 WorkSession checkpoint。生产入口为 `createProductionWorkSessionUi`，在原 executor factory 位置装配 `ExecutorRouter`。

仓库中的原编码实现实际是 `ClaudeCodeExecutor` 调用本地 Claude CLI，本机将其路由到 DeepSeek；不是独立的 DeepSeek SDK agent。新的 `DeepSeekExecutor` 只为这条现有链增加 provider 配置检查，保留原 prompts、continuation、verification 和恢复机制，不增加 Claude 产品模式。

### 修改文件清单

- 依赖：`package.json`、`package-lock.json`。
- 新增 runtime：`packages/development-guardian/{coding-executor-config,codex-error,codex-executor,codex-workspace-tools,executor-router,deepseek-executor}.ts`。
- 复用接口/验证：`packages/development-guardian/{claude-code-executor,model,ports}.ts`。
- 持久化/装配：`packages/development-guardian/work-session/{coding-execution-store,checkpoint,production,dependency-health,guardian-task-runner}.ts`（其中 store 为新增）。
- UI：`packages/development-guardian/work-session/control-ui/{controller,events,view}.ts`、`packages/development-guardian/work-session/launchpad/{server,view}.ts`。
- 新增测试：`tests/{codex-executor,codex-production-wiring,deepseek-executor,executor-router}.test.ts` 与 `tests/codex-test-fixture.ts`；扩展 `tests/{work-session-dependency-preflight,work-session-launchpad}.test.ts`。
- 验证脚本：`scripts/codex-local-smoke.mjs`；说明：本文。

未修改 Scheduler runtime、schedule policy 或已有调度状态机；未增加公共 package runtime exports。Codex 适配保持为工作区改动，没有连同 Scheduler 提交、没有 push。

## 配置

在已有 trusted WorkSession JSON 中增加以下字段；其余必需字段保持不变：

```json
{
  "executor": {
    "defaultMode": "auto",
    "model": "sonnet",
    "maxTurns": 12,
    "allowNpmInstall": false,
    "allowPythonBootstrap": false
  },
  "codex": {
    "enabled": true,
    "model": "gpt-5.6-sol",
    "reasoningEffort": "medium",
    "quotaProbeCooldownMs": 900000
  }
}
```

`executor.model` 仍为已有 DeepSeek CLI alias，不用于 Codex。每个 trusted Task 可用 `executorMode` 覆盖 session 默认值。省略模式默认 Auto；旧的 DeepSeek Off-Peak 配置在没有显式模式时保持 DeepSeek。默认值集中在 `coding-executor-config.ts`。显式禁用 Codex 不会静默改模型或 provider，需选择 DeepSeek。

| 模式 | 首选 | 额度耗尽 | 同一 Task 后续 |
| --- | --- | --- | --- |
| Auto | Codex（已知阻断期直接 DeepSeek） | 安全即时接力到 DeepSeek | 保持 DeepSeek |
| Codex | Codex | 现有可操作 HUMAN_REQUIRED/恢复路径 | 不自动调用 DeepSeek |
| DeepSeek | 原本地 DeepSeek 链 | 使用原错误处理 | 不调用 Codex |

## SDK、认证与有效配置

- 固定 `@openai/codex-sdk@0.151.0`，使用其随包提供的 Windows CLI；当前主机 Node 24.14.1、npm 11.11.0。实际 SDK 类型支持 `startThread`、`resumeThread`、`runStreamed`、per-thread model/reasoning/sandbox/approval。
- 在目标 repo 的工作目录中执行 bundled CLI `login status`，仅接受 ChatGPT 登录；`mcp list --json` 仅用于读取继承服务器名称，不输出配置或凭据。
- 子进程环境使用白名单，移除 `OPENAI_API_KEY`、`CODEX_API_KEY`、Anthropic/DeepSeek keys 以及桌面内部权限标志；不设置 SDK `apiKey`。执行范围内强制 `forced_login_method=chatgpt`、`model_provider=openai`。不修改用户全局 config，不提供付费 OpenAI API fallback。
- 最终传入 SDK thread 的默认值为 `model=gpt-5.6-sol`、`modelReasoningEffort=medium`。不支持模型时明确报错，不降级到 Terra/Luna/旧模型。
- 原生工具使用 `sandboxMode=read-only`、`approvalPolicy=never`、网络关闭、web search 关闭、无额外目录。关闭 shell、hooks、plugins、apps、多 agent、浏览器、GUI、图像生成等工具。

### Windows / WSL development runtime gate

在 Windows 上，Codex Executor 现在显式选择 `Ubuntu-24.04`，通过 `C:\Windows\System32\wsl.exe -d Ubuntu-24.04 --cd <workspace> --exec /usr/bin/bash -lc ...` 验证目标 workspace、bash 和 Git。`docker-desktop` / `docker-desktop-data` 永远不能被选为开发发行版；发行版名、Windows drive path、工作目录或 Git inspection 不可信时 fail closed。WSL Git 需与 Windows Git 使用一致的 `core.autocrlf`，并只为已确认的 `/mnt/d/VSCode/...` workspace 配置 `safe.directory`。

该 gate 负责确认开发 Linux 环境，不授予模型任意 shell。Codex CLI 仍使用官方 Windows bundled binary 和 ChatGPT 登录；repo I/O 只通过下述 scoped MCP bridge。Guardian 在写入 `EXECUTING`、增加 iteration 或启动真实 Executor 前，先运行一次真实只读模型 preflight，要求 Codex 实际完成 `git_status`、根目录 `list_files` 和 `package.json` 的 `read_file`。缺少任一工具证据时停为 `EXECUTOR_ENVIRONMENT_UNAVAILABLE`，不会制造一次假执行记录。

### 为什么不是直接 workspace-write

workspace-write 不能表达 NovaWing 每个 Task 的细粒度 allowed/forbidden paths。采用更窄的原生 read-only，并在本机回环地址启动仅服务当前 turn 的受限 MCP 文件桥。只有六个操作：list/read/write/delete 文件、git status、git diff summary；不存在任意 shell/命令执行入口。写操作先验证 Task scope，拒绝系统配置目录、路径逃逸、Windows 特殊文件名、symlink/junction/hardlink。文件读写上限 512 KB。

该六工具服务器在本次执行配置中明确批准；其他继承 MCP 逐个禁用。随机 capability URL 不进入 execution report 或 UI；关闭时先撤销能力并等待队列完成，再关闭 HTTP 连接。原生 Codex 即使异常遗留，也不能继续通过该桥写入。

实际 0.151 runtime 有两个需要实测才能发现的细节：CLI `-c` 的 dotted key 不按 TOML 处理带引号的路径片段，故对服务器名称使用安全 bare key，无法安全表示时 fail closed；Sol 的工具执行仍需要 `code_mode_host=true`，关闭它会使 MCP 一并不可用。保留必要工具宿主并不授予 shell 权限。

## 错误、额度与 Circuit Breaker

`classifyCodexError` 集中分类 `quota_exhausted / auth_required / transient / configuration_error / model_unavailable / unknown`。优先处理嵌套 structured code/status/metadata；普通 HTTP 429/5xx、连接故障是 transient，默认有限重试一次。401/登录失效、配置错误、模型不可用、未知错误均不自动接力。

模型 turn 正常结束但没有任何 workspace inspection 证据时单独分类为 `no_op_execution`。零变更 no-op 显示 `EXECUTOR_RETRY_REQUIRED`，用户确认 runtime 已修复后复用原 Task ID、scope 与 recovery lineage，丢弃不可信的空报告与该 no-op Codex thread ID，再以同一 executor 配置启动新 thread；若 repo 已有真实改动，则保留改动、移除仅表示证据丢失的 no-op blocker，继续既有 scope check 与 deterministic verification，绝不 rollback 或覆盖。其他恢复类型仍保持 Exact Resume，不会因普通错误轮换 thread。

Windows code-mode host 在长 turn 中可能返回结构化 `ENAMETOOLONG`。它与连接重置、超时同属有限 transient runtime 错误，Router 只自动重试一次，不切换 DeepSeek。若旧版本已把这类错误写成 `FAILED / EXECUTOR / PROVIDER_ERROR` 且 repo 留下真实修改，`recoverFailedExecutorWithCheckpoint` 仅接受同 session、同 Task、同 repo/branch 且通过 fingerprint 验证的显式 checkpoint，把原 Mastra step 恢复为 suspended 后走既有 recovery continuation；不删除旧 snapshot、不创建新 Task、不放宽 scope，也不恢复其他 FAILED 类别。

SDK 0.151 的 `ThreadError` 类型只有 message，没有稳定的结构化 quota/reset 字段。因此保留少量集中 message fallback（例如官方 usage-limit 消息），不把字符串判断散布到 router。结构化 reset/retry 信息支持未来/注入的明确错误；不能宣称当前 SDK 每次都提供它。

仅确定 quota 时持久化 global availability。可靠 `reset_at/resetAt/retry_after/retryAfter` 决定 `blockedUntil`；否则使用集中配置的 15 分钟低频 cooldown（可配 1 分钟至 24 小时），这是下一新 Task 的 probe 时间，不是“额度已恢复”的保证。没有“启动时间 + 5 小时”的逻辑。阻断期 Auto 新 Task 直接 DeepSeek；到期后新 Task 重试 Codex，成功才标记 available。旧 Task 的 sticky DeepSeek 不受恢复影响。

## Thread、持久化与工程接力

一个 Task 首次 startThread，收到 `thread.started` 即同步持久化 ID。之后每轮重新绑定当前 scoped tools，但调用同一 ID 的 resumeThread。ID 同时进入 provider checkpoint；重启时优先使用较新的本地 durable metadata，防止旧 checkpoint 把已接力 Task 切回 Codex。

默认本地协调库：`%LOCALAPPDATA%/NovaWing/coding-executors.sqlite`。metadata、events、handoff、workspace lease 与 global quota availability 独立于 Task 生命周期；不同 session storage URL 仍共用 workspace guard。Task key 为 session ID + Task ID，workspace key 使用 realpath（Windows 大小写归一化）。这些本地数据应与其他 NovaWing 状态一起保护和备份。

handoff 与 sticky failover event/metadata 在同一个 SQLite transaction 中写入，包含：Task goal、constraints、acceptance、do-not-do、allowed/forbidden paths、当前 decision/state、真实 git status、diff stat、changed files、HEAD/branch/worktree fingerprint、可信历史测试与已执行命令、最后工程总结、未解决失败、Reviewer feedback、verification requirements、已批准 scoped verifier。历史测试明确标记需在部分修改后重新验证，不冒充当前通过。

DeepSeek 首先检查真实 repo，保留已有修改；使用现有 checkpoint 验证授权 dirty continuation。重启仍能读到 handoff；新 recovery checkpoint 优先于旧 handoff fingerprint。不复制私有 reasoning、隐藏内部状态、认证信息，不做 reset/restore/rollback，不创建新 Task。

## 单写者与验证

SQLite 原子 workspace lease 覆盖 Codex turn、文件桥撤销、handoff、DeepSeek execute 和独立 verification。相同或不同 Task 同 repo 的第二个 executor 会被拒绝。

若本地 provider 在已产生改动后因受支持的瞬时错误失败，并且进程终止未能确认，lease 会继续保留。只有显式的 failed-Executor recovery、同一 Session/Task/repository/branch 的已验证 checkpoint，以及受支持的瞬时失败账本证据同时成立时，production runtime 才会删除该 Task 的精确 lease；普通启动、PID 消失或超时不会自动夺取所有权。一次恢复若先被陈旧 lease 拒绝，后续显式恢复只接受紧邻的原始瞬时失败证据。

Claude CLI / DeepSeek handoff 的长 prompt 不进入 Windows argv。超过安全阈值的 prompt 通过子进程 stdin 传输，CLI 参数仍保留 `--print`、输出格式、权限、turn budget、模型和 exact resume identity，避免 handoff evidence 触发 `spawn ENAMETOOLONG`。

`runStreamed` 必须消费到 EOF：收到 quota 事件不能立即 break 或启动 DeepSeek。仅在 execute 完整返回、文件桥撤销、ownership 确认释放、且没有 scope/其他硬 blocker 时接力。若旧命令 runner 超时而进程退出不能确认，保留 lease，阻止重试和接力。外部 quota availability 更新不会打断正在运行的 turn。

Codex 和 DeepSeek 都返回原 `ExecutionReport`，附加 execution metadata。Codex 自述“tests passed”不是验证证据；仍由原独立 allowlist/scoped-approval verifier 执行，包含 staging-equivalent `git diff --check`。scope violation 优先阻断，不能利用 quota failover 绕过。

## UI 与 Scheduler

Composer 默认 Auto，提供 Auto/Codex/DeepSeek 及解释；仅 DeepSeek 显示闲时快捷选项，切走时自动清除该选项。API 同样拒绝显式 Auto/Codex + DeepSeek Off-Peak，旧省略模式的闲时请求兼容。模式加入幂等请求比较并持久化。

详情页轻量展示 mode、active executor、model、reasoning、接力原因/安全错误；不展示 thread ID、私有推理或环境。Launchpad 只做通用依赖预检；运行时根据下一/当前 Task 的持久化 active executor 检查，纯 Codex 不要求 Claude CLI，sticky DeepSeek 不要求重新登录 Codex。

Scheduler 的 Immediate/Off-Peak/Custom、到点领取、等待不计时、restart recovery 均沿用已有实现。运行中 quota 接力立即执行，不等待闲时。

## 验证与尚存边界

测试覆盖 Router 三模式及六类错误、effective SDK options、真实 MCP 传输、路径/链接/撤销拒绝、drain-to-EOF、真实两文件部分修改 handoff、单写者、未确认退出、thread/sticky restart、cooldown/resetAt、生产 Guardian/UI 装配、Composer 模式/API/幂等及原 Scheduler 回归。

真实本机 smoke 使用 ChatGPT allowance，只在临时 repo 做一个指定文件的微小编辑和同 thread 恢复，不运行任何用户项目任务：

```sh
npm run build
NOVAWING_CODEX_SMOKE=1 node scripts/codex-local-smoke.mjs
```

真实 smoke 已通过：仅 `src/a.ts` 从 1 改为 2、blockers 为空、独立 `git diff --check` passed、thread 已捕获；新 Executor 实例用 checkpoint 恢复同一 thread，`restartSameThread=true`、continuation blockers 为空、再次独立验证 passed。没有依赖 Codex Desktop 窗口。

第一轮标准 `npm test`：588/588 通过。增补生产装配和 DeepSeek 配置测试后，重新 build/build:tests，并对全部 `dist-tests/tests/*.test.js` 使用 `--test-concurrency=2` 运行：593/593 通过，0 failed/cancelled/skipped，耗时约 311 秒。Windows/WSL preflight 与 no-op recovery 增补后，标准 `npm test` 为 601/601 通过、0 failed/cancelled/skipped，耗时约 474 秒；另有 13/13 定向 Codex/no-op recovery 测试通过。正常 `npm test` 不调用真实模型、不消耗额度。

类型检查、unused、模块边界和 schema migration 验证通过，`git diff --check` 通过。`check:exports` 仍因已有 runtime-export 白名单不同步而失败；Scheduler 交付已用未修改的 archive baseline 复现同样问题，本次没有增加公共 runtime exports，所以不声称聚合 `npm run check` 全绿。

浏览器实测确认 Auto 默认值、DeepSeek 闲时显示/隐藏、切换 Codex 清除闲时选择、隐藏无关 DeepSeek model alias，以及控件布局；页面 console 无错误。使用 `openai-docs` 技能核验 SDK/auth/config 的真实接口，使用 Browser 技能验证产品交互；未自动化 Codex Desktop。

真实限制：

1. 没有为了验收故意耗尽用户真实额度；quota/DeepSeek 接力使用可控错误注入与真实临时 working tree 测试。未声称完成真实余额耗尽后的付费 DeepSeek 端到端测试。
2. SDK message-only 错误格式仍可能变化；不能识别的消息安全进入 unknown，不自动 fallback。
3. 父进程硬崩溃后不能证明旧 CLI 子进程已退出，所以不会按 PID/TTL 自动偷 lease。必须先由操作者确认旧 writer 已停止，再针对该 workspace 的 lease 做受控恢复；不能通过删除整个状态库恢复。正常 checkpoint/restart 与 sticky resume 已覆盖。
4. Scoped file bridge 是更保守的能力集：不支持任意 shell、直接联网、链接文件、二进制或大于 512 KB 单文件写入。需要这些能力的任务应使用现有授权流程或显式 DeepSeek，不能擅自放宽 Codex 权限。
5. DeepSeek 依赖本机既有 Claude CLI → `https://api.deepseek.com` 配置；配置不匹配时明确阻断。未新建 DeepSeek agent loop，未更改全局 provider 设置。
6. OS 用户或外部程序仍能直接修改 repo；本地 lease 约束 NovaWing executor，不是抵御同用户恶意进程的 OS 锁。checkpoint/scope 检查继续是漂移防线。
7. `npm audit --omit=dev` 报告现有 Mastra 依赖链的两项 low（`@mastra/core`、`@ai-sdk/provider-utils`），没有 moderate/high/critical；本任务未顺手升级无关依赖。部分原回归测试仍报告 Windows libSQL 临时 DB 句柄占用/清理警告，断言全部通过。

## 用户要求的 20 项交付索引

| 项 | 结论 / 对应说明 |
| --- | --- |
| 1 修改文件 | 见“修改文件清单”，Scheduler 已独立提交 |
| 2 SDK 接入 | 官方 SDK 0.151.0，生产 ExecutorRouter 工厂，runStreamed |
| 3 本地 ChatGPT auth | bundled CLI login status 实测通过；执行前逐次检查 |
| 4 API key fallback | 环境白名单 + forced ChatGPT + 不传 apiKey，无 OpenAI API fallback |
| 5 effective model | `gpt-5.6-sol`；SDK options 测试与真实编辑通过 |
| 6 effective reasoning | `medium`；SDK options 测试与真实编辑通过 |
| 7 Router | Auto/Codex/DeepSeek；仅 quota 安全接力；同 Task sticky |
| 8 quota 识别 | 集中 structured classifier + SDK message-only 最小 fallback |
| 9 错误区分 | 六类；auth/config/model/unknown 不接力；transient 有限重试 |
| 10 thread 持久化 | SQLite metadata + provider checkpoint；事件到达立即落盘 |
| 11 continuation | 同 ID resumeThread；新 Executor 实例真实恢复通过 |
| 12 handoff | 真实 repo/checkpoint、任务边界、历史测试、工程总结、Reviewer、验证授权 |
| 13 单 writer | workspace 原子 lease；drain EOF；撤销并排空文件桥后接力 |
| 14 circuit breaker | global quota state；可靠 reset 或集中 cooldown |
| 15 quota 恢复 | 新 Task 到期 probe，成功恢复 primary；旧 Task 不回切 |
| 16 Scheduler | 原语义保留，完整回归通过；active failover 不等闲时 |
| 17 UI | Composer 选模式、闲时互斥；详情展示执行器/模型/接力；浏览器实测 |
| 18 新测试 | SDK/路径/MCP/EOF、Router/handoff/lease/restart/quota、生产装配、DeepSeek 配置、UI/API |
| 19 全量回归 | 593/593；静态/边界/migration 通过；既有 exports 白名单失败已披露 |
| 20 真实风险 | 见上面七项；不声称人为耗尽真实额度或真实付费 DeepSeek E2E |

## 依据

官方 [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[认证](https://learn.chatgpt.com/docs/auth)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)，以及随包实际 TypeScript declarations/CLI 帮助。MCP per-server approval 与工具宿主依据官方 [configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)、[feature definitions](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)，并用本机 bundled runtime 验证。
