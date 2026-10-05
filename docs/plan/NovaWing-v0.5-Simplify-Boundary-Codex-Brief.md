# v0.5 SIMPLIFY_BOUNDARY — Codex 实现任务书

签发：Claude Cowork（Principal Product & Architecture Owner），2026-10-04。
执行：Codex（Implementation Engineer）。验收：Claude Cowork 独立 review。

## 0. 目标（一句话）

PASS 不是外部输入：只有 Host 自己开启、自己 spawn 冻结 verifier、自己观察并记录的
**current attempt**，才能让 owner assertion 进入 LOCALLY_VERIFIED；人工 / 外部验收的
身份由服务端会话决定，不由 request body 决定。同时恢复正常正向路径。

## 1. Repo safety

- 从 `main @ a827f91d52b8242b811360140742b3927c36b848` 新建分支
  `codex/v0.5-simplify-boundary` 与新的独立 worktree。开工前确认 main 仍是该 SHA；
  不是则停止并报告。
- 旧 worktree `/Users/weijianjun/.codex/worktrees/v05-trusted-attestation/nova-wing`
  只读，不修改、不删除——它是 BLOCKED 结果的证据。需要的代码手工移植，不整体 apply patch。
- 不 commit、不 push、不 merge；交付为 worktree diff + `artifacts/v0.5-simplify-boundary-<date>/`。
- 0 次真实模型调用、0 付费 API；不读写 `~/Library/Application Support/NovaWing` 真实数据、
  不触碰客户仓库。fixture 一律临时目录。

## 2. 从旧分支移植 / 删除的结论

| 项 | 决定 | 说明 |
| --- | --- | --- |
| Launchpad acceptance 不采信 body `reviewerIdentity` | KEEP（改写） | 旧分支用永久 403 实现，等于关闭全部 EXTERNAL/HUMAN 验收；改为第 4 节的会话模型 |
| `customerDeliveryCompletionGate` 每个 blocking assertion 恰好 1 个 OWNER | KEEP | 原样移植 |
| `saveCapabilityEvidence` 写入 provenance 标记 | REMOVE | 改由 attempt ledger 承担 |
| `customerAssessment` 对 PASS 要求 `record.commit === HEAD` | **REMOVE（推翻交接建议）** | main 没有"在新 HEAD 重验先前任务"的机制，多任务 DAG 前序任务会永久失效。exact commit 绑定放在 attempt↔task record 层；前序任务保持 main 的 ancestry 语义。HEAD 全量重验属于 F4 release gate |
| DEFERRED ancestry 特判 | REMOVE | 只是修复旧分支自己引入的回退；回到 main 统一 ancestry 后不需要。保留其回归测试 |
| `attestation/*` 五个文件、`verifyCompletionAttestations`、gate 的 `attestations` 参数、`requireProductionSigningBoundary`、`ExternalAcceptanceRecord.attestation` | REMOVE / DEFER | 不留未接线代码。旧 patch 已存于旧 artifacts 目录，未来 portable attestation 从那里取 |
| `canonicalization.ts` | REMOVE | 复用现有 `planning/freeze.ts` 的 `canonicalSerialize` |
| `tests/trusted-attestation.test.ts` | REMOVE；sandbox canary 测试 DEFER | canary 仅作已知边界展示，不进 `npm run check` |
| 旧分支 F2-A、F2-C、DEFERRED ancestry、forged-PASS 测试 | KEEP（改写） | 去掉签名依赖，改为断言 ledger / 会话语义 |

## 3. Work item A — Host-owned current-attempt ledger

位置：`packages/development-guardian/delivery/service.ts`（`DeliveryStore`）及
`runtime-adapter.ts`。不新建 package，不新建抽象层。

