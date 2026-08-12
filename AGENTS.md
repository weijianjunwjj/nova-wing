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

`D:/VSCode/obsidian-ai-memory/00-System/AGENT_MEMORY.md`

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

职责边界保持不变：

- OfferFlow = 业务层
- NovaWing = 认知层
- cc-auto = 模型执行层
- Personal OS = 总入口 / workflow bus
- AI-OS = Skill / Prompt / Workflow / Playbook 沉淀层
- ai-code-rules = AI 协作规则内核
