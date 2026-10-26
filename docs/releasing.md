# 发布与打包手册

本项目使用 Node.js 发布脚本、just 和 GitHub CLI 串联版本准备、测试、PR、CI、五平台打包与 GitHub Release。每个命令只执行一个阶段；合并和提升正式版分别由显式命令控制。维护者可从 macOS 发起全部平台的云端构建。

## 最短发布路径

下面以**未来版本** `v0.1.11` 为例；执行前选择实际要发布的新版本。应用当前版本不会因更新本手册而改变。

先完成并提交功能改动，确保当前分支包含 `origin/master` 的历史、工作区干净。脚本会从当前提交创建发布分支，保留已有提交；不要用发布脚本代替功能改动的整理与提交。

```sh
git fetch origin master
just release-doctor
just release-prepare v0.1.11
# 编辑 docs/releases/v0.1.11.md，替换 TODO，写清本次功能、修复和兼容性变化。
just check
just release-pr v0.1.11
just release-merge v0.1.11
just release-publish v0.1.11
just release-verify v0.1.11
# 在目标设备完成人工安装验收后，显式提升正式版：
just release-promote v0.1.11
```

可随时运行 `just release-status v0.1.11` 查看 PR、标签、CI、五平台构建和 Release 链接。发布通常需要约 20 分钟，耗时取决于运行器队列与编译缓存，不提供固定完成时间保证。

## 命令约定与输出

| 命令                       | 前置条件                                           | 成功结果与重跑方式                                                                                              |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `just release-doctor`      | 已安装 Git、gh 和项目工具                          | 汇总工具版本、依赖锁、origin、工作区及 GitHub 权限。失败项给出修复指引；修复后重跑                              |
| `just release-prepare TAG` | 工作区干净、当前提交包含 `origin/master`、版本递增 | 创建 `codex/release-TAG`，同步四份版本并生成 `docs/releases/TAG.md`。同一已准备分支重跑不再递增 MSI             |
| `just check`               | 已安装锁定依赖，允许本机回环端口                   | 类型、格式、Clippy、前端/Rust/发布脚本测试及 Web 生产构建全部通过；任一失败立即停止                             |
| `just release-pr TAG`      | 已检出发布分支，填写发布说明，运行完本地检查       | 仅提交四份版本文件及本版本说明，推送并创建 PR，打印 URL。同提交 PR 直接复用；已有 PR 后出现新改动会停止         |
| `just release-merge TAG`   | 已创建 PR                                          | 等待绑定该 PR 完整 SHA 的 CI，核对其他检查，再按相同 SHA 合并；已合并时直接返回                                 |
| `just release-publish TAG` | 发布 PR 已合并、工作区干净                         | 验证合并提交版本及 master CI，创建 annotated tag，推送并等待 Release 成功。相同标签复用现有运行，不重复创建构建 |
| `just release-status TAG`  | GitHub 已登录                                      | 只读输出 PR、标签、CI、Release 和各任务状态；允许查看尚未完成或失败的版本                                       |
| `just release-verify TAG`  | 已有匹配标签和完整提交的成功 Release 流水线        | 校验 15 个资产的名称/大小/服务端摘要、13 项安装包校验值及六种更新架构；下载两份清单并验证其实际字节             |
| `just release-promote TAG` | 稳定版本已发布且可验证，已完成人工验收             | 重新核验资产后设为正式版 Latest，并回读确认；拒绝 RC 和低于当前 Latest 的版本                                   |

`TAG` 必须包含 `v` 前缀，例如 `v0.1.11` 或 `v0.1.12-rc.1`。失败以非零退出码结束；查看提示中的链接和恢复命令，不应忽略失败继续下一阶段。

准备、提交 PR、合并、发布和提升均提供脚本级 `--dry-run`。just 自己也有同名参数，使用 `--` 分隔，确保传给发布脚本：

```sh
just -- release-prepare v0.1.11 --dry-run
just -- release-pr v0.1.11 --dry-run
just -- release-merge v0.1.11 --dry-run
just -- release-publish v0.1.11 --dry-run
just -- release-promote v0.1.11 --dry-run
```

dry-run 读取前置状态并打印拟执行操作，不创建分支、文件、提交、标签、PR 或 Release。对于必须等待将来 CI 的步骤，会注明待验证条件；不将预演输出视为实际检查通过。

默认每个等待阶段上限 120 分钟，工作流创建等待上限 2 分钟。可配置 1–240 分钟：

```sh
just -- release-merge v0.1.11 --timeout-minutes=30
just -- release-publish v0.1.11 --timeout-minutes=180
# 也可直接使用 Node；支持组合参数。
node scripts/release-manager.mjs publish v0.1.11 --dry-run --timeout-minutes 30
```

