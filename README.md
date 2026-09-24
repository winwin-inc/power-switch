# power-switch

power-switch 是一个本地桌面应用，用来统一管理 AI 模型，并把模型配置应用到 WorkBuddy 和 Claude Code。Codex 暂不支持。

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

点击“测试模型”。应用会发送一次简单的文本请求。测试成功后才能保存模型；修改模型信息后需要重新测试。

测试只验证基本文本调用，不代表图像、工具调用或完整上下文能力一定可用。

### 3. 应用到 Agent

在模型卡片点击“应用到 Agent”：

1. 选择 WorkBuddy 或 Claude Code。
2. 预览将要修改的文件和内容。
3. 确认后写入配置并自动备份。

WorkBuddy 写入成功后可以打开新建任务页，请在 WorkBuddy 中手动选择刚添加的模型。已有任务不会被切换。

## 从 New API 添加

在模型库点击“从 New API 添加”：

1. 输入 New API 实例地址。
2. 登录账号。
3. 选择客户端、平台名称和模型。
4. 点击“创建并添加”。

接口固定使用 `default` 分组。同一实例、同一账号重复添加模型时会复用专属密钥；模型仍需测试通过后才能保存。

## 配置备份与恢复

每次应用配置前，power-switch 都会先创建备份。打开“模型配置备份”可以：

- 查看某次修改前后的内容
- 恢复指定备份
- 删除不需要的备份

恢复前会再次备份当前配置，避免误操作后无法返回。

## 设置配置文件位置

在“设置”中可以修改各 Agent 的配置文件位置。默认位置如下：

| Agent       | 默认位置                              |
| ----------- | ------------------------------------- |
| WorkBuddy   | 用户目录下的 `.workbuddy/models.json` |
| Claude Code | 用户目录下的 `.claude/settings.json`  |

Codex 暂不支持，其配置入口已禁用。

修改路径后点击“保存设置”。设置只会影响之后的读取和写入，不会立即修改 Agent 配置。

## 安全说明

- 模型和 API Key 只保存在本机。
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

### 如何获取其他平台安装包？

应用启动后会检查新版本；发现更新时，点击左下角版本号下方的提示即可安装，完成后按提示重启。macOS DMG、Windows MSI 和 Linux AppImage 支持应用内更新；其他安装包可前往 [Releases](https://github.com/winwin-inc/power-switch/releases) 手动下载。`SHA256SUMS` 可用于核对文件完整性。

### Codex 或 OpenAI Responses 为什么不可选？

目前仅支持 WorkBuddy 和 Claude Code。之前保存的 OpenAI Responses 配置仍会显示，但不能重新选择或应用。
