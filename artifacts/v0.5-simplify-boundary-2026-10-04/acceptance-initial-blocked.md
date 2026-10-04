# v0.5 SIMPLIFY_BOUNDARY — BLOCKED / 未收口

日期：2026-10-04（Asia/Shanghai）。结果：**blocked**。这是一份停止现场报告，不是可合并或产品验收通过证明。

## 停止原因：执行边界失误

任务书明确禁止读写 `~/Library/Application Support/NovaWing`。第一轮 focused.log、第二轮 focused-v2.log 的命令未显式设置 `NOVAWING_DATA_DIR` / `NOVAWING_CONFIG_DIR`；当前 shell 这两个变量均 UNSET。

源码链路：Launchpad `startOnce()` → `resolveInitialExecutorMode()` → 默认 `readCodexAvailability()` → `new CodingExecutionStore(defaultCodingExecutionStorePath()).availability()`。macOS 的默认路径位于真实 NovaWing 目录；`CodingExecutionStore` 构造函数执行 mkdir、以可写方式打开 SQLite、CREATE TABLE IF NOT EXISTS，随后读取 availability。那些测试实际调用了 start，因此不能声称真实目录未被访问，亦不能证明只有只读访问。没有事前快照或文件访问审计，实际写入差异 UNKNOWN。

发现后停止实现及后续验证；没有再次读取真实目录、没有擅自回滚/删除/修复真实数据库。第三轮 focused-v3.log 已在 `/tmp/nw-simplify-check.XXXXXX` 创建的隔离 data/config 根下启动，但不能抵消前两轮违规。部分旧测试显式传入空 env 的路径还需逐一审计，后续仅设置父环境变量未必足够。

## Repo / 权限

- 开工前本地 main = `a827f91d52b8242b811360140742b3927c36b848`。
- 分支 `codex/v0.5-simplify-boundary`，工作树 `/Users/weijianjun/.codex/worktrees/v05-simplify-boundary/nova-wing`。
- 主工作区原有未跟踪任务书保留。旧 `v05-trusted-attestation` 工作树仅只读查看。
- 没有 commit、push、merge，没有修改客户仓库，没有运行真实模型或付费 API。
- 指定 Windows 永久记忆路径不可访问；已读取当前 AGENTS.md、CLAUDE.md、START_HERE、CURRENT_STATE、WORKFLOW 和本轮任务书。
- 非测试代码净增 119 行，未超过约 600 行停止阈值。新增依赖链接 node_modules 指向现有主工作区依赖，只用于编译；未包含在 patch。
- 使用 codex-security:fix-finding 的只读边界调查步骤；停止前尚未进入最终候选独立 review，未声称完成该技能的全部验证门槛。

## 修改完成情况

部分实现已写入，整体未验收：

- DeliveryStore：Host collector 唯一写入 attempt，启动时原子更新 latest 指针，前后 clean commit 检查，成功/失败记录、recordHash 损坏检测；JS #private evidence/write primitives。
- Runtime：独立 executionId 与原 evidenceId 分开传递；completion、持久化重开逐字段核验 latest attempt。保留 main 的 task commit ancestry；旧无 executionId 的本地证据不计 PASS。
- 外部验收：拒绝四种 body 身份字段；会话生成 acceptedBy，并用进程内 WeakSet 防止通过 Store API 仅构造角色对象。既有 plan/assertion/kind/evidence/clean target/immutable 检查保留。
- Launchpad/control-ui：共享同进程 operator session；一次性 ≤60 秒 bootstrap；HttpOnly/SameSite=Strict/Path=/ cookie；HTML/API 鉴权及 mutation Origin 检查；移除旧 token header、HTML token。
- Desktop/CLI：main 导航获得 bootstrap URL；诊断过滤 bootstrap query；CLI 启动终端打印 bootstrap URL。源码接线存在，但 desktop check/真实 Electron smoke 未运行。
- 没有新增 attestation/signing/package/process/storage engine，没有迁移或删除历史记录，没有新增人工验收 UI。

## 第 6 节逐条验收

