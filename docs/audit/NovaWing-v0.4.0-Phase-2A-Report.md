# NovaWing v0.4.0 Phase 2A Report

日期：2026-09-21。范围：Windows x64 开发环境中的 Strict Desktop Host Shutdown + Runtime Lifecycle；继续使用既有 Launchpad → Production Work Session → WorkSessionRuntime → HTTP/SSE。

## 1. Changes

- Launchpad 新增 additive `shutdownMode: 'strict' | 'bounded'`，Desktop 明确选择 strict；共享 start/close Promise，登记完整 HTTP handler、startup hydration/preflight、scheduled recovery、create/start/delete/manual repair 及其 audit/notifier 延续。
- Launchpad 独立保存 Production app ownership 与每个 app 的共享 close；清理完成后才撤销 owner，失败保持可观察。status hydration 使用 allSettled，单个 probe 失败不能使其他 read-only Runtime 脱离 drain；probe 的 load/close 错误均保留。
- Production、Control Server、Controller 补齐 admission、共享 lifecycle、accepted operation drain、SSE/HTTP 清理与错误聚合。初始化失败也尝试 controller/runtime cleanup。
- ETA 的 strict drain 跟踪底层 runner；展示超时仍保留原 fallback 语义。三种既有 Windows notifier 和默认 dependency preflight 在 strict 模式等待 worker 的真实 close，保留既有超时/错误及默认 bounded 行为；没有新增通知产品功能。
- Desktop Host 与单一 Main shutdown coordinator 覆盖 startup 尚未赋值和 repeated quit；窗口工厂加载失败时释放尚未返回的窗口。
- 扩展 gated unit/integration tests、真实 Electron smoke、resource tracker evidence 和 README。

没有修改 Runtime、Golden Path、TaskController、TaskStateV2、Evidence、Checkpoint、Git finalizer、Codex 执行或 Task 完成语义；没有加入 Phase 2B 功能。

## 2. Shutdown Contract

```text
close 同步停止 admission / scheduled polling
→ 等待已接纳 startup、HTTP/control/recovery/repair operations
→ 逐个 owned resource cleanup，等待真实 Runtime / notification / storage drain
→ 聚合并传播错误
→ 仅成功后允许 Electron final app.quit()
```

Launchpad 的 HTTP handler 在收到 request 时登记，包含 body parsing 后的全部延续；关闭开始后新请求返回 503。Control mutation 的工作接纳点是 body 完整校验后同步进入 controller，读取中的 body 只算未完成 handler：关闭会等待其 response，但它不能在关闭后取得 mutation admission。已进入 controller 的工作继续安全 settle。

close 时同步关闭已启动 app 的 Control admission；正在创建的新 app 由此前接纳的 Launchpad operation 持有，完成 controller.start 后立即进入同一清理链。strict 不使用 bounded Promise.race；CLI 默认 bounded helper 保留。测试 runner 的超时仅判定门禁失败，不构成产品退出策略。

## 3. Start / Close Race

可控 deferred gates 和实际 listener 覆盖：close-before-start、hydrate pending、多个 hydrate 中首个失败而另一个仍 pending、preflight pending、listen callback pending、start 已完成、start 在关闭期间失败、新 app.start 与 cleanup 同时失败、Host startup pending、Main 尚未取得 Host。

共享 Promise 用精确 identity 断言，并在调用下层 owner 前缓存，覆盖下层同步重入 start/close/before-quit 的情况。关闭后断言无 listener、interval、live app 或 Runtime owner。反复 start 只能观察既有 operation，关闭后不能接纳首次 start。测试没有用固定 sleep 推测这些竞争顺序。

## 4. Production UI / Runtime Cleanup

