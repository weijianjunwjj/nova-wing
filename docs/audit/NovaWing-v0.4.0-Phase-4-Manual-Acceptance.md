# Phase 4：安装版人工验收

日期：2026-09-22。分支 `feat/v0.4-desktop`。

最终 installer：`artifacts/desktop/NovaWing Setup 0.4.0.exe`
size 218,047,037 bytes，SHA256 `09f830ba3d99ad10b29a59052e87659bc0a65c2b59e2d608b6b99b40e9808445`。

本文件记录 **Windows installed real-host 人工验收的最终结果**。所有自动门禁见 [Phase 4 Report](NovaWing-v0.4.0-Phase-4-Report.md)；自动结果与人工结果分开，人工确认项一律标记 MANUAL / REAL-HOST PASS，不以自动化代替。

```text
Phase 4 installed real-host manual acceptance: PASS
```

## 1. 安装与桌面 Runtime — MANUAL / REAL-HOST PASS

- Windows x64 installer 可安装；可从 **Start Menu** 启动。
- Electron Main 承载 Desktop Runtime；Launchpad 正常。
- Tray 正常；关闭窗口后隐藏到后台正常；Desktop background runtime 正常。
- packaged Codex 可用；Git discovery 可用；SQLite / node:sqlite packaged smoke 可用。
- Windows Native Toast 可真实显示。

## 2. Quick Fill — MANUAL / REAL-HOST PASS

曾发现 allowed paths 解析缺失与 acceptance / verification binding 的 lossy parsing；修复后在安装版确认：

- 中英文 Allowed Paths 正确解析。
- bullets / comma / 顿号 / backticks 等列表形态正确。
- ambiguous permission fail closed。
- partial parsing 不覆盖已有 allowedPaths。
- Acceptance Criteria / Required Evidence 正确绑定。

## 3. 窗口唤醒白屏恢复 — MANUAL / REAL-HOST PASS

Notification click / window restore 的白屏问题已修复，并在安装版人工复验通过：点击 Toast 后窗口恢复、无白屏、进入正确 Session。

修复细节（同健康 URL 不重复 `loadURL`、串行 navigation tail、事件驱动等待 `did-stop-loading` / `ready-to-show`、destroyed window 直达目标 Control URL）见 [白屏修复报告](NovaWing-v0.4.0-Window-White-Screen-Blocker.md) 与 Phase 4 Report 第 5 节。

## 4. HUMAN_REQUIRED / BUSINESS_DECISION — MANUAL / REAL-HOST PASS

```text
Task:    DESKTOP-BUSINESS-DECISION-004
Session: desktop-business-decision-001-202609220448-3f4d96
checkpoint: 74324c695e18afa3040c38643a529661e3b7a787
```

真实事件链：

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

证明：PendingHumanAction durable；BUSINESS_DECISION UI 可用；AnsweredHumanAction 为 typed；human decision consumption 生效；resume 后不会再次重复 BUSINESS_DECISION；Executor 可重新执行；verification / checkpoint / completion 正常。

## 5. DeepSeek Independent Reviewer — MANUAL / REAL-HOST PASS

```text
Task:    DESKTOP-DEEPSEEK-REVIEW-003
Session: desktop-review-001-202609220836-7398d3
checkpoint: f414ac7dc0f55909432f70471d246c6b5aa66412
```

真实事件链：

```text
Codex EXECUTE
→ VERIFY
→ git diff --check PASS
→ npm test PASS
→ CONTROLLER_DECIDED REVIEW
→ REVIEW_REQUIRED
→ REVIEW_STARTED     agent=deepseek-reviewer provider=deepseek
→ AGENT_DISPATCHED   action=REVIEW agent=deepseek-reviewer provider=deepseek
→ REVIEW_PASSED
→ CONTROLLER_DECIDED  action=COMPLETE reasonCode=COMPLETION_CRITERIA_SATISFIED
→ checkpoint
→ TASK_COMPLETED
→ SESSION_COMPLETED   completionReason=ALL_TASKS_COMPLETED
→ Desktop COMPLETED notification
```

证明：Codex 为 Executor、DeepSeek 为独立 Reviewer；installed production reviewer wiring 正常；provider isolation 正常；deterministic Verification 正常；Review PASS 正常；Review 后 completion gate 正常收敛；不再出现重复 `EVIDENCE_MISSING`；Evidence 使用 step identity 正常；Git checkpoint 正常；Session 最终 COMPLETED。

## 6. Evidence Identity 修复 — MANUAL / REAL-HOST PASS

早前真实失败链 `REVIEW_PASSED → VERIFY:EVIDENCE_MISSING → repeated VERIFY → CYCLIC_NO_PROGRESS` 的根因为 binding 使用 command identity 而 completion evidence 使用 step identity。修复后由第 5 节的真实任务验证收敛。细节见 Phase 4 Report 第 9 节。

## 7. Observed transient（非 blocker）

`NO_OP_EXECUTION: Codex completed without workspace inspection; execution evidence is missing` 曾在 DESKTOP-DEEPSEEK-REVIEW-002 出现一次，该 Session 在 EXECUTE 阶段即 fail closed，未进入 VERIFY / REVIEW。同一 installer、同一 fixture 下的 DESKTOP-DEEPSEEK-REVIEW-003 完整成功。不计为 Phase 4 blocker，不据此继续修改 Runtime。

## 8. 未完成 / DEFERRED（不伪报）

- 超出 15 分钟通知对象保留期或退出后的 persisted click，尚无可靠 Session 关联 —— DEFERRED。
- installer 未签名，SmartScreen 可能告警 —— 已知非阻塞。
- macOS、Auto Update、CI —— 属后续 Phase，本轮未实现。

## 9. 自动取证位置

- 安装版本地事件：`%LOCALAPPDATA%\NovaWing\desktop\events.jsonl`
- package smoke：`artifacts/desktop/package-smoke/result.json`
- installer size/SHA256/版本：`artifacts/desktop/installer.json`
- 真实任务参数：`artifacts/desktop/realhost-task.json`
- 历史明细：`window-final-gates.json`、`quick-fill-final-gates.json`、`WINDOWS_PACKAGED_REALHOST.json`

以上 artifacts 均为 ignored，不纳入提交。
