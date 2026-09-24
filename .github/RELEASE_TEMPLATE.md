## power-switch v0.1.2

中文桌面模型管理工具，目前支持 WorkBuddy 和 Claude Code。

### 本次更新

- Claude Code 配置使用 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`。
- Codex 与 OpenAI Responses 暂不支持，相关入口会显示为不可用。
- 修改自动生成名称对应的模型 ID 时，名称会同步更新；手动命名的配置保持原名。

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
- Windows 需要 WebView2 Runtime；MSI 可引导安装，ZIP 需要预先安装。ZIP 仍将数据保存在当前用户应用目录，不能视为数据随身携带的便携版，也不保证注册 `power-switch://` 协议。
- Linux AppImage 需赋予执行权限；部分发行版还需要 FUSE。DEB/RPM 会声明所需的系统依赖。
- 应用不会自动更新。请从后续 Releases 手动下载新版本。
- 云端构建与测试通过不代表所有平台均完成真实机器安装验收。

发布、校验、排障及提升正式版的流程见仓库 `docs/releasing.md`。