| Owner / resource | 关闭语义 |
| --- | --- |
| HTTP | 先 gate 新 mutation；等待已登记 handler 和 startup；最终关闭 listener |
| SSE | 禁止新订阅；controller drain 后 end 全部 SSE，再 await HTTP close，避免相互等待 |
| Controller | 同步停止新 mutation、polling 和 ETA admission；strict 等待 hydrate/start/resume/approval/repair/checkpoint 等原始 Promise 及状态展示延续 |
| Runtime | 继续使用既有共享 close 和 workflow、storage、verification/checkpoint、notification drain |
| SQLite/libSQL | Runtime 原有 ledger、schedule store、analytics store、Mastra storage 逐项 close；真实 Electron 兼容性与重开测试保留 |
| Scheduler | Launchpad recovery interval 与 controller due polling 同步停止；已经接纳的 due preflight/dispatch 等到真实执行 settle |
| Preflight | strict 的默认 command runner 等待 worker close，超时/error 继续报告不可用；不会把 kill 请求当作已经退出 |
| Notifier / ETA | Runtime 原有通知队列 drain；既有通知 worker strict 等 close；ETA strict 等底层 runner，展示 timeout 不代表释放 |
| Control origins | 每个 Production close 的 finally 撤销登记；Host cleanup 最后清空 registry |

关闭后新到达的请求会关闭连接，包括 Host 校验失败的请求。真实网络回归使用只发 headers、不发完整 body 的新请求，证明被拒绝的连接不会拖住 listener close。

CodingExecutionStore 按操作打开和关闭数据库，没有新增常驻连接。SMTP 使用原有非 pool 发送和 Runtime notification drain。自定义 dependency seam 必须履行自身 Promise 所代表的资源所有权契约。

## 5. Error Propagation

故障注入证明：server.close 同步抛错仍执行 Controller/ETA 和 Runtime cleanup；多个 owner 报错保留在 AggregateError 中。Controller cleanup 抛错仍结束真实 SSE 并关闭 HTTP。Production hydrate 失败也尝试全部已有 owner，并用 `ProductionWorkSessionInitializationError.cleanupErrors` 区分普通初始化失败和清理失败。

普通 factory 错误在关闭前已被处理且没有 cleanup failure 时，不会永久污染后续正常 Quit；部分初始化的 cleanup failure 始终保留。关闭期间的 startup failure 会传播到 Host/coordinator。失败后不恢复 admission，也不授权 graceful final quit。

## 6. Electron Lifecycle

`before-quit` 在完成前 preventDefault；第一次创建 shutdown Promise，之后复用。coordinator 同时等待已接纳 Main startup 和 Host close；只有成功设置 completed 后调用一次 final app.quit，最后的 before-quit 放行，不递归启动另一轮 cleanup。

真实 Electron smoke 中关闭最后一个窗口并追加 Quit，共观察到 3 次请求、1 次 shutdown、1 次 Host close、1 次 final quit；两个隔离 Runtime 的 close attempt 各为 1。第二个真实 Production/Runtime workflow 被 fake task gate 持有，释放之前 shutdown 保持 pending，释放之后完成持久化并关闭。9 个关闭后 mutation 返回 503，没有新 Runtime 或 Task。

失败使用 `DESKTOP_SHUTDOWN_FAILURE` 输出嵌套结构化错误，开发入口设置非零 exitCode 且不宣称成功。smoke 必须同时满足机器记录 PASS 与真实进程退出成功，不能只凭 Electron exit code 0。

## 7. Test Results

