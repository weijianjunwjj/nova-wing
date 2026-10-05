# Claude ↔ Codex 交接协议

目的：让 Claude（Owner / 审核）和 Codex（实现 / 运行）看到同一份 NovaWing 状态，同时不要求 Claude
每轮通读仓库；运行时事实不靠 Claude 推断。本协议补充 [WORKFLOW](WORKFLOW.md)，不覆盖
[AGENTS.md](../../AGENTS.md)，也不授予任何权限。

## 1. 事实归属

| 事实类型 | 以谁为准 | 依据 |
| --- | --- | --- |
| 运行时事实：测试结果、Node/npm 版本、命令行为、环境 | Codex | 日志 + `HANDOFF.json` 的 sha256 |
| 产品与架构判断、验收判据、范围与停止条件 | Claude | 任务契约与验收报告 |
| 外部影响授权：commit / push / merge / 模型调用 / 真实数据 | 用户 | 本轮明确授权 |

Claude 不能在 VM 里复现 macOS 运行环境（`node_modules` 是指向主机路径的符号链接，VM 内不可达），
所以 Claude 对运行行为的判断一律标"推断"，不得写成事实，也不得写进硬约束。

## 2. 交接快照 `HANDOFF.json`

Codex 每轮结束（无论 PASS / BLOCKED / 停止）写入本轮 artifacts 目录，体积目标 ≤ 2 KB。
不写凭据、客户内容或真实数据路径下的文件内容。

```json
{
  "round": "v0.5-followup-1",
  "status": "DONE | BLOCKED | STOPPED",
  "worktree": "/Users/weijianjun/.codex/worktrees/<name>/nova-wing",
  "branch": "codex/...",
  "baseSha": "<40 位>",
  "headSha": "<40 位>",
  "trackedDirty": false,
  "untrackedOutsideArtifacts": ["node_modules"],
  "runtime": { "node": "v24.x.y", "npm": "x.y.z", "os": "darwin-arm64" },
  "commands": [
    { "cmd": "npm run check", "cwd": "<worktree>", "exit": 0,
      "summary": "1397/0 unit, 194/0 desktop", "log": "artifacts/.../x.log", "logSha256": "<64 位>" }
  ],
  "changedFiles": { "path/relative/to/worktree": "<sha256>" },
  "assumptionChecks": [
    { "id": "A1", "claim": "Owner 假设原文", "result": "HOLDS | FAILS", "evidence": "file:line" }
  ],
  "stopTriggered": null,
  "notRun": ["..."],
  "pending": ["待核实项"]
}
```

`changedFiles` 只列本轮改动的文件（相对 `baseSha`），不是全仓库。

## 3. Claude 每轮开头的轻量核对

只执行下面这一段，然后以快照为准，不通读仓库。在 VM 里必须设置 `GIT_OPTIONAL_LOCKS=0`，
否则 `git status` 会在 `main/.git/worktrees/<id>/` 留下删不掉的 `index.lock`。

```bash
W=<worktree 的 VM 路径>; H=$W/artifacts/<round>/HANDOFF.json
export GIT_OPTIONAL_LOCKS=0 GIT_DIR=<main>/.git/worktrees/<id> GIT_WORK_TREE=$W
cd $W && python3 - "$H" <<'EOF'
import json,sys,subprocess,hashlib,os
h=json.load(open(sys.argv[1])); g=lambda *a: subprocess.run(['git',*a],capture_output=True,text=True).stdout.strip()
ok = g('rev-parse','HEAD')==h['headSha'] and (g('diff','--name-only','HEAD')=='')==(not h['trackedDirty'])
bad=[p for p,s in h['changedFiles'].items() if not os.path.exists(p) or hashlib.sha256(open(p,'rb').read()).hexdigest()!=s]
bad+=[c['log'] for c in h['commands'] if c.get('log') and hashlib.sha256(open(c['log'],'rb').read()).hexdigest()!=c['logSha256']]
print('HANDOFF_OK' if ok and not bad else f'HANDOFF_MISMATCH head_ok={ok} bad={bad}')
EOF
```

- `HANDOFF_OK`：快照可信。审查只读与本轮相关的 `git diff <baseSha>..<headSha> -- <文件>` 或具体行。
- `HANDOFF_MISMATCH` 或快照缺失：停止审核，向用户报告差异，不根据猜测下结论。
- 跨轮背景依赖 [CURRENT_STATE](CURRENT_STATE.md) 和 Claude 的永久记忆，不重新扫描仓库。

## 4. Claude 给 Codex 的指令写法

指令统一使用 [CODEX_TASK_TEMPLATE](CODEX_TASK_TEMPLATE.md)，分三层：

1. **硬约束**：权限、范围、预算、停止条件。Codex 不得违背。
2. **验收判据**：可观察结果（命令输出、状态码、日志命中数），只写"什么算通过"，不写实现方式。
3. **Owner 假设**：Claude 对代码现状的判断，每条附 `文件:行号`，并且必须是 Claude 本轮实际 grep 过的。
   Codex 先核实再动手：
   - 假设成立：照常执行。
   - 假设不成立：在 `assumptionChecks` 中附证据，在硬约束内用最小改动满足验收判据；
     只有满足判据需要越过硬约束时才停止。

禁止把未核实的假设写进硬约束或验收判据。例如"view.ts 每个 fetch 都显式传了 credentials"
只能写成 Owner 假设，不能写成"必须严格等于 same-origin"。

## 5. 环境一致性

- Node 版本以 `package.json` `engines`（`>=24.0.0`）为准；`scripts/run-isolated-tests.mjs`
  负责拒绝低版本（v0.5 follow-up 第 1 项）。在这项落地之前，指令 STEP 0 必须先检查 `node --version`。
- 机器上有多个 NovaWing worktree（pr3-local-acceptance、requirement002-stabilization 等），
  指令和快照都必须写绝对路径与分支，不写"仓库"或"本地"这类泛称。
