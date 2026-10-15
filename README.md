# power-switch

power-switch 是一个本地桌面应用，用来统一管理 AI 模型，并把模型配置应用到 WorkBuddy、Claude Code 和 Codex。

## 下载与安装

请从 [GitHub Releases](https://github.com/winwin-inc/power-switch/releases) 下载对应系统的安装包：

- macOS：下载通用版 `.dmg`，支持 Intel 和 Apple Silicon。
- Windows：按设备选择 x64 或 ARM64 的 `.msi`。
- Linux：按发行版选择 x64 或 ARM64 的 `.AppImage`、`.deb` 或 `.rpm`。

首次打开时，macOS 或 Windows 可能显示未验证发布者提示，请确认下载地址后再允许打开。Windows 使用 MSI 安装时可能需要安装 WebView2；Linux 使用 AppImage 前请先赋予执行权限。

## 快速开始

### 1. 添加模型

打开“模型库”，点击“添加模型”，填写：

- 模型名称
- 接口协议
- API 地址
- API Key
- 模型 ID

根据服务商能力设置工具调用、图像输入、上下文窗口和推理档位。

### 2. 测试模型

点击“测试模型”。应用会发送一次简单的文本请求。测试成功后才能保存模型；修改模型信息后需要重新测试。从 New API 添加和分享链接导入也会在入库前测试，批量导入仅保存测试成功的条目。

测试只验证基本文本调用，不代表图像、工具调用或完整上下文能力一定可用。

### 3. 应用到 Agent

在模型卡片点击“应用到 Agent”：

1. 选择与模型协议兼容的 WorkBuddy、Claude Code 或 Codex。
2. 预览将要修改的文件和内容。
3. 确认后写入配置并自动备份。

WorkBuddy 写入成功后可以打开新建任务页，请在 WorkBuddy 中手动选择刚添加的模型。已有任务不会被切换。

应用到 Claude Code 时，可通过“是否 1M模型”控制写入的模型 ID 是否添加 `[1m]` 后缀，仅影响 Claude 配置。每次打开弹窗，`MiniMax-M2.7-highspeed`、`k3` 默认不勾选，其他及未来新增模型默认勾选；手动调整只对本次应用生效。此选项不会修改模型库中的原始 ID 或上下文窗口数值，也不验证服务端的 1M 能力。

## 从 New API 添加

在模型库点击“从 New API 添加”：

1. 输入 New API 实例地址。
2. 登录账号。
3. 选择客户端、平台名称和模型。
4. 点击“创建并添加”。

接口固定使用 `default` 分组。同一实例、同一账号重复添加模型时会复用专属密钥；创建或复用密钥后会测试模型，成功才保存到模型库。测试失败时，密钥可能已经创建，重试会复用已有密钥。

## MCP 连接器

打开侧栏“**MCP 连接器**”，列表默认内置“马上赢 X 平台”和“马上赢内部 LightDash”，也可以自定义添加远程 Streamable HTTP MCP。两条内置连接器固定使用 `x-api-key` 认证，令牌分别保存；点击“配置令牌”，通过各自申请链接取得令牌并填写即可。内置条目不能删除。以前保存的同服务 ID 记录会保留原有身份和令牌。自定义连接器默认无需认证，也可选 Bearer 或自定义请求头密钥。

清单每条显示一个连接器，操作按钮在宽窗口中横向排列，窄窗口中在条目内换行。测试连接时，仅发起测试的列表按钮或弹窗按钮显示加载动画，结果显示在对应位置。

| 内置连接器           | 服务 ID                  | 固定 MCP 地址                           | 令牌申请地址                                                                                        |
| -------------------- | ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 马上赢 X 平台        | `msy-x-lightdash`        | `https://mcp-x.brandct.com/mcp`         | [申请马上赢 X 令牌](https://x.brandct.com/generalSettings/personalAccessTokens)                     |
| 马上赢内部 LightDash | `msy-internal-lightdash` | `https://mcp-lightdash.banmahui.cn/mcp` | [申请马上赢内部 LightDash 令牌](https://lightdash.banmahui.cn/generalSettings/personalAccessTokens) |

申请链接在桌面端通过系统默认浏览器打开。

“测试连接”只初始化 MCP 并读取工具清单，不调用工具。失败仍可保存，应用前会提示测试状态。连接器的固定地址和令牌保存在 `~/.power-switch/mcp-connectors.json`；编辑后需要重新应用到 Agent。

点击“应用到 Agent”通过 WorkBuddy、Claude Code、Codex 平台导航选择配置范围，可跨平台勾选。WorkBuddy 仅支持用户全局，项目级选项显示“暂不支持”并置灰；Codex 和 Claude Code 支持用户全局及项目级。项目级配置使用同一个所选项目目录。应用先完整预览脱敏变更，再备份并合并到各平台的原生配置；预览内容统一滚动，确认按钮固定在底部。

| Agent       | 用户全局                | 项目级（所选项目目录内） |
| ----------- | ----------------------- | ------------------------ |
| WorkBuddy   | `~/.workbuddy/mcp.json` | 暂不支持（不可选）       |
| Codex       | `~/.codex/config.toml`  | `.codex/config.toml`     |
| Claude Code | `~/.claude.json`        | `.mcp.json`              |

路径依据 [WorkBuddy MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)、[Codex 配置文档](https://learn.chatgpt.com/docs/config-file/config-basic)、[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)。

有认证的项目级配置包含明文令牌。项目属于 Git 仓库时，本应用只允许写入已被 Git 忽略、且未被跟踪的目标文件；需要你先设置忽略规则。应用完成后，重启或新建目标 Agent 会话；WorkBuddy 还需在“自定义连接器”中信任该连接器，Codex 项目级配置需信任项目，Claude Code 项目级连接器首次使用时需批准。删除本应用中的连接器记录不会移除已应用的 Agent 配置。

## 配置备份与恢复

每次应用配置前，power-switch 都会先创建备份。打开“模型配置备份”可以：

- 查看某次修改前后的内容
- 恢复指定备份
- 删除不需要的备份

恢复前会再次备份当前配置，避免误操作后无法返回。

## 本地数据目录

macOS、Linux 使用 `$HOME/.power-switch`，Windows 使用 `%USERPROFILE%\.power-switch`。设置页会显示实际路径。目录中的 `models.json` 保存模型、API Key 和应用设置；`mcp-connectors.json` 保存 MCP 地址和令牌；`new-api.json` 保存密钥创建恢复记录；`new-api/sessions/` 保存 New API 登录会话；`backups/` 保存应用配置前的原始快照。`skill-staging/` 只用于技能安装期间的临时文件，`.lock` 用于防止多个进程同时写入。

以上凭据和快照均为**明文**，请按敏感数据保护整个目录。应用只读写这个新目录，不会读取、迁移或删除旧应用数据目录与旧系统凭据库条目；升级后需要重新添加旧模型并登录 New API。应用到 Agent 时，仍会写入各 Agent 自己的配置文件。

## 设置配置位置

在“设置”中可以修改 WorkBuddy、Claude Code 的配置文件位置和 Codex 的配置目录。默认位置如下：

| Agent       | 默认位置                              |
| ----------- | ------------------------------------- |
| WorkBuddy   | 用户目录下的 `.workbuddy/models.json` |
| Claude Code | 用户目录下的 `.claude/settings.json`  |
| Codex       | 用户目录下的 `.codex/config.toml`     |

Codex 使用 OpenAI Responses 协议。手动添加时，所选模型必须由服务商的 `/models` 接口返回，并需填写实际上下文窗口。应用配置时会生成独立的模型目录文件，保留现有配置中的其他供应商和设置。

配置智谱或 MiniMax 时，可分别参考其 [Codex 接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/codex)和 [Codex 手动配置说明](https://platform.minimax.cn/docs/token-plan/codex)。API 地址填写文档中的基础地址；power-switch 会向其 `/responses` 端点发送测试请求。

修改路径后点击“保存设置”。设置只会影响之后的读取和写入，不会立即修改 Agent 配置。

## 安全说明

- 模型、API Key、New API 登录会话和备份均以明文保存在本机用户目录。
- API Key 以本地配置形式保存，请不要分享模型文件、备份文件或带密钥的分享链接。
- 保存模型不会自动修改 Agent；必须经过“应用到 Agent”并确认后才会写入。
- 删除模型库记录不会撤销服务商上的密钥，需要时请到服务商控制台操作。

## 常见问题

### 测试模型失败怎么办？

检查 API 地址、API Key、模型 ID 和协议是否匹配。部分服务商要求地址包含 `/v1`，部分服务商不需要，请以服务商文档为准。

### 为什么 WorkBuddy 没有自动切换模型？

WorkBuddy 的新任务页面支持打开，但深链不能可靠地替你选择自定义模型。应用会打开新建任务页，请手动选择模型。

### 如何确认配置已经生效？

先在模型库测试模型，再应用到目标 Agent。应用成功回读配置后会显示写入结果；随后请在 Agent 中新建会话验证。

### 关于与软件更新

在侧边栏“关于”中可以查看当前应用版本、打开 GitHub 项目仓库及该版本的更新日志。更新日志链接随应用版本自动变化。

默认在启动后检查正式版更新；在「关于 → 软件更新」中可关闭自动检查，或启用「测试计划」接收 RC 版本。关闭自动检查后仍可手动检查，但「测试计划」不可选。发现更新后，需点击确认才会下载和安装；完成后按提示重启。macOS DMG、Windows MSI 和 Linux AppImage 支持应用内更新；其他安装包可前往 [Releases](https://github.com/winwin-inc/power-switch/releases) 手动下载。`SHA256SUMS` 可用于核对文件完整性。

### 为什么某个 Codex 模型不能添加？

确认服务商提供 `/models` 清单，且该模型 ID 位于清单中；随后检查 `/responses` 是否返回包含助手文本的已完成响应。两项检查缺一不可。
