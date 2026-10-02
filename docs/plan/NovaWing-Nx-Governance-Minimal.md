# Nx 与独立治理：最小实现

日期：2026-10-02。源码基线 `ad26456e686a8e6517d157e96e3c2ebe00a257ef`；
提交保留 `a827f91` 新增的 Claude 交接文档。复用 Planning、Plan Freeze、Reviewer、
TaskController 和 owned checkpoint，不迁移现有源码目录，不引入服务进程。

## 实际行为

| 入口 | 约束与结果 |
| --- | --- |
| 规划 | 默认由独立 DeepSeek 路由做语义审查；同 provider 自审被拒绝。审查对象是副本，PASS 收据绑定 plan ID、版本及内容哈希；内容改变后不能批准。 |
| 执行 | 每次交付 dispatch 重验冻结任务的目标、约束、验收及路径权限。偏移先返回 BLOCKED，不调用 Executor。 |
| 运行审查 | Reviewer 用 `GOVERNANCE_DRIFT:` 标记需求/范围/验收漂移；Controller 暂停，继续决定也不能自动重写实现。普通实现缺陷仍走既有修复流程。 |
| 手动纠偏 | Customer Mode 的“请求独立纠偏”调用一次显式配置的 Claude 模型；无工具、MCP、自动重试、自动升级或自动恢复。请求先落盘，结果绑定证据包哈希，可重启读取。 |
| 采用建议 | 用户点击“按建议生成新版方案”后走既有 change request / generate / DeepSeek 复审 / 人工批准流程；旧 frozen snapshot 保留。建议本身没有审批或执行权限。 |

已冻结历史版本沿用既有冻结协议。未冻结旧草稿缺少新的审查收据，须重新生成并审查。
纠偏 verdict 为 KEEP、REVISE 或 NEEDS_EVIDENCE；不是产品验收 PASS。

## 配置

复用已有 Claude CLI 的 DeepSeek 配置，也可单独设置角色路由：

| 角色 | 环境变量 | 要求 |
| --- | --- | --- |
| Auditor | `NOVAWING_AUDITOR_BASE_URL`、`NOVAWING_AUDITOR_API_KEY` 或 `NOVAWING_AUDITOR_AUTH_TOKEN`、`NOVAWING_AUDITOR_MODEL` | HTTPS 的 `api.deepseek.com`；默认模型别名 `sonnet`，具体映射由现有 DeepSeek CLI 路由决定。 |
| Adjudicator | `NOVAWING_ADJUDICATOR_BASE_URL`、`NOVAWING_ADJUDICATOR_API_KEY` 或 `NOVAWING_ADJUDICATOR_AUTH_TOKEN`、`NOVAWING_ADJUDICATOR_MODEL` | 必须显式选择 `claude-*` 模型；如需 Opus，填入账户实际可用的 Opus 模型 ID。独立 endpoint 必须提供独立角色凭据。 |

不配置 Adjudicator 不影响常规执行；点击纠偏会明确失败，不回退到其他模型。
CLI 需支持 `--bare`、`--tools`、`--disallowedTools`、`--strict-mcp-config` 等参数。
每次调用最长 120 秒，单轮，输出上限 128 KB；这些不是金额上限。
非 DeepSeek 的纠偏 endpoint 仅记录为 `claude-configured-route`；不能凭模型名称证明第三方网关的底层模型身份。
配置凭据留在环境/本机配置，不提交到仓库。

## Nx

```sh
npm ci
npm run nx:graph
npx nx run nova-wing:build
npm run check:affected -- --base=origin/main --head=HEAD
npm run check
```

10 个项目节点复用现有目录；root build/typecheck 可本地缓存，完整 check 不缓存。
affected 只决定是否运行全量检查，不声称已有细粒度测试拆分。关闭 Nx Cloud，默认串行。
治理 AST 检查要求纯 policy 不导入运行能力，governance/escalation 的调用使用公开 index。
受限环境如不支持 Nx worker socket，可设置 `NX_DAEMON=false NX_ISOLATE_PLUGINS=false`。

## 证据和限制

运行中目标仓库先请求边界暂停，用户在暂停后再点击。证据采集绑定 frozen snapshot 和
runtime plan、仓库身份/分支/baseline，前后复核 HEAD/status/diff。原始请求和结果仅保存到
本机数据目录；HTTP 返回裁决及身份摘要。未跟踪文件内容、新鲜测试结果缺失时明确列出，
纠偏模型不得把缺失事实当作通过。

这是最小第一版：未实现跨进程全局纠偏锁、金额预算账本或自动补齐产品证据。
本轮无真实付费模型调用；Windows/macOS 本机运行与真实 DeepSeek/Claude 路由待验收。
自动化验证范围及结果见本次 PR。
