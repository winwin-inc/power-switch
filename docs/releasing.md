# 发布说明

## 测试安装包（不发布版本）

`just package-local` 在当前系统打包并收集测试安装包；macOS 始终生成 Intel 与 Apple Silicon 通用 DMG。也可用 `just package macos-universal`、`just package windows-x64`、`just package windows-arm64`、`just package linux-x64` 或 `just package linux-arm64` 明确指定平台。Windows 与 Linux 命令须在对应架构的原生系统执行。命令会检查 Rust 目标库、使用锁定依赖，并把安装包和 `SHA256SUMS` 放在 `artifacts/packages/v<版本>-<提交前 12 位>[-dirty]/<平台>/`。

本地需要 Node.js、pnpm、just 和对应系统的 Tauri 原生依赖。macOS 通用包还需要同时安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` Rust 目标；缺少时可使用 rustup 管理工具链并执行 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`。

从 Mac 触发全部五个平台的原生构建：

```sh
just package-all
# 或在已检出该分支时显式指定：just package-all my-branch
gh run list --repo winwin-inc/power-switch --workflow package.yml
just package-download <成功运行的 ID>
```

云端命令要求当前分支工作区干净，且 GitHub 上该分支的提交与本地 `HEAD` 相同。`Package` 工作流只上传保留 14 天的 Actions 工件；下载命令把它们放在 `artifacts/packages/cloud/<运行 ID>/` 并逐平台验证 SHA-256。测试包关闭更新器产物与签名，不创建 GitHub Release，也不能充当正式更新资产。正式版本仍使用下文的标签发布流程；Microsoft Store MSIX 使用独立工作流。

## 分支与版本策略

本项目使用 GitHub Actions 执行持续集成与桌面应用发布，采用以下策略：

- `master` 是默认开发和发布基线；功能在短期分支开发，经 PR 检查后合并，不维护长期 `release` 分支。
- 推送 `master`、面向 `master` 的 PR、手动运行 CI 均执行质量检查，不创建 Release。
- 推送 `v<SemVer>` 标签触发 Release，例如 `v0.1.0`、`v0.2.0-rc.1`。标签提交必须属于远程 `master` 历史。
- 每个新版本都先创建 **Pre-release**，包括没有 `rc` 后缀的标签。验证完成后，由维护者手动提升正式版。
- 已发布正式版不可由流水线覆盖。不移动已发布标签，修复应发布新的补丁版本。
- 默认更新通道只读取 GitHub Latest 正式版；用户在设置中启用「自动更新」和「测试计划」后，原生更新器从已发布 Release 中选择最高版本的正式版或 RC。任何通道的安装都必须经过用户确认。

## 首次配置

仓库需要允许 GitHub Actions 运行。普通检查仅有 `contents: read`，发布任务单独使用 `contents: write` 和自动提供的 `GITHUB_TOKEN`。生成应用内更新包还需要配置 Tauri 更新签名私钥。

## 更新签名密钥

