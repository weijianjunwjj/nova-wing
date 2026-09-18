# NovaWing v0.3.2 Cross-platform Audit Report

验收日期：2026-09-18。基线：`ce2fea6`。范围：整个 tracked repository，以及本轮新增文件。

## Audit Inventory

计数单位为“匹配的源代码行”，一行命中多个模式只计一次；不是漏洞数量。
最初 rg 扫描得到 1,608 行；补充正斜杠盘符、npm shim、大小写环境变量等模式后，
可重复的完整基线扫描为 **1,671 行**。全部分类，无 UNCLASSIFIED。

| 分类 | Before | After |
| --- | ---: | ---: |
| A — ACCIDENTAL_WINDOWS_ASSUMPTION | 68 | 0 |
| B — LEGITIMATE_WINDOWS_ADAPTER | 64 | 65 |
| C — CROSS_PLATFORM_ABSTRACTION | 443 | 514 |
| D — TEST_FIXTURE_ONLY | 961 | 984 |
| E — DOCUMENTATION_ONLY | 135 | 149 |
| Total platform-sensitive matches | 1671 | 1712 |

逐行 file / line / source / category / reason 清单：
[before](platform-before.json)、[after](platform-after.json)。C 包括统一平台契约、portable Node API、
SQL `exec`、排序、协议路径规范化及进程调用等合法命中，不代表尚未修复的平台假设。
两个生成的 inventory JSON 因含源代码摘录而不递归计数；其他 docs、README、CI、根启动器、
patch、lockfile、packages、scripts、tests 均扫描。扫描器：`scripts/audit-platform-assumptions.mjs`；
`--baseline` 读取 Git 中的 `ce2fea6`，默认扫描当前 tracked + 新增非忽略文件。

## Architecture

- Platform boundary：`packages/development-guardian/platform/`；既有导入文件保留兼容 re-export。
- Shell source of truth：`platform/shell.ts`。执行器与 dependency preflight 共用 executable resolver。
  Windows 仅原生 Git Bash，拒绝 System32/WindowsApps shim，验证 native fingerprint；
  支持显式覆盖和标准安装目录，不再尝试个人开发机的 D 盘安装。
  macOS/Linux 使用 Bash，忽略 Windows shell override，不检查 MINGW。
- Path source of truth：`platform/paths.ts`。Windows LOCALAPPDATA；macOS Application Support；
  Linux XDG config/data 与标准 fallback。config、SMTP、session SQLite、execution store、analytics、
  repair audit 和 ETA 均通过此处解析。文件 URL 使用 `pathToFileURL`，不再拼接 `file:///`。
- Executable source of truth：`platform/executables.ts` 与 `platform/codex-runtime.ts`。
  AskBridge 的 runtime/preflight/login/installer 共享名称与位置；Codex 只用 SDK 所属原生包。
- Secret permission strategy：Windows 使用 PowerShell/.NET 创建当前用户拥有的精确受保护 ACL，
  并回读验证；避免旧 `icacls /grant:r` 残留其他显式授权。POSIX 目录 0700、文件 0600，校验 owner、
  类型和 mode，拒绝目标/父目录 symlink。先保护空的独占临时文件，再写 secret、sync、同目录 rename。
  权限或替换失败保留旧文件；读取宽权限 POSIX secret fail closed；交互密码无回显。

## Fixed Assumption Families

