//! Capability-driven New API connector with private sessions and recoverable token creation.
mod http;
#[cfg(test)]
mod tests;
pub mod vault;

use crate::{
    files,
    model::{ModelConfig, Protocol},
};
use http::{read_json, ApiClient};
use pinyin::ToPinyin;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;
use vault::Vault;

pub const DEFAULT_URL: &str = "https://new-api.banmahui.cn";
pub const LOGIN_TIMEOUT: u64 = 600;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    /// Construct a safe error from local text, never from a server response or credential-bearing URL.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct OAuthProvider {
    pub name: String,
    pub slug: String,
    pub client_id: String,
    pub authorization_endpoint: String,
    #[serde(default)]
    pub scopes: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub version: String,
    pub provider: OAuthProvider,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    #[serde(default)]
    pub display_name: String,
    pub group: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub base_url: String,
    pub phase: &'static str,
    pub user: Option<User>,
    pub login_id: Option<String>,
    pub error: Option<Error>,
}

pub struct LoginStart {
    pub id: String,
    pub url: Url,
    pub callback: Url,
    pub canceled: Arc<AtomicBool>,
}

struct PendingLogin {
    id: String,
    state: String,
    callback: Url,
    client: ApiClient,
    dialect: LoginDialect,
    started: u64,
    canceled: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
enum LoginDialect {
    Cookie,
    Bearer,
}

#[derive(Deserialize, Serialize)]
struct SavedSession {
    base_url: String,
    user: User,
    expires_at: u64,
    auth: SavedAuth,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum SavedAuth {
    Cookie {
        cookie: String,
    },
    Bearer {
        access_token: String,
        access_expires_at: u64,
        refresh_cookie: String,
        session_id: String,
    },
}

#[derive(Deserialize)]
struct LegacySavedSession {
    base_url: String,
    user: User,
    cookie: String,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSession {
    Current(SavedSession),
    Legacy(LegacySavedSession),
}

enum SessionAuth {
    Cookie,
    Bearer {
        access_expires_at: u64,
        session_id: String,
    },
}

struct Session {
    client: ApiClient,
    auth: SessionAuth,
    user: User,
    expires_at: u64,
    verified_at: u64,
}

#[derive(Clone, Serialize)]
pub struct Group {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub model_id: String,
    pub protocols: Vec<Protocol>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub groups: Vec<Group>,
    pub selected_group: String,
    pub models: Vec<Candidate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    pub base_url: String,
    pub user_id: i64,
    pub group: String,
    pub model_id: String,
    pub protocol: Protocol,
    pub name: String,
    pub supports_tool_call: bool,
    pub supports_images: bool,
    pub context_window: Option<u64>,
    pub reasoning_levels: Vec<String>,
    #[serde(default)]
    pub replace_invalid: bool,
    #[serde(default)]
    pub restart_uncertain: bool,
}

pub struct PreparedImport {
    pub model: ModelConfig,
    pub siblings: Vec<String>,
    pub reused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub model: ModelConfig,
    pub reused: bool,
    pub message: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum CreationPhase {
    Prepared,
    Submitted,
    Ready,
}

#[derive(Clone, Deserialize, Serialize)]
struct LocalModel {
    #[serde(default)]
    model_id: String,
    protocol: Protocol,
    id: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct TokenRecord {
    base_url: String,
    user_id: i64,
    group: String,
    model_id: String,
    #[serde(default)]
    unrestricted: bool,
    name: String,
    token_id: Option<i64>,
    #[serde(default)]
    prior_token_ids: Option<Vec<i64>>,
    phase: CreationPhase,
    models: Vec<LocalModel>,
}

#[derive(Deserialize, Serialize)]
struct Journal {
    version: u32,
    records: Vec<TokenRecord>,
}

pub struct NewApi {
    path: PathBuf,
    vault: Box<dyn Vault>,
    session: Option<Session>,
    pending: Option<PendingLogin>,
    last_error: Option<(String, Error)>,
}

impl NewApi {
    /// Initialize separate connector metadata without changing existing model-library schemas.
    pub fn new(data_dir: PathBuf, vault: Box<dyn Vault>) -> Self {
        Self {
            path: data_dir.join("new-api.json"),
            vault,
            session: None,
            pending: None,
            last_error: None,
        }
    }

