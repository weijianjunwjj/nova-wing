# NovaWing v0.4.0 Phase 4 Report

日期：2026-09-22。分支 `feat/v0.4-desktop`。

## 0. 结论

```text
Phase 4: PASS
```

Windows Package & Real-host 的人工验收已完成并确认。自动门禁与 installed real-host 证据分开记录，人工确认项一律标记为 **MANUAL / REAL-HOST PASS**，不以自动化结果冒充。

本文件是 Phase 4 的最终报告；早期 BLOCKED 快照、Quick Fill blocker、窗口白屏 blocker 作为历史过程记录保留，其 installer SHA 均已 OBSOLETE。

## 1. Phase 4 Scope

让 NovaWing 以 Windows 桌面产品形态交付，并在真实安装主机上端到端可用：

- Windows x64 NSIS 打包与安装，Start Menu 启动，Electron Main 承载 Desktop Runtime。
- 打包运行时的 Codex / Git / SQLite / node:sqlite 可用性与解析隔离。
- 后台 Runtime、单实例、Tray、close→hide、严格退出生命周期。
- Windows 原生 Toast 通知与点击恢复。
- Launchpad 的 Quick Fill（Task Brief 结构化解析）在无 lossy parsing 的前提下可用。
- Session 内 HUMAN_REQUIRED / BUSINESS_DECISION 的真实闭环（用户回答 → resume → 恢复执行 → 完成）。
- 独立 Reviewer 在 installed production 配置下真实接线可用（Codex executor + DeepSeek reviewer）。
- Completion evidence 身份一致性：Execution command 与 Completion evidence 的命名空间必须可分。

不在本轮范围：macOS 打包、Auto Update、代码签名、GitHub Actions、uninstall/reinstall 之外的发布工程。

## 2. Windows Packaging

最终交付为 NSIS per-user installer，产物身份如下（`artifacts/desktop/installer.json`，ignored）：

| 字段 | 值 |
| --- | --- |
| filename | NovaWing Setup 0.4.0.exe |
| size | 218,047,037 bytes |
| SHA256 | `09f830ba3d99ad10b29a59052e87659bc0a65c2b59e2d608b6b99b40e9808445` |
| productName / version | NovaWing / 0.4.0 |
| appId / AUMID | io.github.weijianjunwjj.novawing |
| ToastActivatorCLSID | {5F5D220B-E789-5710-A023-D7CA6AD8E382} |
| Electron / embedded Node | 44.4.3 / 24.21.0 |
| build host Node | 24.14.1 |
| electron-builder | 26.15.3（精确锁定） |
| target / arch | NSIS / x64 |
| signature | NotSigned（Authenticode 实测） |

**此 SHA256 是 Phase 4 的唯一最终 installer artifact identity。** 早期 `b8c777bd…`、`2ec3f06a…`、`def42c52…` 三个包分别对应 Phase 4 初版、Quick Fill 修复版和窗口白屏修复版，均已被本包取代，不得作为最终验收版本引用。

打包结构：独立 staging（自带 package.json、desktop/main/assets、dist/packages、production node_modules），保留 `name=nova-wing`、`type=module` 与原 exports/dependencies，支持 `nova-wing/development-guardian` self-reference。依赖按 lockfile production graph 与 win32/x64 目标复制，`npmRebuild=false`、`nodeGypRebuild=false`、`asar=false`。staging 8436 files → 最终 resources/app 5309 files。Package smoke 在源码之外的系统 Temp 完整副本内运行，`app.isPackaged=true`，交付树不含 harness/fixture。

不含源码 tests/docs/.git/.env、业务 DB、日志、临时 repo、Desktop fixture、Electron/builder/TypeScript 开发依赖。

### 打包运行时可用性（automated）