| Family | 修复与保留边界 |
| --- | --- |
| Shell | 删除 dependency-health 的第二套 Windows-only policy，probe 失败/超时/异常阻断执行；Git 独立真实探测。 |
| Paths | 所有本机状态使用同一 OS resolver；POSIX 不读 LOCALAPPDATA；Linux 忽略相对 XDG 值。增加显式 NOVAWING_DATA_DIR 用于部署和测试隔离。 |
| AskBridge | 非 Windows 无 .exe；统一本地安装路径及覆盖；原 shell installer 转为兼容 wrapper，Node installer 构建固定版本及补丁；V2 无 Bridge 仍可运行。 |
| Codex | 保留六目标映射，移入 adapter；真实执行 bundled binary；修复没有选 Task 时被 cwd 检查误报 unavailable 的冷启动缺陷。任务级 SDK/workspace preflight 不变。 |
| Other executors | Claude/DeepSeek/10x 使用共同 shell；Python venv 命令、权限、Brain 建议和 verifier parsing 支持当前 host；历史 Windows 任务语法保留。Provider routing 未改变。 |
| SMTP secrets | 安全持久化支持三平台，不再因缺少 Windows ACL 工具禁用邮件；未实际发送邮件。 |
| Notifications | 三个 Windows toast adapter 明确命名；公共层使用 desktop capability factory；macOS/Linux SKIPPED，真实任务正常完成。 |
| Launchers | npm 标准入口无 VBS/PowerShell 隐含依赖；NovaWing.windows.vbs 是 Windows 实现，NovaWing.vbs 保留兼容转发；浏览器按 host 发现，缺失不阻断服务。 |
| Locale/process/filesystem | macOS 继承的无效 C.UTF-8 改用通用 C；子 verifier 清除 NODE_TEST_CONTEXT；统一路径大小写 key 与 CLI 路径适配；npm tooling 直接执行 npm JS CLI，避免 .cmd shell shim。 |

另检查了 tempdir、文件 rename、symlink、Git 行结束符、process signals、锁与 SQLite 生命周期。
临时目录使用 OS API；scope bridge 拒绝链接逃逸；协议/Git 路径的 slash normalization 是数据格式，
并非宿主路径拼接。Windows-only tree kill 已隔离；通用信号处理保持 Node 契约。
SQLite 保留 `ce2fea6` 的单一 libSQL driver 生命周期修复，未重写锁或放宽完成门。
未迁移或删除用户旧目录；旧配置的显式 session URL 保持有效，迁移说明见 README。

## Static Guard

`npm run check:platform` → `scripts/check-platform-boundaries.mjs`，已接入 `npm run check`。

检查 common TS/JS/MJS/CJS，包括未跟踪的新文件。解析字符串、template、OS 环境变量标识符与
平台分支，拒绝盘符路径、原生 executable、Windows 工具/指纹、OS 目录与固定 locale。
精确文件 allowlist 记录在脚本的 `platformAdapters`，新增 adapter 需要显式登记；tests/docs 不受
生产源代码规则误伤。回归在临时 common 源文件中逐项写入被禁模式，确认命令非零退出。

Known allowlist：下节列出的 platform 源文件、`scripts/platform/npm-command.mjs`、两个明确用途的
notification smoke 脚本，以及 guard 自己的规则定义；不是给整个 packages 或 scripts 放行。
Windows fixture 和文档的保留均在 inventory 分类。

## Platform Matrix

| Platform | Validation |
| --- | --- |
| Windows x64 | UNIT |
| Windows arm64 | UNIT |
| macOS x64 | UNIT |
| macOS arm64 | UNIT + REAL HOST |
| Linux x64 | UNIT |
| Linux arm64 | UNIT |

显式 platform 参数注入，未修改 `process.platform`。六组合覆盖 shell resolver/fingerprint、
Codex target、paths、AskBridge、secret strategy、dependency preflight 与 Git 失败边界。
真实宿主另验证 private secret write/replace/failure、optional notification、cold Launchpad preflight。

## Gates

| Gate | Result |
| --- | --- |
| Targeted | 平台矩阵、进程/权限、shell、Python、SMTP、Launchpad 回归通过；最终纳入全量门禁 |
| npm run check | **970/970 PASS；0 failed，0 cancelled，0 skipped**；typecheck/unused/migration/exports/boundaries/platform 全通过 |
| consumer:selftest | PASS；独立 tarball 消费闭环 |
| reliability:v030 | **10/10 COMPLETED，10/10 COMMITTED**；每次 EXECUTE/VERIFY 各 1 |
| SQLite restart | **5 轮** SCHEDULED → COMPLETED → reopen，每轮 TaskRunner only once |
| SQLite integrity | **25/25** 关闭后 `PRAGMA integrity_check = ok` |
| Post-smoke scan | A = 0；逐行分类完整；静态门禁通过 |
| Git whitespace | `git diff --check` PASS |