核验文件与 JSON 报告保存在 `artifacts/releases/TAG/verify-*/`；报告路径由命令输出。每次核验使用新目录，避免将旧下载当成新产物。默认模式比较 GitHub 服务端安装包摘要与已下载的 `SHA256SUMS`，并对两份清单进行本地哈希；若需要下载全部安装包逐一计算本地 SHA-256：

```sh
just -- release-verify v0.1.11 --download
```

报告明确记录验证模式、标签提交、工作流链接、文件摘要和人工验收未执行状态。更新清单验证检查版本、日期、六种架构、精确下载 URL 及非空的签名字段；实际更新包的签名由客户端使用内置公钥验证。

## 首次环境配置

本地与 CI 使用 Node.js 22、pnpm 10.18.3；CI 的 Rust 工具链固定为 1.92.0，包含 rustfmt 和 clippy。本机还需要 Git、GitHub CLI、just 和当前平台的 Tauri 原生依赖。

```sh
pnpm install --frozen-lockfile
gh auth login --hostname github.com --git-protocol ssh --web
gh auth status
just release-doctor
```

`origin` 必须指向 `winwin-inc/power-switch` 的 GitHub SSH 或 HTTPS 地址。推送走本地 Git 身份认证，API 操作走 `gh` 登录身份；两者都须有对应权限。doctor 检查 API 身份的仓库 push 权限，实际 SSH/HTTPS 推送权限在推送时验证。GitHub Actions 必须已启用。

doctor 不会自动安装工具、更新锁文件或修改凭据。若本机 pnpm 是版本管理包装器，启动时可能访问 registry；网络不通时应修复 registry 或安装指定版本，避免自动回退到其他 pnpm 版本。安装后的 pnpm 锁与仓库锁不一致时重新执行冻结依赖安装。

Rust HTTP 模拟测试需要临时绑定本机回环端口。如果沙箱报 `Failed to bind an OS port` / `PermissionDenied`，应在允许本机端口的环境重跑完整测试，不要跳过测试。前端和 Rust 测试使用临时目录，不修改真实 WorkBuddy、Claude Code、Codex 配置。

### 更新签名密钥

Actions 的发布任务使用最小 `contents: write` 权限和自动提供的 `GITHUB_TOKEN`。更新签名私钥放在仓库 Actions Secret 中，离线备份，不写入代码、发布报告或公开日志：

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo winwin-inc/power-switch < /path/to/power-switch.key
# 私钥设有密码时另行配置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
```

客户端内置公钥用于验证更新。此签名不等于 Apple 开发者签名、公证或 Windows 发布者证书；当前安装包仍可能出现系统未知发布者提示。密钥丢失后，已安装客户端无法验证后续使用其他密钥签发的更新。

## 版本、提交与 CI 规则

- 四份应用版本为 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中的本项目版本；版本准备只修改这些版本，不升级依赖。
- Windows MSI 只按 `ProductVersion` 前三段比较升级次序。MSI 与应用版本独立，准备时将当前第三段加一，第四段保持零：应用 `v0.1.10` 的 MSI `0.1.11.0`，下一次准备为 `0.1.12.0`。RC 也递增 MSI；第四段不用于区分 RC。超过 `255.255.65535` 范围时停止，需维护者选择新的合法 MSI 版本序列。
- 发布分支为 `codex/release-TAG`，说明固定为 `docs/releases/TAG.md`。PR 阶段只自动暂存四份版本文件和此说明；其他修改应先独立提交。任何位置的 `.env`、`.venv`、`venv` 都不能自动暂存或提交。
- PR、master 和 Release 各自保留质量门禁。脚本按仓库、工作流路径、完整 SHA、分支及事件匹配运行，不复用其他提交的成功结果。
- 发布标签绑定对应发布 PR 的合并提交，验证其属于远程 master 历史。即使 master 后来前进，也不会把额外提交意外打入本版本。
- 正式与测试打包共享平台定义。前端生产产物先构建，再供三平台 Rust 检查使用；正式包在五个原生运行器上构建。
- 更新清单的时间来自标签提交时间，同一提交重跑保持固定；已公开预发布只接受同提交、同字节资产的幂等验证，已发布正式版不覆盖。

由标签推送触发、且仍保留成功 Release 运行记录的历史版本（例如 `v0.1.10`），也可直接运行 `release-status` 和 `release-verify`。首次引入本流程的代码应先经过正常 PR 合并，之后再用新命令准备下一个版本。

## 本地与云端测试安装包

测试包用于安装验收，关闭更新器产物签名，不创建 GitHub Release。对应原生系统才能执行该平台本地打包；macOS 本地总是生成 Intel/Apple Silicon 通用 DMG。

```sh
just package-local
just package macos-universal
# Windows/Linux 在对应原生系统执行：
# just package windows-x64
# just package windows-arm64
# just package linux-x64
# just package linux-arm64
```

macOS 通用构建需要同时安装 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` Rust 目标。缺失时，使用 rustup 管理的工具链安装：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

