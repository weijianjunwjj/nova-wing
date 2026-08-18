# NovaWing Development Guardian MVP Runbook

> 日期：2026-08-18  
> 适用分支：`feat/development-guardian-mvp`  
> 环境：Windows Native + Git Bash-only

本手册只用于验证 Development Guardian MVP，不改变长期架构与 Scope Lock。

## 1. 本机基线

```bash
cd /d/VSCode/nova-wing

git pull --ff-only origin feat/development-guardian-mvp
npm ci
npm run check
```

要求：Node.js >= 24、Claude Code 可从 Git Bash 调用，并且正式自动执行任务前目标 worktree 必须干净。

## 2. ChatGPT Web Bridge

### 当前选择：ask-bridge

10x-chat PoC 在本机进入 Playwright Chromium 下载路径，国际 CDN 极慢。按照 Scope Lock 的 Bridge 止损规则，不继续为第三方浏览器二进制消耗时间，当前 MVP 使用 `ask-bridge 0.2.11`。

`0.2.11` 相比此前固定的 `0.2.10` 包含与当前 PoC 直接相关的上游修复：兼容新版 `chrome-devtools-mcp` 的 `list_pages` 输出格式，避免 provider URL 解析失败后每次调用都误开新分页；同时上游已将 `chrome-devtools-mcp` 固定版本升级到 `1.7.0`。NovaWing 仍保留自己的 task → conversation URL 绑定与会话漂移 fail-closed，不依赖“任意 ChatGPT tab”复用。

ask-bridge 使用系统已安装的真实 Google Chrome，通过 Chrome DevTools Protocol / chrome-devtools-mcp 操作网页；Windows 会检查 Program Files、Program Files (x86) 与 LOCALAPPDATA 的标准 Chrome 路径，因此不需要再下载一份 Playwright Chromium。

### Git Bash 安装 / 升级

NovaWing 提供 Git Bash-only 安装脚本，直接下载固定版本的 ask-bridge 官方 Windows Release：

```bash
npm run guardian:chatgpt:install
```

安装位置：

```text
~/.local/bin/ask-bridge.exe
```

验证：

```bash
"$HOME/.local/bin/ask-bridge.exe" --version
```

当前应输出 `0.2.11`。

### 第一次登录

```bash
npm run guardian:chatgpt:login
```

它会使用 ask-bridge 专属持久 Chrome Profile 打开 ChatGPT。只人工登录一次；不要把 OpenAI 密码写入源码、配置或环境变量。

## 3. ChatGPT-only PoC

```bash
npm run guardian:chatgpt:poc
```

目标链路：

```text
NovaWing
→ ask-bridge
→ real Google Chrome
→ ChatGPT Web
→ final response output file
→ strict Delegation Packet
```

### 同一任务的 ChatGPT 会话连续性

Guardian 不允许同一个 task 的每次 review 都新建 ChatGPT 会话。

当没有显式配置 `NOVAWING_CHATGPT_CONVERSATION_URL` 时，第一次 review 使用 `--new` 创建该 task 的独立 ChatGPT 会话；NovaWing 会从 ask-bridge stdout 的 `Thread Link` 捕获真实 ChatGPT conversation URL，并绑定到当前 task。之后同一进程内该 task 的所有 review 都必须带 `--session-url` 回到同一会话。

模型与 reasoning 只在首轮创建 task 会话时设置；后续 `--session-url` review 不重复切换这些 UI 选项，以减少不必要的 Browser Bridge 开销。

如果已绑定 task 的后续调用返回了不同的 Thread Link，Guardian fail-closed；如果第一次 review 没有获得 Thread Link，那么第二次 review 也不会静默新建会话，而是停止。

当前绑定先覆盖一次 Guardian 进程内的完整任务。进程重启后的 task/session 恢复属于后续 Trace + Resume 阶段；在此之前，如需跨进程固定会话，可以显式设置：

```bash
export NOVAWING_CHATGPT_CONVERSATION_URL='https://chatgpt.com/c/你的会话ID'
```

可选模型与推理：

```bash
export NOVAWING_CHATGPT_MODEL='GPT-5.6 Sol'
export NOVAWING_CHATGPT_REASONING='high'
```

## 4. 完整 GPT Web ↔ Claude Code PoC

### 4.1 先跑隔离金丝雀

在碰真实项目之前，先跑 NovaWing 自带的隔离金丝雀：

```bash
npm run guardian:poc:canary
```

这个命令会自动在 NovaWing 的 `.guardian-workspaces/canary-*` 下创建一个独立 Git 仓库，里面只有一个故意写错的 `normalizeName` 实现和真实失败测试。它先提交干净 baseline，再启动：

```text
ChatGPT Web Brain
→ Claude Code 修改唯一允许的 src 文件
→ Guardian 独立 npm test + git diff --check
→ 同一 ChatGPT conversation Review
→ done / revise / blocked
```

安全边界：测试文件、`package.json` 与 `.git/**` 都 forbidden；Claude Code 不允许 commit/push；目标仓库是隔离工作区，不会修改 NovaWing 当前源码或 OfferFlow。

成功时必须同时满足：