    /// Discover the configured OAuth provider without treating a release label as a contract.
    pub async fn check(&self, raw: &str) -> Result<Connection> {
        let base = instance_url(raw)?;
        let api = ApiClient::new(&base)?;
        let response = api
            .api(api.management(Method::GET, "/api/status", None))
            .await?;
        let data = &response["data"];
        let version = data["version"].as_str().unwrap_or("未知版本");
        if let Some(server) = data["server_address"].as_str().filter(|s| !s.is_empty()) {
            if instance_url(server)? != base {
                return Err(Error::new(
                    "url",
                    "实例地址与服务端 ServerAddress 不一致，请使用服务端配置的地址",
                ));
            }
        }
        let providers: Vec<OAuthProvider> =
            serde_json::from_value(data["custom_oauth_providers"].clone())
                .map_err(|_| Error::new("oauth", "实例未提供可用的自定义 OAuth 配置"))?;
        let provider = providers
            .iter()
            .find(|p| p.slug == "keycloak")
            .or_else(|| {
                if providers.len() == 1 {
                    providers.first()
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                Error::new(
                    "oauth",
                    "未找到 Keycloak；实例需配置一个明确的自定义 OAuth 提供方",
                )
            })?
            .clone();
        if provider.slug.is_empty()
            || !provider
                .slug
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || provider.client_id.is_empty()
        {
            return Err(Error::new("oauth", "OAuth 提供方配置无效"));
        }
        https_url(&provider.authorization_endpoint)?;
        Ok(Connection {
            base_url: base,
            version: version.into(),
            provider,
        })
    }

    /// Start with a fresh cookie jar so an existing session cannot turn login into account binding.
    pub async fn start_login(&mut self, raw: &str) -> Result<LoginStart> {
        if self.pending.is_some() {
            return Err(Error::new("login_busy", "已有登录窗口，请先完成或取消登录"));
        }
        let connection = self.check(raw).await?;
        let client = ApiClient::new(&connection.base_url)?;
        let modern = client
            .api(
                client
                    .management(Method::POST, "/api/oauth/state", None)
                    .json(&json!({"provider":connection.provider.slug,"intent":"login"})),
            )
            .await;
        let (response, dialect) = match modern {
            Ok(response) => (response, LoginDialect::Bearer),
            Err(error) if matches!(error.code, "not_found" | "method_not_allowed") => (
                client
                    .api(client.management(Method::GET, "/api/oauth/state", None))
                    .await?,
                LoginDialect::Cookie,
            ),
            Err(error) => return Err(error),
        };
        let state = match dialect {
            LoginDialect::Bearer => response["data"]["flow_token"].as_str(),
            LoginDialect::Cookie => response["data"].as_str(),
        }
        .filter(|s| !s.is_empty() && s.len() <= 512)
        .ok_or_else(|| {
            Error::new(
                "oauth_contract",
                "实例未返回可识别的 OAuth state，登录已停止",
            )
        })?
        .to_string();
        let callback = Url::parse(&format!(
            "{}/oauth/{}",
            connection.base_url, connection.provider.slug
        ))
        .map_err(|_| Error::new("oauth", "OAuth 回调地址无效"))?;
        let mut url = https_url(&connection.provider.authorization_endpoint)?;
        // Server-provided endpoints cannot override the required OAuth authorization parameters.
        let extras: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| {
                ![
                    "client_id",
                    "redirect_uri",
                    "response_type",
                    "state",
                    "scope",
                    "response_mode",
                ]
                .contains(&key.as_ref())
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        url.query_pairs_mut()
            .extend_pairs(extras)
            .append_pair("client_id", &connection.provider.client_id)
            .append_pair("redirect_uri", callback.as_str())
            .append_pair("response_type", "code")
            .append_pair("state", &state)
            .append_pair("scope", &connection.provider.scopes);
        let id = Uuid::new_v4().to_string();
        let canceled = Arc::new(AtomicBool::new(false));
        self.last_error = None;
        self.pending = Some(PendingLogin {
            id: id.clone(),
            state,
            callback: callback.clone(),
            client,
            dialect,
            started: now(),
            canceled: canceled.clone(),
        });
        Ok(LoginStart {
            id,
            url,
            callback,
            canceled,
        })
    }

    /// Consume the pending flow once, validate state, and exchange the code with New API only.
    pub async fn finish_login(&mut self, id: &str, callback_url: &Url) -> Result<()> {
        if self.pending.as_ref().is_none_or(|p| p.id != id) {
            return Err(Error::new("oauth", "登录流程已结束，请重新登录"));
        }
        let flow = self.pending.take().unwrap();
        let base = flow.client.base.clone();
        let result = self.exchange_login(flow, callback_url).await;
        if let Err(ref error) = result {
            self.last_error = Some((base, error.clone()));
        }
        result
    }

    /// Exchange the OAuth code once and recognize the resulting dashboard auth contract.
    async fn exchange_login(&mut self, flow: PendingLogin, callback_url: &Url) -> Result<()> {
        if flow.canceled.load(Ordering::SeqCst) {
            return Err(Error::new("oauth_canceled", "登录已取消"));
        }
        if now().saturating_sub(flow.started) >= LOGIN_TIMEOUT {
            return Err(Error::new("oauth_timeout", "登录已超时，请重新发起"));
        }
        let code = validate_callback(&flow.callback, &flow.state, callback_url)?;
        let provider = flow.callback.path().trim_start_matches("/oauth/");
        let canceled = flow.canceled.clone();
        let result = flow
            .client
            .api(
                flow.client
                    .management(Method::GET, &format!("/api/oauth/{provider}"), None)
                    .query(&[("code", code.as_str()), ("state", flow.state.as_str())]),
            )
            .await?;
        let mut session = session_from_oauth(flow.client, flow.dialect, &result["data"])?;
        verify(&mut session).await?;
        if canceled.load(Ordering::SeqCst) {
            return Err(Error::new("oauth_canceled", "登录已取消"));
        }
        self.persist_session(&session)?;
        self.session = Some(session);
        self.last_error = None;
        Ok(())
    }

    /// Cancel only the matching native flow; late callbacks cannot revive a canceled session.
    pub fn cancel_login(&mut self, id: &str) {
        if self.pending.as_ref().is_some_and(|p| p.id == id) {
            self.pending
                .as_ref()
                .unwrap()
                .canceled
                .store(true, Ordering::SeqCst);
            self.pending = None;
        }
    }

    /// Record a timeout or failed native window creation without putting URL details in messages.
    pub fn fail_login(&mut self, id: &str, error: Error) {
        if self.pending.as_ref().is_some_and(|p| p.id == id) {
            let base = self.pending.take().unwrap().client.base;
            self.last_error = Some((base, error));
        }
    }

    /// Poll local authorization state; restored sessions are verified once before being reported usable.
    pub async fn status(&mut self, raw: &str) -> Result<LoginStatus> {
        let base = instance_url(raw)?;
        if let Some(flow) = &self.pending {
            if flow.client.base == base {
                if now().saturating_sub(flow.started) < LOGIN_TIMEOUT {
                    return Ok(LoginStatus {
                        base_url: base,
                        phase: "pending",
                        user: None,
                        login_id: Some(flow.id.clone()),
                        error: None,
                    });
                }
                let id = flow.id.clone();
                self.fail_login(&id, Error::new("oauth_timeout", "登录已超时，请重新发起"));
            }
        }
        if let Some((server, error)) = &self.last_error {
            if server == &base {
                return Ok(LoginStatus {
                    base_url: base,
                    phase: "error",
                    user: None,
                    login_id: None,
                    error: Some(error.clone()),
                });
            }
        }
        match self.ensure_session(&base).await {
            Ok(()) => Ok(LoginStatus {
                base_url: base,
                phase: "connected",
                user: self.session.as_ref().map(|s| s.user.clone()),
                login_id: None,
                error: None,
            }),
            Err(error) if error.code == "login_required" => Ok(LoginStatus {
                base_url: base,
                phase: "disconnected",
                user: None,
                login_id: None,
                error: None,
            }),
            Err(error) => Err(error),
        }
    }

    /// Restore either credential dialect and recheck it against the actual server account.
    async fn ensure_session(&mut self, base: &str) -> Result<()> {
        let mut restored = false;
        if self.session.as_ref().is_none_or(|s| s.client.base != base) {
            let raw = self.vault.get(base)?.ok_or_else(login_required)?;
            let stored: StoredSession = serde_json::from_str(&raw)
                .map_err(|_| Error::new("keychain", "保存的会话无法读取，请重新登录"))?;
            let saved = match stored {
                StoredSession::Current(saved) => saved,
                StoredSession::Legacy(old) => SavedSession {
                    base_url: old.base_url,
                    user: old.user,
                    expires_at: old.expires_at,
                    auth: SavedAuth::Cookie { cookie: old.cookie },
                },
            };
            if saved.base_url != base || saved.expires_at <= now() {
                return Err(login_required());
            }
            self.check(base).await?;
            let mut client = ApiClient::new(base)?;
            let auth = match saved.auth {
                SavedAuth::Cookie { cookie } => {
                    client.restore_cookie(&cookie, "session", "/")?;
                    SessionAuth::Cookie
                }
                SavedAuth::Bearer {
                    access_token,
                    access_expires_at,
                    refresh_cookie,
                    session_id,
                } => {
                    if access_token.is_empty() || session_id.is_empty() {
                        return Err(login_required());
                    }
                    client.restore_cookie(&refresh_cookie, "new_api_refresh", "/api/user/auth")?;
                    client.set_access_token(access_token);
                    SessionAuth::Bearer {
                        access_expires_at,
                        session_id,
                    }
                }
            };
            self.session = Some(Session {
                client,
                auth,
                user: saved.user,
                expires_at: saved.expires_at,
                verified_at: 0,
            });
            restored = true;
        }
        if self.session.as_ref().is_some_and(|s| s.expires_at <= now()) {
            self.session = None;
            return Err(login_required());
        }
        let (refreshed, ready) = ready_session(self.session.as_mut().unwrap()).await;
        // A refresh rotates the server cookie; commit it even if the follow-up identity check fails.
        if refreshed {
            self.persist_session(self.session.as_ref().unwrap())?;
        }
        match ready {
            Ok(()) => {
                if restored && !refreshed {
                    self.persist_session(self.session.as_ref().unwrap())?;
                }
                Ok(())
            }
            Err(error) => {
                if error.code == "login_required" {
                    self.session = None;
                    self.vault.remove(base)?;
                }
                Err(error)
            }
        }
    }

    /// Save only into an OS secret store; no fallback plaintext file is permitted.
    fn persist_session(&self, session: &Session) -> Result<()> {
        let auth = match &session.auth {
            SessionAuth::Cookie => SavedAuth::Cookie {
                cookie: session.client.session_cookie("session", "/")?,
            },
            SessionAuth::Bearer {
                access_expires_at,
                session_id,
            } => SavedAuth::Bearer {
                access_token: session
                    .client
                    .access_token()
                    .ok_or_else(login_required)?
                    .to_string(),
                access_expires_at: *access_expires_at,
                refresh_cookie: session
                    .client
                    .session_cookie("new_api_refresh", "/api/user/auth/refresh")?,
                session_id: session_id.clone(),
            },
        };
        let saved = SavedSession {
            base_url: session.client.base.clone(),
            user: session.user.clone(),
            expires_at: session.expires_at,
            auth,
        };
        let raw =
            serde_json::to_string(&saved).map_err(|_| Error::new("keychain", "会话序列化失败"))?;
        self.vault.set(&session.client.base, &raw)
    }

    /// Remove local authorization without deleting model keys or calling the shared PAT generator.
    pub fn disconnect(&mut self, raw: &str) -> Result<()> {
        let base = instance_url(raw)?;
        self.vault.remove(&base)?;
        if self.session.as_ref().is_some_and(|s| s.client.base == base) {
            self.session = None;
        }
        if self.pending.as_ref().is_some_and(|s| s.client.base == base) {
            self.pending = None;
        }
        self.last_error = None;
        Ok(())
    }

    /// Require a user identity match so a stale UI cannot create a key in a different account.
    async fn authenticated(&mut self, raw: &str, user_id: i64) -> Result<ApiClient> {
        let base = instance_url(raw)?;
        self.ensure_session(&base).await?;
        let session = self.session.as_ref().unwrap();
        if session.user.id != user_id {
            return Err(Error::new(
                "account_changed",
                "登录账号已改变，请刷新后重新选择模型",
            ));
        }
        Ok(session.client.clone())
    }

    /// Intersect allowed group models with protocol metadata; OpenAI models may be probed for Responses.
    pub async fn catalog(
        &mut self,
        raw: &str,
        user_id: i64,
        selected: Option<&str>,
    ) -> Result<Catalog> {
        let api = self.authenticated(raw, user_id).await?;
        let groups_response = api
            .api(api.management(Method::GET, "/api/user/self/groups", Some(user_id)))
            .await?;
        let object = groups_response["data"]
            .as_object()
            .ok_or_else(|| Error::new("response", "分组信息格式不兼容"))?;
        let groups: Vec<Group> = object
            .iter()
            .map(|(id, v)| Group {
                id: id.clone(),
                label: v["desc"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(id)
                    .to_string(),
            })
            .collect();
        let default = &self.session.as_ref().unwrap().user.group;
        let group = selected
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if object.contains_key(default) {
                    default.clone()
                } else {
                    groups.first().map(|g| g.id.clone()).unwrap_or_default()
                }
            });
        if !object.contains_key(&group) {
            return Err(Error::new(
                "group",
                "当前账号没有可用的所选分组，请刷新分组列表",
            ));
        }
        let available = api
            .api(
                api.management(Method::GET, "/api/user/models", Some(user_id))
                    .query(&[("group", &group)]),
            )
            .await?;
        let pricing = api
            .api(api.management(Method::GET, "/api/pricing", Some(user_id)))
            .await?;
        let names = available["data"]
            .as_array()
            .ok_or_else(|| Error::new("response", "用户模型列表格式不兼容"))?;
        let rows = pricing["data"]
            .as_array()
            .ok_or_else(|| Error::new("response", "模型协议信息格式不兼容"))?;
        let mut models = Vec::new();
        for name in names.iter().filter_map(Value::as_str) {
            let mut protocols = Vec::new();
            for row in rows
                .iter()
                .filter(|r| r["model_name"].as_str() == Some(name))
            {
                for kind in row["supported_endpoint_types"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    // New API advertises `openai` even when its Responses relay is enabled.
                    // Offer Codex as a candidate, then require a successful Responses probe before saving.
                    let candidates: &[Protocol] = match kind {
                        "openai" => &[Protocol::OpenaiChat, Protocol::OpenaiResponses],
                        "openai-response" => &[Protocol::OpenaiResponses],
                        "anthropic" => &[Protocol::AnthropicMessages],
                        _ => continue,
                    };
                    for &protocol in candidates {
                        if !protocols.contains(&protocol) {
                            protocols.push(protocol);
                        }
                    }
                }
            }
            if !protocols.is_empty() && !models.iter().any(|m: &Candidate| m.model_id == name) {
                models.push(Candidate {
                    model_id: name.into(),
                    protocols,
                });
            }
        }
        models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        if !names.is_empty() && models.is_empty() {
            return Err(Error::new(
                "protocol_metadata",
                "可用模型缺少可识别的协议元数据；已停止自动导入，请检查 New API 模型接口",
            ));
        }
        Ok(Catalog {
            groups,
            selected_group: group,
            models,
        })
    }

    /// Read the durable creation journal and fail closed on corruption instead of creating duplicates.
    fn journal(&self) -> Result<Journal> {
        let snapshot = files::Snapshot::read(&self.path).map_err(storage)?;
        let Some(bytes) = snapshot.bytes else {
            return Ok(Journal {
                version: 2,
                records: vec![],
            });
        };
        let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| {
            Error::new(
                "storage",
                "New API 恢复记录已损坏；请恢复记录后重试，未创建新密钥",
            )
        })?;
        if journal.version != 1 && journal.version != 2 {
            return Err(Error::new("storage", "New API 恢复记录版本不兼容"));
        }
        Ok(Journal {
            version: 2,
            ..journal
        })
    }