本地产物位于 `artifacts/packages/v<版本>-<提交前12位>[-dirty]/<平台>/`，包含安装包与 `SHA256SUMS`。版本、提交及 dirty 标记用于辨认源码，不能将测试包上传冒充正式更新资产。

从 Mac 发起全部五个平台的云端测试打包：

```sh
just package-all
gh run list --repo winwin-inc/power-switch --workflow package.yml
just package-download RUN_ID
```

前置条件是当前分支干净且已推送，远程 SHA 与本地一致。Package 工作流先运行 CI，再构建五平台安装包，工件保留 14 天；下载到 `artifacts/packages/cloud/RUN_ID/` 并验证各平台校验值。Package 不上传 GitHub Release。

## GitHub Release 与 RC

| 系统                        | 原生运行器       | 发布文件                         |
| --------------------------- | ---------------- | -------------------------------- |
| macOS Intel + Apple Silicon | macos-15-intel   | `.dmg`、`.zip`、更新器 `.tar.gz` |
| Windows x64                 | windows-2022     | `.msi`、`.zip`                   |
| Windows ARM64               | windows-11-arm   | `.msi`、`.zip`                   |
| Linux x64                   | ubuntu-22.04     | `.AppImage`、`.deb`、`.rpm`      |
| Linux ARM64                 | ubuntu-22.04-arm | `.AppImage`、`.deb`、`.rpm`      |

macOS 检查及打包固定使用标准 Intel 执行器，避免 `macos-15` 默认标签的架构迁移影响构建环境；通用包仍包含 Intel 和 Apple Silicon 两种架构。

命名为 `power-switch-TAG-<平台>.<扩展名>`。完整 Release 包含 12 个常规安装包、macOS 更新归档、`SHA256SUMS` 和 `latest.json`，合计 15 个资产。五个平台全部构建成功后，才通过草稿上传、核对服务端 SHA-256 并公开为预发布。版本说明优先读取标签内的 `docs/releases/TAG.md`；旧版本回退到历史发布模板。

新版本默认进入预发布状态；稳定版在人工验收后通过 `release-promote` 进入 Latest。RC 使用同样的准备、PR、合并、发布和核验步骤，例如 `v0.1.12-rc.1`；禁止对 RC 执行 promote。RC 验证完成后，另准备没有后缀的正式版本，不能移动 RC 标签。

默认客户端读取 Latest 正式版。用户在“关于 → 软件更新”开启自动更新及测试计划后可接收 RC；下载安装仍需应用内确认。更新清单与安装包优先走现有 `ghfast.top` 加速源，失败后回退原始 GitHub URL，客户端始终使用内置公钥验签。

## 失败恢复与续跑

| 场景                                    | 处理方式                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| prepare 完成后再次运行                  | 检出相同发布分支再运行；保留已填写说明，不再次增加 MSI                                                                                     |
| prepare 中途被操作系统中断，版本不一致  | 查看 Git diff，修复四份项目版本后执行 `just release-check TAG`；不要在不明状态继续                                                         |
| PR 已有但本地又有新改动                 | 脚本停止；人工审阅并按正常 Git/PR 流程提交、推送，重新跑 CI 后再执行 merge                                                                 |
| 网络中断，无法确认推送/创建 PR 是否成功 | 先运行 status 或查看远端分支，再重跑同一阶段；脚本复用同提交 PR                                                                            |
| CI 或某个平台失败、取消                 | 查看输出日志。仅网络问题时执行 `gh run rerun RUN_ID --failed --repo winwin-inc/power-switch`，然后重跑原阶段命令；代码问题需修复并重新检查 |
| 工作流未在两分钟内出现或等待超时        | 查看 status、Actions 是否启用及标签触发是否正确；运行已开始时重跑 publish 会复用匹配运行                                                   |
| 标签已推送，但尚无运行且确认触发遗漏    | 用同标签启动：`gh workflow run release.yml --repo winwin-inc/power-switch --ref TAG -f tag=TAG`，随后重跑 publish；将 TAG 替换为实际值     |
| GitHub 上传中断，仍为草稿               | 保留构建工件，重跑失败的发布任务；工件保留 14 天。校验成功前不会公开不完整草稿                                                             |
| verify 下载中断或发现摘要不符           | 保存失败日志，重新运行核验；每次使用新目录。重复摘要失败需调查，不能继续 promote                                                           |
| 已发布正式版发现问题                    | 发布新的补丁版本；不覆盖安装包、不移动或删除旧标签                                                                                         |
| 已有标签指向其他提交                    | 脚本停止；人工检查来源，为新代码选择新版本号                                                                                               |

