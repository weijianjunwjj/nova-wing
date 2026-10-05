# v0.5 follow-up：脚本静态隔离分类

核查日期：2026-10-05（Asia/Shanghai）。基线：`43c471ba3dbc49ef877e9c5c0f07509195968ce5`。
仅阅读入口及其直接相关依赖源码；下列五个 npm 脚本均未修改、未运行。
“可能”表示源码中的默认依赖路径可达，不表示本轮发生了访问。没有读取、写入或 stat 真实 NovaWing 数据目录。

| npm 脚本 / 入口 | platformPaths 默认路径 | 真实 provider 配置 | 网络 | 建议 |
| --- | --- | --- | --- | --- |
| `certify:v0.2` — `tests/certification/v0.2/run-certification.ts` | 是，间接经 Launchpad / production 默认依赖；场景 repo/data fixture 未覆盖全部默认 store、audit、config 根 | 可能：未注入的 reviewer route、coding availability、managed runtime policy 使用生产默认解析；主要 provider/reviewer/repair 回答已脚本化 | 本机 HTTP：是；外部模型：Layer A 回答脚本化，Layer B 即使 `NOVAWING_CERT_LIVE=1` 也标 `NOT_RUN`；真实 route/config 默认路径仍需隔离 | **需注入 fixture**：先补齐 data/config/provider-route/availability/policy 依赖，再用 runner `--exec` 包住完整入口及 release-gate 子进程；不能只隔离 `npm test` |
| `benchmark:v1v2` — `tests/benchmark/run-benchmark.ts` → `harness.ts` | 未发现：catalog 来自 cwd；TaskEventLogV2 在内存中；brain/executor/dispatcher 为脚本化对象 | 否，`providerHealthSnapshot()` 明确返回 scripted 状态 | 未发现，执行与验证结果来自 scripted work | **可接入 runner**：使用 `--exec` 模式并保留 `--all` / `--task` 等原参数；catalog 与结果路径为仓库内显式路径 |
| `benchmark:v028` — `tests/benchmark/run-architecture-benchmark.ts` → `harness.ts` | 未发现：mkdtemp 创建 repo fixture，事件在内存中，finally 清理 fixture | 否，agents 的 provider 名称是模拟身份；dispatch 返回脚本化结果，modelProviderCallCount 是模拟计数 | 未发现 | **可接入 runner**：完整入口用 `--exec`；结果仍写入 cwd 的 `benchmark/v028-results.json` |
| `benchmark:planning-quality` — `scripts/planning-quality-benchmark.mjs` | 部分隔离：传入临时 data/config/env 与 PlanningStore；Launchpad 部分 audit / notifier 默认依赖仍使用进程默认路径 | 是，创建真实 Codex planning provider 和 semantic reviewer；继承 process.env 和未隔离 HOME 的认证来源 | 本机 HTTP：是；provider 被调用时会执行真实 Codex turn，可能访问外部服务 | **必须保持人工专用**：需单独模型预算与认证授权；runner 只能隔离路径，不能令真实模型调用变成 fixture。入口还使用旧 token header / getTokenForTest，当前 session 适配需另轮处理 |
| `reliability:v030` — `scripts/v030-golden-path-reliability.mjs` | 未发现：临时 repo + 内存 TaskEventLogV2；finally rm 临时 repo | 否，EXECUTE 写固定文件，不调用真实模型 | 未发现；VERIFY 仅运行 fixture 内的 Node / npm 命令，checkpoint 仅在 fixture 本地 commit，autoPush=false | **可接入 runner**：用 `--exec` 保证 Git 全局身份、HOME 与 verifier 子进程隔离；保留显式 artifact 输出路径 |

## 源码依据

- `package.json`：上述五个 scripts 的命令及入口保持基线原值。
- Certification：`run-certification.ts` 的 `main()` / `runGates()`；`harness.ts` 的 `createCertProductionApp()`；`scenarios-entry.ts` S01 和 `scenarios-risk.ts` S15 的 Launchpad 组合；`scenarios-review-runtime.ts` 的 DeepSeek adapter 注入了 routeAvailable 与 commandRunner，不据 provider 名称推定真实调用。
- 默认路径与 provider 解析：`work-session/launchpad/server.ts` 的构造器和 `createNovaWingLaunchpad()`；`work-session/production.ts` 的 managed policy 解析、默认 store / reviewer registry；`deepseek-executor.ts` 的 route 配置读取。这里只读源码，未读取配置文件内容。
- Benchmark：`tests/benchmark/harness.ts` 的 `providerHealthSnapshot()`、`runV1Internal()`、`runV2Internal()`、`architectureFixture()` 和 `runArchitectureBenchmark()`。
- Planning quality：入口的 `env`、真实 provider/reviewer 工厂、`postPlanning()` 与 Launchpad 默认依赖；provider 工厂连接 `launchpad/repair-model.ts` 的 Codex SDK turn。
- Reliability：入口的 `fixtureRepo()`、`runOnce()`、scripted dispatcher、`finalizeCompletedTask()` policy。

## 本轮落地范围

仅 `test:domain` 接入已有 runner。上述分类是后续建议，不是本轮执行授权，也不是运行通过结论。
runner 默认以 `node --test` 执行测试；这些独立 CLI 入口若以后接入，应使用 `--exec`。
本轮不启动 EM-1，模型调用为 0，付费 API 为 0。
