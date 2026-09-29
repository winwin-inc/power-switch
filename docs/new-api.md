# New API 接入

power-switch 内置 New API 接入模块，默认地址为 `https://new-api.banmahui.cn`。连接器按 OAuth 接口响应选择 Cookie 会话或 Bearer／刷新 Cookie 流程，版本号只用于显示，不作为兼容性开关。无需修改 New API 或 Keycloak 服务端。

## 使用

1. 可先点击应用顶栏的 **新手指引**，通过三步动画了解申请密钥、模型入库和应用到 Agent 的流程。随后在模型库点击橙色 **从 New API 添加**。实例地址应为 HTTPS 根地址，不包含 `/v1`，且与 New API 的 `ServerAddress` 一致。
2. 点击 **钉钉 / Keycloak 登录**，在独立窗口完成授权。应用不会读取或保存钉钉密码。
3. 选择目标客户端、平台名称和模型。接口固定使用 `default` 分组，无需在页面选择。列表只显示该分组可用的模型，并按服务端元数据筛选；对 Codex，`openai` 模型也会作为 Responses 候选，是否真正兼容由保存前的调用确认。默认优先选中 `auto`；没有兼容的 `auto` 时选择第一个可用模型。平台名称默认为 `winwin`，可自行修改，切换模型时保留。
4. 按上游实际能力设置图像、工具调用和推理档位，不能从模型别名推断。
5. 点击 **创建并添加**。同一实例、同一账号创建或复用一把 power-switch 专属密钥，不设置模型限制；首次创建使用 `default` 分组决定密钥的实际访问范围。应用先检查所选模型是否可访问，再发送一次模型调用；只有收到所选协议的有效文本回复才保存到模型库。调用可能消耗账户额度；失败时密钥可能已创建，重试会复用。
6. 可主动显示或复制密钥。保存后按需点击 **测试连接** 可再次调用模型；测试只确认基本文本调用及响应格式，不证明工具调用、图像、流式或上下文能力。应用到 Agent 时只预览并写入配置，不重复调用模型。
7. 返回模型库，模型名称展示为“平台名称 · 模型 ID”（例如 `winwin · auto`），接口调用仍使用原始模型 ID。使用原有 **应用到 Agent → 预览 → 确认覆盖并备份** 流程。