    /// Commit a private journal before any non-idempotent remote operation.
    fn save_journal(&self, journal: &Journal) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(journal)
            .map_err(|_| Error::new("storage", "无法编码 New API 恢复记录"))?;
        files::atomic_write(&self.path, &bytes).map_err(storage)
    }

    /// Create or recover one owned token, returning a stable model ID for an idempotent library save.
    pub async fn prepare_import(&mut self, request: ImportRequest) -> Result<PreparedImport> {
        let base = instance_url(&request.base_url)?;
        let mut model = ModelConfig {
            id: String::new(),
            name: request.name,
            protocol: request.protocol,
            base_url: api_base(&base, request.protocol),
            model_id: request.model_id,
            api_key: String::new(),
            supports_tool_call: request.supports_tool_call,
            supports_images: request.supports_images,
            context_window: request.context_window,
            reasoning_levels: request.reasoning_levels,
        };
        model.validate().map_err(|e| Error::new("model", e))?;
        if model.protocol == Protocol::OpenaiResponses && model.context_window.is_none() {
            return Err(Error::new("model", "请按实际模型能力填写 Codex 上下文窗口"));
        }
        self.check(&base).await?;
        let catalog = self
            .catalog(&base, request.user_id, Some(&request.group))
            .await?;
        if !catalog
            .models
            .iter()
            .any(|m| m.model_id == model.model_id && m.protocols.contains(&model.protocol))
        {
            return Err(Error::new(
                "model",
                "所选分组未声明支持该模型与协议，请刷新模型列表",
            ));
        }
        let api = self.authenticated(&base, request.user_id).await?;
        let desired_name = token_name(&self.session.as_ref().unwrap().user);
        let mut journal = self.journal()?;
        let index = journal
            .records
            .iter()
            .position(|r| r.base_url == base && r.user_id == request.user_id && r.unrestricted)
            .unwrap_or_else(|| {
                let models = journal
                    .records
                    .iter()
                    .filter(|r| {
                        r.base_url == base && r.user_id == request.user_id && !r.unrestricted
                    })
                    .flat_map(|r| {
                        r.models.iter().map(|m| LocalModel {
                            model_id: r.model_id.clone(),
                            protocol: m.protocol,
                            id: m.id.clone(),
                        })
                    })
                    .collect();
                journal.records.push(TokenRecord {
                    base_url: base.clone(),
                    user_id: request.user_id,
                    group: request.group.clone(),
                    model_id: String::new(),
                    unrestricted: true,
                    name: desired_name.clone(),
                    token_id: None,
                    prior_token_ids: None,
                    phase: CreationPhase::Prepared,
                    models,
                });
                journal.records.len() - 1
            });
        let mut record = journal.records[index].clone();
        let mut reused = record.phase != CreationPhase::Prepared;
        if record.phase == CreationPhase::Ready {
            let token = self.find_token(&api, &record).await?;
            let valid = token
                .as_ref()
                .is_some_and(|t| token_matches(t, &record) && token_active(t));
            if !valid {
                if !request.replace_invalid {
                    return Err(Error::new("token_invalid", "关联密钥已失效、被删除或限制被修改；确认后可创建新密钥，旧密钥不会被自动删除"));
                }
                record.name = desired_name.clone();
                record.token_id = None;
                record.prior_token_ids = None;
                record.phase = CreationPhase::Prepared;
                reused = false;
            }
        }
        if record.phase == CreationPhase::Submitted {
            match self.find_token(&api, &record).await? {
                Some(token) if token_matches(&token, &record) => {
                    record.token_id = token["id"].as_i64();
                    record.phase = CreationPhase::Ready;
                }
                Some(_) => {
                    return Err(Error::new(
                        "token_invalid",
                        "找到的令牌限制与创建记录不符，已停止恢复",
                    ))
                }
                None if request.restart_uncertain => {
                    record.name = desired_name;
                    record.prior_token_ids = None;
                    record.phase = CreationPhase::Prepared;
                    reused = false;
                }
                None => return Err(creation_uncertain()),
            }
        }
        if record.phase == CreationPhase::Prepared {
            // Names are human-readable and may repeat; persist existing IDs to distinguish this creation.
            record.prior_token_ids = Some(
                self.search_named_tokens(&api, &record)
                    .await?
                    .iter()
                    .filter_map(|token| token["id"].as_i64())
                    .collect(),
            );
            // Save 'submitted' first: a crash or lost response must never cause an automatic second POST.
            record.phase = CreationPhase::Submitted;
            journal.records[index] = record.clone();
            self.save_journal(&journal)?;
            let result = api
                .api(
                    api.management(Method::POST, "/api/token/", Some(record.user_id))
                        .json(&json!({
                            "name": record.name, "expired_time": -1, "unlimited_quota": true,
                            "remain_quota": 0,
                            "group": record.group, "allow_ips": "", "cross_group_retry": false
                        })),
                )
                .await;
            if let Err(error) = result {
                // Even a successful HTTP response may be lost after the database insert; reconcile first.
                if matches!(
                    error.code,
                    "api_rejected" | "forbidden" | "login_required" | "rate_limit"
                ) {
                    // Keep the submitted marker until a subsequent explicit retry has checked the server.
                    return Err(Error::new(
                        "creation_uncertain",
                        format!("{}。创建记录已保存，请先重新检查令牌列表。", error.message),
                    ));
                }
            }
            match self.find_token(&api, &record).await {
                Ok(Some(token)) if token_matches(&token, &record) => {
                    record.token_id = token["id"].as_i64();
                    record.phase = CreationPhase::Ready;
                }
                _ => return Err(creation_uncertain()),
            }
        }
        let id = record
            .token_id
            .filter(|i| *i > 0)
            .ok_or_else(creation_uncertain)?;
        journal.records[index] = record.clone();
        self.save_journal(&journal)?;
        let key_response = api
            .api(api.management(
                Method::POST,
                &format!("/api/token/{id}/key"),
                Some(record.user_id),
            ))
            .await?;
        model.api_key = normalize_full_key(&key_response["data"]["key"])?;
        model.api_key = check_key(&base, &model).await?;
        let binding = record
            .models
            .iter()
            .find(|m| m.protocol == model.protocol && m.model_id == model.model_id)
            .map(|m| m.id.clone())
            .unwrap_or_else(|| {
                let id = Uuid::new_v4().to_string();
                record.models.push(LocalModel {
                    model_id: model.model_id.clone(),
                    protocol: model.protocol,
                    id: id.clone(),
                });
                id
            });
        model.id = binding;
        model.validate().map_err(|e| Error::new("model", e))?;
        let siblings = record.models.iter().map(|m| m.id.clone()).collect();
        journal.records[index] = record;
        self.save_journal(&journal)?;
        Ok(PreparedImport {
            model,
            siblings,
            reused,
        })
    }

