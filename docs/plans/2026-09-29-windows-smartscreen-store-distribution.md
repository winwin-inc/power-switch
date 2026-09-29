# Windows 11 SmartScreen 提示优化实施计划

**目标：** 让从 Microsoft Store 安装的 Windows 11 用户不再遇到「Windows 已保护你的电脑／发布者未知」SmartScreen 下载警告，并保留现有 GitHub MSI/ZIP 分发。

**已确认方案：** 用户已有 Partner Center 账号，但尚无代码签名凭证，因此采用由 Microsoft Store 签名的 **MSIX 商店版**。GitHub MSI/ZIP 保持原有发布与 Tauri 更新流程；商店版由 Microsoft Store 管理更新。未签名 MSIX 只作为 Partner Center 的提交文件，不能当作可直接双击安装的公开下载包。

**技术栈：** Tauri 2、Windows SDK MakeAppx、GitHub Actions、Microsoft Partner Center。

## 选择依据

| 路径           | SmartScreen 首次安装                           | 签名凭证                                   | 对现有项目的影响                 |
| -------------- | ---------------------------------------------- | ------------------------------------------ | -------------------------------- |
| GitHub MSI/ZIP | 新文件可能提示，截图中的 EXE 仍显示发布者未知  | 若要显示可信发布者，需另购证书             | 保留当前流程                     |
| Store MSI/EXE  | 从商店安装时不出现该下载警告                   | **发布者必须自行签名**安装包和全部 PE 文件 | 当前无法提交                     |
| Store MSIX     | Store 审核后重新签名，商店安装不出现该下载警告 | **提交时无需自购 CA 证书**                 | 新增打包流程，商店版改用商店更新 |

Tauri 目前不直接生成 MSIX。本项目用 Windows SDK `MakeAppx.exe` 将 Tauri 编译的 `power-switch.exe`、现有 Store 图标和手写的包清单打成 x64、ARM64 两个 MSIX。包清单的 `Identity Name`、`Publisher`、展示名称必须与 Partner Center 预留产品的“查看应用标识详细信息”精确一致。

## 已实现的仓库工作

### 1. 包清单和构建脚本

- 新增 `scripts/store-msix.mjs`：只接受稳定版标签，验证四项 Partner Center 身份字段，映射 Store 四段版本号，生成全信任桌面应用清单，声明 `power-switch://` 协议，并通过 `MakeAppx.exe` 打包。
- 新增 `scripts/store-msix.test.mjs`：测试版本映射、身份字段拒绝、XML 转义、x64/ARM64、全信任和协议声明。
- 新增 `.github/workflows/store-msix.yml`：人工指定已有稳定版标签；先运行质量门禁，再分别在 Windows x64、ARM64 runner 上编译商店版并上传未签名 MSIX 供 Partner Center 提交。

### 2. 更新渠道隔离

- Cargo `store-msix` feature 让商店版的更新命令不访问 GitHub，也不安装 GitHub MSI。
- 前端 `VITE_STORE_MSIX=1` 隐藏 GitHub 更新开关并显示 Microsoft Store 更新说明。
- 商店版通过 MSIX 清单注册 `power-switch://`，不在启动时用 Tauri 插件重复写入 Windows 注册表。
- 原 GitHub MSI/ZIP 的构建和应用内更新保持原路径。

## 发布前还要完成的工作

1. **预留产品。** 在 [Apps & Games 工作区](https://aka.ms/submitwindowsapp)创建 MSIX 应用，取得 `Package/Identity Name`、完整 `Publisher`（`CN=…`）、发布者显示名称、应用显示名称。若没有工作区，先通过 [Store 开发者入口](https://storedeveloper.microsoft.com/)完成注册和身份验证。
2. **设置仓库变量。** 在 GitHub 仓库 Actions Variables 填写 `STORE_PACKAGE_NAME`、`STORE_PUBLISHER`、`STORE_PUBLISHER_DISPLAY_NAME`、`STORE_DISPLAY_NAME`，逐字复制 Partner Center 值。它们是公开包标识，不是私钥。缺任何一项时工作流必须提前失败。
3. **准备稳定版标签。** Store 工作流只接受 `v<major>.<minor>.<patch>`，拒绝 RC 和构建元数据。Store 版本映射为 `(major + 1).minor.patch.0`，例如应用 `v0.1.6` 对应 MSIX `1.1.6.0`，满足 Store 首段非零、末段保留零的要求。
4. **构建并检验。** 从仓库 Actions 手动运行 `Microsoft Store MSIX`，输入稳定版标签，下载两个 `store-windows-*` 工件。确认 `MakeAppx` 成功、清单身份匹配、x64/ARM64 正确，运行 Windows App Certification Kit。
5. **提交与实测。** 把 MSIX 上传 Partner Center，等待商店签名和审核。在干净 Windows 11 x64/ARM64 设备通过商店安装，测试首次启动、模型添加/应用、`power-switch://`、本地数据目录，以及商店从旧版升级新版后的配置保留和更新提示。商店版不可用 GitHub MSI 覆盖更新。
6. **更新用户入口。** 商店正式公开后，再把 README 的 Windows 首选安装入口指向实际 Store 产品页；GitHub MSI/ZIP 继续提供，但说明新文件仍可能有 SmartScreen 信誉提示。

## 验收边界

- 目前没有 Partner Center 产品标识和已发布的商店包，因此无法完成正式打包、上传审核或证明最终用户首次安装没有提示。
- Store 消除的是 SmartScreen 下载警告；可能仍有系统 UAC、企业策略或首次使用 WebView2 的运行环境差异。
- 从现有 GitHub 安装迁移到 MSIX 时，应验证本机模型和密钥能否读取；若 MSIX 的应用数据虚拟化改变路径，提交商店前必须增加迁移逻辑或显式导入步骤。

## 官方依据

- [Microsoft：SmartScreen 应用信誉](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Microsoft：MSIX 商店提交要求与商店签名](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Microsoft：手工生成 MSIX 包组件](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
- [Microsoft：MakeAppx 命令](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
