# NovaWing AI collaboration rules

## Cross-project permanent memory

涉及以下内容时：

- 用户长期偏好
- 跨项目架构
- 长期技术规划
- AI 协作规则
- 历史架构决策
- OfferFlow / NovaWing / cc-auto / Personal OS / AI-OS 之间的职责边界

任务开始前先读取：

- Windows：`D:/VSCode/obsidian-ai-memory/00-System/AGENT_MEMORY.md`
- macOS：`/Users/weijianjun/obsidian-ai-memory/00-System/AGENT_MEMORY.md`

按当前操作系统选择，读取前核验文件存在；一端不可访问不得错误判定另一端路径不存在。

然后按照该文件的协议读取相关永久记忆。

之后必须重新核验当前项目自身事实，包括：

1. 用户本轮最新明确指令
2. AGENTS.md
3. CLAUDE.md
4. 权威项目文档
5. 当前源码
6. tests
7. 数据库 / state（如果相关）
8. git status

项目当前实现事实优先于 Obsidian 中的历史摘要。

不要把整个 Obsidian Vault 复制进项目。

临时 debug、一次性上下文不要写入永久记忆。

只有跨项目、长期稳定、未来有复用价值的决策才允许晋升到永久记忆。

职责边界按实际工程作用域区分：

- OfferFlow = 求职业务层
- NovaWing v0.1 领域内核 = 认知 / 已批准主线；同仓库 `development-guardian` = 本地 AI 研发 Harness / 工作会话 / 验证与证据，不是正式内核包公共 API
- cc-auto = OfferFlow 仓库内的模型执行组件；不等于 NovaWing 的 `development-guardian`
- Personal OS = 总入口 / workflow bus
- AI-OS = Skill / Prompt / Workflow / Playbook 沉淀层
- ai-code-rules = AI 协作规则内核
