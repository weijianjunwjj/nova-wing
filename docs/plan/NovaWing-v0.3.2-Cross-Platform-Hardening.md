# NovaWing v0.3.2 跨平台与持久化修复

范围：修复 v0.3.1 在 macOS arm64 冷启动发现的 6 个测试失败，不改变包发布版本、业务功能或既有任务权限。

## Scheduled persistence：证据与连接所有权

原实现中，`ScheduledStartStore` 用 `node:sqlite`，Mastra 的 `LibSQLStore` 用
`@libsql/client -> libsql`，两套原生 SQLite 引擎在同一进程访问同一个 session 文件。
`ExecutionLedgerStore` 实际访问既有的 `.execution-ledger.sqlite` 侧文件，不是此次同库冲突方。

在 macOS 14.3 arm64、Node 24.21.0、锁定的 libSQL 依赖上进行了以下隔离实验：

| 实验 | 结果 |
| --- | --- |
| 原实现，5 轮 SCHEDULED → COMPLETED → close/reopen | 5/5 失败；关闭后完整性检查发现 schedule 行 NULL 与索引不一致 |
| 原实现，关闭 Mastra mmap | 5/5 仍失败 |
| 仅将 schedule 的 driver 替换为相同 libsql，保持 SQL、文件和时序 | 5/5 通过，每轮 5 次 runtime 重开，完整性均 ok |

关闭前直接读取 Mastra workflow snapshot，已得到 `value.state=COMPLETED`、`status=success`。
因此原始正常完成后损坏不能归因于遗漏 await 完成快照。也未用 sleep、重试或 journal
模式切换作为修复。实验将问题隔离至同文件的混合 driver 生命周期，未对 SQLite 内部
具体页缓存/锁故障机制作未经验证的断言。

修复保留同一 session 数据库及原 schedule 表，改用 Mastra 自己依赖的同步 libsql driver。
解析沿 `@mastra/libsql -> @libsql/client -> libsql` 依赖链进行，避免偶然选中另一个 hoisted
或全局 driver；不新增依赖版本或修改 lockfile。同步 claim/cancel API、BEGIN IMMEDIATE、
owner PID 与死进程恢复规则保持。未来升级 Mastra 驱动依赖必须重跑这些回归。

这是**单一 driver、各 store 明确拥有连接**，不是单一物理连接：

- ScheduledStartStore 仅拥有并关闭自己的同步 libsql 连接；初始化失败释放该连接。
- Mastra 拥有自己的 client/内部事务连接，由 LibSQLStore.close 关闭。
- Ledger 继续拥有既有侧文件上的 node:sqlite 连接，不向 session 文件写入。
- 状态读取仍可能初始化 schema/pragma；不是物理只读，但必须保持 durable state 与执行次数。

`runtime.close()` 先关闭新操作入口，等待已接纳的启动、恢复、读取及其快照写入，再等待
通知持久化及 Mastra 初始化完成，最后关闭各自拥有的连接。重复 close 共享同一 Promise。
除本次关闭产生的 pre-dispatch 取消外，操作/关闭错误汇总向调用者报告。

dispatch 的接纳边界位于 `workflow.createRun()` 之前：边界之前关闭，任务不执行且可重启；
一旦开始 createRun，就必须等待整个 run 完成。不能在已写入 `pending/value={}` 后抛弃 run，
否则会留下无法恢复的空 snapshot。回归用受控 Promise gate 覆盖这两个边界和活动 TaskRunner。

原 T021 崩溃夹具用永不完成的任务加 `close()` 模拟进程异常退出，与明确的 graceful drain
语义不兼容。恢复回归改用独立子进程：等待真实 RUNNING/Task claim 已持久化，再终止进程，
新进程语义的 runtime 读取同一数据库。原有 RECOVERABLE、原 session identity 和不重复
已完成任务的断言保留，不把正常关闭伪装成崩溃。

Launchpad 曾把任何状态读取错误映射为 READY，掩盖了 SHORT_READ。现在读取异常传播，
不会把损坏的已完成会话当作新任务展示或重新执行。