更新签名私钥由维护者生成并离线备份，不要提交到仓库或粘贴到公开日志。将私钥文件内容添加为仓库 Actions Secret：

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo winwin-inc/power-switch < /path/to/power-switch.key
```

Tauri 配置内的公钥用于验证更新包。设置仓库 Secret 后，Release 工作流才能构建带签名的更新资产。签名密钥丢失后，已安装版本无法验证后续更新。

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

维护者本机需要 Git SSH 推送权限。查看私有仓库 Actions、修改默认分支及管理 Release 时，还需 GitHub CLI 登录：

```sh
gh auth login --hostname github.com --git-protocol ssh --web
gh auth status
gh repo edit winwin-inc/power-switch --default-branch master
```

更改默认分支前需确保 `master` 已推送。保持仓库现有可见性；私有仓库的下载链接仅对有权限的用户开放。GitHub 托管 runner 的可用额度遵循仓库所属账号计划。

CI 使用 Node.js 22、pnpm 10.18.3、Rust 1.92.0。前端依赖采用 `--frozen-lockfile`，Rust 检查、测试和发布构建采用 `--locked`。

Windows Installer 只比较 MSI `ProductVersion` 的前三段，[第四段不参与升级比较](https://learn.microsoft.com/en-us/windows/win32/msi/productversion)。已发布的 `v0.1.6-rc.4` 安装包设置为 `0.1.6.4`，正式版 `v0.1.6` 使用 `0.1.7.0`；`v0.1.7` 的 WiX 版本使用 `0.1.8.0`，确保 MSI 升级序列实际递增，应用本身仍显示 `0.1.7`。后续 Windows 版本必须使前三段高于 `0.1.8`，不能只增加第四段。发布前应在 Windows 上验证从上一版 MSI 升级。

## 准备一个版本

在已同步的 `master` 上建立版本准备分支：

```sh
git switch master
git pull --ff-only origin master
git switch -c codex/release-v0.1.5
pnpm install --frozen-lockfile
```

以 `0.1.5` 为例，编辑 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 中的项目版本，三处必须完全一致；不要修改依赖版本来代替项目版本。更新 Cargo 锁文件中的本项目记录：

```sh
cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
pnpm release:check -- v0.1.5
just check
git diff --check
git diff -- src-tauri/Cargo.lock
```

审阅锁文件，只接受与本次改动相关的变化。`release:check` 会比较上述三处以及 `Cargo.lock` 的本项目版本，并拒绝不合法标签。缺少 just 时，执行 Justfile 中对应的 pnpm/Cargo 命令。

将版本修改及必要发布说明提交，推送分支并发起 PR：

```sh
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git diff --cached --check
git diff --cached
git commit -m "chore: prepare v0.1.5"
git push -u origin codex/release-v0.1.5
gh pr create --base master --title "Prepare v0.1.5" --body "Synchronize the application version for the next prerelease."
```

任何层级的 `.env`、`.venv`、`venv`、密钥和本地模型数据都不能暂存或提交。

## 打标签并自动发布

PR 合并且 `master` CI 成功后：

```sh
git switch master
git pull --ff-only origin master
pnpm release:check -- v0.1.5
git status --short
git tag -a v0.1.5 -m "power-switch v0.1.5"
git push origin v0.1.5
```

首次发布使用项目已有版本 `0.1.0`，将上面标签替换为 `v0.1.0`，无需先增加版本号。打标签前必须确认工作区没有未提交的发布改动。

查看运行状态：

```sh
gh run list --repo winwin-inc/power-switch --workflow release.yml
gh run watch RUN_ID --repo winwin-inc/power-switch --exit-status
gh release view v0.1.5 --repo winwin-inc/power-switch
```

Release 流程依次执行标签和版本检查、可复用 CI、五个平台构建、资产完整性检查、草稿上传与校验，最后才公开为预发布。CI 测试数据使用隔离目录，不运行会修改真实 WorkBuddy 等配置的手动验收工具。

### 补齐已经手动创建的 Release

如果先在 GitHub 页面发布 Release，页面只会自动附带源码 ZIP/TAR，不会编译桌面应用。对于已经存在、且没有人工上传资产的 `v0.1.0` 正式版，在 `master` 包含补建工作流后，进入 **Actions → Release → Run workflow**，选择 `master`，填写 `tag = v0.1.0`，勾选 `repair_existing_release`。也可在已登录 GitHub CLI 后运行：

```sh
gh workflow run release.yml --repo winwin-inc/power-switch --ref master -f tag=v0.1.0 -f repair_existing_release=true
gh run list --repo winwin-inc/power-switch --workflow release.yml --limit 5
```

手动运行会从指定标签检出应用源码并执行完整测试与五平台构建。只有全部产物齐全才开始上传。补建模式仅接受没有上传资产的现有正式版，源码 ZIP/TAR 不算上传资产；它不会移动标签或改变正式版状态。如果某个平台失败，请先修复构建问题，再重试；如已有部分资产上传，需人工核对后处理，不会自动覆盖正式版文件。后续版本应先推送标签，让工作流自动创建带安装包的预发布，不需在网页中提前创建 Release。

## 安装包与校验

| 系统                        | Runner           | Rust target               | 文件后缀                                       |
| --------------------------- | ---------------- | ------------------------- | ---------------------------------------------- |
| macOS Intel + Apple Silicon | macos-14         | universal-apple-darwin    | macos-universal.dmg / .zip / updater `.tar.gz` |
| Windows x64                 | windows-2022     | x86_64-pc-windows-msvc    | windows-x64.msi / .zip                         |
| Windows ARM64               | windows-11-arm   | aarch64-pc-windows-msvc   | windows-arm64.msi / .zip                       |
| Linux x64                   | ubuntu-22.04     | x86_64-unknown-linux-gnu  | linux-x64.AppImage / .deb / .rpm               |
| Linux ARM64                 | ubuntu-22.04-arm | aarch64-unknown-linux-gnu | linux-arm64.AppImage / .deb / .rpm             |

完整名称示例：`power-switch-v0.1.0-macos-universal.dmg`。每次发布必须包含 12 个常规安装包、macOS 更新归档、`SHA256SUMS` 和 `latest.json`。Windows MSI 与 Linux AppImage 复用常规安装包作为更新包；更新签名写入 `latest.json`。上传完成后，发布程序还会比较 GitHub 服务端返回的 SHA-256，校验失败不会公开草稿。

下载全部产物后，在 macOS/Linux 校验：

```sh
gh release download v0.1.0 --repo winwin-inc/power-switch --dir release-download
cd release-download
shasum -a 256 -c SHA256SUMS
```

Windows 可执行 `Get-FileHash .\power-switch-v0.1.0-windows-x64.msi -Algorithm SHA256`，将结果与 `SHA256SUMS` 同名记录比较。

- macOS DMG 和 ZIP 中的应用均为通用二进制，构建时通过 `lipo` 校验 Intel 与 ARM64 架构。首版没有 Apple 开发者签名和公证；可能只有构建工具所需的临时签名。确认来源与校验值后，可在系统“隐私与安全性”查看允许打开的选项，不要关闭系统的全局安全检查。
- Windows MSI 可引导安装 WebView2 并完成安装注册。ZIP 只包含应用可执行文件，需预装 WebView2；数据仍保存在 `%USERPROFILE%\.power-switch`，不保证注册 `power-switch://` 导入协议。系统可能显示未知发布者提示。
- Linux AppImage 使用前需 `chmod +x`，部分发行版需要 FUSE；DEB/RPM 由系统包管理器安装。New API 登录会话在三个桌面系统中均明文保存在用户目录的 `.power-switch/new-api/sessions/`。
- 默认在启动时检查 GitHub 最新正式版；「测试计划」开启后还会检查已发布的 RC。关闭「自动更新」则跳过启动检查，设置页的「检查更新」仍可使用正式版通道。检查只读取清单，用户确认后才下载。安装后 macOS/Linux 可点击重启；Windows 安装器会自动关闭应用，安装完成后重新打开应用。
- 更新清单与安装包优先通过 `https://ghfast.top/` 加速读取；加速源请求、解析或安装包验签失败时，客户端重试原始 GitHub Release 地址。发布清单仍记录原始 GitHub URL，更新包始终按内置公钥验签。
- 已安装的旧版客户端仍使用固定的 Latest 正式版地址，无法从远端获得新的通道设置；需要手动安装一次支持「测试计划」的版本，之后才可选择接收 RC。

