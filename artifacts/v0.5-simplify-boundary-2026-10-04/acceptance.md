# v0.5 SIMPLIFY_BOUNDARY — Addendum-1 纠偏验收证据

日期：2026-10-04（Asia/Shanghai）。执行：Codex。**修改与本地验证完成；产品验收待 Claude Cowork / Owner 独立 review。**

本报告对应原 brief §6 和 Addendum-1；不将本地 fixture PASS 等同于真实客户交付、Electron 实机验收或 Owner 批准。

## 修改完成

工作树 `/Users/weijianjun/.codex/worktrees/v05-simplify-boundary/nova-wing`，分支 `codex/v0.5-simplify-boundary`。main / HEAD 均为 `a827f91d52b8242b811360140742b3927c36b848`。

保留 A/B/C 实现，未重写 ledger、身份模型或 bootstrap/session 架构。相对纠偏开工快照的全部 14 个文件：

| 文件 | 本轮修改 |
| --- | --- |
| `package.json` | npm test / check:desktop 进入隔离 runner |
| `scripts/run-isolated-tests.mjs` | 临时 HOME、data/config、XDG、Windows profile、Git 配置；先 canary 后命令；清理自己创建的临时根 |
| `scripts/check-platform-boundaries.mjs` | 在既有精确 adapter 清单登记隔离入口，附理由；检测规则不变 |
| `tests/test-isolation.canary.mjs` | passwd 真实 home 对照、默认路径与 env:{} 隔离、Git identity 校验 |
| `tests/work-session-launchpad.test.ts` | Browser delete mock POST 携带真实 /bootstrap cookie；原断言不变 |
| `tests/runtime-ui-view.test.ts` | 认证管线断言从旧 token header 适配为 same-origin credentials |
| `tests/v040-human-decision-control.test.ts` | 合法 POST 补精确 Origin；恶意 Origin / 无认证反例保留 |
| `tests/work-session-launchpad-strict-lifecycle.test.ts` | 关闭前取 cookie，关闭期间复用 |
| `tests/work-session-strict-control-lifecycle.test.ts` | 关闭和 request observer 注册前取得 cookie，避免 bootstrap 干扰事件顺序 |
| `tests/work-session-production-legacy-adoption.test.ts` | 带 session 到达不存在的端点；404 和零 Runtime 调用断言保留 |
| `tests/work-session-scheduled-recovery.test.ts` | 新 Control listener 真实 bootstrap 后查询 status |
| `tests/delivery-obligation.test.ts` | 恢复旧 DEFERRED ancestry 回归，除标题外保持用例正文 |
| `desktop/main/window-lifecycle.mjs` | 修正脱敏正则语法；保留 undefined 诊断字段和非 bootstrap 错误身份；bootstrap 凭据仍脱敏 |
| `desktop/tests/window-lifecycle.test.mjs` | 新增 bootstrap 导航与错误/诊断不泄漏凭据回归；原断言不变 |

全 diff 相对 main：**非测试代码净增 179 行**；本轮净增 60 行（runner 52、adapter 登记 1、desktop 兼容性修复 7）。不含测试；完整逐文件增删及 SHA-256 见 `source-manifest.json`。未修改生产默认路径逻辑，未新增依赖、package、存储引擎或签名系统。

交付：`implementation.patch` 含 tracked + 新增源码/测试；`correction-only.patch` 单独显示本轮差异。未包含 node_modules 链接或 artifacts。没有源码仓库 commit / push / merge；probe/test 的 Git commit 仅发生在临时 fixture 仓库。旧 worktree 只读，客户仓库未访问。0 次真实模型调用、0 付费 API；reviewer/agent 都是本地 fixture adapter。

## 测试通过

Node v24.21.0。所有执行应用代码的命令都经 `node scripts/run-isolated-tests.mjs`；完整 check 外层也隔离，保护迁移、exports 等非 node:test 子命令。

| 验证 | pass / fail | 证据 |
| --- | --- | --- |
| 首个隔离 canary（先于本轮任何 Launchpad 测试） | 2 / 0 | `isolation-canary.log` |
| focused：delivery-obligation、delivery-runtime-plan、operator-session、Launchpad、control server、reviewer-runtime | 166 / 0 | `correction-focused.log` |
| 认证 / lifecycle / DEFERRED 补充回归 | 144 / 0 | `correction-auth-regression.log` |
| 最终 `npm run check` 中全量单元测试 | 1397 / 0 | `full-check.log` |
| 最终 `npm run check` 中 desktop 测试 | 194 / 0 | `full-check.log` |
| 显式 `npm run check:desktop` | 194 / 0 | `desktop-check.log` |
| typecheck、unused/checkJs、migration、exports、boundaries、platform | 全部 PASS；完整 check exit 0 | `full-check.log` |
| F2/F3 原脚本临时副本 replay | 2 个脚本 exit 0；结果断言全部通过 | `f2-f3-original-replay.log`、`f2-correction-results.json`、`f3-correction-results.json` |
| diff whitespace | PASS | `git diff --check` |