`publish` 不自动重新触发失败运行，不自动提升 Latest。对同标签重新编译可能产生不同二进制；已公开预发布的资产如不一致，不会覆盖，改发新版本。对已发布正式版重复执行发布工作流会被拒绝。

特殊的“已有正式版但从未上传任何资产”修复仍保留原有 `repair_existing_release` 工作流参数，仅供维护者人工处理。已有部分文件时不满足补建条件，不能用此参数覆盖或补造正式版。此兼容入口不属于常规发布路径。

## 人工安装验收

自动化通过说明源码检查、构建和发布文件校验通过，不代表已在所有系统安装运行。每次发布在适用目标设备记录以下检查结果与版本、设备、系统信息：

- 安装、首次启动、图标和 `power-switch://` 导入协议。
- 模型添加、测试、应用到 Agent、配置差异预览、备份与恢复；使用隔离配置路径。
- MCP 配置应用及本地数据目录读写。
- 从上一正式版升级并保留本地数据；Windows 特别检查 MSI 升级顺序。
- “关于”显示版本和更新日志正确；正式版与 RC 通道、确认安装和重启行为正常。

macOS DMG/ZIP 应同时包含 Intel 和 Apple Silicon 架构，打包脚本通过 `lipo -archs` 检查；没有完成对应硬件验收时明确记为待验收。Windows ZIP 需预装 WebView2，不保证注册导入协议；MSI 可引导安装依赖。Linux AppImage 需要执行权限，部分系统还需 FUSE；DEB/RPM 声明系统依赖。

验收结果可另行记录到 `docs/acceptance.md`。验证脚本报告中的 `manualInstallationAcceptance` 始终为 `not-performed`，不会根据自动化结果伪造人工验收结论。

## Microsoft Store MSIX（Windows）

Store 版与 GitHub MSI/ZIP 版是两个分发渠道。Store 版使用 MSIX，由 Microsoft 在审核通过后签名并通过商店更新；GitHub 版继续使用现有 MSI/ZIP 和 Tauri 更新签名。没有受信任的 Windows 代码签名证书时，不要向 Store 提交当前 MSI/EXE，也不要把未签名的 MSIX 作为可双击安装包提供给用户。

先在 [Partner Center 应用和游戏](https://aka.ms/submitwindowsapp)选择 **新建产品 → MSIX 或 PWA 应用**，输入名称、检查可用性，再点 **预留产品名称**（[微软操作说明](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)）。若首页只有“见解”和“我的访问权限”，先检查是否已通过 [Store 开发者入口](https://storedeveloper.microsoft.com/)完成 Microsoft Store 开发者注册；企业 Entra 账号还须由账号所有者或管理员分配 Developer、Manager 或 Owner 角色。刚完成注册可等待约五分钟并刷新或打开上述直达链接，详见[微软账号说明](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)。预留后打开产品管理中的“查看应用标识详细信息”，把以下四项原样写入仓库 **Settings → Secrets and variables → Actions → Variables**：

| 仓库变量                       | Partner Center 值                        |
| ------------------------------ | ---------------------------------------- |
| `STORE_PACKAGE_NAME`           | Package/Identity Name                    |
| `STORE_PUBLISHER`              | 完整的 Publisher 标识，通常以 `CN=` 开头 |
| `STORE_PUBLISHER_DISPLAY_NAME` | Publisher display name                   |
| `STORE_DISPLAY_NAME`           | 已预留的应用显示名称                     |

这些是公开包标识，不是签名私钥。Store 工作流在缺少任何值或使用 RC 标签时提前失败。仅在正式版标签已进入 `master` 历史后，手动运行 Actions 中的 **Microsoft Store MSIX**，输入例如 `v0.1.6`。工作流执行现有质量检查，分别产出 x64、ARM64 的 `store-windows-*` 工件。`MakeAppx` 生成的包未签名，只供 Partner Center 提交。应用版本 `0.1.6` 映射为 Store 包版本 `1.1.6.0`；映射固定为 `(major + 1).minor.patch.0`，确保 Store 要求的首段非零、末段为零，并保持跨版本递增。

上传前检查两个包的清单身份与架构，使用 Windows App Certification Kit 检验。在 Partner Center 审核和重新签名完成后，通过 **Microsoft Store 页面**安装到干净的 Windows 11 x64、ARM64 机器，测试启动、模型添加与应用、`power-switch://` 导入、本地数据和商店升级。商店版不会检查或安装 GitHub MSI；设置中会显示商店更新说明。现有 GitHub 安装用户改装商店版时，应确认模型与密钥从 `%USERPROFILE%\.power-switch` 读取；旧 AppData 目录不会被读取或迁移。还应在 MSIX 包中实测新目录的写入与 ACL，因为 MSIX 可能虚拟化新建文件。确认产品页可用后再把 README 的 Windows 首选入口改为商店链接。