1. `collectProvisionedEvidence` 是唯一写 attempt 的地方。开始前读 clean HEAD 并要求
   等于 `transition.implementationCommit`；生成 `executionId = randomUUID()`；运行现有 collector；
   结束后再读一次 HEAD，必须仍相等且 clean，否则 attempt 记为失败。写一次性记录
   `verification-attempt/<executionId>`：

   `executionId, runtimePlanHash, assertionId, runtimeTaskId, obligationId, transitionId,
   implementationCommit, blueprintHash, verifierHash(canonicalSerialize(transition.verifier) 的 sha256),
   artifactHashes, evidenceId, result, observedMatch, startedAt, finishedAt`

   并原子更新 `verification-attempt-latest/<obligationId,commit>` → `executionId`。
2. `saveCapabilityEvidence` 改为 `#private`（JS 真私有，不是 TS `private`）。
   DeliveryStore 不得再有任何公开方法接收调用方构造的 `CapabilityEvidence` 或 attempt。
3. `collectProvisionedEvidence` 返回值带上 `executionId`；dispatcher 写入 verification result
   （`rawOutputRef` 或新字段，择一），`deliveryCompletionGate` 写入
   `AssertionCompletionEvidence.executionId`（新增可选字段）。
4. 新增 `#attemptValid(plan, item, transition)`：读取 attempt，逐字段要求与 item / transition /
   plan 完全一致，`observedMatch === true`，且它是该 `(obligationId, commit)` 的 latest attempt
   （后一次 FAIL 覆盖前一次 PASS）。`recordLocalTaskCompletion` 与 `customerAssessment`
   对每个非 DEFERRED item 调用；不满足即 BLOCK / 跳过，不抛异常给 UI。
5. reviewer verdict 逻辑保持 main 现状（独立 runtime、evidenceId 关联）。
6. 不迁移历史记录：没有 `executionId` 的旧 local-completion 自然不再计为 PASS，文件保留不删。

诚实边界（写入报告）：ledger 防的是"通过 NovaWing API / 工具通道伪造或重放"和意外损坏；
不防同 UID 进程直接改写数据目录（v0.5 NON-GOAL，原 F3-C）。

## 4. Work item B — server-owned acceptance identity

1. `POST /api/delivery/acceptance`：必须持有第 5 节的 operator session，否则 403。
   body 出现 `reviewerIdentity / principalId / authorityLevel / role` 任一字段 → 400
   `IDENTITY_FIELDS_NOT_ACCEPTED`（显式拒绝，避免调用方误以为冒名成功）。
   可选 `displayName` 仅为 metadata。
2. `ExternalAcceptanceRecord` 用 `acceptedBy: { role: 'LOCAL_OPERATOR_UI', channel: 'LAUNCHPAD_SESSION',
   sessionRef: sha256(sessionId), displayName? }` 取代 `reviewerIdentity`；gate 只认服务端写入的
   `role`。保留 main 现有的 plan hash / assertion / kind / evidence / clean target / immutable 检查。
3. 旧记录（只有 `reviewerIdentity`）不迁移、不计为验收，文件保留。
4. main 源码中没有前端调用 `/api/delivery/acceptance`（只读 grep 确认），即人工验收目前只有 API、
   没有 UI。本轮不做验收 UI；`capability-layer.ts` 中 `requiredInputs: ['reviewerIdentity', …]`
   改为不含身份字段的描述。

## 5. Work item C — 不再把共享 token 嵌入无鉴权 HTML

现状（main 源码）：Launchpad `GET /`、`/advanced`、`/customer` 把 `this.token` 渲染进页面；
control-ui `serveHtml` 同样渲染 `controlToken`，而 control-ui 有 `approve-verification`、
`human-decision` 等授权类 mutation。Host header 检查不能阻止本机 curl。两者都在范围内。

1. Host 生成一次性、短时效（≤60 s）bootstrap code；`GET /bootstrap?code=…` 消费后设置
   `HttpOnly; SameSite=Strict; Path=/` 的 session cookie 并 302 到原页面。code 只能用一次。
2. Desktop：main process 内直接拿到 bootstrap URL 交给 BrowserWindow `loadURL`（同进程，
   不落盘、不写日志）。CLI：只打印到启动终端。