canary 是独立的 2 项测试，外层与嵌套 runner 各自执行；未合并进上述业务测试数量。各次日志的根路径和 canary PASS 标记见 `isolation-audit.json`。

历史失败保留，不用最终 PASS 覆盖：第一次隔离全量运行 1374 pass / 22 fail，见 `full-check-correction-baseline.log`。其中失败后的 strict-control worker 留有未完成 fake Runtime，终止本次拥有的 PID 16887 后全量结束。第一次认证修复即通过 144 项回归。后续平台登记缺口、desktop 正则语法、desktop 三项兼容性回归、新增测试的 checkJs 类型收窄分别有独立日志；每种失败在首次针对性修复后通过，没有同一失败两次修复未果。具体见 `test-adaptation.md`。

## 原任务书 §6 逐项证据

| # | 结果及对应证据 |
| --- | --- |
| 1 F2-A | contributor 冒充 owner、缺 owner / 重复 owner 均 BLOCK。focused 的 `SIMPLIFY F2-A` 与 replay F2 A |
| 2 F2-B | 换名、同 provider、同 runtime、缺 review capability 均 BLOCK；独立 provider/runtime 正向 SUCCESS。reviewer-runtime focused 与 replay F2 D 原矩阵 |
| 3a | 无 session 有/无旧 header 均 403，assessment 不变。acceptance/session 测试 + replay F2 C |
| 3b | session + 四类 body 身份字段逐项 400，无 acceptance 写入；replay 复证 `IDENTITY_FIELDS_NOT_ACCEPTED` |
| 3c | session + 合法 body 返回 201；server-owned acceptedBy role/channel/sessionRef/displayName 及 reopen 相等 |
| 4 F3-A | 0 次 collector，自洽 evidence 经公开 API 被拒；手写自洽 completion/index 后 reopen 仍 BLOCK。replay F3 A |
| 5 F3-B | C1 真实 collector 1 次，C2 collector 0 次；重算自洽 metadata/hash 并复用 executionId，公开完成和 reopen 都 BLOCK。replay F3 B |
| 6 | verifier / blueprint / commit / plan 漂移、后一次真实 FAIL 覆盖 PASS 均 BLOCK。`SIMPLIFY current attempt...` |
| 7 | Host 冻结 verifier → attempt → 独立 review → finalize 正向通过；四个旧失败恢复 PASS。durable contributor T1/T2 DAG 在独立 external acceptance 后达 CUSTOMER_DELIVERY_COMPLETED |
| 8 | reopen assessment 一致；逐字段 tamper、删除 attempt、截断 JSON、旧无 executionId 记录均 BLOCK，无未处理异常 |
| 9 | 两套服务无 session 的 HTML/API 被拒且无 token/code；cookie flags、bootstrap 一次性和超时、Origin 检查通过 |
| 10 | 完整 check 与独立 check:desktop 均 exit 0；最终 failed=0 |

四个受保护旧用例的核心断言保持不变；session / executionId 管道适配逐项 diff 见 `test-adaptation.md`。

## F2/F3 原脚本 replay

从旧 worktree artifacts 只读复制到 `novawing-simplify-replay-*` 临时目录。原脚本 SHA-256：

- F2 `9349206ccaf8cb488346e2217f59e936ca7e41fc0d44db9d3aa5aea500a948cc`
- F3 `3678ddb7dc3b76f2fb4c2f7cd4220c40d36800c6b21c761c0137ad013aceb740`

不是声称零修改重放：适配 import/output/fixture 路径、退休的公开 writer 与 token API、executionId、HTTP bootstrap/session，以及从漏洞存在时的 ACCEPTED 期望改为本任务要求的 BLOCK。逐行保留在 `f2-correction-replay-adaptation.diff` / `f3-correction-replay-adaptation.diff`，执行副本和哈希在同目录及 `correction-replay-manifest.json`。