正式门禁结果：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run desktop:smoke` | PASS；真实 Electron UI 与兼容性两轮，外部 exit/child/temporary cleanup PASS | `phase2a-desktop-smoke-final.log`、`strict-shutdown-result.json` |
| `npm run check` | PASS，exit 0；主测试 1038/1038，Desktop 17/17，无失败、取消或跳过；typecheck/unused/migration/exports/boundaries/platform 全部通过 | `phase2a-check-pass.log` |
| `npm run pack:check` | PASS；234 个 deterministic build files，236 个 tarball files；无 Desktop/tests/docs 泄漏 | `phase2a-pack.log` |
| `npm run consumer:selftest` | PASS；全新 tarball consumer 的 migration/proposal/approval/context/snapshot-import/deep-import-rejection | `phase2a-consumer.log` |
| `git diff --check` / `git diff --cached --check` | PASS；working tree 与 staged diff 均通过 | Git 工作树 / 暂存区 |

专项命令包含 Launchpad、Control、ETA、status probe、notifier 五个文件，74/74 PASS，无失败或跳过；新增 preflight worker 测试 5/5 PASS，并纳入最终完整 check。专项命令为 `node --test --test-concurrency=1 dist-tests/tests/work-session-launchpad-strict-lifecycle.test.js dist-tests/tests/work-session-strict-control-lifecycle.test.js dist-tests/tests/work-session-task-eta.test.js dist-tests/tests/work-session-status-probe-lifecycle.test.js dist-tests/tests/strict-notifier-lifecycle.test.js`。

首轮完整 `npm run check` 为 1027 tests / 1023 pass / 4 fail：一个既有断言要求保留单个 hydration error 的原对象，三个新增 status-probe 测试在进程内删除 libSQL DB 时遇到 EBUSY。前者恢复单错 identity、多错聚合；后者改为真实子进程退出后父进程检查清理，没有放宽错误断言或忽略 EBUSY。保留首轮日志和最终重跑日志。

第二轮主测试 1033/1033 PASS，但 exports 门禁发现初始化错误类经 wildcard barrel 进入公共 runtime exports，因此整轮仍判 FAIL。已将该类移入内部模块，保持既有公共 export allowlist，不通过放宽门禁解决；修正后单独 `npm run check:exports` PASS，再重跑完整 check。

第三轮主测试 1038 tests / 1037 pass / 1 fail：既有 `v0.3.0 production D` 在 `inspectRepository` 抛出 `production V2 repository inspection failed`。该 Git inspection block 与基准 HEAD 一致，失败早于 EXECUTE/VERIFY 和 shutdown；旧错误没有保留具体 Git 命令的 exit/stderr，因此无法确定具体原因。未改 Golden Path 或该测试；`node --test --test-name-pattern 'production D' dist-tests/tests/v030-golden-path-production.test.js` 单 case 复跑 1/1 PASS，`node --test dist-tests/tests/v030-golden-path-production.test.js` 全文件复跑 5/5 PASS。保留原始失败日志与独立复跑日志，不将这轮记成 PASS。

最终完整复跑主测试 1038/1038 PASS，包含上述 production D；随后所有静态、迁移、出口、边界和 Desktop 门禁通过，`npm run check` exit 0。源码在最终门禁期间保持冻结，最终 smoke 的逐 Runtime 单次 close 与子进程采样增强已包含在验证版本中。

关键契约的测试来源：

| 契约 | 测试 |
| --- | --- |
| shared start/close、startup await races、late app、handler/repair/recovery drain、默认 bounded | `tests/work-session-launchpad-strict-lifecycle.test.ts` |
| 所有 Control mutation、scheduled due dispatch、真实 SSE、部分 body、cleanup 多错和 Production race | `tests/work-session-strict-control-lifecycle.test.ts` |
| read-only Runtime probe 的 load/close 错误与子进程资源清理 | `tests/work-session-status-probe-lifecycle.test.ts` |
| worker timeout/error/exit 与真实 close 的区分、默认 bounded | `tests/strict-notifier-lifecycle.test.ts`、`tests/strict-preflight-lifecycle.test.ts` |
| ETA 展示 timeout 后继续持有底层 runner | `tests/work-session-task-eta.test.ts` |
| Host startup race、同步重入、Main 未取得 Host、repeated quit 和 failure | `desktop/tests/lifecycle.test.mjs` |
| 真实 Electron Quit、执行中 task gate、9 个关闭后 mutation、逐 Runtime 单次 close、SSE 和资源归零 | `desktop/tests/launchpad-smoke.mjs` + `scripts/desktop-smoke.mjs` |

机器可读证据及完整命令日志位于 Git 忽略的 `artifacts/desktop/bootstrap-smoke/`：

- `strict-shutdown-result.json`：`DESKTOP_STRICT_SHUTDOWN`，真实 Electron 的 shared close、reject、accepted drain、SSE、HTTP、Runtime、origin、timer、repeated quit、exit。
- `launchpad-result.json`、`result.json`：原 UI、数据库兼容性、进程与临时目录 cleanup。
- `phase2a-*.log`：专项、Desktop、check、pack、consumer 门禁。

start/close fault injection、scheduled dispatch 和多错误传播由 deterministic unit/integration tests 给证据，不将这些虚报成真实 Electron smoke 中的故障注入。

## 8. Compatibility

- 既有 CLI/default Launchpad close 保留 bounded 等待；专门 gate 测试证明底层工作仍 pending 时默认 close 可按原契约返回。Desktop strict 则必须继续等待。
- HTTP/SSE 路由、token/origin/CSP、现有 UI 和 Runtime 业务契约保持。新增 closing 返回仅用于生命周期拒绝。
- 包 name/version/exports/files、production/dev dependencies 和 lockfile 未变；Desktop 仍不进入 npm runtime tarball。
- 不重新设计架构、不重复 Phase 1/1B，不使用真实 Codex、真实通知或用户数据做本轮测试。

## 9. Findings / Remaining Risks

- Git Bash packaged discovery 未解决。全量 check 的 `NOVAWING_GIT_BASH_PATH=D:/Git/bin/bash.exe` 仅设置于当前命令进程，不是产品解决方案。
- real Codex quit duration 未认证；strict 没有强制退出时限，工作不 settle 就继续等待。
- Windows system shutdown/logoff、force kill、断电等不属于本轮受控 Quit 证明。
- packaged environment、其他 OS/arch、安装、签名、ASAR 和分发仍待后续验证。
- 本轮 smoke 使用隔离 v1 fake workload，证明 Host/ownership/HTTP/SSE lifecycle；不声称完成 V2 真实模型任务认证。
- 既有 Windows libSQL 在 close API 完成后可能仍保留临时 DB 的 OS handle；完整既有测试仍会打印相关 cleanup warning。本轮 status-probe 测试遇到 EBUSY，因此改用进程隔离，在真实 close 断言与子进程退出后由父进程验证文件清理。Electron 同样由外部 runner 验证退出后清理；不宣称进程内任何时刻都可立即删除 libSQL 文件。
- 完整回归曾遇到一次未复现的既有 V2 repository inspection 失败；独立复跑结果和最终完整 check 分开记录，未放宽该断言。
- 自动审批以 `blocked by policy` 拒绝清理首轮失败及诊断运行留下的六个 `novawing-status-probe-*` 临时目录，没有更具体原因；未绕过该拒绝。这些旧失败运行的临时文件保留在系统 Temp，不进入 Git，与最终隔离子进程和 Electron smoke 的正常 cleanup 门禁分别记录。

## 10. Git

```text
branch: feat/v0.4-desktop
HEAD before: a08861d167e31d266788c605a8f20390ba5435ce
HEAD after: 本报告所属提交，准确 SHA 见最终交付回复
commit: fix(desktop): enforce strict runtime shutdown lifecycle
working tree: 提交后的实际状态见最终交付回复
```

全部 Gate 通过后才提交实现和本报告。HEAD after 是包含本报告的提交，准确 SHA 和提交后 working tree 在交付回复中记录。原有未跟踪的 `docs/plan/NovaWing-v0.4.0-Desktop-Architecture-Survey.md` 保持原样，不纳入本轮提交。不 push、merge 或 tag。

## 11. Verdict

PASS

全部要求的正式门禁通过。strict close 不再以 bounded timeout 伪报完成，外围 owner 链共享关闭、停止 admission、drain 已接纳工作、逐项 cleanup 和错误传播已验证；Runtime 业务语义保持。判定范围为本报告明确记录的 Windows 开发环境与受控 Electron Quit。

## 12. Next Step

只有本轮 PASS 且审查通过后，才进入 **Phase 2B — Background Desktop Runtime**：close window → hide、Tray、single instance、show/restore/focus、renderer crash recovery、powerSaveBlocker。

Prevent Sleep 必须依据真实 operation activity observer，不能依据 durable RUNNING。到本轮结束即停止，等待审查。
