# v0.4.0 Quick Fill Release Blocker

**最终状态（2026-09-22）：RESOLVED。** Quick Fill 修复已在 installed real-host 上人工验证 PASS，见 [Phase 4 Report](NovaWing-v0.4.0-Phase-4-Report.md) 第 4 节。本文件保留为历史过程记录，其 installer SHA 已 OBSOLETE。

后续更新：本报告安装包为 Quick Fill 修复时的历史版本，已由 [窗口白屏修复报告](NovaWing-v0.4.0-Window-White-Screen-Blocker.md) 的新版 0.4.0 替代。这里的自动门禁记录继续保留，但 installer SHA 不代表最新包。

日期：2026-09-21。分支 `feat/v0.4-desktop`，HEAD `1ce8111065051a7256d73a2d61d1551ea4fccf37`。本轮不 commit / push / merge / tag，不继续 HUMAN_REQUIRED / uninstall / reinstall 人工验收。

## 修复范围

- 沿用 deterministic Task Brief parser、现有结构化 fields 与 Composer 验证链路。
- Allowed Paths 支持只能修改、允许修改的文件、allowed files、编号/Markdown 列表、逗号/中文顿号/逗号、backtick、中文“和”。重复权限声明必须一致；含糊、冲突、越界或无法完整解析的范围进入 `unresolvedFields: ['allowedPaths']`。
- 补齐真实原文的多行 Workspace / Branch、“目标分支”、“任务描述”、邮件通知关闭。
- 明确的命令结果句分别生成 Acceptance Criteria 和 requiredEvidence；backtick 是输入格式，不进入最终 shell command。裸 `node --test` 可以结构化抽取，但仍保留现有 APPROVAL_REQUIRED，不扩大运行权限。
- 部分识别或无识别结果时保留既有字段值（包括项目、分支、Task ID、Task 描述及策略）。Allowed Paths 未识别或解析失败时，显示人工确认提示并阻断创建；必须编辑该字段或成功重新解析后才能提交。明确无效的 Task ID 也需人工编辑或重新解析；模型建议不清除此状态。
- Runtime / Golden Path / Evidence / Checkpoint 实现及命令执行 allowlist 未在本轮修改；既有 Phase 4 未提交改动保留。

## 回归证据

[完整 fixture](../../tests/fixtures/desktop-realhost-001.txt) 来自用户本轮随后提供的 DESKTOP-REALHOST-001 原文，替换早期按项目参数组装的临时样本。断言覆盖 Workspace、Branch、Task ID、Executor、Auto Commit/Push、Reasoning、邮件开关，以及真实表单写入：

```text
Allowed Paths:
src/sum.mjs
test/sum.test.mjs

Acceptance Criteria:
npm test passes.

Required Evidence bindings:
npm test passes. => npm test
```

现有 UI 通过 Required Evidence bindings 承载 Verification Command，未新增另一套命令模型。

另覆盖 A–H、混合语言、模糊命令不猜测、权限冲突/越界、已有值保留、表单提交阻断与人工编辑解除。权限段内未标注的自然语言尾段现在保守要求确认，既有相关断言已更新。

## 门禁与安装包

最终结果：**自动门禁 PASS，安装版人工 Quick Fill 待验证**。

| 门禁 | 最终结果 |
| --- | --- |
| Quick Fill / verifier / Launchpad targeted | 81/81 PASS |
| `npm run check` | exit 0；业务 1103/1103、Desktop 63/63；全部静态门禁 PASS |
| `npm run desktop:smoke` | PASS |
| `npm run desktop:package:dir` | PASS；重新 staging/build，内容审计 5309 files |
| `npm run desktop:package:smoke` | PASS；本轮新 package 的证据 |
| `npm run pack:check` | PASS |
| `npm run consumer:selftest` | PASS |
| `npm run desktop:build:win` | PASS；新 NSIS 0.4.0 |
| `git diff --check` | PASS |
| 包内真实 fixture 与编译文件一致性 | PASS；三个 Quick Fill 编译文件与已测试 dist 逐字节一致 |

新安装包：`artifacts/desktop/NovaWing Setup 0.4.0.exe`，218040476 bytes，版本仍为 0.4.0。

```text
installer SHA256:
2ec3f06a44cca3733ffd712ecf946f8b6e0c080def10e76ee1ba63be825e1e41

package content SHA256 (fresh package smoke):
91a76f8401c013790bf0805abe010c4b54623554db5b83099a357e433c943efa

full user fixture SHA256:
f7ce55ccfbb6d366cc44594994eb3608850fb1f695a97df55869d8cebd3201a8
```

旧 SHA256 `b8c777bde5c14592b9b76c2df6a88bc96cdb0c2ed4fed525ea1136b99bdcd1b2` 的 installer **OBSOLETE**，不得作为修复版本使用。旧 `installer.json` / package smoke 已归档到 ignored artifacts 中的 `*-obsolete-before-quick-fill.json`。新包重新 staging、package smoke，经 package 内容 SHA 绑定后生成 NSIS，没有复用旧 package evidence。

机器证据：`artifacts/desktop/quick-fill-final-gates.json`、`quick-fill-final-*.log`、`installer.json`、`package-smoke/result.json`、`quick-fill-package-regression.json`。后者包含实际 installer hash 复算、package smoke hash 对照、包内原文解析结果和三个编译文件 SHA。检查结束时 HEAD 仍为 `1ce8111065051a7256d73a2d61d1551ea4fccf37`，所有 Phase 4 与本轮改动保持未提交。

早期完整 check 的日志 `artifacts/desktop/quick-fill-check.log` 保留：1082 PASS / 3 FAIL；原因是代理在收到完整原文后重建共用 `dist-tests`，令并行进行中的旧测试加载三个模块时得到 Cannot find module。该次结果不作为最终门禁。后续最终门禁串行运行，期间不再重建共用输出目录。

## 人工等待点

Phase 4 **BLOCKED**。本轮修复和打包后停止，未安装新包、未创建真实任务、未执行后续人工验收。下一步只按 [人工清单](NovaWing-v0.4.0-Phase-4-Manual-Acceptance.md) 验证新安装版 Quick Fill；通过后才恢复其余 real-host 验收。旧包上的 `888a2e5` checkpoint 不充当新包证据。