```text
PACKAGED_CONTENT_AUDIT: PASS
codex_packaged_resolver: PASS   (codex-cli 0.151.0，来自包内 vendor)
Git/Bash discovery: PASS        (registry → D:\Git\bin\bash.exe，fingerprint 校验)
node:sqlite create/insert/select/close: PASS
libSQL win32-x64 native 加载: PASS
Runtime create/ledger/snapshot/close/reopen: PASS
```

拒绝 WSL/System32/WindowsApps、裸 bash、缺失 installation 与错误 fingerprint；显式无效 override 不退回其他来源；无全局 Codex/PATH fallback。

## 3. Installed Real-host — Windows 安装与桌面 Runtime

**MANUAL / REAL-HOST PASS。** 由操作者在真实安装主机上确认：

- Windows x64 installer 可安装，可从 **Start Menu** 启动。
- Electron Main 承载 Desktop Runtime，Launchpad 正常。
- Tray 正常；关闭窗口后隐藏到后台正常；Desktop background runtime 正常。
- packaged Codex 可用；Git discovery 可用；SQLite / node:sqlite packaged smoke 可用。
- Windows Native Toast 可真实显示。
- Notification click / window restore 的白屏问题已修复并人工复验 PASS。

## 4. Quick Fill

曾发现两个缺陷：Allowed Paths 解析缺失，以及 acceptance / verification binding 存在 lossy parsing。

已修复并 **MANUAL / REAL-HOST PASS**，覆盖：

- 中英文 Allowed Paths。
- bullets / comma / 顿号 / backticks 等列表形态。
- ambiguous permission fail closed。
- partial parsing 不覆盖已有 allowedPaths。
- Acceptance Criteria / Required Evidence 正确绑定。

## 5. Window White-screen Recovery

**MANUAL / REAL-HOST PASS。**

白屏根因：同一健康 Session 也被无条件 `loadURL()`；Session 导航与 renderer recovery 分属不同 promise，`showWindow()` 未等待恢复完成；`loadURL()` resolve / `did-finish-load` 可以早于 `did-stop-loading`。

修复：规范化 URL 比较后直接 restore/show/focus；每个 BrowserWindow 共用串行 navigation tail，同地址在队列执行时再次判断，最多一个 Main loadURL 在途；切换 URL 时保持 visible intent 但加载期间隐藏内容窗口，事件驱动等待 `did-stop-loading` / `ready-to-show`（不使用固定 sleep，不关闭背景节流）；destroyed window 的 Session 点击直接创建到目标 Control URL。

原有 live owned-origin 验证、映射撤销后的 Launchpad fallback、最后已提交可信 URL、安全窗口配置与严格退出语义保持不变。

## 6. Native Toast

**MANUAL / REAL-HOST PASS。**

Main 极早设置 AUMID / ToastActivatorCLSID；通知图标与产品名正确；通知点击可恢复窗口并打开对应 Session（白屏修复后复验通过）。

对象保留窗口为 15 分钟；超出保留期或退出后的 cold-start persisted click 未实现可靠 Session 关联，记为 DEFERRED（见第 12 节）。

## 7. HUMAN_REQUIRED / BUSINESS_DECISION

**MANUAL / REAL-HOST PASS。** 最终成功任务：

```text
Task:    DESKTOP-BUSINESS-DECISION-004
Session: desktop-business-decision-001-202609220448-3f4d96
checkpoint: 74324c695e18afa3040c38643a529661e3b7a787
```

事件链：

```text
BUSINESS_DECISION
→ HUMAN_REQUIRED
→ Desktop notification
→ 用户输入 staging
→ submitHumanDecision
→ resume
→ autonomous diagnosis / recovery
→ Executor 重新执行
→ git diff --check PASS
→ npm test PASS
→ checkpoint
→ COMPLETED
→ Desktop completion notification
```

该链证明：PendingHumanAction durable；BUSINESS_DECISION UI 可用；AnsweredHumanAction 为 typed；human decision consumption 生效；resume 后不会再次重复 BUSINESS_DECISION；Executor 可重新执行；verification / checkpoint / completion 正常。

