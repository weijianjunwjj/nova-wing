# Addendum 1 · SIMPLIFY_BOUNDARY 纠偏轮（2026-10-04，Owner：Claude）

适用于 `codex/v0.5-simplify-boundary` worktree。原 brief 全部条款继续有效；本文件只增补，不放宽。

## 1. Owner 裁定

- 实现方向：ACCEPTED。A（current-attempt ledger）、B（host verdict / 唯一 OWNER）、C（server-owned
  acceptedBy + bootstrap session）与 brief §2–5 一致，保留现有 diff，不重写。
- 本轮：NOT ACCEPTED。§6 #2/#10 未运行，F2/F3 原脚本未回放，1 个 focused 失败，且有数据隔离事故。
- 下一步：一次 bounded correction 轮（本文件 §3），不是 stop。

## 2. 事故定性（已核实 vs 待核实）

根因有两层。第一层是 main 既有 harness 缺陷：`npm test` 不设 `NOVAWING_DATA_DIR`/`HOME`，
main 中 `planning.test.ts`、`delivery-runtime-plan.test.ts` 等已在未注入依赖时调用 `launchpad.start()`，
另有 6 个测试使用 `env: {}`。第二层是 Codex 未按 brief §1 手动补隔离变量的流程失误。

已从源码核实：`CodingExecutionStore` 链路是幂等的（`mkdirSync(recursive)` + `CREATE TABLE IF NOT EXISTS`
+ `SELECT`，无 INSERT）。

待核实：Launchpad 其他默认依赖（planning/delivery store、analytics、repair audit、hydrateStatuses）
在被测路径上是否写入；真实数据目录是否实际被改动；历史 `npm run check` 是否早已同样触达真实路径。
真实目录的任何检查（含只读 stat）须用户单独授权，本轮 Codex 不做。

## 3. 本轮范围（按顺序）

1. Harness 隔离（P0，先于任何测试）。新增 `scripts/run-isolated-tests.mjs`（或等价），由它创建临时根目录，
   为整个 `node --test` 进程设 `HOME`、`NOVAWING_DATA_DIR`、`NOVAWING_CONFIG_DIR`、`XDG_DATA_HOME`、
   `XDG_CONFIG_HOME`。`npm test` 与 `check:desktop` 都改走它。git 测试所需的 user.name/email 用
   `GIT_CONFIG_GLOBAL` 指向临时文件，不读真实 `~/.gitconfig`。
   增加 canary 测试：断言 `platformPaths().data` 不以 `os.userInfo().homedir` 下的真实 NovaWing 路径开头。
   注意 `userInfo()` 读 passwd，不受 HOME 影响。只改脚本/测试，不改生产默认路径逻辑。
2. 修剩余失败测试 "Browser delete confirmation…"：mock POST 携带经真实 `/bootstrap` 获得的 cookie
   （复用 `mintSession`），不改断言。
3. 跑满 §6：focused、`npm run check`、`check:desktop`，并对 F2/F3 原脚本做 replay（从旧 worktree 复制
   到临时目录执行，旧 worktree 只读），记录到 `artifacts/v0.5-simplify-boundary-2026-10-04/`。
4. 文档化残留风险（写入 acceptance.md 的 KNOWN_RESIDUAL 节，不写代码）：
   - F3-C：同 UID 进程可直接写 ledger 文件。
   - Cookie 跨端口：`novawing_operator` 绑定 host，不绑定端口。CLI 模式下，同一浏览器里打开的另一个
     127.0.0.1 端口服务会收到该 cookie。浏览器侧伪造已被 `authorizeMutation` 的 Origin/Sec-Fetch-Site/Referer
     校验阻断；Desktop 路径另有 navigation registry + `onBeforeRequest` + 随机 partition。剩余攻击需要
     同 UID 的恶意本地服务端重放，与 F3-C 同类，v0.5 不修。

## 4. 不做

不改 cookie→header 方案；不给 session 绑定 origin；不恢复 attestation/签名；不处理
delivery→work-session 的 import 分层（记入 deferred）；不检查、不修复真实数据；不 commit/push/merge。

## 5. PASS 判据（全部满足）

原 §6 的 10 条全部满足；canary 测试存在且通过；日志中可见临时根前缀，且全量 grep 日志不出现真实
`Library/Application Support/NovaWing` 路径；F2/F3 replay 结果文件与 acceptance.md 一致；failed=0。

## 6. 停止条件（任一触发即停并报告）

- 任何测试必须依赖真实数据目录才能通过。
- Harness 修复需要改生产代码的默认路径逻辑。
- 发现隔离前写入真实目录的证据：只记录证据位置，不修复数据，停止。
- 同一失败两次修复未果；非测试代码净增超过原 §8 上限。
- worktree 存在 `index.lock` 且确有 git 进程持有。若无进程持有，记录后可删除该锁文件。

预算：0 次模型调用、0 付费 API；仅本地计算。
