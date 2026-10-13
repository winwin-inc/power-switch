## power-switch

中文桌面模型与 MCP 连接器管理工具，支持 WorkBuddy、Claude Code 和 Codex。

### 本次更新

- 启用 MCP 连接器管理，内置“马上赢 X 平台”和“马上赢内部 LightDash”，提供令牌申请入口；链接通过系统默认浏览器打开。
- 支持自定义远程 Streamable HTTP MCP，默认无需认证，也可使用 Bearer 或自定义请求头密钥。
- 测试连接只执行初始化并读取工具清单，显示工具数量或失败原因；编辑后重新应用才会更新 Agent 配置。
- 按 WorkBuddy、Claude Code、Codex 导航选择应用范围；WorkBuddy 仅支持用户全局，Codex 和 Claude Code 支持用户全局及项目级。
- 应用前完整预览脱敏变更，同名条目替换会明确提示；确认后备份、合并、回读校验，并拦截外部修改及保护项目级令牌。
- 连接器及令牌保存于用户目录 `.power-switch/mcp-connectors.json`。令牌会明文写入连接器库、选定 Agent 配置及本地备份；删除库记录不会删除已应用配置。
- 验证 MCP 认证、超时、异常响应，以及平台合并、脱敏、外部修改拦截与回滚；通过原生跨平台构建发布。

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