实现约束（不因本轮验收放宽）：

- `PendingHumanActionType` 刻意只覆盖 `BUSINESS_DECISION`。命令授权、凭据、修改范围扩张等权限类操作永不生成 pending action。
- `submitHumanDecision` 与通用 `resume()` 分离；`RECOVERY_REQUIRES_AUTHORIZATION` 在通用 resume 路径被显式拒绝，只有真正存在 pendingHumanAction 时才可由专用控件消费。
- 身份（sessionId / taskId / generation）由 Runtime 落库补齐并经 Control UI 对 durable state 校验，过期页面、重复提交、replayed generation 都无法启动第二次恢复。
- 诊断重复索要同一 generation 内已回答的 BUSINESS_DECISION 时 fail closed 为 `RECOVERY_BLOCKED` + `ANSWERED_BUSINESS_DECISION_REPEATED`，不再铸造同型 pending action 形成同页循环。
- 已回答的业务决定不为其他权限条目背书：剩余权限类条目仍独立阻塞恢复。

## 8. DeepSeek Independent Reviewer

**MANUAL / REAL-HOST PASS。** 最终成功任务：

```text
Task:    DESKTOP-DEEPSEEK-REVIEW-003
Session: desktop-review-001-202609220836-7398d3
checkpoint: f414ac7dc0f55909432f70471d246c6b5aa66412
```

真实 installed real-host 事件链：

```text
Codex EXECUTE
→ VERIFY
→ git diff --check PASS
→ npm test PASS
→ CONTROLLER_DECIDED REVIEW
→ REVIEW_REQUIRED
→ REVIEW_STARTED        agent=deepseek-reviewer provider=deepseek
→ AGENT_DISPATCHED      action=REVIEW agent=deepseek-reviewer provider=deepseek
→ REVIEW_PASSED
→ CONTROLLER_DECIDED    action=COMPLETE reasonCode=COMPLETION_CRITERIA_SATISFIED
→ checkpoint
→ TASK_COMPLETED
→ SESSION_COMPLETED     completionReason=ALL_TASKS_COMPLETED
→ Desktop COMPLETED notification
```

该链证明：Codex 为 Executor、DeepSeek 为独立 Reviewer；installed production reviewer wiring 正常；provider isolation 正常；deterministic Verification 正常；Review PASS 正常；Review 后 completion gate 正常收敛；不再出现重复 `EVIDENCE_MISSING`；Evidence 使用 step identity 正常；Git checkpoint 正常；Session 最终 COMPLETED。

实现要点：Composer 声明的能力 profile 现在显式包含 executor 与独立 reviewer；reviewer profile 仅在其真实 provider 路由（DeepSeek）刚被确认时才声明，探测缺失或抛错一律 fail closed 为「本机没有 reviewer」，不猜测能力存在。Reviewer 不可用时的原因文本保留稳定的 `no available agent for REVIEW` token（Runtime Repair 依赖该 token 推导 NO_AVAILABLE_AGENT_FOR_REVIEW），操作者可读说明只作追加，不替换机器 token。

## 9. Evidence Identity Blocker 与修复

早前真实失败链：

```text
REVIEW_PASSED
→ VERIFY:EVIDENCE_MISSING
→ repeated VERIFY
→ CYCLIC_NO_PROGRESS
```

根因：`binding.requiredEvidence` 使用 **command identity**（`git diff --check`、`npm test`），而实际 completion evidence 使用 **step identity**（`verify-1`、`verify-2`）。两者命名空间不同，completion gate 永远无法匹配 evidence.type。

修复为：V2 / Controller completion truth 统一使用 step identity，并与 execution command 身份分离。

- Golden → Controller handoff 使用 `identity: 'step'`。
- DIRECT / Controller trusted bindings 使用 step identity。
- 新增 `verificationCommandsForEvidence`，提供 stepId → 可执行 command 映射。
- production Executor packet 使用真实 shell command，step id 绝不进入 packet 或 shell。
- completion gate 安全标准未放宽；legacy `bindingsFromVerificationPlan` 的默认 command identity 行为未全局改变。