    /// Match a known ID or reconcile only new, policy-matching IDs after a named creation attempt.
    async fn find_token(&self, api: &ApiClient, record: &TokenRecord) -> Result<Option<Value>> {
        let matches: Vec<_> = self
            .search_named_tokens(api, record)
            .await?
            .into_iter()
            .filter(|token| {
                if let Some(id) = record.token_id {
                    return token["id"].as_i64() == Some(id);
                }
                match &record.prior_token_ids {
                    Some(prior) => {
                        token["id"].as_i64().is_some_and(|id| !prior.contains(&id))
                            && token_matches(token, record)
                    }
                    // Legacy UUID-named journal entries still recover with their original exact name.
                    None => true,
                }
            })
            .collect();
        if matches.len() > 1 {
            return Err(Error::new(
                "ambiguous_token",
                "存在多把符合本次创建条件的令牌，无法确认归属；请在 New API 中检查",
            ));
        }
        Ok(matches.into_iter().next())
    }

    /// Read all exact-name matches; identical display names across models must not imply identical keys.
    async fn search_named_tokens(
        &self,
        api: &ApiClient,
        record: &TokenRecord,
    ) -> Result<Vec<Value>> {
        let mut matches = Vec::new();
        for page in 1..=100 {
            let response = api
                .api(
                    api.management(Method::GET, "/api/token/search", Some(record.user_id))
                        .query(&[
                            ("keyword", record.name.clone()),
                            ("p", page.to_string()),
                            ("page_size", "100".into()),
                        ]),
                )
                .await?;
            let items = response["data"]["items"]
                .as_array()
                .ok_or_else(|| Error::new("response", "令牌搜索响应格式不兼容，已停止创建"))?;
            for token in items
                .iter()
                .filter(|t| t["name"].as_str() == Some(&record.name))
            {
                if token["id"].as_i64().is_none_or(|id| id <= 0) {
                    return Err(Error::new("response", "令牌搜索返回了无效 ID，已停止创建"));
                }
                matches.push(token.clone());
            }
            let total = response["data"]["total"]
                .as_u64()
                .ok_or_else(|| Error::new("response", "令牌搜索缺少分页总数，已停止创建"))?;
            if page * 100 >= total || items.is_empty() {
                return Ok(matches);
            }
        }
        Err(Error::new("response", "令牌搜索结果过多，已停止自动处理"))
    }

