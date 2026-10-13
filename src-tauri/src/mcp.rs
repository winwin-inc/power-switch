//! Remote MCP connectors are app-owned records projected into each client's native config.
use crate::{
    adapters::Change,
    files::{self, Snapshot},
    model::AppResult,
    paths::{self, Paths, Settings},
};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::{
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use toml_edit::{value, DocumentMut, Item, Table};

pub const BUILTIN_X_ID: &str = "3d921c53-7b74-46b8-a921-661025ac1a87";
pub const BUILTIN_INTERNAL_ID: &str = "8e291422-6e9d-4edf-ae30-83564e6f6a2e";

struct BuiltinDefinition {
    id: &'static str,
    name: &'static str,
    server_id: &'static str,
    url: &'static str,
}

const BUILTINS: [BuiltinDefinition; 2] = [
    BuiltinDefinition {
        id: BUILTIN_X_ID,
        name: "马上赢 X 平台",
        server_id: "msy-x-lightdash",
        url: "https://mcp-x.brandct.com/mcp",
    },
    BuiltinDefinition {
        id: BUILTIN_INTERNAL_ID,
        name: "马上赢内部 LightDash",
        server_id: "msy-internal-lightdash",
        url: "https://mcp-lightdash.banmahui.cn/mcp",
    },
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    None,
    Bearer,
    CustomHeader,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpDraft {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub server_id: String,
    pub url: String,
    pub auth_mode: AuthMode,
    #[serde(default)]
    pub header_name: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnector {
    pub id: String,
    pub name: String,
    pub server_id: String,
    pub url: String,
    pub auth_mode: AuthMode,
    pub header_name: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSummary {
    pub id: String,
    pub name: String,
    pub server_id: String,
    pub url: String,
    pub auth_mode: AuthMode,
    pub header_name: String,
    pub has_token: bool,
    pub built_in: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub tool_count: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpTarget {
    Workbuddy,
    WorkbuddyProject,
    Codex,
    CodexProject,
    ClaudeUser,
    ClaudeProject,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStore {
    connectors: Vec<McpConnector>,
}

pub struct McpProjection {
    pub changes: Vec<Change>,
    pub notices: Vec<String>,
    pub project_secrets: Vec<ProjectSecret>,
}

pub struct ProjectSecret {
    pub path: PathBuf,
    pub project_dir: PathBuf,
}

/// Provide a fixed built-in connector before its independent PAT has been configured.
fn builtin_connector(definition: &BuiltinDefinition) -> McpConnector {
    McpConnector {
        id: definition.id.into(),
        name: definition.name.into(),
        server_id: definition.server_id.into(),
        url: definition.url.into(),
        auth_mode: AuthMode::CustomHeader,
        header_name: "x-api-key".into(),
        token: String::new(),
    }
}

/// Identify built-ins by stable identity first, then adopt records with the same reserved server ID.
fn builtin_definition(id: &str, server_id: &str) -> Option<&'static BuiltinDefinition> {
    BUILTINS
        .iter()
        .find(|definition| definition.id == id)
        .or_else(|| {
            BUILTINS
                .iter()
                .find(|definition| definition.server_id == server_id)
        })
}

/// Recognize built-ins including records previously added as custom templates.
fn is_builtin(connector: &McpConnector) -> bool {
    builtin_definition(&connector.id, &connector.server_id).is_some()
}

/// Keep the built-in endpoint and authentication fixed while preserving its saved ID and PAT.
fn normalize_builtin(connector: &McpConnector) -> McpConnector {
    if let Some(definition) = builtin_definition(&connector.id, &connector.server_id) {
        McpConnector {
            id: connector.id.clone(),
            token: connector.token.clone(),
            ..builtin_connector(definition)
        }
    } else {
        connector.clone()
    }
}

/// Validate a stable server identifier and a credential-free HTTP endpoint.
fn validate(draft: &mut McpDraft) -> AppResult<()> {
    draft.name = draft.name.trim().to_string();
    draft.server_id = draft.server_id.trim().to_string();
    draft.url = draft.url.trim().to_string();
    draft.header_name = draft.header_name.trim().to_string();
    if draft.name.is_empty() || draft.name.len() > 256 {
        return Err("请填写不超过 256 字的连接器名称".into());
    }
    if draft.server_id.is_empty()
        || draft.server_id.len() > 80
        || !draft
            .server_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("服务 ID 只支持英文字母、数字、- 和 _，最长 80 字".into());
    }
    let url = url::Url::parse(&draft.url).map_err(|_| "请输入有效的 MCP URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("MCP URL 必须是无账号、查询参数和片段的 HTTP(S) 地址".into());
    }
    if draft.token.len() > 16384 {
        return Err("令牌超过长度限制".into());
    }
    if draft.auth_mode == AuthMode::CustomHeader {
        let header =
            HeaderName::from_bytes(draft.header_name.as_bytes()).map_err(|_| "请求头名称无效")?;
        if [
            "authorization",
            "host",
            "content-type",
            "accept",
            "mcp-session-id",
            "mcp-protocol-version",
        ]
        .contains(&header.as_str())
        {
            return Err("该请求头由 MCP 客户端管理，请选择其他名称".into());
        }
    } else {
        draft.header_name.clear();
    }
    if draft.auth_mode == AuthMode::None {
        draft.token.clear();
    }
    Ok(())
}

/// Read the private connector library without creating it on first launch.
fn read_store(paths: &Paths) -> AppResult<McpStore> {
    let snapshot = Snapshot::read(&paths.data.join("mcp-connectors.json"))?;
    match snapshot.text()? {
        Some(text) => serde_json::from_str(text).map_err(|_| "MCP 连接器库格式无效".into()),
        None => Ok(McpStore::default()),
    }
}

/// Persist the entire connector library using the existing private atomic writer.
fn write_store(paths: &Paths, store: &McpStore) -> AppResult<()> {
    files::atomic_write(
        &paths.data.join("mcp-connectors.json"),
        &serde_json::to_vec_pretty(store).map_err(|_| "无法保存 MCP 连接器")?,
    )
}

/// Convert a stored record to display metadata with no credential value.
fn summary(connector: &McpConnector) -> McpSummary {
    let connector = normalize_builtin(connector);
    McpSummary {
        id: connector.id.clone(),
        name: connector.name.clone(),
        server_id: connector.server_id.clone(),
        url: connector.url.clone(),
        auth_mode: connector.auth_mode,
        header_name: connector.header_name.clone(),
        has_token: !connector.token.is_empty(),
        built_in: is_builtin(&connector),
    }
}

/// List connector metadata without sending stored PATs into the UI.
pub fn list(paths: &Paths) -> AppResult<Vec<McpSummary>> {
    let store = read_store(paths)?;
    let mut summaries = BUILTINS
        .iter()
        .map(|definition| {
            let builtin = store
                .connectors
                .iter()
                .find(|c| {
                    builtin_definition(&c.id, &c.server_id)
                        .is_some_and(|found| found.id == definition.id)
                })
                .cloned()
                .unwrap_or_else(|| builtin_connector(definition));
            summary(&builtin)
        })
        .collect::<Vec<_>>();
    summaries.extend(
        store
            .connectors
            .iter()
            .filter(|c| !is_builtin(c))
            .map(summary),
    );
    Ok(summaries)
}

/// Resolve an edit draft, retaining the existing PAT when its field is left blank.
pub fn resolve(paths: &Paths, mut draft: McpDraft) -> AppResult<McpConnector> {
    let store = read_store(paths)?;
    let requested = BUILTINS.iter().find(|definition| definition.id == draft.id);
    let old = if let Some(definition) = requested {
        store.connectors.iter().find(|c| {
            builtin_definition(&c.id, &c.server_id).is_some_and(|found| found.id == definition.id)
        })
    } else if draft.id.is_empty() {
        None
    } else {
        Some(
            store
                .connectors
                .iter()
                .find(|c| c.id == draft.id)
                .ok_or("连接器已被删除，请刷新")?,
        )
    };
    let definition =
        requested.or_else(|| old.and_then(|c| builtin_definition(&c.id, &c.server_id)));
    if let Some(definition) = definition {
        let fixed = builtin_connector(definition);
        draft.id = old.map_or_else(|| fixed.id.clone(), |c| c.id.clone());
        draft.name = fixed.name;
        draft.server_id = fixed.server_id;
        draft.url = fixed.url;
        draft.auth_mode = fixed.auth_mode;
        draft.header_name = fixed.header_name;
    } else if BUILTINS
        .iter()
        .any(|definition| definition.server_id == draft.server_id.trim())
    {
        return Err("该服务 ID 属于内置连接器，请在列表中配置令牌".into());
    }
    validate(&mut draft)?;
    if draft.auth_mode != AuthMode::None && draft.token.is_empty() {
        draft.token = old.map(|c| c.token.clone()).unwrap_or_default();
    }
    if draft.auth_mode != AuthMode::None && draft.token.is_empty() {
        return Err("请填写访问令牌".into());
    }
    HeaderValue::from_str(&draft.token).map_err(|_| "令牌含有不支持的请求头字符")?;
    Ok(McpConnector {
        id: if draft.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            draft.id
        },
        name: draft.name,
        server_id: draft.server_id,
        url: draft.url,
        auth_mode: draft.auth_mode,
        header_name: draft.header_name,
        token: draft.token,
    })
}

/// Save a validated connector while preventing two library records from sharing a server ID.
pub fn upsert(paths: &Paths, draft: McpDraft) -> AppResult<McpSummary> {
    let connector = resolve(paths, draft)?;
    let mut store = read_store(paths)?;
    if store
        .connectors
        .iter()
        .any(|c| c.server_id == connector.server_id && c.id != connector.id)
    {
        return Err("服务 ID 已被其他连接器使用".into());
    }
    if let Some(old) = store.connectors.iter_mut().find(|c| c.id == connector.id) {
        *old = connector.clone();
    } else {
        store.connectors.push(connector.clone());
    }
    write_store(paths, &store)?;
    Ok(summary(&connector))
}

/// Remove one library record without touching configuration already applied to agents.
pub fn delete(paths: &Paths, id: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效的连接器 ID")?;
    let mut store = read_store(paths)?;
    if BUILTINS.iter().any(|definition| definition.id == id)
        || store.connectors.iter().any(|c| c.id == id && is_builtin(c))
    {
        return Err("内置连接器不能删除".into());
    }
    let before = store.connectors.len();
    store.connectors.retain(|c| c.id != id);
    if store.connectors.len() == before {
        return Err("连接器已被删除，请刷新".into());
    }
    write_store(paths, &store)
}

/// Look up a full connector only inside the native backend.
pub fn get(paths: &Paths, id: &str) -> AppResult<McpConnector> {
    let store = read_store(paths)?;
    let requested = BUILTINS.iter().find(|definition| definition.id == id);
    let connector = store
        .connectors
        .iter()
        .find(|c| c.id == id)
        .or_else(|| {
            requested.and_then(|definition| {
                store.connectors.iter().find(|c| {
                    builtin_definition(&c.id, &c.server_id)
                        .is_some_and(|found| found.id == definition.id)
                })
            })
        })
        .map(normalize_builtin)
        .ok_or_else(|| {
            if let Some(definition) = requested {
                format!("请先为{}填写访问令牌", definition.name)
            } else {
                "连接器不存在".to_string()
            }
        })?;
    if is_builtin(&connector) && connector.token.is_empty() {
        return Err(format!("请先为{}填写访问令牌", connector.name));
    }
    Ok(connector)
}

/// Connect using the official MCP Rust SDK and list tools without invoking any tool.
pub async fn test(connector: McpConnector) -> AppResult<McpTestResult> {
    test_with_timeout(connector, Duration::from_secs(15)).await
}

/// Bound a real SDK handshake so a stalled server cannot block the UI indefinitely.
async fn test_with_timeout(connector: McpConnector, timeout: Duration) -> AppResult<McpTestResult> {
    let mut config = StreamableHttpClientTransportConfig::with_uri(connector.url.clone());
    match connector.auth_mode {
        AuthMode::None => {}
        AuthMode::Bearer => config = config.auth_header(connector.token.clone()),
        AuthMode::CustomHeader => {
            let header = HeaderName::from_bytes(connector.header_name.as_bytes())
                .map_err(|_| "请求头名称无效")?;
            let value = HeaderValue::from_str(&connector.token).map_err(|_| "令牌格式无效")?;
            config = config.custom_headers(HashMap::from([(header, value)]));
        }
    }
    let outcome = tokio::time::timeout(timeout, async {
        let transport = StreamableHttpClientTransport::from_config(config);
        let client = ().serve(transport).await.map_err(|e| e.to_string())?;
        let tools = client.list_all_tools().await.map_err(|e| e.to_string())?;
        let _ = client.cancel().await;
        Ok::<usize, String>(tools.len())
    })
    .await;
    match outcome {
        Ok(Ok(tool_count)) => Ok(McpTestResult { tool_count }),
        Ok(Err(error)) => Err(if connector.token.is_empty() {
            error
        } else {
            error.replace(&connector.token, "••••••••")
        }),
        Err(_) => Err("连接超时，请检查 MCP 地址和网络".into()),
    }
}

/// Return the native configuration path for one selected MCP target.
fn target_path(
    paths: &Paths,
    settings: &Settings,
    target: McpTarget,
    project_dir: Option<&Path>,
) -> AppResult<PathBuf> {
    let path = match target {
        McpTarget::Workbuddy => paths
            .target(settings, crate::model::AgentKind::Workbuddy)?
            .parent()
            .ok_or("WorkBuddy 配置目录无效")?
            .join("mcp.json"),
        McpTarget::Codex => paths.target(settings, crate::model::AgentKind::Codex)?,
        McpTarget::ClaudeUser => paths.home.join(".claude.json"),
        McpTarget::WorkbuddyProject => {
            return Err("WorkBuddy 暂不支持 MCP 项目级配置，请选择用户全局".into())
        }
        McpTarget::CodexProject | McpTarget::ClaudeProject => {
            let dir = project_dir.ok_or("请选择项目目录")?;
            paths::validate_absolute(dir)?;
            let meta = fs::symlink_metadata(dir).map_err(|_| "项目目录不存在")?;
            if !meta.is_dir() || files::unsafe_file_type(&meta) {
                return Err("项目目录必须是普通目录".into());
            }
            dir.join(match target {
                McpTarget::CodexProject => ".codex/config.toml",
                _ => ".mcp.json",
            })
        }
    };
    paths::validate_absolute(&path)?;
    if path.starts_with(&paths.data) {
        return Err("Agent 配置不能指向应用数据目录".into());
    }
    Ok(path)
}

/// Reject tracked or unignored project MCP files before copying a literal PAT into them.
pub(crate) fn check_project_secret(check: &ProjectSecret) -> AppResult<()> {
    let dir = &check.project_dir;
    let relative = check
        .path
        .strip_prefix(dir)
        .map_err(|_| "项目配置路径无效")?;
    let repo = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .map_err(|_| "无法检查 Git 状态；请安装 Git 后重试项目级应用")?;
    if !repo.status.success() {
        return Ok(());
    }
    let tracked = Command::new("git")
        .args(["ls-files", "--error-unmatch", "--"])
        .arg(relative)
        .current_dir(dir)
        .output()
        .map_err(|_| "无法检查 MCP 文件是否已被 Git 跟踪")?;
    if tracked.status.success() {
        return Err(format!(
            "项目 {} 已被 Git 跟踪，不能写入明文令牌",
            relative.display()
        ));
    }
    let ignored = Command::new("git")
        .args(["check-ignore", "--no-index", "-q", "--"])
        .arg(relative)
        .current_dir(dir)
        .output()
        .map_err(|_| "无法检查 MCP 文件的 Git 忽略规则")?;
    if !ignored.status.success() {
        return Err(format!(
            "项目 {} 尚未被 Git 忽略，请先添加忽略规则",
            relative.display()
        ));
    }
    Ok(())
}

/// Encode a JSON MCP entry, preserving all unrelated entries and top-level fields.
fn json_projection(
    before: &Snapshot,
    connector: &McpConnector,
    target: McpTarget,
) -> AppResult<(Vec<u8>, bool)> {
    let mut root: Value = before.text()?.map_or(Ok(json!({})), |text| {
        serde_json::from_str(text).map_err(|_| "现有 MCP JSON 无效，请先修复".to_string())
    })?;
    let object = root.as_object_mut().ok_or("MCP JSON 根节点必须是对象")?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("mcpServers 必须是对象")?;
    let replaced = servers.contains_key(&connector.server_id);
    let mut entry = json!({"type": if target == McpTarget::Workbuddy { "streamableHttp" } else { "http" }, "url": connector.url});
    if let Some((name, token)) = auth_header(connector) {
        entry["headers"] = json!({name: token});
    }
    servers.insert(connector.server_id.clone(), entry);
    let mut bytes = serde_json::to_vec_pretty(&root).map_err(|_| "无法生成 MCP JSON")?;
    bytes.push(b'\n');
    Ok((bytes, replaced))
}

/// Encode a Codex MCP table, preserving comments and other TOML tables.
fn codex_projection(before: &Snapshot, connector: &McpConnector) -> AppResult<(Vec<u8>, bool)> {
    let mut doc = before
        .text()?
        .unwrap_or("")
        .parse::<DocumentMut>()
        .map_err(|_| "现有 Codex TOML 无效，请先修复")?;
    if !doc.contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or("Codex mcp_servers 必须为表")?;
    let replaced = servers.contains_key(&connector.server_id);
    let mut entry = Table::new();
    entry["url"] = value(&connector.url);
    if let Some((name, token)) = auth_header(connector) {
        let mut headers = Table::new();
        headers[&name] = value(token);
        entry["http_headers"] = Item::Table(headers);
    }
    servers[&connector.server_id] = Item::Table(entry);
    Ok((doc.to_string().into_bytes(), replaced))
}

/// Produce the literal HTTP authentication header used by each native client.
fn auth_header(connector: &McpConnector) -> Option<(String, String)> {
    match connector.auth_mode {
        AuthMode::None => None,
        AuthMode::Bearer => Some((
            "Authorization".into(),
            format!("Bearer {}", connector.token),
        )),
        AuthMode::CustomHeader => Some((connector.header_name.clone(), connector.token.clone())),
    }
}

/// Project selected agents into the existing backup-capable file transaction.
pub fn project(
    paths: &Paths,
    settings: &Settings,
    connector: &McpConnector,
    targets: &[McpTarget],
    project_dir: Option<&Path>,
) -> AppResult<McpProjection> {
    if targets.is_empty() {
        return Err("请至少选择一个 Agent".into());
    }
    if targets.contains(&McpTarget::WorkbuddyProject) {
        return Err("WorkBuddy 暂不支持 MCP 项目级配置，请选择用户全局".into());
    }
    let mut changes = vec![];
    let mut notices = vec![];
    let mut project_secrets = vec![];
    for (index, target) in targets.iter().enumerate() {
        if targets[..index].contains(target) {
            continue;
        }
        let path = target_path(paths, settings, *target, project_dir)?;
        if matches!(target, McpTarget::CodexProject | McpTarget::ClaudeProject)
            && connector.auth_mode != AuthMode::None
        {
            let check = ProjectSecret {
                path: path.clone(),
                project_dir: project_dir.ok_or("请选择项目目录")?.to_path_buf(),
            };
            check_project_secret(&check)?;
            project_secrets.push(check);
        }
        let before = Snapshot::read(&path)?;
        let (after, replaced) = if matches!(target, McpTarget::Codex | McpTarget::CodexProject) {
            codex_projection(&before, connector)?
        } else {
            json_projection(&before, connector, *target)?
        };
        if replaced {
            notices.push(format!(
                "{} 中同名服务 {} 将被替换。",
                path.display(),
                connector.server_id
            ));
        }
        if *target == McpTarget::ClaudeProject {
            notices.push("Claude Code 首次使用项目级 MCP 时需要在交互会话中信任该连接器。".into());
        }
        if *target == McpTarget::Workbuddy {
            notices.push("请重启 WorkBuddy，并在“自定义连接器”中信任该连接器。".into());
        }
        if *target == McpTarget::CodexProject {
            notices.push("Codex 仅在受信任的项目中读取项目级 .codex/config.toml，请在 Codex 中确认项目信任。".into());
        }
        changes.push(Change {
            before,
            after: Some(after),
        });
    }
    notices.push("目标 Agent 可能需要重启或新建会话才能读取 MCP 配置。".into());
    Ok(McpProjection {
        changes,
        notices,
        project_secrets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::{matchers::method, Mock, MockServer, Request, ResponseTemplate};

    /// Build a fake connector that never reaches the real WinWin endpoint.
    fn connector(url: String) -> McpConnector {
        McpConnector {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Mock MCP".into(),
            server_id: "mock".into(),
            url,
            auth_mode: AuthMode::CustomHeader,
            header_name: "x-api-key".into(),
            token: "TEST-PAT".into(),
        }
    }

    /// Answer initialize and tools/list but never execute a business tool.
    #[tokio::test]
    async fn test_connects_and_lists_tools_only() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(|request: &Request| {
                if request.headers.get("x-api-key").and_then(|v| v.to_str().ok()) != Some("TEST-PAT") {
                    return ResponseTemplate::new(401);
                }
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                let method = body["method"].as_str().unwrap_or("");
                if method == "notifications/initialized" { return ResponseTemplate::new(202); }
                let result = match method {
                    "initialize" => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1.0.0"}}),
                    "tools/list" => json!({"tools":[{"name":"search","description":"mock","inputSchema":{"type":"object","properties":{}}}]}),
                    _ => return ResponseTemplate::new(400),
                };
                ResponseTemplate::new(200).set_body_json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
            })
            .mount(&server)
            .await;
        let result = test_with_timeout(
            connector(format!("{}/mcp", server.uri())),
            Duration::from_secs(4),
        )
        .await
        .unwrap();
        assert_eq!(result.tool_count, 1);
        let requests = server.received_requests().await.unwrap();
        let methods: Vec<_> = requests
            .iter()
            .filter_map(|r| serde_json::from_slice::<Value>(&r.body).ok())
            .filter_map(|v| v["method"].as_str().map(str::to_string))
            .collect();
        assert!(methods.contains(&"initialize".into()));
        assert!(methods.contains(&"tools/list".into()));
        assert!(!methods.iter().any(|m| m == "tools/call"));
    }

    /// Accept a valid server with no tools and send Bearer authentication on the handshake.
    #[tokio::test]
    async fn test_accepts_empty_tool_list_with_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(|request: &Request| {
                if request
                    .headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    != Some("Bearer TEST-PAT")
                {
                    return ResponseTemplate::new(401);
                }
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                if body["method"] == "notifications/initialized" {
                    return ResponseTemplate::new(202);
                }
                let result = match body["method"].as_str() {
                    Some("initialize") => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1.0.0"}}),
                    Some("tools/list") => json!({"tools":[]}),
                    _ => return ResponseTemplate::new(400),
                };
                ResponseTemplate::new(200)
                    .set_body_json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
            })
            .mount(&server)
            .await;
        let mut item = connector(format!("{}/mcp", server.uri()));
        item.auth_mode = AuthMode::Bearer;
        let result = test_with_timeout(item, Duration::from_secs(4))
            .await
            .unwrap();
        assert_eq!(result.tool_count, 0);
    }

    /// Report an authentication rejection without echoing the submitted PAT.
    #[tokio::test]
    async fn test_rejects_unauthorized_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let error = test_with_timeout(
            connector(format!("{}/mcp", server.uri())),
            Duration::from_secs(3),
        )
        .await
        .unwrap_err();
        assert!(!error.contains("TEST-PAT"));
    }

    /// Bound delayed servers and reject malformed MCP responses.
    #[tokio::test]
    async fn test_times_out_or_rejects_bad_json() {
        let slow = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(250)))
            .mount(&slow)
            .await;
        let timeout = test_with_timeout(
            connector(format!("{}/mcp", slow.uri())),
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();
        assert!(timeout.contains("超时"));
        let bad = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not-json"))
            .mount(&bad)
            .await;
        assert!(test_with_timeout(
            connector(format!("{}/mcp", bad.uri())),
            Duration::from_secs(2)
        )
        .await
        .is_err());
    }
}