3. 除 `/bootstrap` 与静态资源外，HTML 与 `/api/*` 都要求有效 session；mutation 继续要求 origin 检查。
   删除 `x-novawing-launchpad-token` / `x-novawing-control-token` header 路径，页面不再含 token。
4. 不建账号系统、不做多用户。session 持有者即 `LOCAL_OPERATOR_UI`，报告中如实写明
   "本机能拿到 bootstrap URL 的人 = operator"。
5. 相应更新 `desktop/tests/*-smoke.mjs` 与 `getTokenForTest` 的测试用法（改成测试专用的
   mint-session helper，不进生产路径）。

## 6. v0.5 PASS 判据（全部必须满足）

| # | 测试（新增或改写，名称可调整） | 期望 |
| --- | --- | --- |
| 1 | F2-A contributor 数据冒充 owner | customer gate BLOCK（唯一 owner） |
| 2 | F2-B executor 换 reviewer 名 / 同 provider / 同 runtime | BLOCK（main 现有独立性矩阵保留） |
| 3a | 无 session 调 acceptance（有/无旧 token header 均测） | 403，assessment 不变 |
| 3b | 有 session + body 带 `reviewerIdentity` 等 | 400，无记录写入 |
| 3c | 有 session + 合法 body | 201，`acceptedBy.role` 由服务端写入；reopen 后一致 |
| 4 | F3-A：未调用 collector，构造内部自洽 evidence / completion record 走公开 API 与 reopen | BLOCK（无 attempt） |
| 5 | F3-B：C1 真实 attempt 的 evidence 重新包装到 C2 | BLOCK（attempt commit 不符） |
| 6 | 漂移：改 verifier / blueprint / commit / runtimePlanHash 后复用旧 attempt；同 obligation 后一次 FAIL | 全部 BLOCK |
| 7 | 正向：Host spawn 冻结 verifier → attempt → 独立 reviewer PASS → finalize → LOCALLY_VERIFIED；多任务 DAG 到 CUSTOMER_DELIVERY_COMPLETED | PASS |
| 8 | 重启：新 DeliveryStore 实例 reopen 得到同一 assessment；篡改 attempt 字段 / 删除 attempt / 截断 JSON | BLOCK，不抛未处理异常 |
| 9 | `GET /`、`/customer`、control-ui `GET /` 无 session：响应不含 token / bootstrap code；bootstrap code 重放失败 | PASS |
| 10 | `npm run check` 与 `npm run check:desktop` | 0 failed（报告实际数量） |

旧分支的 4 个失败用例必须恢复为 PASS，且**不得改变它们的核心断言**；只允许适配
`executionId` / session 这类管道字段。每个改动用 diff 说明。

额外报告（不阻塞）：重放原 F2/F3 probe；F3-C（同 UID 直接写数据目录）记为 KNOWN_RESIDUAL。

## 7. Non-goals

签名 / Ed25519 / authority registry / SANDBOX_PROTECTED / OS_PRINCIPAL / helper daemon /
账号系统 / F1 修改 / F4 release sink / v0.6 规划 / 顺手重构 / 修改 frozen assertion 或历史数据。

## 8. Stop conditions（遇到即停并报告，不自行扩张）

- main 不在 `a827f91`。
- 任何判据只能通过改测试核心断言、放宽 gate 或真实模型调用才能通过。
- 需要 Section 3–5 以外的新架构元素（新 package、新进程、新存储引擎）。
- 非测试代码净增超过约 600 行。
- 同一问题两种方案都失败。

## 9. 交付物

`artifacts/v0.5-simplify-boundary-<date>/` 下：`implementation.patch`、`acceptance.md`
（逐条对应第 6 节，区分 修改完成 / 测试通过 / 流程通过 / 产品验收）、`full-check.log`、
`desktop-check.log`、F2/F3 重放日志、改写测试的前后 diff 说明。