原始门禁日志保留在本机 `.tmp/cross-platform/`（Git 忽略）：`check.log`、`consumer-selftest.log`、
`reliability.log`、`restart-integrity.log`、`host-preflight.json`、`product-status.json`、`launchpad.log`。
这些是实际运行结果；可靠性/调度 TaskRunner 测试与下面的真实模型验收分开报告。

## macOS Real Product Smoke Test

| Item | Evidence |
| --- | --- |
| Launchpad | 实际 `npm run guardian:launchpad`，通过浏览器 UI 创建任务，未调用模拟创建 API |
| Shell | Bash 3.2.57(1)-release，真实 fingerprint READY |
| Git | Apple Git 2.39.3，真实 Git probe READY |
| Runtime | macOS arm64，Node v24.21.0 |
| Codex | SDK bundled darwin-arm64 `codex-cli 0.151.0`；真实模型 gpt-5.6-terra / high |
| Task creation | macOS Real Agent Smoke Test；ID `macos-real-agent-smoke` |
| Repository | `/private/tmp/novawing-macos-product.hiwoKV` |
| Branch | `codex/macos-real-agent-smoke` |
| Agent execution | 1 次真实 Codex，GOLDEN；总耗时 23.392 秒 |
| Verification | 独立 `git diff --check` 与 `npm test`，实际 exitCode 均 0；精确字节断言通过 |
| Evidence | UI Debug 可查看 verifier、TaskStateV2 events、execution ledger 与 checkpoint；摘要见 [macos-product-proof.json](macos-product-proof.json) |
| Checkpoint | `c6af763e3fbe1006e46f0a6e2b2ba715018226c8`，仅提交 `hello-novawing.txt` |
| Final state | **COMPLETED / ALL_TASKS_COMPLETED**，临时 repo working tree clean，无失败事件 |

真实文件为 24 bytes，精确内容 `NovaWing works on macOS.`，无尾部换行；SHA-256：
`07ea6c3676fc8e82d94fb523b8b4452e2b2aea2442cf349d0ab161fa995c7f56`。
`package.json` 和 `verify.test.mjs` 相对初始 commit 完全未改。
文件由 Codex 创建；验收代理只预置测试仓库和 verifier，没有代写目标文件。

验收中间失败完整披露：第一次 UI 创建后，门禁的 build 已替换 dist，旧 Launchpad 被既有 stale-runtime
保护正确阻止；重启后同一任务真实执行与验证通过，但临时仓库误用受保护 main 分支，checkpoint 被
正确拒绝，session 是 FAILED。这些尝试未计为 PASS、未改写其状态，也没有放宽保护。
随后在新的独立分支/仓库通过 UI 从头执行，得到上述完整成功。最终成功任务不存在隐藏失败。
先前失败任务仍保留可审计记录；任务完成统计不能替代 session 状态与 commit 实物核验。

## Remaining Platform-specific Code

以下路径相对于 `packages/development-guardian/`，其余注明仓库相对路径。

