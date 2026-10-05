# Codex 任务指令模板

按 [HANDOFF_PROTOCOL](HANDOFF_PROTOCOL.md) 第 4 节填写。尖括号是占位符；不适用的项写"无"，不要删掉。

```text
【轮次】<round id>：<一句话目标 / 用户价值>

【STEP 0 · 环境核对，任一不符立即停止并报告】
- worktree：<绝对路径>
- 分支：<branch>
- HEAD 必须等于：<40 位 SHA>
- tracked diff 必须为 0（未跟踪文件只允许：<列表，如 node_modules 符号链接>）
- `node --version` 必须 ≥ 24；把输出写在每份日志的第一行

【一 · 硬约束（不得违背）】
- 允许修改：<文件 / 目录>
- 禁止修改：<生产代码 / 某些文件 / frozen 数据等>
- Git：<允许新增 N 个 commit | 不允许>；push=<否>；merge=<否>；amend=<否>；tag=<否>
- 预算：模型调用 <0>，付费 API <0>，网络 <否>
- 数据：不读写、不 stat 真实 NovaWing 数据目录；fixture 一律放临时目录
- 停止条件：<列出>；同一失败一次针对性修复后仍失败就停止

【二 · 验收判据（只写什么算通过）】
- J1：<可观察结果，例如：`npm run check` exit 0，failed=0>
- J2：<……>

【三 · Owner 假设（先核实再动手）】
- A1：<假设>（依据 <文件:行号>）
- A2：<……>
假设不成立：在 HANDOFF.json 的 assumptionChecks 中附证据，在硬约束内用最小改动满足判据；
只有必须越过硬约束时才停止。

【交付】
- 改动文件逐个 stage，禁止 `git add .` / `-A`；commit 前贴出 `git diff --cached --stat`
- 写入 artifacts/<round>/HANDOFF.json（字段见 HANDOFF_PROTOCOL 第 2 节）
- 回报内容：修改完成 / 测试通过 / 流程通过 / 待 Owner 验收 四项分开写，并附 HANDOFF.json 路径
```
