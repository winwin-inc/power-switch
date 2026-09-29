## power-switch

中文桌面模型管理工具，支持 WorkBuddy、Claude Code 和 Codex。

### 本次更新

- 应用本地数据统一保存到用户目录的 `.power-switch`，包括模型、API Key、New API 登录会话与备份；所有凭据按当前设计明文保存。旧数据目录和系统凭据库不会自动读取或迁移，升级后需要重新添加模型并登录 New API。
- 下载更新清单与安装包时优先使用 `ghfast.top`，加速源不可用时回退 GitHub 原地址；更新包继续验签。
- 优化添加模型弹窗的固定标题栏、设置界面与交互细节。
- 覆盖模型保存、New API 会话持久化和跨平台构建的自动化检查。
- Microsoft Store MSIX 打包流程已经准备好，但商店包须在产品名称预留、包标识配置及商店审核后另行提供；此处下载的是 GitHub 分发版。

### 下载选择

文件名中的版本与本次标签一致：

| 系统          | 文件后缀                                 | 说明                                             |
| ------------- | ---------------------------------------- | ------------------------------------------------ |
| macOS         | `macos-universal.dmg` / `.zip`           | 同时支持 Intel 和 Apple Silicon；ZIP 内为 `.app` |
| Windows x64   | `windows-x64.msi` / `.zip`               | MSI 安装版，或免安装可执行程序                   |
| Windows ARM64 | `windows-arm64.msi` / `.zip`             | ARM64 原生应用                                   |
| Linux x64     | `linux-x64.AppImage` / `.deb` / `.rpm`   | 按发行版选择                                     |
| Linux ARM64   | `linux-arm64.AppImage` / `.deb` / `.rpm` | ARM64 原生应用                                   |

`SHA256SUMS` 包含全部 12 个安装产物的 SHA-256 校验值。

### 安装须知

- 当前安装包未使用开发者证书签名或 Apple 公证，系统可能提示未知发布者或阻止首次打开。请先确认下载来源并核对校验值。
- Windows 需要 WebView2 Runtime；MSI 可引导安装，ZIP 需要预先安装。ZIP 仍将数据保存在当前用户的 `.power-switch` 目录，不能视为数据随身携带的便携版，也不保证注册 `power-switch://` 协议。
- Linux AppImage 需赋予执行权限；部分发行版还需要 FUSE。DEB/RPM 会声明所需的系统依赖。
- 流水线先将本版发布为预发布；完成验证并提升为正式版后，才会进入 Latest 更新通道。已安装的正式版客户端届时可检查到本版。
- 检查更新只读取版本清单，下载安装需要在应用内再次确认。
- 云端构建与测试通过不代表所有平台均完成真实机器安装验收。

发布、校验、排障及提升正式版的流程见仓库 `docs/releasing.md`。
