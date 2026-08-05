# ADR 0002：可分发包来源与 Host Snapshot V3 合约

- 状态：Accepted for local packaging; remote publication pending authorization
- 日期：2026-08-05
- 范围：NovaWing 包分发与框架无关的宿主组合快照合约

## 背景

NovaWing 需要成为可复现安装的依赖，而不是依赖 monorepo 源码布局、本地路径或软链接。
它还需要在不绑定具体宿主的前提下，为宿主数据与 NovaWing 数据提供一个组合 Snapshot V3
manifest 和恢复验证协议。本 ADR 不授权真实发布，也不实现任何具体宿主接线、数据导出、
数据恢复或文件替换。

## 正式依赖来源比较

| 方案 | 版本不可变性 | 鉴权 | CI 可用性/安装速度 | 回滚 | 维护成本 | 决策 |
| --- | --- | --- | --- | --- | --- | --- |
| npm 公共 Registry | 已发布版本不可覆盖；可用 integrity 锁定 | 消费通常无需令牌，发布需要令牌/OIDC | npm 原生缓存，工具链覆盖最广 | lockfile 回退旧 SemVer；废弃坏版本 | 最低 | **唯一推荐正式来源** |
| GitHub Packages | 版本化包可锁定 | 私有消费通常需要 GitHub 令牌 | GitHub CI 友好，跨环境需配置 registry/令牌 | 回退旧版本 | 中 | 不作为正式来源 |
| Git 精确 commit SHA | commit 可精确定位，但产物构建环境不随 SHA 自动固定 | 取决于仓库可见性 | 安装慢，缓存与依赖审计较弱 | 回退 SHA | 高 | 不采用 |
| GitHub Release 不可变 tarball | 上传资产可校验 SHA-256，但 npm lock/integrity 工作流较弱 | 取决于 Release 可见性 | 需自建下载、校验和缓存流程 | 回退资产 URL/摘要 | 中高 | 不采用 |
| 本地 tarball | 文件摘要可校验，但没有远程可用性 | 无 | 仅适合隔离开发验收 | 手工切换文件 | 高且易漂移 | 只用于开发验收 |

决定将 **npm 公共 Registry** 作为未来唯一正式远程依赖来源。理由是不可覆盖的版本、标准
`package-lock.json` integrity、消费端免鉴权、CI 缓存与安装速度、回退旧版本的简单性以及
最低的长期维护成本。正式消费不得使用本地路径、软链接、workspace/link/file 依赖或本地
tarball；本地 tarball 仅验证即将发布的同一产物。

以下事实尚待用户确认，确认前必须保持 `private: true`，不得发布：

- 待确认：包名 `nova-wing` 在 npm 公共 Registry 的所有权/可用性；如不可用，需确定 scope。
- 待确认：源码与包内容是否获准公开，以及最终许可证；当前 metadata 为 `UNLICENSED`。
- 待确认：发布 CI 平台、受保护环境、npm provenance/OIDC 或最小权限 token 的配置。
- 待确认：发布责任人、审批门和废弃版本的操作责任。

## SemVer 与锁定策略

- patch：不改变公开类型/行为合约的缺陷修复、验证增强、性能或文档修订。
- minor：向后兼容的新公共 API、可选 manifest 字段或新组件能力。
- major：删除/重命名出口、收紧到会拒绝既有合法输入、改变状态机/持久化语义、修改
  manifest 格式或摘要算法。Snapshot 格式的破坏性变化还必须使用新格式名/版本。
- `0.x` 阶段仍按上述规则表达意图；正式宿主采用前应达到 `1.0.0` 并冻结公共合约。
- 正式消费者使用精确 SemVer 并提交 `package-lock.json`；CI 使用 `npm ci`，以 lockfile 中的
  resolved version 和 integrity 为准，不使用 branch、tag、范围或本地路径作为生产锁定。

## 发布前检查与回滚

候选版本只能从干净、已审阅的 commit 构建。发布门必须依次通过：

```text
npm ci
npm run build
npm run check
npm run pack:check
npm run consumer:selftest
npm audit
```

还必须核对版本/tag 一致、tarball 文件白名单、实际 tarball SHA-256、许可证与 README、无
install/prepare/postinstall 副作用、无网络型生命周期脚本，并由授权人显式批准发布。当前
仓库没有自动发布脚本；本 ADR 不创建远程包、Release 或 tag。

已发布版本不得覆盖或复用。发现问题时停止推广并 deprecate 坏版本，消费者将 lockfile
回退到最近已验证的精确版本并重新执行 `npm ci`/验收；修复以新 SemVer 发布。只有凭据泄露
等必须撤包的事件才考虑 unpublish，并遵循 Registry 政策，不能把撤包当作常规回滚。

## Host Snapshot V3 决策

组合格式固定为 `host.snapshot.v3`，与 NovaWing 子系统的 `novawing.snapshot.v3` 分离。
组合 manifest 包含创建时间、宿主名称/应用版本/schema 版本、排序后的完整组件 manifests、
组件集合 SHA-256 和覆盖全部字段的组合 SHA-256。组件 manifest 自带格式、版本、schema、
metadata、权威表行数/内容摘要和独立摘要；摘要通过规范化键顺序以及表/组件排序做到注册顺序
无关。

registry 不扫描数据库。每个组件必须显式登记身份、owner、格式/版本和权威表；重复组件、
重复表、宿主声明 `nw_*` 或 NovaWing 声明冻结三表之外的表均失败。组合校验拒绝未知/缺失
组件、未知格式/版本、表集变化和任意层摘要不一致。

恢复协议要求先停止新请求并排空操作，关闭所有写连接，使用专用连接把两套 schema bootstrap
到隔离临时数据库，再写入数据。只有组件校验、组合校验和全部组件恢复后校验都通过，才允许
原子替换正式文件或宣布成功；最后才重开运行时连接。禁止跨活动连接逐表读取，禁止在运行中
的生产文件上原地部分覆盖，任一组件失败即整体失败并保留原文件。

当前代码仅实现合约、registry、校验器、NovaWing 组件 adapter、生命周期接口和独立测试夹具；
具体宿主适配、请求排空、连接管理、导出/恢复、临时文件与原子 rename 均属于后续切片。