新建密钥在 New API 控制台中的名称为 **OAuth 同步的用户显示名拼音 + `-ps`**，例如“赵斌”对应 `zhaobin-ps`。英文姓名转为小写并去掉空格；显示名无法转换时使用用户名，仍不可用时使用用户 ID。拼音由本机 [pinyin](https://docs.rs/pinyin/0.11.0/pinyin/) 字典转换，不发送姓名到额外服务。旧版按模型受限的密钥保留在服务端；首次继续导入时创建新的账号共享密钥，不自动撤销旧密钥。

浏览器演示使用内存中的虚构账号和密钥，不请求真实实例，不修改本地 Agent 配置。ego-browser 是调研和网页测试工具，不是插件运行依赖。

## 协议和接口

| New API 元数据    | power-switch 协议                      | 客户端           | API 基础地址      |
| ----------------- | -------------------------------------- | ---------------- | ----------------- |
| `openai`          | `openai-chat`、`openai-responses` 候选 | WorkBuddy、Codex | `https://实例/v1` |
| `anthropic`       | `anthropic-messages`                   | Claude Code      | `https://实例`    |
| `openai-response` | `openai-responses`                     | Codex            | `https://实例/v1` |

Codex 只接受 OpenAI Responses。当前 New API 实例的 `/api/pricing` 对 `auto` 仅声明 `openai` 和 `anthropic`，即使它实际支持 Responses，也不会声明 `openai-response`。因此 `openai` 会使模型出现在 Codex 候选列表，但不会直接认定为可用：专属密钥的 `/v1/models` 清单须包含所选模型，且 `/v1/responses` 必须返回已完成的非空助手文本，才会保存到模型库。导入时还需填写实际上下文窗口。应用后在用户级 `config.toml` 中生成自定义供应商和模型目录，保留其他配置与 `auth.json`。

登录时，Rust 使用隔离 HTTP 会话先尝试 `POST /api/oauth/state`（提供方和 `login` 意图）；仅在 404／405 时尝试旧版 `GET`。它分别读取 `flow_token` 或字符串 state，在隔离 WebView 中打开提供方授权地址，并保留 New API 原始回调 `/oauth/{provider}`。原生导航处理器校验回调来源、路径及唯一 state，截获授权码并阻止网页再次兑换，由同一 Rust HTTP 会话请求 `/api/oauth/{provider}`。Client Secret 和 Keycloak Token 始终由 New API 服务端处理。

旧流程的管理请求使用 Cookie 与 `New-Api-User`；新流程使用 OAuth 回调返回的短期 Bearer 令牌，并按需通过刷新 Cookie 续期。管理凭证不会发往模型调用接口，也不调用会覆盖现有系统访问令牌的 `/api/user/token`。

使用的管理接口：`/api/status`、`/api/user/self`、`/api/user/self/groups`、`/api/user/models?group=…`、`/api/pricing`、`POST /api/token/`、`GET /api/token/search`、`POST /api/token/{id}/key`。完整 API Key 通过专用接口取得，不使用令牌列表中的脱敏值。`GET /v1/models` 验证模型密钥访问。

应用把完整密钥视为不透明字符串，拒绝空值、脱敏值和控制字符。先用服务端原样返回的密钥读取 `/v1/models`；只有鉴权失败且密钥不带 `sk-` 时才尝试补一次前缀。校验通过后才写入模型库。[rc.21 OAuth](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.21/controller/oauth.go) 与 [rc.40 OAuth](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.40/controller/oauth.go) 的差异由认证流程处理，不再靠版本字符串判断。

## 存储与恢复

- macOS、Windows、Linux 均将登录会话明文保存在用户目录的 `.power-switch/new-api/sessions/`。每个规范化实例地址对应一个以 SHA-256 命名的 JSON 文件，文件内记录格式版本、实例地址和会话；读取时校验实例。系统钥匙串及旧应用数据目录中的记录不再读取或迁移，升级后需要重新登录。
- 本机会话最长保留 30 天；新流程也受服务端会话到期时间约束。启动恢复时核对身份，Bearer 临近到期时使用仅限 `/api/user/auth` 路径的刷新 Cookie 续期。会话失效后重新登录，已创建的模型密钥独立有效。
- API Key 明文保存在 `.power-switch/models.json`，应用设置也在此文件中；配置快照明文保存在 `.power-switch/backups/`。这些文件和会话文件都包含敏感信息，复制或备份整个目录时应按凭据处理。管理会话、授权码和完整远端响应不写日志、分享链接或错误提示。
- `.power-switch/new-api.json` 只保存账号 ID、实例、首次创建分组、令牌名称与 ID、创建前同名令牌的 ID，以及每个关联模型的模型 ID、协议和稳定本地 ID。Unix 目录权限为 `0700`、文件权限为 `0600`；Windows 使用仅当前用户和 SYSTEM 可访问的受保护 ACL。**请保留此文件**，它负责识别已有密钥并恢复未完成操作。
- 同一用户的不同令牌允许使用相同的姓名拼音名称。创建前记录已存在的同名令牌 ID，再写入 `submitted` 记录；恢复时排除旧 ID，核对账号、首次分组及无限制设置，已有绑定按令牌 ID 识别。旧版恢复记录可读，升级后保留为迁移来源。
- 崩溃、断网或响应丢失后先恢复查询，不自动重发无法确认结果的创建请求。可先点击 **重新检查并继续**；只有用户核对服务端列表并勾选允许重新创建时，才启动新的创建操作。
- 重复导入复用密钥和本地模型 ID；同一实例、同一账号的模型与协议共用一把密钥。其他分组的模型若不在共享密钥的 `/v1/models` 清单中，导入会停止并提示调整分组权限。用户主动更换失效密钥时，同步更新本机仍指向原接口的关联模型；已写入 Agent 的配置需重新预览应用。
- **断开连接** 仅移除本机管理会话，不删除服务端密钥。删除模型库记录也不撤销服务端密钥，需要撤销时在 New API 控制台操作。

## 测试和版本范围

自动化测试使用本机模拟 HTTP 服务、内存凭证库和临时目录，不访问生产账号。覆盖 OAuth state／回调／重放／取消／超时、账号隔离、密钥响应丢失和恢复、重复导入、协议筛选、失效密钥、私有存储及按需推理测试。

```sh
pnpm test
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm tauri build --bundles app
```

OAuth 的原生窗口需要在 macOS 上完成一次真实钉钉授权验收：检查扫码显示、授权返回、模型读取、创建与复用、显示／复制密钥、一次实际模型测试及应用预览。若身份提供方禁止嵌入式窗口，应保留错误现场并另行适配系统浏览器回调；不会自动转为读取其他浏览器的 Cookie。

连接检查不再因版本号不同而拦截。未知的 state、登录、刷新、模型协议或密钥响应会在对应步骤明确报错并停止；OAuth 后若实例要求站内二次验证，当前自动接入会提示后停止。不会自动升级服务端、修改 Keycloak、执行 SQL 或猜测不兼容的接口。版本无关不等于完全不依赖管理接口契约，未来接口行为变化时仍需针对该环节适配。

## 本轮交付验证（2026-09-22）

- Rust 测试 35 项、Vitest 14 项通过；TypeScript、Clippy 和格式检查通过。
- macOS `.app` 构建通过，输出位于 `src-tauri/target/release/bundle/macos/power-switch.app`。
- ego-browser 完成浏览器演示的登录、协议筛选、Codex 上下文填写、模型导入和按需测试流程。浏览器截图接口超时，界面检查使用页面快照和 DOM 布局信息。
- 尚未完成原生窗口真实钉钉扫码、生产密钥创建与实际付费调用；自动化结果不能替代这部分联调验收。

## 当前支持范围

WorkBuddy 支持 OpenAI Chat，Claude Code 支持 Anthropic Messages，Codex 支持 OpenAI Responses。New API 导入前必须通过所选协议的实际文本调用；现有模型不会因本次改动自动重测，编辑后重新保存需要再次测试。
