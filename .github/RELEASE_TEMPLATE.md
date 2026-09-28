## power-switch

中文桌面模型管理工具，支持 WorkBuddy、Claude Code 和 Codex。

### 本次更新

- 开放 Codex 配置：支持 OpenAI Responses 模型，写入用户级自定义供应商及模型目录，沿用预览、备份和恢复流程。
- 手动添加、New API 添加和分享链接导入均须通过一次真实文本调用才能入库；Responses 需要已完成的非空助手回复。
- New API 兼容 Cookie 与 Bearer／刷新会话；将默认分组标记为 `openai` 的模型列为 Codex 候选，保存前再用 Responses 调用确认。
- 应用到 Agent 时只预览并写入配置，不重复发送模型请求。既有模型不会自动重测，编辑后保存需要重新验证。

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
- 此 RC 预发布不会进入正式版 Latest 更新通道，请从 Releases 手动下载；正式版可通过应用内更新检查安装。
- 云端构建与测试通过不代表所有平台均完成真实机器安装验收。

发布、校验、排障及提升正式版的流程见仓库 `docs/releasing.md`。