## 独立 verifier 环境

原 `commandEnvironment` 仅在 Windows Git Bash 分支清除 NODE_TEST_CONTEXT。
在 macOS 中，`node --test` 子进程继承该变量后会跳过文件并返回 0，产生假通过。
现在所有 shell/verifier 使用清理后的基础环境，再为 Windows 注入原有 Bash 变量。
真实失败的子测试必须返回 1，并输出其断言错误；Golden Path 必须经历失败验证和修复。

## SDK bundled Codex runtime

executor 与 repair model 共用 `codex-runtime.ts`。六种平台/架构映射来自当前安装的
SDK 0.151.0 的 `findCodexPath` 及其 native package manifest：

| 平台 | x64 triple | arm64 triple |
| --- | --- | --- |
| Darwin | x86_64-apple-darwin | aarch64-apple-darwin |
| Linux | x86_64-unknown-linux-musl | aarch64-unknown-linux-musl |
| Windows | x86_64-pc-windows-msvc | aarch64-pc-windows-msvc |

依赖解析从 SDK 入口经 `@openai/codex` 到其 optional platform package，核验
`vendor/<triple>/codex-package.json` 和 `bin/codex`（Windows 为 `codex.exe`）。
不支持的目标或缺失的安装文件明确返回 configuration_error，不查 PATH 或全局 codex。
本机已实际解析 darwin-arm64 二进制并执行 `--version`，得到 `codex-cli 0.151.0`。

## 路径断言

NOVAWING_CONFIG_DIR 测试用本平台 tmpdir 构造绝对路径，并比较 resolve 结果。
保留 LOCALAPPDATA 的 join 语义测试，不更改生产 path.resolve 行为。

## 既有 reliability 脚本的证据契约

额外验收发现 `reliability:v030` 的真实子命令全部返回 0，但脚本只报告 name/status，
遗漏当前 Golden Path 要求的 stepId/command/cwd，10 次均被正确拒绝为 EVIDENCE_MISSING。
脚本现在把已实际执行的计划步骤身份、工作目录和真实 exitCode 一并报告。
没有修改 Golden 完成门、脚本通过阈值或验证命令，不把缺失证据直接判作通过。

## 验证边界

定向测试覆盖持久化重启/多实例 claim/关闭、真实失败 verifier、六平台映射及 Launchpad。
Windows Git Bash 环境及 Windows/Linux runtime 映射可在本机单元验证。
Windows/Linux 原生执行、文件锁与完整生命周期仍需相应真机 CI；Windows 标记为
NEEDS_WINDOWS_CONFIRMATION，不以 macOS 结果宣称已完成 Windows 真机验收。

## macOS 最终验收记录

环境：macOS 14.3 arm64，Node v24.21.0，npm 11.19.0。

- Scheduled start/recovery 定向：39/39 PASS；真实崩溃恢复定向：8/8 PASS。
- Executor/verifier + Golden production：38/38 PASS；Codex + repair：39/39 PASS。
- Launchpad：48/48 PASS。
- `npm run check`：958/958 PASS，0 failure、0 cancelled、0 skipped；全部后续工程门禁通过。
- `npm run consumer:selftest`：PASS，独立 tarball 消费者闭环通过。
- `npm run reliability:v030`：10/10 COMPLETED，10/10 COMMITTED，每次 EXECUTE/VERIFY 各 1 次。
- 最终独立进程探针（脱离 node:test）：5 轮，每轮 5 次 runtime 重开；SCHEDULED 保持、
  到期仅执行 1 次、后续保持 COMPLETED，每次关闭后 `PRAGMA integrity_check = ok`。
- `git diff --check`：PASS；package.json、package-lock.json、README 保持不变。

一次性探针、原始日志、数据库和 reliability 产物均位于 Git 忽略的 `.tmp/` 或 `artifacts/`，
不随代码提交。自动化测试的 reusable crash fixture 属于正式回归测试资源。
