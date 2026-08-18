# NovaWing Development Guardian MVP Runbook

> 日期：2026-08-18  
> 适用分支：`feat/development-guardian-mvp`  
> 环境：Windows Native + Git Bash-only

本手册只用于验证 Development Guardian MVP，不改变长期架构与 Scope Lock。

## 1. 本机基线检查

在 Git Bash 中：

```bash
cd /d/VSCode/nova-wing

git fetch origin
git switch feat/development-guardian-mvp
git status --short

node -v
npm -v
git --version
bash --version
claude --version
```

要求：

- Node.js >= 24。
- `git status --short` 在正式运行自动执行任务前必须为空。
- `claude` 必须可以从 Git Bash 直接调用。

然后安装并验证 NovaWing 自身：

```bash
npm ci
npm run check
```

`npm run check` 未通过时，不进入真实 Browser / Claude Code PoC。

## 2. 第一次登录 ChatGPT Web Bridge

10x-chat 当前只作为可替换 ChatGPT Web Adapter。MVP PoC 阶段跟随 npm 的 `latest` dist-tag；只有真实 Bridge PoC 成功后才锁定一个已实际发布、已验证可用的具体版本。不要把 GitHub `main` 分支 `package.json` 中的版本号直接当成 npm 已发布版本。

先确认 npm 实际解析到的版本：

```bash
npx --yes 10x-chat@latest --version
```

再登录：

```bash
npm run guardian:chatgpt:login
```

会打开一个由 10x-chat 管理的持久浏览器 Profile。

只在这个浏览器窗口中人工完成 ChatGPT 登录；不要把 OpenAI 密码写进 NovaWing 配置、环境变量或源码。

登录成功后窗口会自动关闭。

## 3. 先跑 ChatGPT-only PoC

先验证：

```text
NovaWing
→ 10x-chat delegate
→ ChatGPT Web
→ 合法 Delegation Packet
```

运行：

```bash
npm run guardian:chatgpt:poc
```

成功结果应输出：

```json
{
  "status": "ok",
  "packet": {
    "verdict": "proceed"
  }
}
```

实际 packet 会包含完整的 `goal / instructions / constraints / verification / doNotDo / rationale`。

如果希望固定到一个专用 ChatGPT 会话：

```bash
export NOVAWING_CHATGPT_CONVERSATION_URL='https://chatgpt.com/c/你的会话ID'
npm run guardian:chatgpt:poc
```

### ChatGPT-only PoC 停止条件

出现以下任一情况，不继续接 Claude Code：

- 登录状态无法稳定复用；
- `10x-chat` 无法稳定进入 ready；
- npm `latest` 中尚未包含 `delegate` 命令；
- ChatGPT 回复经常截断；
- GPT 无法稳定输出合法 Delegation Packet；
- 页面协议变化导致 Bridge 状态未知。

如果 10x-chat 在限定 PoC 窗口内持续失败，按 Scope Lock 切换 `ask-bridge`，不在 10x-chat 内深挖修复。

## 4. 完整 GPT Web ↔ Claude Code PoC

只有 ChatGPT-only PoC 成功后才运行。

目标仓库必须是一个**干净 Git worktree**。第一轮建议使用低风险、可随时丢弃的测试分支或测试仓库。

示例：

```bash
export NOVAWING_TARGET_REPO='/d/VSCode/your-target-repo'
export NOVAWING_TASK_GOAL='完成一个明确、很小、可验证的开发任务'
export NOVAWING_TASK_CONSTRAINTS='不要改变公开 API,不要扩大范围'
export NOVAWING_ACCEPTANCE_CRITERIA='现有测试通过,目标行为可验证'
export NOVAWING_DO_NOT_DO='不要 git commit,不要 git push,不要改数据库 schema'
export NOVAWING_ALLOWED_PATHS='src/**,tests/**'
export NOVAWING_FORBIDDEN_PATHS='migrations/**,.env'
export NOVAWING_GUARDIAN_MAX_ITERATIONS='3'

npm run guardian:poc
```

也可以把 goal 直接放到命令尾部：

```bash
npm run guardian:poc -- '完成一个明确、很小、可验证的开发任务'
```

可选：

```bash
export NOVAWING_CHATGPT_CONVERSATION_URL='https://chatgpt.com/c/你的专用会话ID'
export NOVAWING_CHATGPT_MODEL='Thinking'
export NOVAWING_CLAUDE_MODEL='sonnet'
export NOVAWING_CLAUDE_MAX_TURNS='12'
export NOVAWING_GUARDIAN_TIMEOUT_MS='1200000'
```

不要为了跑通 PoC 使用 Claude Code 的 `--dangerously-skip-permissions`。

## 5. 当前安全边界

### 自动允许

- GPT Web 生成 `proceed / revise / blocked / done` 决策；
- Claude Code 读取、搜索、编辑文件；
- Guardian 独立执行白名单验证命令；
- 同一任务的 Claude Code session resume；
- 最多按 `maxIterations` 自动循环。

### 当前会立即停到 HUMAN_REQUIRED

- 目标仓库启动时已有未提交改动；
- GPT Web Bridge 失败或输出协议非法；
- Claude Code 报 blocker / 执行异常；
- 修改文件越过 `allowedPaths`；
- 修改文件进入 `forbiddenPaths`；
- GPT 要求执行非白名单验证命令；
- 达到最大循环数；
- GPT 在没有执行证据时直接宣告 done；
- deterministic verification 缺失、failed 或 skipped。

## 6. 当前验证命令白名单

Guardian 最少自动执行 `git diff --check`，GPT 还可以从以下命令中选择：

```text
npm test
npm run test
npm run typecheck
npm run build
npm run lint
npm run check
git diff --check
```

其他命令不会被 GPT 文本直接转成 shell 执行；MVP 会停到人工处理。

## 7. PoC 成功标准

完整 PoC 至少证明一次：

```text
User Goal
→ GPT Web: proceed
→ Claude Code: execute
→ deterministic verification
→ GPT Web: revise
→ Claude Code: execute again (resume same session)
→ deterministic verification
→ GPT Web: done
→ COMPLETED
```

整个过程用户不手工复制 GPT ↔ Claude Code 内容。

只有这条链真实跑通，才进入下一阶段：持久化 / resume / Human-on-Exception 通知。
