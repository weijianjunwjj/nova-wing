# ADR 0003：私有 GitHub Packages 发布与不可变消费

- 状态：Accepted；真实发布仍需受保护环境人工批准
- 日期：2026-08-05
- 范围：NovaWing npm 包的发布来源、版本与消费规则
- 取代：ADR 0002 中“npm 公共 Registry 是正式来源”的分发结论；ADR 0002 的 Host Snapshot V3 技术结论保持不变

## 决策

唯一正式远程来源是 GitHub Packages 私有 npm Registry：
`https://npm.pkg.github.com`。`origin` 为
`https://github.com/weijianjunwjj/nova-wing.git`，所以 GitHub owner、npm scope 与正式包名分别为
`weijianjunwjj`、`@weijianjunwjj`、`@weijianjunwjj/nova-wing`。不得发布到 npm 公共
Registry，也不得把占位 scope 写入配置。

仓库根 `package.json` 继续使用 `"private": true` 与 `"license": "UNLICENSED"`。
`private` 是根目录的防误发布门；`UNLICENSED` 表示没有授予公众复制、修改或再分发许可，
并不表示包可公开使用。正式 manifest 只在 `release-package/` 内由脚本确定性生成，不继承
`private`、开发脚本、开发/测试依赖或生命周期钩子。发布目录只包含 README 与构建后的
JavaScript/声明文件，避免把源码布局、测试、ADR、临时数据库、凭证或本地路径带入包。

正式出口固定为：

```text
@weijianjunwjj/nova-wing/core
@weijianjunwjj/nova-wing/sqlite
@weijianjunwjj/nova-wing/testing
@weijianjunwjj/nova-wing/host-snapshot
```

`testing` 只用于测试宿主和合约验收，不是生产宿主接入层；导入它不会执行默认生产副作用。
未列入 `exports` 的深层路径均为私有实现。

## SemVer 与不可变版本

- 版本必须是精确、合法的 SemVer。patch 用于兼容修复，minor 用于向后兼容能力，major
  用于破坏公开 API、状态/持久化语义或 manifest 格式的变更；`0.x` 仍按此表达意图。
- 已发布版本永不覆盖、永不重新发布。同一版本的后续修复必须提升 SemVer。
- 每次发布记录 package version、构建所用 Git commit SHA 与 `release:inspect` 输出的 tarball
  SHA-256。三者共同构成审计关联；版本标识消费坐标，commit 标识源码，摘要标识实际字节。
- 回滚只能将消费者改回上一个已发布并验证的精确版本，重新执行 `npm install` 并提交新的
  lockfile；不得重写旧版本，也不得把本地 tarball 当成生产回滚来源。
- 本地 tarball 仅用于发布前隔离验证，不得写入生产依赖或仓库 lockfile。

正式消费者必须使用精确版本，不使用 `^`、`~`、`latest`、Git、workspace、link、file 或本地
路径依赖，并必须提交包含 `resolved` 与 `integrity` 的 `package-lock.json`。CI 使用 `npm ci`。

## 发布授权与通道

真实 `npm publish` 只存在于 `.github/workflows/publish-github-packages.yml`。工作流只能通过
`workflow_dispatch` 手动启动，调用者必须具有仓库工作流权限、提供与 `package.json` 一致的
严格 SemVer，并输入确认词 `publish`。`github-packages` Environment 应在当前 GitHub 套餐支持时
配置 required reviewers 与 prevent self-review，由仓库指定发布责任人批准；若私有仓库套餐不
提供该保护规则，则必须限制 Actions 手动运行权限，并在运行前采用仓库外审批记录。

工作流只授予 `contents: read` 和 `packages: write`，使用短期 `GITHUB_TOKEN`，不使用长期 PAT，
不输出 secret，不回写版本，不创建或推送 tag/Release。`actions/checkout@v4` 与
`actions/setup-node@v4` 固定到受支持主版本，以兼顾安全更新和可维护性；如组织政策要求完全
不可变的第三方步骤，应再由依赖更新流程将它们固定到经审计的 commit SHA。

发布前必须通过源码检查、构建、现有 pack/consumer 验收、`release:prepare`、
`release:inspect`、`release:selftest`、依赖审计、版本复核与干净工作树检查。任一步失败都不会
执行发布。工作流不把输入拼接为 shell 参数，发布命令只指向生成的 `release-package/` 和
GitHub Packages Registry。