| File | Reason / why safe |
| --- | --- |
| platform/shell.ts | 唯一 native Bash adapter；Windows shim 拒绝与 fingerprint；非 Windows 不读取 Windows override。兼容 EXPECTED_GIT_BASH_EXECUTABLE 常量不参与 preflight policy。 |
| platform/paths.ts | 唯一 OS config/data root、CLI path 和 case policy；宿主外的测试通过显式平台选择对应 node:path 实现。 |
| platform/executables.ts | 原生名称、venv、AskBridge 与 Codex 环境白名单；不接触 provider credential 内容。 |
| platform/codex-runtime.ts | 固定 SDK 原生 target 表；不从系统 PATH 选择任意 Codex。 |
| platform/codex-development-runtime.ts | 显式历史 WSL probe；SDK executor 不依赖、不调用这个可选入口。非 Windows 路径实际验证 Bash/Git。 |
| platform/environment.ts | 仅调整不支持的宿主 locale 与测试进程上下文，不影响 routing 或授权。 |
| platform/secret-protection.ts | Windows 精确 ACL / POSIX mode 验证；失败闭锁。 |
| platform/process.ts | 仅 Windows 调用 taskkill，PID 来源为本次持有的 child；非 Windows 使用 Node child signal。 |
| platform/browser.ts | 平台浏览器及 opener；可选，不成为 Work Session 前置依赖。 |
| platform/windows-repair-notifier.ts | Windows-only repair toast；非 Windows 不启动 host。 |
| platform/windows-runtime-repair-notifier.ts | Windows-only runtime toast；非 Windows no-op。 |
| platform/windows-task-run-notifier.ts | Windows-only completion toast；非 Windows SKIPPED，邮件独立。 |
| scripts/platform/npm-command.mjs | Node/npm CLI 的可用安装布局解析；不通过 shell 执行 .cmd。 |
| scripts/guardian-repair-notification-smoke.mjs | Windows toast 专用验收入口，非公共启动依赖。 |
| scripts/novawing-notification-channel-smoke.mjs | 显式平台 notification fixtures 与可选真实 toast 检查。 |
| NovaWing.windows.vbs | Windows 专属隐藏启动器。 |
| NovaWing.vbs | 保留原入口，转发 Windows 专属实现；标准 npm 入口不引用它。 |
| verification-command-policy.ts / verification-evidence.ts / work-session/guardian-task-runner.ts / work-session/verification-planner.ts | 保留可识别 Windows 和 POSIX 工具输出/历史命令的 parser；不把这些文本当作宿主 executable discovery。 |
| common source 的 windowsHide、tmpdir、spawn、execFile、chmod/rename、Git slash paths | 合法跨平台 Node API 或明确协议数据；逐行理由与位置见 after inventory。 |
| tests / docs / lockfile / CI / patch | fixtures、历史说明、optional native package targets 或显式 runner，不强迫公共 runtime 使用某 OS。 |

## Remaining Risks

- Windows real-host：**NEEDS_WINDOWS_CONFIRMATION**。六目标单测不能代替 Windows 真机 Git Bash、
  ACL/PowerShell、Toast、native Codex、文件锁与 rename 验证。
- Linux real-host：未执行 Linux 真机验收；仅 UNIT。Linux native Codex、XDG、桌面 opener 与实际文件系统
  仍需相应宿主验证。
- 第三方 AskBridge 的 Cargo build / browser login 未在三宿主全部运行；本轮验证的是 NovaWing 的
  resolver、install/login/preflight 契约与 V2 不依赖 Bridge。没有重写第三方实现。
- POSIX secret 是权限保护，不是加密存储；Windows 当前用户 ACL 同样不宣称静态加密。
- 历史本机数据不自动迁移。项目没有 CLAUDE.md；规则指定的 Windows 永久记忆路径在本机不存在，
  没有把其他项目文档当作本项目事实，也未修改跨项目职责边界。

## Git

Branch：`fix/v0.3.2-cross-platform-hardening`。

Commit：本报告所在的新本地提交，subject 为
`fix: remove implicit Windows assumptions from common runtime`；精确 hash 见交付消息。
保留 `ce2fea6`，不 amend，不 push，不 tag，不 merge。

Working tree：提交完成后的交付检查要求 clean；实际结果见最终交付消息。

## Conclusion

**PASS**：A = 0，永久静态门禁已加入，全量工程门禁通过，macOS 真实 Launchpad 与真实 Codex task
完成，文件/证据/checkpoint 均核验。Git clean 在新本地 commit 后再次确认。
Windows/Linux 的 UNIT 结果不表述为真机通过。
