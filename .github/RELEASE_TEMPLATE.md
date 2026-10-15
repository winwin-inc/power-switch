## power-switch

中文桌面模型与 MCP 连接器管理工具，支持 WorkBuddy、Claude Code 和 Codex。

### 本次更新

- 应用到 Claude Code 时可选择“是否 1M模型”，控制模型 ID 的 `[1m]` 后缀；不改变模型库的原始 ID，每次应用单独设置。
- 新增“关于”页面，集中显示应用版本、仓库与当前版本更新日志，并提供自动更新、测试计划和手动检查更新控制。
- 配置预览与备份详情支持逐行查看修改，便于确认即将写入或恢复的内容。
- 模型配置备份支持按 Agent 平台筛选；应用 MCP 配置后及时刷新备份列表。
- 完善内置 MCP 连接器说明，并增加相关前端与 Rust 回归测试。

### 下载选择

文件名中的版本与本次标签一致：

| 系统          | 文件后缀                                 | 说明                                             |
| ------------- | ---------------------------------------- | ------------------------------------------------ |
| macOS         | `macos-universal.dmg` / `.zip`           | 同时支持 Intel 和 Apple Silicon；ZIP 内为 `.app` |
| Windows x64   | `windows-x64.msi` / `.zip`               | MSI 安装版，或免安装可执行程序                   |
| Windows ARM64 | `windows-arm64.msi` / `.zip`             | ARM64 原生应用                                   |
| Linux x64     | `linux-x64.AppImage` / `.deb` / `.rpm`   | 按发行版选择                                     |
| Linux ARM64   | `linux-arm64.AppImage` / `.deb` / `.rpm` | ARM64 原生应用                                   |

`SHA256SUMS` 包含全部 12 个常规安装包及 macOS 更新归档的 SHA-256 校验值。

### 安装须知

- 当前安装包未使用开发者证书签名或 Apple 公证，系统可能提示未知发布者或阻止首次打开。请先确认下载来源并核对校验值。
- Windows 需要 WebView2 Runtime；MSI 可引导安装，ZIP 需要预先安装。ZIP 仍将数据保存在当前用户的 `.power-switch` 目录，不能视为数据随身携带的便携版，也不保证注册 `power-switch://` 协议。
- Linux AppImage 需赋予执行权限；部分发行版还需要 FUSE。DEB/RPM 会声明所需的系统依赖。
- 本版正式发布后进入 Latest 更新通道，已安装的正式版客户端可检查到更新。
- 检查更新只读取版本清单，下载安装需要在应用内再次确认。
- 云端构建与测试通过不代表所有平台均完成真实机器安装验收。

发布、校验、排障及提升正式版的流程见仓库 `docs/releasing.md`。