    /// Test only a model imported by this connector, without disclosing credentials to login pages.
    pub async fn test_model(&self, model: &ModelConfig) -> Result<String> {
        let journal = self.journal()?;
        let record = journal
            .records
            .iter()
            .find(|r| {
                r.models.iter().any(|m| {
                    m.id == model.id
                        && m.protocol == model.protocol
                        && (m.model_id == model.model_id
                            || (!r.unrestricted && r.model_id == model.model_id))
                }) && api_base(&r.base_url, model.protocol) == model.base_url
            })
            .ok_or_else(|| {
                Error::new(
                    "model",
                    "该配置已被修改或并非由 New API 导入，请重新导入后测试",
                )
            })?;
        test_inference(&record.base_url, model).await
    }
}

/// Treat returned keys as opaque credentials and reject only unusable or masked values.
fn normalize_full_key(value: &Value) -> Result<String> {
    let raw = value.as_str().unwrap_or_default();
    if raw.is_empty()
        || raw.len() > 4096
        || !raw.bytes().all(|byte| byte.is_ascii_graphic())
        || raw.contains('*')
    {
        return Err(Error::new(
            "key",
            "服务端未返回完整 API Key；请重试获取，已有密钥不会重复创建",
        ));
    }
    Ok(raw.to_string())
}

/// Validate a configured HTTPS endpoint while retaining query parameters for IdP authorization URLs.
fn https_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| Error::new("url", "请输入有效的 HTTPS 地址"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new("url", "仅支持不含账号和片段的 HTTPS 地址"));
    }
    Ok(url)
}

/// Normalize instance roots; path-based API endpoints are deliberately not interpreted as panel URLs.
pub fn instance_url(raw: &str) -> Result<String> {
    #[cfg(test)]
    if raw.starts_with("http://127.0.0.1:") {
        return Ok(raw.trim_end_matches('/').into());
    }
    let mut url = https_url(raw)?;
    if !["", "/"].contains(&url.path()) || url.query().is_some() {
        return Err(Error::new(
            "url",
            "请填写 New API 实例根地址，不含 /v1、路径或查询参数",
        ));
    }
    url.set_path("");
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Match only the exact registered callback, with one state and one authorization code.
pub fn validate_callback(expected: &Url, state: &str, received: &Url) -> Result<String> {
    if expected.origin() != received.origin()
        || expected.path() != received.path()
        || !received.username().is_empty()
        || received.password().is_some()
        || received.fragment().is_some()
    {
        return Err(Error::new("oauth", "OAuth 回调来源或路径不匹配"));
    }
    let states: Vec<_> = received
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .collect();
    if states.len() != 1 || states[0] != state {
        return Err(Error::new("oauth", "OAuth state 不匹配，请重新登录"));
    }
    if received.query_pairs().any(|(k, _)| k == "error") {
        return Err(Error::new("oauth_denied", "登录授权被取消或拒绝"));
    }
    let codes: Vec<_> = received
        .query_pairs()
        .filter(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .collect();
    if codes.len() != 1 || codes[0].is_empty() || codes[0].len() > 8192 {
        return Err(Error::new("oauth", "OAuth 授权码缺失或无效"));
    }
    Ok(codes[0].clone())
}

/// Convert advertised protocols to the native clients' existing base-URL conventions.
pub fn api_base(base: &str, protocol: Protocol) -> String {
    match protocol {
        Protocol::AnthropicMessages => base.into(),
        _ => format!("{base}/v1"),
    }
}

/// Parse only recognized OAuth results; a challenge must never be treated as a login.
fn session_from_oauth(
    mut client: ApiClient,
    dialect: LoginDialect,
    data: &Value,
) -> Result<Session> {
    let (user_value, auth, expires_at) = match dialect {
        LoginDialect::Cookie => {
            client.session_cookie("session", "/")?;
            (data.clone(), SessionAuth::Cookie, now() + 30 * 86400)
        }
        LoginDialect::Bearer => {
            let access = data["access_token"].as_str().ok_or_else(|| {
                if data["require_verification"].as_bool() == Some(true)
                    || (data["flow_token"].is_string() && data["methods"].is_array())
                    || data.get("challenge").is_some()
                    || data.get("verification_required").is_some()
                    || data.get("verification_id").is_some()
                {
                    Error::new(
                        "verification_required",
                        "New API 要求站内二次验证；当前自动接入无法继续，请在 New API 完成验证后重试",
                    )
                } else {
                    Error::new("oauth_contract", "OAuth 登录响应格式未知，已停止自动接入")
                }
            })?;
            let access_expires_at = data["access_expires_at"].as_u64().unwrap_or_default();
            let session_id = data["session"]["sid"].as_str().unwrap_or_default();
            let server_expires_at = data["session"]["expires_at"].as_u64().unwrap_or_default();
            if !data["token_type"]
                .as_str()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
                || access.is_empty()
                || access.len() > 8192
                || access
                    .bytes()
                    .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
                || access_expires_at <= now()
                || session_id.is_empty()
                || server_expires_at <= now()
            {
                return Err(Error::new(
                    "oauth_contract",
                    "OAuth 凭证格式未知，已停止自动接入",
                ));
            }
            client.session_cookie("new_api_refresh", "/api/user/auth/refresh")?;
            client.set_access_token(access.to_string());
            (
                data["user"].clone(),
                SessionAuth::Bearer {
                    access_expires_at,
                    session_id: session_id.to_string(),
                },
                server_expires_at.min(now() + 30 * 86400),
            )
        }
    };
    let user: User = serde_json::from_value(user_value).map_err(|_| {
        Error::new(
            "oauth_contract",
            "OAuth 未返回可识别的用户信息，已停止自动接入",
        )
    })?;
    if user.id <= 0 {
        return Err(Error::new("oauth_contract", "OAuth 返回的用户 ID 无效"));
    }
    Ok(Session {
        client,
        auth,
        user,
        expires_at,
        verified_at: 0,
    })
}

/// Refresh an expiring bearer once, then verify the same user before returning it to the UI.
async fn ready_session(session: &mut Session) -> (bool, Result<()>) {
    let due = matches!(
        session.auth,
        SessionAuth::Bearer {
            access_expires_at,
            ..
        } if access_expires_at <= now() + 60
    );
    let mut refreshed = false;
    if due {
        if let Err(error) = refresh_session(session).await {
            return (false, Err(error));
        }
        refreshed = true;
    }
    if refreshed || now().saturating_sub(session.verified_at) >= 60 {
        match verify(session).await {
            Ok(()) => {}
            Err(error)
                if error.code == "login_required"
                    && !refreshed
                    && matches!(session.auth, SessionAuth::Bearer { .. }) =>
            {
                if let Err(error) = refresh_session(session).await {
                    return (false, Err(error));
                }
                refreshed = true;
                if let Err(error) = verify(session).await {
                    return (true, Err(error));
                }
            }
            Err(error) => return (refreshed, Err(error)),
        }
    }
    (refreshed, Ok(()))
}

/// Rotate the refresh cookie through the same-origin endpoint and retain the old local cap.
async fn refresh_session(session: &mut Session) -> Result<()> {
    let sid = match &session.auth {
        SessionAuth::Bearer { session_id, .. } => session_id.clone(),
        SessionAuth::Cookie => return Err(login_required()),
    };
    let result = session
        .client
        .api(
            session
                .client
                .client
                .post(format!("{}/api/user/auth/refresh", session.client.base))
                .header("Origin", &session.client.base)
                .header("X-Auth-Session", &sid),
        )
        .await
        .map_err(|error| {
            if matches!(error.code, "api_rejected" | "login_required") {
                login_required()
            } else {
                error
            }
        })?;
    let data = &result["data"];
    let token = data["access_token"].as_str().unwrap_or_default();
    let access_expires_at = data["access_expires_at"].as_u64().unwrap_or_default();
    let returned_sid = data["session"]["sid"].as_str().unwrap_or_default();
    let server_expires_at = data["session"]["expires_at"].as_u64().unwrap_or_default();
    let user: User = serde_json::from_value(data["user"].clone()).map_err(|_| {
        Error::new(
            "auth_contract",
            "刷新会话的用户信息格式未知，已停止自动接入",
        )
    })?;
    if !data["token_type"]
        .as_str()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
        || token.is_empty()
        || token.len() > 8192
        || token
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || access_expires_at <= now()
        || returned_sid != sid
        || server_expires_at <= now()
        || user.id != session.user.id
    {
        return Err(Error::new(
            "auth_contract",
            "刷新会话的凭证格式未知，已停止自动接入",
        ));
    }
    session
        .client
        .session_cookie("new_api_refresh", "/api/user/auth/refresh")?;
    session.client.set_access_token(token.to_string());
    session.auth = SessionAuth::Bearer {
        access_expires_at,
        session_id: sid,
    };
    session.expires_at = session.expires_at.min(server_expires_at);
    session.user = user;
    session.verified_at = 0;
    Ok(())
}

/// Confirm identity against New API rather than trusting a cached username or UI-supplied user ID.
async fn verify(session: &mut Session) -> Result<()> {
    let response = session
        .client
        .api(
            session
                .client
                .management(Method::GET, "/api/user/self", Some(session.user.id)),
        )
        .await
        .map_err(|e| {
            if e.code == "api_rejected" {
                login_required()
            } else {
                e
            }
        })?;
    let user: User = serde_json::from_value(response["data"].clone())
        .map_err(|_| Error::new("response", "用户信息格式不兼容"))?;
    if user.id != session.user.id {
        return Err(login_required());
    }
    session.user = user;
    session.verified_at = now();
    Ok(())
}

/// Check ownership and security settings before reusing a shared or legacy token.
fn token_matches(token: &Value, record: &TokenRecord) -> bool {
    token["id"].as_i64().is_some_and(|id| id > 0)
        && token["user_id"].as_i64() == Some(record.user_id)
        && token["name"].as_str() == Some(&record.name)
        && token["group"].as_str() == Some(&record.group)
        && if record.unrestricted {
            token["model_limits_enabled"].as_bool() == Some(false)
                || token.get("model_limits_enabled").is_none()
        } else {
            token["model_limits_enabled"].as_bool() == Some(true)
                && token["model_limits"].as_str() == Some(&record.model_id)
        }
        && token["unlimited_quota"].as_bool() == Some(true)
        && token["expired_time"].as_i64() == Some(-1)
        && token["allow_ips"].as_str().unwrap_or_default().is_empty()
        && !token["cross_group_retry"].as_bool().unwrap_or(false)
}

/// Reject disabled, expired or exhausted tokens before trying to retrieve their full keys.
fn token_active(token: &Value) -> bool {
    token["status"].as_i64() == Some(1)
        && token["expired_time"]
            .as_i64()
            .is_some_and(|e| e == -1 || e > now() as i64)
        && (token["unlimited_quota"].as_bool() == Some(true)
            || token["remain_quota"].as_i64().is_some_and(|q| q > 0))
}

/// Verify the server's key as returned, trying the known prefix only on auth failure.
async fn check_key(base: &str, model: &ModelConfig) -> Result<String> {
    let raw = model.api_key.as_str();
    match check_key_candidate(base, raw, &model.model_id).await {
        Ok(()) => Ok(raw.to_string()),
        Err(error) if error.code == "login_required" && !raw.starts_with("sk-") => {
            let prefixed = format!("sk-{raw}");
            check_key_candidate(base, &prefixed, &model.model_id)
                .await
                .map_err(token_auth_error)?;
            Ok(prefixed)
        }
        Err(error) => Err(token_auth_error(error)),
    }
}

/// Check one key candidate against the read-only model listing before local persistence.
async fn check_key_candidate(base: &str, key: &str, model_id: &str) -> Result<()> {
    let api = ApiClient::new(base)?;
    let response = read_json(api.client.get(format!("{base}/v1/models")).bearer_auth(key)).await?;
    let rows = response["data"]
        .as_array()
        .ok_or_else(|| Error::new("response", "模型密钥校验响应格式未知，已停止保存"))?;
    if !rows.iter().any(|row| row["id"].as_str() == Some(model_id)) {
        return Err(Error::new(
            "group_access",
            "共享密钥的创建分组无法访问所选模型；请在 New API 调整该密钥的分组权限后重试，应用不会另建密钥",
        ));
    }
    Ok(())
}

/// Report key rejection without reflecting any remote response or credential.
fn token_auth_error(error: Error) -> Error {
    if error.code == "login_required" {
        Error::new(
            "token_unusable",
            "API Key 未通过鉴权；已有创建记录已保留，可重试或在 New API 检查",
        )
    } else {
        error
    }
}

/// Send one explicitly requested, small inference and validate the native protocol response shape.
async fn test_inference(base: &str, model: &ModelConfig) -> Result<String> {
    let api = ApiClient::new(base)?;
    let (path, body) = match model.protocol {
        Protocol::OpenaiChat => (
            "/v1/chat/completions",
            json!({"model":model.model_id,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":64,"stream":false}),
        ),
        Protocol::OpenaiResponses => (
            "/v1/responses",
            json!({"model":model.model_id,"input":"Reply with OK.","max_output_tokens":64,"stream":false}),
        ),
        Protocol::AnthropicMessages => (
            "/v1/messages",
            json!({"model":model.model_id,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":64,"stream":false}),
        ),
    };
    let mut request = api.client.post(format!("{base}{path}")).json(&body);
    request = if model.protocol == Protocol::AnthropicMessages {
        request
            .header("x-api-key", &model.api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(&model.api_key)
    };
    let response = read_json(request).await?;
    let valid = response.get("error").is_none()
        && match model.protocol {
            Protocol::OpenaiChat => response["choices"]
                .as_array()
                .is_some_and(|a| !a.is_empty()),
            Protocol::OpenaiResponses => {
                response["object"].as_str() == Some("response")
                    && response["output"].is_array()
                    && matches!(
                        response["status"].as_str(),
                        Some("completed" | "incomplete")
                    )
            }
            Protocol::AnthropicMessages => {
                response["type"].as_str() == Some("message") && response["content"].is_array()
            }
        };
    if !valid {
        return Err(Error::new(
            "inference",
            "未收到所选协议的有效模型响应，请检查模型和上游渠道",
        ));
    }
    Ok("调用已验证：收到所选协议的模型响应。本次测试不验证上下文窗口、工具调用或图像能力。".into())
}

/// Use the verified OAuth display name's lowercase pinyin with a stable suffix, within the 50-byte limit.
fn token_name(user: &User) -> String {
    for name in [&user.display_name, &user.username] {
        let mut spelling = String::new();
        for character in name.trim().chars() {
            if let Some(pinyin) = character.to_pinyin() {
                spelling.extend(pinyin.plain().chars().filter_map(|letter| match letter {
                    'ü' => Some('v'),
                    'ê' => Some('e'),
                    c if c.is_ascii_alphanumeric() => Some(c),
                    _ => None,
                }));
            } else if character.is_ascii_alphanumeric() {
                spelling.push(character.to_ascii_lowercase());
            }
        }
        if !spelling.is_empty() {
            spelling.truncate(spelling.len().min(47));
            return format!("{spelling}-ps");
        }
    }
    format!("user{}-ps", user.id)
}
/// Read wall-clock time for cookie retention, login expiry and remote token metadata.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
/// Provide one stable UI error for missing or expired login sessions.
fn login_required() -> Error {
    Error::new("login_required", "请先登录 New API")
}
/// Require reconciliation or explicit user choice when a non-idempotent request has uncertain results.
fn creation_uncertain() -> Error {
    Error::new(
        "creation_uncertain",
        "密钥创建结果尚未确认。请先重新检查；若确认 New API 没有该密钥，可勾选允许重新创建。",
    )
}
/// Convert local persistence failures without including serialized model or credential contents.
fn storage(_error: String) -> Error {
    Error::new(
        "storage",
        "本地 New API 记录保存或读取失败；请检查目录权限和磁盘空间后重试",
    )
}