## 重跑、正式发布与故障处理

- 单个平台构建失败：检查日志修复后再发布，发布任务依赖整个构建矩阵成功，不会公开缺包版本。
- 网络导致上传失败：保留草稿及构建 artifacts，从 Actions 重新运行失败的发布任务，继续上传并校验。构建 artifacts 保留 14 天。
- 同标签运行会串行处理，不取消正在上传的任务。已公开预发布仅允许同提交、同校验值的幂等验证；重新编译产生不同二进制时不会覆盖，需发布新版本。
- 首次发布完成后，在对应真实机器验证安装、启动、图标、导入协议和主要功能。CI 成功只证明自动化检查和构建成功，不能替代人工安装验收。
- 验证通过后，在 GitHub Release 编辑页取消“预发布”标记并设为 Latest；或执行以下命令：

```sh
gh release edit v0.1.0 --repo winwin-inc/power-switch --prerelease=false --latest
```

- 正式版的同标签重跑会被明确拒绝。发现问题应发布新的补丁版本，不删除或移动原版本标签。
- Actions 报 `Resource not accessible by integration` 时，检查组织策略是否允许工作流发布 Release，以及发布任务的 `contents: write` 是否保留。
- 本地 Rust 测试需要临时回环端口供模拟服务器使用；受限沙箱禁止监听时应在允许回环端口的环境运行测试，不应删除或跳过这些测试。