- `finalState = COMPLETED`；
- `independentFinalTest.exitCode = 0`；
- changed files 只包含 `src/normalize-name.mjs`；
- ChatGPT 后续 review 仍在同一 task / conversation；
- 若 Reviewer 给出 `revise`，Claude Code 必须复用同一 session 继续。

默认 Claude Code 使用 `sonnet`，ChatGPT reasoning 使用 `high`。可用环境变量覆盖模型，但第一轮金丝雀不建议提高成本。

#### 性能诊断

金丝雀默认开启性能诊断，不改变任务裁决，只记录真实耗时。最终 `canary-result` 会额外包含：

```text
timings:
  canary/setup
  chatgpt-web/bridge-command       # 每一轮 GPT Web review 的总耗时
  claude-executor/clean-start      # git clean-worktree 检查
  claude-executor/claude-code      # Claude Code 端到端 wall-clock
  claude-executor/inspect-changes  # git status
  claude-executor/verification     # 每条确定性验证命令
  claude-executor/executor-total
  guardian/run-total
  canary/independent-final-test
  canary/script-total

claudeBreakdown:
  wallClockMs                      # NovaWing 实测 Claude Code 命令总耗时
  reportedDurationMs               # Claude Code JSON 自报 duration_ms
  apiDurationMs                    # Claude Code JSON 自报 duration_api_ms
  reportedNonApiMs                 # reportedDurationMs - apiDurationMs
  wallMinusReportedMs              # 进程启动/退出等外层差值
  apiSharePctOfReported            # API 时间占 Claude 自报总时间比例
  numTurns
  totalCostUsd

bridgeDiagnostics:
  ask-bridge --verbose 的阶段输出，并记录每行相对当前 review 的 elapsedMs
```

这样可以区分：本地 Git/npm 慢、Claude Code 慢、Claude API/模型等待慢、Claude 本地 agent/tool loop 慢、ChatGPT Web/Bridge 慢，还是浏览器自动化某一步卡住。诊断期间保持模型与 reasoning 不变，先测量再优化。若只想关闭 verbose 诊断：

```bash
export NOVAWING_GUARDIAN_DIAGNOSTICS=0
```

### 4.2 再跑真实目标仓库

只有金丝雀成功后，才运行真实项目任务。目标仓库必须是干净 Git worktree，并优先使用低风险、可丢弃分支。

```bash
export NOVAWING_TARGET_REPO='/d/VSCode/your-target-repo'
export NOVAWING_TASK_GOAL='完成一个明确、很小、可验证的开发任务'
export NOVAWING_TASK_CONSTRAINTS='不要改变公开 API,不要扩大范围'
export NOVAWING_ACCEPTANCE_CRITERIA='现有测试通过,目标行为可验证'
export NOVAWING_DO_NOT_DO='不要 git commit,不要 git push,不要改数据库 schema'
export NOVAWING_ALLOWED_PATHS='src/**,tests/**'
export NOVAWING_FORBIDDEN_PATHS='migrations/**,.env'
export NOVAWING_GUARDIAN_MAX_ITERATIONS='3'
export NOVAWING_CHATGPT_REASONING='high'

npm run guardian:poc
```

可选：

```bash
export NOVAWING_CHATGPT_CONVERSATION_URL='https://chatgpt.com/c/你的专用会话ID'
export NOVAWING_CHATGPT_MODEL='GPT-5.6 Sol'
export NOVAWING_CLAUDE_MODEL='sonnet'
export NOVAWING_CLAUDE_MAX_TURNS='12'
export NOVAWING_GUARDIAN_TIMEOUT_MS='1200000'
```

不要使用 Claude Code `--dangerously-skip-permissions`。

## 5. 当前安全边界

自动允许：GPT Web 生成 `proceed / revise / blocked / done`；Claude Code 在允许工具范围内读取、搜索、编辑；Guardian 独立执行白名单验证；同一任务 ChatGPT conversation 复用；同一任务 Claude session resume；最多按 `maxIterations` 循环。

以下立即进入 HUMAN_REQUIRED：目标仓库启动时已有未提交改动；Bridge 失败或协议非法；同 task ChatGPT 会话发生漂移；Claude Code blocker / 异常；修改文件越过 allowedPaths 或进入 forbiddenPaths；非白名单验证命令；达到最大循环数；GPT 无执行证据直接 done；deterministic verification 缺失、failed 或 skipped。

## 6. 验证命令白名单

Guardian 至少自动执行 `git diff --check`。GPT 还可以选择：

```text
npm test
npm run test
npm run typecheck
npm run build
npm run lint
npm run check
git diff --check
```

目标项目没有某个命令时，不应要求该命令；其他命令不会由 GPT 文本直接变成 shell 执行。

## 7. MVP PoC 成功标准

```text
User Goal
→ GPT Web: proceed (bind one ChatGPT conversation)
→ Claude Code: execute
→ deterministic verification
→ same GPT Web conversation: revise / done
→ if revise: Claude Code execute again (same Claude session)
→ deterministic verification
→ same GPT Web conversation: done
→ COMPLETED
```

整个过程用户不手工复制 GPT ↔ Claude Code 内容。只有真实跑通，才进入持久化 / resume / Human-on-Exception 通知阶段。