| # | 本轮证据 | 状态 |
| --- | --- | --- |
| 1 F2-A 唯一 OWNER | 新增缺 owner / 重复 owner 的 gate 反例通过 | focused PASS；原 probe 未重放 |
| 2 F2-B reviewer 独立性 | main reviewer 代码未修改 | 本轮专项矩阵 NOT RUN |
| 3a 无 session，含/不含旧 header | 403，assessment 相等 | focused PASS |
| 3b 四种 body 身份字段 | 400 IDENTITY_FIELDS_NOT_ACCEPTED，无 acceptance 文件 | focused PASS |
| 3c 合法 session/body | 201，server acceptedBy/hash/displayName，重开与落盘一致 | focused PASS |
| 4 F3-A 无 Host collector 的自洽伪证据 | 公开 writer 不存在，recordLocalTaskCompletion BLOCKED，reopen BLOCKED | focused PASS；未补直接伪造 completion 文件的额外场景 |
| 5 F3-B C1 包装成 C2 | ledger 对 commit mismatch 返回 false；reopen BLOCKED | focused PASS；原 C2 完整 probe NOT RUN |
| 6 漂移与后一次 FAIL | verifier/blueprint/commit/runtimePlanHash 拒绝；真实 collector 后一次失败撤销原 PASS | focused PASS |
| 7 正向 Host → review → finalize；多任务 DAG | 四个历史正向用例均 PASS；新增真实子进程 collector → ledger → local completion → reopen PASS | fixture 流程部分 PASS；未声称所有多 owner DAG 端到端完成 |
| 8 重开 / 篡改 / 删除 / 截断 | 遍历 attempt 字段篡改、删除、截断和无 executionId 均 BLOCKED，原件还原后 assessment 相同 | focused PASS |
| 9 HTML/API 无 session、bootstrap | 两套服务均 403；cookie flags、一次性、超时、Origin、跨 control 导航通过 | HTTP focused PASS；真实浏览器 NOT RUN |
| 10 full + desktop | 未运行 | NOT RUN / 阻塞 |

四个旧失败的核心断言未改，diff 说明见 [test-adaptation.md](test-adaptation.md)。这些 PASS 不能抵消任务执行边界违规或全量检查缺口。

## 实际命令与结果

共同 cwd：本报告所在工作树；Node `v24.21.0`。未调用 npm install。

- `npm run typecheck`：中途通过（typecheck-current.log 后续被编译诊断覆盖，保留各轮原始日志）。最终 build/build:tests 通过，见 focused-v3.log。
- 最后一轮：`npm run build && npm run build:tests && node --test --test-concurrency=1 dist-tests/tests/delivery-obligation.test.js dist-tests/tests/delivery-runtime-plan.test.js dist-tests/tests/operator-session.test.js dist-tests/tests/work-session-launchpad.test.js dist-tests/tests/work-session-w005-a-server.test.js`：**151 tests / 150 pass / 1 fail / exit 1**。
- 剩余失败 `Browser delete confirmation removes only the successful card and reveals the empty state`：模拟 browserFetch 的 Node POST 没有添加 Cookie，服务端拒绝后 cardRemoved 仍 false。停止时没有修改其核心断言或继续修复。
- `git diff --check`：PASS。
- `npm run check`、`npm run check:desktop`、真实 Electron smoke、最终候选 review：NOT RUN。
- 原 F2/F3 probe：NOT RUN。替代 focused 结果摘录见 f2-f3-replay.log；不冒充原始 probe 重放。

## 四层结果

| 层级 | 判定 |
| --- | --- |
| 修改完成 | PARTIAL：A/B/C 主实现及大部分测试适配存在，停止前未收口 |
| 测试通过 | PARTIAL：150/151；全量与 desktop 未跑 |
| 流程通过 | 隔离 fixture 的四条历史正向恢复；完整产品流程 NOT RUN |
| 产品验收 | BLOCKED，待独立 review，不能交付为 v0.5 PASS |

## 诚实边界

Ledger 防 NovaWing API/工具通道的伪造重放及意外损坏，不防同 UID 进程直接改写 data directory；F3-C = **KNOWN_RESIDUAL**。recordHash 是损坏检测，不是签名。

本机能拿到 bootstrap URL 的人 = operator；本轮没有账号系统、OS principal 或 sandbox isolation。session 是同进程 Host 的本地逻辑权限；没有把它描述为多用户身份认证。生产 bootstrap TTL 为 60 秒，session 当前实现为内存 12 小时有效。

未再读取真实数据确认损害，因此真实数据影响仍 UNKNOWN。后续恢复应先建立覆盖所有旧测试 env/依赖的隔离运行方式，再继续剩余 cookie 适配、完整 F2/F3 probes、候选 review、full/desktop checks；本报告不自动授权检查或恢复真实数据。

## 交付物

[implementation.patch](implementation.patch)、[source-manifest.json](source-manifest.json)、[test-adaptation.md](test-adaptation.md)、[focused-v3.log](focused-v3.log) 与早期诊断日志均保留。full-check.log / desktop-check.log 明确记录 NOT RUN，没有虚构成功输出。
