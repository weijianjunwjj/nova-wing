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

10x-chat PoC 在本机进入 Playwright Chromium 下载路径，国际 CDN 极慢。按照 Scope Lock 的 Bridge 止损规则，不继续为第三方浏览器二进制消耗时间，当前 MVP 切换到 `ask-bridge 0.2.10`。

ask-bridge 使用系统已安装的真实 Google Chrome，通过 Chrome DevTools Protocol / chrome-devtools-mcp 操作网页；Windows 会检查 Program Files、Program Files (x86) 与 LOCALAPPDATA 的标准 Chrome 路径，因此不需要再下载一份 Playwright Chromium。

### Git Bash 安装

NovaWing 提供 Git Bash-only 安装脚本，直接下载 ask-bridge 官方 Windows Release：

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
→ final response stdout
→ strict Delegation Packet
```

成功应输出：

```json
{
  "status": "ok",
  "packet": {
    "verdict": "proceed"
  }
}
```

可选固定专用会话与模型：

```bash
export NOVAWING_CHATGPT_CONVERSATION_URL='https://chatgpt.com/c/你的会话ID'
export NOVAWING_CHATGPT_MODEL='GPT-5.6 Sol'
export NOVAWING_CHATGPT_REASONING='high'

npm run guardian:chatgpt:poc
```

ask-bridge 支持 `--session-url` 接续既有 ChatGPT 对话；ChatGPT reasoning 支持 `auto / instant / medium / high`。

## 4. 完整 GPT Web ↔ Claude Code PoC

只有 ChatGPT-only PoC 成功后才运行。

目标仓库必须是干净 Git worktree。第一轮使用低风险、可随时丢弃的测试分支或测试仓库。

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

自动允许：GPT Web 生成 `proceed / revise / blocked / done`；Claude Code 在允许工具范围内读取、搜索、编辑；Guardian 独立执行白名单验证；同一任务 Claude session resume；最多按 `maxIterations` 循环。

以下立即进入 HUMAN_REQUIRED：目标仓库启动时已有未提交改动；Bridge 失败或协议非法；Claude Code blocker / 异常；修改文件越过 allowedPaths 或进入 forbiddenPaths；非白名单验证命令；达到最大循环数；GPT 无执行证据直接 done；deterministic verification 缺失、failed 或 skipped。

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
→ GPT Web: proceed
→ Claude Code: execute
→ deterministic verification
→ GPT Web: revise
→ Claude Code: execute again (same session)
→ deterministic verification
→ GPT Web: done
→ COMPLETED
```

整个过程用户不手工复制 GPT ↔ Claude Code 内容。只有真实跑通，才进入持久化 / resume / Human-on-Exception 通知阶段。