F3 使用临时合成仓库与两个 fixture commit，artifact 在 C1/C2 不变；没有克隆或读取客户仓库。结果为 `F2_PASS_BOUNDARY_ENFORCED` 与 `F3_AB_PASS_NO_HOST_ATTEMPT_OR_COMMIT_REPLAY`。F3-C 原 probe 只伪造 evidence，没有伪造完整 ledger；该次 BLOCK 不能证明同 UID 防护。

## 流程通过：隔离证据

首个 canary 通过后才启动 Launchpad 测试。runner 为子进程设置临时 HOME / USERPROFILE、NOVAWING_DATA_DIR / CONFIG_DIR、XDG 两根、APPDATA / LOCALAPPDATA、TMP*；Git 使用临时 `GIT_CONFIG_GLOBAL` fixture identity，并禁用系统配置和继承的 config override。canary 的 `userInfo().homedir` 只读账号记录，用于字符串对照，不访问真实目录；同时验证默认参数及 `env: {}` 的路径都落在临时根。

最终 full-check 外层根：
`/private/var/folders/j3/zkcqwhw536v6nmm3sg10v7wm0000gn/T/novawing-isolated-tests-km9Q1o`

嵌套 runner 的根位于该根的 tmp 子目录。日志显示 `CANARY_REAL_PROFILE_REFERENCES=0`、`ISOLATION_CANARY=PASS` 和 cleanup PASS。对 artifacts 全部 `.log` 使用真实账号 home + 受保护路径字符串做 `rg -n -F`，**exit 1 / 0 命中**；数量、每份日志根前缀及 canary 记录见 `isolation-audit.json`。此 grep 只读取日志，不检查真实目录。

指定 index.lock 已核验没有 Git 进程持有：lsof 显示非 Git 的 Virtualization 进程，pgrep/ps 没有 Git 持有者，按本轮指令删除并记录于 `correction-lock-check.json`。未触发本轮停止条件。

历史隔离事故仍单独保留在 `acceptance-initial-blocked.md`；本轮未读取、写入或 stat/ls 真实数据目录，未发现新的隔离前实际写入证据。真实历史影响仍 UNKNOWN；日志 0 命中和当前 canary 不能追溯证明历史未访问或未修改。

## KNOWN_RESIDUAL

1. **F3-C，同 UID 文件写权限**：同 UID 进程能直接改写 ledger 文件。ledger 只防 NovaWing API/工具通道的伪造、重放与意外损坏；recordHash 是损坏检测，不是签名。v0.5 不提供 OS principal / sandbox / cryptographic attestation。
2. **Cookie 跨端口**：`novawing_operator` 绑定 host，不绑定端口。CLI 模式同一浏览器访问另一个 127.0.0.1 端口时会发送此 cookie。浏览器侧伪造由 mutation 的 Origin / Sec-Fetch-Site / Referer 检查阻断；Desktop 另有 navigation registry、onBeforeRequest 和随机 partition。剩余同 UID 恶意本地服务端重放与 F3-C 同类，按 Addendum 不修。

本机能拿到 bootstrap URL 的人 = operator。session 是同进程本地逻辑权限，不是账号系统或多用户身份认证。delivery → work-session import 分层列为 DEFERRED；没有顺手重构。历史只有 reviewerIdentity 的 acceptance、没有 executionId 的 PASS 记录不迁移、不计验收、不删除。人工验收仍只有 API，本轮没有新增 UI。

## 待 Owner 验收

- Claude Cowork 对完整 diff、受保护断言、F2/F3 适配与第 6 节证据独立 review，作出产品 ACCEPTED / NOT ACCEPTED 裁定。
- 确认上述两项 KNOWN_RESIDUAL 与 import 分层 DEFERRED 按 v0.5 范围接受。
- 真实目录历史影响保持 UNKNOWN；只有用户另行授权才可检查，本报告不请求或推定该授权。
- 真实 Electron 启动/交互与真实客户交付未运行；check:desktop 为本地自动测试，不冒充实机或客户业务验收。

## 四层结论

| 层 | 判定 |
| --- | --- |
| 修改完成 | PASS：纠偏范围完成，A/B/C 保留，无默认路径生产逻辑改动 |
| 测试通过 | PASS：最终 check、check:desktop、focused、补充回归和 replay 通过 |
| 流程通过 | PASS：本轮临时根隔离、canary、日志 grep、权限与停止条件满足；不抹去历史事故 |
| 产品验收 | PENDING_OWNER_REVIEW；未 commit / push / merge |