最终 installed real-host DESKTOP-DEEPSEEK-REVIEW-003 证明该修复有效。

## 10. Automated Validation

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **PASS**；1133 / 1133 tests，desktop 70 / 70 |
| `git diff --check` | **PASS** |
| `npm run desktop:package:dir` | **PASS** |
| `npm run desktop:package:smoke` | **PASS** |
| `npm run desktop:build:win` | **PASS** |

## 11. Installed Real-host Validation

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| Windows 安装 / Start Menu 启动 | 人工 | MANUAL / REAL-HOST PASS |
| Launchpad / Tray / close→hide / background runtime | 人工 | MANUAL / REAL-HOST PASS |
| Native Toast 显示与点击恢复 | 人工 | MANUAL / REAL-HOST PASS |
| Quick Fill（中英文 / 列表 / 失败闭合 / 绑定） | 人工 | MANUAL / REAL-HOST PASS |
| HUMAN_REQUIRED → BUSINESS_DECISION → resume → COMPLETED | 人工 + 账本 | MANUAL / REAL-HOST PASS |
| Codex Executor + DeepSeek Independent Reviewer → COMPLETED | 人工 + 账本 | MANUAL / REAL-HOST PASS |
| Evidence identity 修复 | 人工 real-host 复现验证 | MANUAL / REAL-HOST PASS |
| packaged Codex / Git / SQLite | 自动 packaged probe | PASS |

## 12. Known Non-blocking Observations

1. **DESKTOP-DEEPSEEK-REVIEW-002 transient no-op。** 曾出现一次 `NO_OP_EXECUTION: Codex completed without workspace inspection; execution evidence is missing`。该 Session 在 EXECUTE 阶段即 fail closed，未进入 VERIFY / REVIEW。随后同一版本 installer、同一 fixture 下的 DESKTOP-DEEPSEEK-REVIEW-003 完整成功。记录为一次 observed transient Codex no-op；NovaWing 对其正确 fail closed 到 HUMAN_REQUIRED，不计为 Phase 4 blocker，不据此继续修改 Runtime。
2. **`verificationCommandsForEvidence` 通过 package barrel `export *` 暴露。** `work-session/index.ts` 使用 `export * from './verification-plan.js'`，该 helper 因此成为 `nova-wing/development-guardian` 公共 API（`check-package-exports` 已同步登记）。隐藏它需要重构模块边界或把 `export *` 改为显式命名导出，属于超出本阶段收口范围的结构性改动。保持现状，记为本条 **non-blocking cleanup candidate**。
3. **Notification cold-start / 超出 15 分钟保留期。** 退出后或超出对象保留期的 persisted click 尚无可靠 Session 关联，记为 DEFERRED，未伪报支持。
4. **installer 未签名。** SmartScreen 可能告警；Authenticode 实测 NotSigned。
5. **macOS / Auto Update / CI** 未实现，属后续 Phase。

## 13. Git

```text
branch: feat/v0.4-desktop
Phase 4 final fix commit: 见本轮 commit（保持独立 final-fix commit，不 amend 03d328e）
push / merge / tag: NOT_DONE
```

安装包二进制、dist/、release artifacts、acceptance fixture repo、临时日志与数据库副本均未纳入提交（`artifacts/`、`dist/` 已在 `.gitignore` 中）。

## 14. Verdict

```text
Phase 4: PASS

NovaWing v0.4.0 Phase 4 — Windows Package & Real-host: PASS
```

自动门禁全绿；Windows 安装、桌面 Runtime、Quick Fill、白屏恢复、Native Toast、HUMAN_REQUIRED / BUSINESS_DECISION 闭环、DeepSeek 独立 Reviewer 与 Evidence identity 修复均已在真实安装主机上人工确认。

Ready for Phase 5 — macOS Package & Real-host。
