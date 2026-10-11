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
- NovaWing 当前代码 = 本地 AI 研发 Harness / 工作会话 / 验证与证据，以及 Windows/macOS Desktop；原 v0.1 认知领域内核已从本分支删除
- cc-auto = OfferFlow 仓库内的模型执行组件；不等于 NovaWing 的 `development-guardian`
- Personal OS = 总入口 / workflow bus
- AI-OS = Skill / Prompt / Workflow / Playbook 沉淀层
- ai-code-rules = AI 协作规则内核

## 当前工程范围

- 基线与此次裁剪以 `docs/plan/NovaWing-Core-Desktop-Rebase.md` 为准。
- Windows/macOS Desktop 的托盘、后台、通知、更新、安装包和发布链路必须保留。
- 真实执行入口为 V2 + Golden Path；风险任务自动进入 Controller，不恢复 V1/AskBridge 栈。
- 不读写真实用户配置、数据库或历史会话进行测试；模型集成测试使用注入替身。
- 产品方向保持冻结；工程维护与用户其他项目的业务活动分开处理。
