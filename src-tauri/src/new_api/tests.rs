use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tempfile::TempDir;
use wiremock::{
    matchers::{body_partial_json, header, method, path, path_regex},
    Mock, MockServer, Request, ResponseTemplate,
};

#[derive(Clone, Default)]
struct MemoryVault(Arc<Mutex<HashMap<String, String>>>);

impl Vault for MemoryVault {
    /// Return test secrets without touching the real macOS keychain.
    fn get(&self, account: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    /// Store credentials inside this test only.
    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }
    /// Emulate local disconnection.
    fn remove(&self, account: &str) -> Result<()> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

struct Fixture {
    server: MockServer,
    dir: TempDir,
    connector: NewApi,
    tokens: Arc<Mutex<Vec<Value>>>,
}

/// Keep key format opaque while rejecting masks and control characters.
#[test]
fn full_key_accepts_opaque_formats_and_rejects_masks() {
    let raw = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
    assert_eq!(normalize_full_key(&json!(raw)).unwrap(), raw);
    assert_eq!(
        normalize_full_key(&json!(format!("sk-{raw}"))).unwrap(),
        format!("sk-{raw}")
    );
    assert_eq!(
        normalize_full_key(&json!("opaque-v2.key_+")).unwrap(),
        "opaque-v2.key_+"
    );
    for invalid in [
        json!(null),
        json!(""),
        json!("sk-***masked***"),
        json!(format!("{raw}\n")),
    ] {
        assert_eq!(normalize_full_key(&invalid).unwrap_err().code, "key");
    }
}

/// Provide a fully local management/relay server; test code never creates real credentials.
async fn fixture() -> Fixture {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut connector = NewApi::new(dir.path().into(), Box::<MemoryVault>::default());
    let client = ApiClient::new(&server.uri()).unwrap();
    connector.session = Some(Session {
        client,
        auth: SessionAuth::Cookie,
        user: user(),
        expires_at: now() + 86400,
        verified_at: now(),
    });
    Mock::given(method("GET")).and(path("/api/status")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{
        "version":"v1.0.0-rc.21","server_address":server.uri(),"custom_oauth_providers":[{"name":"Keycloak","slug":"keycloak","client_id":"public-client","authorization_endpoint":"https://idp.example/authorize","scopes":"openid profile email"}]
    }}))).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/user/self/groups"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":true,"data":{"staff":{"desc":"员工组"}}})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/user/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"success":true,"data":["model-one","responses-only","no-metadata"]}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/api/pricing")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":[
        {"model_name":"model-one","supported_endpoint_types":["openai","anthropic","unknown"]},
        {"model_name":"responses-only","supported_endpoint_types":["openai-response"]},
        {"model_name":"not-authorized","supported_endpoint_types":["openai"]}
    ]}))).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header(
            "Authorization",
            "Bearer sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"data":[{"id":"model-one"},{"id":"responses-only"}]})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(401))
        .with_priority(10)
        .mount(&server)
        .await;
    let tokens = Arc::new(Mutex::new(Vec::<Value>::new()));
    let search_tokens = tokens.clone();
    Mock::given(method("GET"))
        .and(path("/api/token/search"))
        .respond_with(move |request: &Request| {
            let keyword = request
                .url
                .query_pairs()
                .find(|(k, _)| k == "keyword")
                .unwrap()
                .1
                .into_owned();
            let items: Vec<_> = search_tokens
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["name"].as_str() == Some(&keyword))
                .cloned()
                .collect();
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":true,"data":{"items":items,"total":items.len()}}))
        })
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/api/token/[1-9][0-9]*/key$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":true,"data":{"key":"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL"}})),
        )
        .mount(&server)
        .await;
    Fixture {
        server,
        dir,
        connector,
        tokens,
    }
}

/// Construct one stable fixture account with a non-default group.
fn user() -> User {
    User {
        id: 77,
        username: "fixture".into(),
        display_name: "Test user".into(),
        group: "staff".into(),
    }
}

/// Create a normal import request with the user-approved token defaults.
fn request(base: &str) -> ImportRequest {
    ImportRequest {
        base_url: base.into(),
        user_id: 77,
        group: "staff".into(),
        model_id: "model-one".into(),
        protocol: Protocol::OpenaiChat,
        name: "测试模型".into(),
        supports_tool_call: true,
        supports_images: false,
        context_window: None,
        reasoning_levels: vec![],
        replace_invalid: false,
        restart_uncertain: false,
    }
}

/// Emulate an insert that can succeed even when its HTTP response fails.
async fn mount_create(fixture: &Fixture, response_status: u16, expected: u64) {
    let tokens = fixture.tokens.clone();
    let user_id = fixture.connector.session.as_ref().unwrap().user.id;
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .and(header("New-Api-User", user_id.to_string().as_str()))
        .and(body_partial_json(
            json!({"expired_time":-1,"unlimited_quota":true,"group":"staff"}),
        ))
        .respond_with(move |request: &Request| {
            let mut token: Value = request.body_json().unwrap();
            assert!(token.get("model_limits_enabled").is_none());
            assert!(token.get("model_limits").is_none());
            let mut records = tokens.lock().unwrap();
            token["id"] = json!(
                records
                    .iter()
                    .filter_map(|t| t["id"].as_i64())
                    .max()
                    .unwrap_or(0)
                    + 1
            );
            token["user_id"] = json!(user_id);
            token["status"] = json!(1);
            token["key"] = json!("sk-***masked***");
            records.push(token);
            ResponseTemplate::new(response_status).set_body_json(json!({"success":true}))
        })
        .expect(expected)
        .mount(&fixture.server)
        .await;
}

/// URL and callback validation must reject credentials, non-HTTPS URLs, duplicate state and replay inputs.
#[test]
fn validates_urls_callbacks_and_native_base_conventions() {
    assert_eq!(
        instance_url(" https://new-api.example/ ").unwrap(),
        "https://new-api.example"
    );
    for raw in [
        "http://example.com",
        "https://u:p@example.com",
        "https://example.com/v1",
        "https://example.com?key=secret",
        "https://example.com/#secret",
    ] {
        assert!(instance_url(raw).is_err());
    }
    let expected = Url::parse("https://new-api.example/oauth/keycloak").unwrap();
    let good = Url::parse(
        "https://new-api.example/oauth/keycloak?state=random&code=secret&session_state=x",
    )
    .unwrap();
    assert_eq!(
        validate_callback(&expected, "random", &good).unwrap(),
        "secret"
    );
    for raw in [
        "https://evil.example/oauth/keycloak?state=random&code=secret",
        "https://new-api.example/oauth/other?state=random&code=secret",
        "https://new-api.example/oauth/keycloak?state=random&state=random&code=secret",
        "https://new-api.example/oauth/keycloak?state=wrong&code=secret",
        "https://new-api.example/oauth/keycloak?state=random&code=a&code=b",
        "https://new-api.example/oauth/keycloak?state=random&error=denied",
    ] {
        assert!(validate_callback(&expected, "random", &Url::parse(raw).unwrap()).is_err());
    }
    assert_eq!(
        api_base("https://site", Protocol::AnthropicMessages),
        "https://site"
    );
    assert_eq!(
        api_base("https://site", Protocol::OpenaiResponses),
        "https://site/v1"
    );
    assert!(token_name(&user()).len() <= 50);
}

/// OAuth names become lowercase pinyin, with safe fallbacks and an intact suffix at the API limit.
#[test]
fn token_names_use_oauth_name_pinyin() {
    let mut account = user();
    account.display_name = " 赵斌 ".into();
    assert_eq!(token_name(&account), "zhaobin-ps");
    account.display_name = "Zhao Bin".into();
    assert_eq!(token_name(&account), "zhaobin-ps");
    account.display_name = "吕明".into();
    assert_eq!(token_name(&account), "lvming-ps");
    account.display_name = String::new();
    assert_eq!(token_name(&account), "fixture-ps");
    account.display_name = "张".repeat(40);
    assert!(token_name(&account).len() <= 50);
    assert!(token_name(&account).ends_with("-ps"));
    account.display_name = "吕".repeat(40);
    assert_eq!(token_name(&account).len(), 50);
    account.display_name = "☀️".into();
    account.username.clear();
    assert_eq!(token_name(&account), "user77-ps");
}

/// Identical human-readable names must preserve each model's ID and ignore pre-existing unrelated keys.
#[tokio::test]
async fn same_name_tokens_are_distinguished_by_creation_snapshot_and_id() {
    let mut f = fixture().await;
    f.connector.session.as_mut().unwrap().user.display_name = "赵斌".into();
    f.tokens.lock().unwrap().push(json!({"id":99,"user_id":77,"name":"zhaobin-ps","status":1,"group":"staff","model_limits_enabled":true,"model_limits":"model-one","expired_time":-1,"unlimited_quota":true}));
    mount_create(&f, 200, 2).await;
    let first = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert_eq!(
        f.connector.journal().unwrap().records[0].token_id,
        Some(100)
    );
    let mut second = request(&f.server.uri());
    second.model_id = "responses-only".into();
    second.protocol = Protocol::OpenaiResponses;
    second.context_window = Some(128000);
    f.connector.prepare_import(second).await.unwrap();
    assert_eq!(f.connector.journal().unwrap().records.len(), 1);
    assert_eq!(
        f.connector.journal().unwrap().records[0].token_id,
        Some(100)
    );
    let repeated = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert!(repeated.reused);
    assert_eq!(repeated.model.id, first.model.id);
    f.tokens.lock().unwrap()[1]["status"] = json!(2);
    let mut replacement = request(&f.server.uri());
    replacement.replace_invalid = true;
    f.connector.prepare_import(replacement).await.unwrap();
    assert_eq!(
        f.connector.journal().unwrap().records[0].token_id,
        Some(101)
    );
    assert!(f
        .tokens
        .lock()
        .unwrap()
        .iter()
        .all(|t| t["name"] == "zhaobin-ps"));
}

/// The picker must exclude inaccessible models and models with no compatible protocol metadata.
#[tokio::test]
async fn catalog_intersects_permissions_and_protocols() {
    let mut f = fixture().await;
    let catalog = f
        .connector
        .catalog(&f.server.uri(), 77, None)
        .await
        .unwrap();
    assert_eq!(catalog.selected_group, "staff");
    assert_eq!(catalog.models.len(), 2);
    assert_eq!(
        catalog.models[0].protocols,
        vec![
            Protocol::OpenaiChat,
            Protocol::OpenaiResponses,
            Protocol::AnthropicMessages,
        ]
    );
    assert!(f
        .connector
        .catalog(&f.server.uri(), 77, Some("forbidden"))
        .await
        .is_err());
    assert_eq!(
        f.connector
            .catalog(&f.server.uri(), 88, None)
            .await
            .err()
            .unwrap()
            .code,
        "account_changed"
    );
}

/// A catalog with no recognizable protocol metadata must explain why import is blocked.
#[tokio::test]
async fn catalog_rejects_missing_protocol_metadata() {
    let mut f = fixture().await;
    Mock::given(method("GET"))
        .and(path("/api/pricing"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":[]})))
        .with_priority(1)
        .mount(&f.server)
        .await;
    assert_eq!(
        f.connector
            .catalog(&f.server.uri(), 77, None)
            .await
            .err()
            .unwrap()
            .code,
        "protocol_metadata"
    );
}

/// Both a repeat import and another protocol must reuse one token and stable library identities.
#[tokio::test]
async fn creates_reads_full_key_and_reuses_across_protocols() {
    let mut f = fixture().await;
    mount_create(&f, 200, 1).await;
    let first = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert!(!first.reused);
    assert_eq!(
        first.model.api_key,
        "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL"
    );
    let again = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert!(again.reused);
    assert_eq!(first.model.id, again.model.id);
    let mut anthropic = request(&f.server.uri());
    anthropic.protocol = Protocol::AnthropicMessages;
    let other = f.connector.prepare_import(anthropic).await.unwrap();
    assert!(other.reused);
    assert_eq!(other.model.base_url, f.server.uri());
    assert_ne!(other.model.id, first.model.id);
    assert_eq!(other.siblings.len(), 2);
    Mock::given(method("GET"))
        .and(path("/api/user/self/groups"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{"staff":{"desc":"员工组"},"alternate":{"desc":"其他组"}}})))
        .with_priority(1)
        .mount(&f.server).await;
    let mut second_model = request(&f.server.uri());
    second_model.group = "alternate".into();
    second_model.model_id = "responses-only".into();
    second_model.protocol = Protocol::OpenaiResponses;
    second_model.context_window = Some(128000);
    let second = f.connector.prepare_import(second_model).await.unwrap();
    assert!(second.reused);
    assert_eq!(second.siblings.len(), 3);
    assert_eq!(f.tokens.lock().unwrap().len(), 1);
    assert_eq!(f.connector.journal().unwrap().records[0].group, "staff");
    let journal = std::fs::read_to_string(f.dir.path().join("new-api.json")).unwrap();
    assert!(!journal.contains("sk-test-key"));
    assert!(!journal.contains("session="));
    let requests = f.server.received_requests().await.unwrap();
    assert!(requests.iter().all(|r| r.url.path() != "/api/user/token"));
    assert!(requests
        .iter()
        .filter(|r| r.url.path() == "/v1/models")
        .all(|r| !r.headers.contains_key("cookie") && !r.headers.contains_key("new-api-user")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(f.dir.path().join("new-api.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

/// A version-one restricted-token journal migrates model identities to one unrestricted account token.
#[tokio::test]
async fn migrates_legacy_models_without_deleting_remote_tokens() {
    let mut f = fixture().await;
    let old_id = Uuid::new_v4().to_string();
    let old = json!({"version":1,"records":[{"base_url":f.server.uri(),"user_id":77,"group":"staff","model_id":"model-one","name":"legacy-ps","token_id":42,"phase":"ready","models":[{"protocol":"openai-chat","id":old_id}]}]});
    std::fs::write(
        f.dir.path().join("new-api.json"),
        serde_json::to_vec(&old).unwrap(),
    )
    .unwrap();
    f.tokens.lock().unwrap().push(json!({"id":42,"user_id":77,"name":"legacy-ps","status":1,"group":"staff","model_limits_enabled":true,"model_limits":"model-one","expired_time":-1,"unlimited_quota":true}));
    mount_create(&f, 200, 1).await;
    let mut next = request(&f.server.uri());
    next.model_id = "responses-only".into();
    next.protocol = Protocol::OpenaiResponses;
    next.context_window = Some(128000);
    let migrated = f.connector.prepare_import(next).await.unwrap();
    assert!(!migrated.reused);
    assert!(migrated.siblings.contains(&old_id));
    assert!(f.tokens.lock().unwrap().iter().any(|t| t["id"] == 42));
    let journal = f.connector.journal().unwrap();
    assert_eq!(journal.version, 2);
    assert_eq!(journal.records.len(), 2);
    assert!(journal.records[1].unrestricted);
    assert_eq!(journal.records[1].models[0].model_id, "model-one");
}

/// A shared token cannot silently create another token when its original group lacks the requested model.
#[tokio::test]
async fn shared_token_with_missing_model_stops_without_second_creation() {
    let mut f = fixture().await;
    mount_create(&f, 200, 1).await;
    f.connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"data":[{"id":"model-one"}]})),
        )
        .with_priority(1)
        .mount(&f.server)
        .await;
    let mut next = request(&f.server.uri());
    next.model_id = "responses-only".into();
    next.protocol = Protocol::OpenaiResponses;
    next.context_window = Some(128000);
    assert_eq!(
        f.connector.prepare_import(next).await.err().unwrap().code,
        "group_access"
    );
    assert_eq!(f.tokens.lock().unwrap().len(), 1);
}

/// Account and instance boundaries each require an independent shared token.
#[tokio::test]
async fn separates_shared_tokens_by_account_and_instance() {
    let mut first = fixture().await;
    mount_create(&first, 200, 1).await;
    first
        .connector
        .prepare_import(request(&first.server.uri()))
        .await
        .unwrap();
    first.connector.session.as_mut().unwrap().user.id = 88;
    mount_create(&first, 200, 1).await;
    let mut account_request = request(&first.server.uri());
    account_request.user_id = 88;
    first
        .connector
        .prepare_import(account_request)
        .await
        .unwrap();
    assert_eq!(first.connector.journal().unwrap().records.len(), 2);
    assert_eq!(first.tokens.lock().unwrap().len(), 2);
    let mut second = fixture().await;
    second.connector.path = first.dir.path().join("new-api.json");
    mount_create(&second, 200, 1).await;
    second
        .connector
        .prepare_import(request(&second.server.uri()))
        .await
        .unwrap();
    assert_eq!(second.connector.journal().unwrap().records.len(), 3);
    assert_eq!(second.tokens.lock().unwrap().len(), 1);
}

/// A server-side insert followed by an HTTP failure must be recovered without a second POST.
#[tokio::test]
async fn recovers_insert_when_create_response_is_lost() {
    let mut f = fixture().await;
    mount_create(&f, 500, 1).await;
    let saved = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert_eq!(
        saved.model.api_key,
        "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL"
    );
    f.connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
}

/// An unknown insert result remains recoverable across restarts and never blindly creates again.
#[tokio::test]
async fn uncertainty_survives_restart_without_duplicate_creation() {
    let mut f = fixture().await;
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&f.server)
        .await;
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "creation_uncertain"
    );
    let session = f.connector.session.take();
    let mut restarted = NewApi::new(f.dir.path().into(), Box::<MemoryVault>::default());
    restarted.session = session;
    assert_eq!(
        restarted
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "creation_uncertain"
    );
}

/// A later search must recover an uncertain insertion using its durable exact name.
#[tokio::test]
async fn resumes_pending_creation_after_server_becomes_visible() {
    let mut f = fixture().await;
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&f.server)
        .await;
    let _ = f.connector.prepare_import(request(&f.server.uri())).await;
    let journal = f.connector.journal().unwrap();
    let r = &journal.records[0];
    f.tokens.lock().unwrap().push(json!({"id":1,"user_id":77,"name":r.name,"status":1,"group":"staff","expired_time":-1,"unlimited_quota":true}));
    let result = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert!(result.reused);
}

/// Reconciliation must stop if two new keys have the same name and identical model restrictions.
#[tokio::test]
async fn uncertain_same_name_creation_rejects_multiple_new_candidates() {
    let mut f = fixture().await;
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&f.server)
        .await;
    let _ = f.connector.prepare_import(request(&f.server.uri())).await;
    let record = &f.connector.journal().unwrap().records[0];
    for id in [1, 2] {
        f.tokens.lock().unwrap().push(json!({"id":id,"user_id":77,"name":record.name,"status":1,"group":"staff","expired_time":-1,"unlimited_quota":true}));
    }
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "ambiguous_token"
    );
}

/// A journal from the UUID naming version can still recover a pending token without creating a replacement.
#[tokio::test]
async fn legacy_name_journal_without_snapshot_still_recovers() {
    let mut f = fixture().await;
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&f.server)
        .await;
    let _ = f.connector.prepare_import(request(&f.server.uri())).await;
    let name = "power-switch-00000000-0000-4000-8000-000000000001";
    let mut journal = serde_json::to_value(f.connector.journal().unwrap()).unwrap();
    journal["records"][0]["name"] = json!(name);
    journal["records"][0]
        .as_object_mut()
        .unwrap()
        .remove("prior_token_ids");
    std::fs::write(
        f.dir.path().join("new-api.json"),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    f.tokens.lock().unwrap().push(json!({"id":1,"user_id":77,"name":name,"status":1,"group":"staff","expired_time":-1,"unlimited_quota":true}));
    assert!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .unwrap()
            .reused
    );
    assert_eq!(f.tokens.lock().unwrap().len(), 1);
}

/// Changed remote restrictions require explicit replacement; callers cannot silently broaden access.
#[tokio::test]
async fn rejects_modified_or_disabled_tokens_and_ambiguous_names() {
    let mut f = fixture().await;
    mount_create(&f, 200, 1).await;
    f.connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    f.tokens.lock().unwrap()[0]["model_limits_enabled"] = json!(true);
    f.tokens.lock().unwrap()[0]["model_limits"] = json!("model-one,another-model");
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "token_invalid"
    );
    f.tokens.lock().unwrap()[0]["model_limits_enabled"] = json!(false);
    f.tokens.lock().unwrap()[0]["status"] = json!(2);
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "token_invalid"
    );
    let duplicate = f.tokens.lock().unwrap()[0].clone();
    f.tokens.lock().unwrap().push(duplicate);
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "ambiguous_token"
    );
}

/// Codex capabilities and protocol mismatches are rejected before remote token creation.
#[tokio::test]
async fn rejects_invalid_model_config_before_creating() {
    let mut f = fixture().await;
    let mut req = request(&f.server.uri());
    req.protocol = Protocol::OpenaiResponses;
    assert_eq!(
        f.connector.prepare_import(req).await.err().unwrap().code,
        "model"
    );
    let mut req = request(&f.server.uri());
    req.protocol = Protocol::OpenaiResponses;
    req.context_window = Some(128000);
    req.model_id = "no-metadata".into();
    assert_eq!(
        f.connector.prepare_import(req).await.err().unwrap().code,
        "model"
    );
    assert!(f
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|r| r.url.path() != "/api/token/"));
}

/// New API business errors must not be mistaken for success or reflected with their secret payloads.
#[tokio::test]
async fn checks_business_success_and_redacts_error_bodies() {
    let server = MockServer::start().await;
    Mock::given(path("/failure"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":false,"message":"secret-token-in-response"})),
        )
        .mount(&server)
        .await;
    let api = ApiClient::new(&server.uri()).unwrap();
    let error = api
        .api(api.management(Method::GET, "/failure", None))
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "api_rejected");
    assert!(!error.message.contains("secret-token"));
    Mock::given(path("/redirect"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/failure", server.uri())),
        )
        .mount(&server)
        .await;
    assert_eq!(
        api.api(api.management(Method::GET, "/redirect", None))
            .await
            .err()
            .unwrap()
            .code,
        "redirect"
    );
}

/// Cancellation and expiry consume native flows without ever calling the OAuth exchange endpoint.
#[tokio::test]
async fn canceled_timed_out_and_replayed_logins_cannot_complete() {
    let mut f = fixture().await;
    Mock::given(method("GET"))
        .and(path("/api/oauth/state"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":"state-nonce"})),
        )
        .mount(&f.server)
        .await;
    let flow = f.connector.start_login(&f.server.uri()).await.unwrap();
    assert_eq!(
        flow.url
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .unwrap()
            .1,
        format!("{}/oauth/keycloak", f.server.uri())
    );
    f.connector.cancel_login(&flow.id);
    let mut callback = flow.callback;
    callback.set_query(Some("state=state-nonce&code=one-time-code"));
    assert!(f.connector.finish_login(&flow.id, &callback).await.is_err());
    let next = f.connector.start_login(&f.server.uri()).await.unwrap();
    f.connector.pending.as_mut().unwrap().started = now() - LOGIN_TIMEOUT;
    assert_eq!(
        f.connector
            .finish_login(&next.id, &callback)
            .await
            .err()
            .unwrap()
            .code,
        "oauth_timeout"
    );
    assert!(f.connector.finish_login(&next.id, &callback).await.is_err());
    assert!(f
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|r| r.url.path() != "/api/oauth/keycloak"));
}

/// Verify a successful callback stores a session in the vault and rejects replay.
#[tokio::test]
async fn oauth_verifies_identity_and_saves_only_in_vault() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    Mock::given(method("GET"))
        .and(path("/api/oauth/state"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("set-cookie", "session=preauth; Path=/; HttpOnly")
                .set_body_json(json!({"success":true,"data":"state-nonce"})),
        )
        .mount(&f.server)
        .await;
    Mock::given(path("/api/oauth/keycloak"))
        .and(header("cookie", "session=preauth"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("set-cookie", "session=authenticated; Path=/; HttpOnly")
                .set_body_json(json!({"success":true,"data":user()})),
        )
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(path("/api/user/self"))
        .and(header("cookie", "session=authenticated"))
        .and(header("New-Api-User", "77"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":user()})),
        )
        .mount(&f.server)
        .await;
    let flow = f.connector.start_login(&f.server.uri()).await.unwrap();
    let mut callback = flow.callback;
    callback.set_query(Some("state=state-nonce&code=one-time-code"));
    f.connector.finish_login(&flow.id, &callback).await.unwrap();
    assert!(vault
        .get(&f.server.uri())
        .unwrap()
        .unwrap()
        .contains("session=authenticated"));
    assert!(!f.dir.path().join("new-api.json").exists());
    assert!(f.connector.finish_login(&flow.id, &callback).await.is_err());
    f.connector.disconnect(&f.server.uri()).unwrap();
    assert!(vault.get(&f.server.uri()).unwrap().is_none());
}

/// A release label is diagnostic: the same public OAuth contract may appear under any version.
#[tokio::test]
async fn check_accepts_unknown_release_labels() {
    let server = MockServer::start().await;
    let version = Arc::new(Mutex::new("v1.0.0-rc.40".to_string()));
    let current = version.clone();
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/api/status"))
        .respond_with(move |_: &Request| {
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{
                "version":current.lock().unwrap().as_str(),"server_address":base,
                "custom_oauth_providers":[{"name":"Keycloak","slug":"keycloak","client_id":"public-client","authorization_endpoint":"https://idp.example/authorize"}]
            }}))
        })
        .mount(&server)
        .await;
    let connector = NewApi::new(
        tempfile::tempdir().unwrap().path().into(),
        Box::<MemoryVault>::default(),
    );
    assert_eq!(
        connector.check(&server.uri()).await.unwrap().version,
        "v1.0.0-rc.40"
    );
    *version.lock().unwrap() = "future-build-with-same-contract".into();
    assert_eq!(
        connector.check(&server.uri()).await.unwrap().version,
        "future-build-with-same-contract"
    );
}

/// The new OAuth flow uses POST state, bearer management calls, and a scoped refresh cookie.
#[tokio::test]
async fn bearer_oauth_login_verifies_and_persists_only_private_credentials() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session = None;
    Mock::given(method("POST"))
        .and(path("/api/oauth/state"))
        .and(body_partial_json(
            json!({"provider":"keycloak","intent":"login"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"success":true,"data":{"flow_token":"new-flow","expires_at":now()+600}}),
        ))
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/oauth/keycloak"))
        .respond_with(ResponseTemplate::new(200)
            .insert_header("set-cookie", "new_api_refresh=refresh-one; Path=/api/user/auth; HttpOnly")
            .set_body_json(json!({"success":true,"data":{
                "access_token":"access-one","token_type":"Bearer","access_expires_at":now()+3600,
                "session":{"sid":"sid-one","expires_at":now()+86400},"user":user()
            }})))
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/user/self"))
        .and(header("Authorization", "Bearer access-one"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":user()})),
        )
        .mount(&f.server)
        .await;
    let flow = f.connector.start_login(&f.server.uri()).await.unwrap();
    assert!(flow
        .url
        .query_pairs()
        .any(|(key, value)| key == "state" && value == "new-flow"));
    let mut callback = flow.callback;
    callback.set_query(Some("state=new-flow&code=one-time-code"));
    f.connector.finish_login(&flow.id, &callback).await.unwrap();
    let saved: Value = serde_json::from_str(&vault.get(&f.server.uri()).unwrap().unwrap()).unwrap();
    assert_eq!(saved["auth"]["mode"], "bearer");
    assert_eq!(
        saved["auth"]["refresh_cookie"],
        "new_api_refresh=refresh-one"
    );
    assert!(!f.dir.path().join("new-api.json").exists());
    let requests = f.server.received_requests().await.unwrap();
    assert!(requests.iter().all(
        |request| request.url.path() != "/api/oauth/state" || request.method.as_str() == "POST"
    ));
    assert!(requests
        .iter()
        .filter(|request| request.url.path() == "/api/user/self")
        .all(|request| !request.headers.contains_key("new-api-user")));
}

/// Restoring a bearer session refreshes through its scoped cookie and saves the rotation.
#[tokio::test]
async fn bearer_session_refreshes_after_restart_without_changing_account() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session = None;
    let base = f.server.uri();
    vault
        .set(
            &base,
            &json!({
                "base_url":base,"user":user(),"expires_at":now()+86400,
                "auth":{"mode":"bearer","access_token":"access-old","access_expires_at":now()-1,
                    "refresh_cookie":"new_api_refresh=refresh-old","session_id":"sid-one"}
            })
            .to_string(),
        )
        .unwrap();
    Mock::given(method("POST"))
        .and(path("/api/user/auth/refresh"))
        .and(header("Origin", base.as_str()))
        .and(header("X-Auth-Session", "sid-one"))
        .and(header("cookie", "new_api_refresh=refresh-old"))
        .respond_with(ResponseTemplate::new(200)
            .insert_header("set-cookie", "new_api_refresh=refresh-new; Path=/api/user/auth; HttpOnly")
            .set_body_json(json!({"success":true,"data":{
                "access_token":"access-new","token_type":"Bearer","access_expires_at":now()+3600,
                "session":{"sid":"sid-one","expires_at":now()+86400},"user":user()
            }})))
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/user/self"))
        .and(header("Authorization", "Bearer access-new"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":user()})),
        )
        .mount(&f.server)
        .await;
    assert_eq!(f.connector.status(&base).await.unwrap().phase, "connected");
    let saved: Value = serde_json::from_str(&vault.get(&base).unwrap().unwrap()).unwrap();
    assert_eq!(saved["auth"]["access_token"], "access-new");
    assert_eq!(
        saved["auth"]["refresh_cookie"],
        "new_api_refresh=refresh-new"
    );
    assert_eq!(f.connector.status(&base).await.unwrap().phase, "connected");
}

/// Unknown state shapes and post-OAuth challenges cannot start token creation.
#[tokio::test]
async fn unknown_oauth_contracts_fail_closed_without_legacy_downgrade() {
    let mut f = fixture().await;
    Mock::given(method("POST"))
        .and(path("/api/oauth/state"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{}})))
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/oauth/state"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":"legacy-state"})),
        )
        .mount(&f.server)
        .await;
    assert_eq!(
        f.connector
            .start_login(&f.server.uri())
            .await
            .err()
            .unwrap()
            .code,
        "oauth_contract"
    );
    assert!(f
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(
            |request| request.url.path() != "/api/oauth/state" || request.method.as_str() != "GET"
        ));
}

/// The upstream login-verification challenge is reported without persisting a session.
#[tokio::test]
async fn bearer_oauth_reports_required_second_verification() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session = None;
    Mock::given(method("POST"))
        .and(path("/api/oauth/state"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":true,"data":{"flow_token":"new-flow"}})),
        )
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/oauth/keycloak"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{
                "require_verification":true,"flow_token":"verify-flow","methods":[{"type":"email"}]
            }})),
        )
        .mount(&f.server)
        .await;
    let flow = f.connector.start_login(&f.server.uri()).await.unwrap();
    let mut callback = flow.callback;
    callback.set_query(Some("state=new-flow&code=one-time-code"));
    let error = f
        .connector
        .finish_login(&flow.id, &callback)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "verification_required");
    assert!(vault.get(&f.server.uri()).unwrap().is_none());
}

/// Old keychain JSON can migrate after account verification regardless of its saved release.
#[tokio::test]
async fn legacy_cookie_record_migrates_without_version_matching() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session = None;
    let base = f.server.uri();
    vault
        .set(
            &base,
            &json!({
                "base_url":base,"version":"unrelated-build","user":user(),
                "cookie":"session=authenticated","expires_at":now()+86400
            })
            .to_string(),
        )
        .unwrap();
    Mock::given(method("GET"))
        .and(path("/api/user/self"))
        .and(header("cookie", "session=authenticated"))
        .and(header("New-Api-User", "77"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":user()})),
        )
        .mount(&f.server)
        .await;
    assert_eq!(f.connector.status(&base).await.unwrap().phase, "connected");
    let saved: Value = serde_json::from_str(&vault.get(&base).unwrap().unwrap()).unwrap();
    assert_eq!(saved["auth"]["mode"], "cookie");
    assert_eq!(saved["auth"]["cookie"], "session=authenticated");
    assert!(saved.get("version").is_none());
}

/// A validated exact key is kept unchanged; a missing prefix is added only after 401.
#[tokio::test]
async fn relay_key_validation_prefers_exact_server_value() {
    let f = fixture().await;
    let model = ModelConfig {
        id: String::new(),
        name: "test".into(),
        protocol: Protocol::OpenaiChat,
        base_url: format!("{}/v1", f.server.uri()),
        model_id: "model-one".into(),
        api_key: "opaque-v2.key_+".into(),
        supports_tool_call: true,
        supports_images: true,
        context_window: None,
        reasoning_levels: vec![],
    };
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("Authorization", "Bearer opaque-v2.key_+"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"data":[{"id":"model-one"}]})),
        )
        .with_priority(1)
        .mount(&f.server)
        .await;
    assert_eq!(
        check_key(&f.server.uri(), &model).await.unwrap(),
        model.api_key
    );
    let mut old = model;
    old.api_key = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL".into();
    assert_eq!(
        check_key(&f.server.uri(), &old).await.unwrap(),
        format!("sk-{}", old.api_key)
    );
}

/// Bearer management requests can complete the existing recoverable create workflow.
#[tokio::test]
async fn bearer_management_imports_one_model_without_legacy_user_header() {
    let mut f = fixture().await;
    let mut client = ApiClient::new(&f.server.uri()).unwrap();
    client.set_access_token("access-one".into());
    f.connector.session = Some(Session {
        client,
        auth: SessionAuth::Bearer {
            access_expires_at: now() + 3600,
            session_id: "sid-one".into(),
        },
        user: user(),
        expires_at: now() + 86400,
        verified_at: now(),
    });
    let tokens = f.tokens.clone();
    Mock::given(method("POST"))
        .and(path("/api/token/"))
        .and(header("Authorization", "Bearer access-one"))
        .and(body_partial_json(
            json!({"expired_time":-1,"unlimited_quota":true,"group":"staff"}),
        ))
        .respond_with(move |request: &Request| {
            let mut token: Value = request.body_json().unwrap();
            token["id"] = json!(1);
            token["user_id"] = json!(77);
            token["status"] = json!(1);
            tokens.lock().unwrap().push(token);
            ResponseTemplate::new(200).set_body_json(json!({"success":true}))
        })
        .expect(1)
        .mount(&f.server)
        .await;
    let imported = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    assert_eq!(imported.model.model_id, "model-one");
    let requests = f.server.received_requests().await.unwrap();
    assert!(requests
        .iter()
        .filter(|request| matches!(
            request.url.path(),
            "/api/user/self/groups" | "/api/user/models" | "/api/token/search" | "/api/token/"
        ))
        .all(|request| request
            .headers
            .get("authorization")
            .is_some_and(|value| value.to_str().ok() == Some("Bearer access-one"))
            && !request.headers.contains_key("new-api-user")));
}

/// Closing the native window while exchange is running must prevent any credential persistence.
#[tokio::test]
async fn cancellation_during_exchange_does_not_save_session() {
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session = None;
    Mock::given(method("GET"))
        .and(path("/api/oauth/state"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":"state-nonce"})),
        )
        .mount(&f.server)
        .await;
    let flow = f.connector.start_login(&f.server.uri()).await.unwrap();
    let cancel = flow.canceled.clone();
    Mock::given(path("/api/oauth/keycloak"))
        .respond_with(move |_: &Request| {
            cancel.store(true, Ordering::SeqCst);
            ResponseTemplate::new(200)
                .insert_header("set-cookie", "session=authenticated; Path=/; HttpOnly")
                .set_body_json(json!({"success":true,"data":user()}))
        })
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(path("/api/user/self"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":user()})),
        )
        .mount(&f.server)
        .await;
    let mut callback = flow.callback;
    callback.set_query(Some("state=state-nonce&code=one-time-code"));
    assert_eq!(
        f.connector
            .finish_login(&flow.id, &callback)
            .await
            .unwrap_err()
            .code,
        "oauth_canceled"
    );
    assert!(f.connector.session.is_none());
    assert!(vault.get(&f.server.uri()).unwrap().is_none());
}

/// Expired or remotely revoked sessions cannot be used to create a key in a stale UI.
#[tokio::test]
async fn expired_sessions_require_login_and_forget_revoked_credentials() {
    let mut f = fixture().await;
    f.connector.session.as_mut().unwrap().expires_at = now() - 1;
    assert_eq!(
        f.connector.status(&f.server.uri()).await.unwrap().phase,
        "disconnected"
    );
    let mut f = fixture().await;
    let vault = MemoryVault::default();
    vault.set(&f.server.uri(), "saved-secret").unwrap();
    f.connector.vault = Box::new(vault.clone());
    f.connector.session.as_mut().unwrap().verified_at = 0;
    Mock::given(path("/api/user/self"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&f.server)
        .await;
    assert_eq!(
        f.connector.status(&f.server.uri()).await.unwrap().phase,
        "disconnected"
    );
    assert!(vault.get(&f.server.uri()).unwrap().is_none());
    assert!(f.connector.session.is_none());
}

/// A corrupt journal must stop before any remote insert, preserving recoverability.
#[tokio::test]
async fn corrupt_journal_prevents_duplicate_creation() {
    let mut f = fixture().await;
    std::fs::write(f.dir.path().join("new-api.json"), "broken-json").unwrap();
    assert_eq!(
        f.connector
            .prepare_import(request(&f.server.uri()))
            .await
            .err()
            .unwrap()
            .code,
        "storage"
    );
    assert!(f
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|r| r.url.path() != "/api/token/"));
}

/// A minimum inference is made only when explicitly called and uses the selected native protocol.
#[tokio::test]
async fn explicit_test_uses_correct_protocol_and_never_panel_credentials() {
    let mut f = fixture().await;
    mount_create(&f, 200, 1).await;
    let imported = f
        .connector
        .prepare_import(request(&f.server.uri()))
        .await
        .unwrap();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header(
            "authorization",
            "Bearer sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
        ))
        .and(body_partial_json(
            json!({"model":"model-one","stream":false,"max_tokens":64}),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"choices":[{"message":{"content":"OK"}}]})),
        )
        .expect(1)
        .mount(&f.server)
        .await;
    assert!(f
        .connector
        .test_model(&imported.model)
        .await
        .unwrap()
        .contains("调用已验证"));
    let mut modified = imported.model;
    modified.base_url = "https://other.example/v1".into();
    assert_eq!(
        f.connector.test_model(&modified).await.err().unwrap().code,
        "model"
    );
}

/// A failed New API Responses probe leaves the library untouched; retry reuses the key and applies to Codex.
#[tokio::test]
async fn responses_import_retries_then_applies_to_codex() {
    use crate::{engine::Engine, model::AgentKind, paths::Paths};

    let mut f = fixture().await;
    mount_create(&f, 200, 1).await;
    let mut req = request(&f.server.uri());
    req.model_id = "model-one".into();
    req.protocol = Protocol::OpenaiResponses;
    req.context_window = Some(128000);

    let paths = Paths {
        home: f.dir.path().join("home"),
        data: f.dir.path().join("app-data"),
        workbuddy_env: None,
        codex_env: None,
    };
    let mut engine = Engine::open(paths.clone()).unwrap();
    let first = f.connector.prepare_import(req).await.unwrap();
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&f.server)
        .await;
    assert!(crate::model_probe::test_model(&first.model).await.is_err());
    assert!(engine.data().unwrap().models.is_empty());

    let existing_key = first.model.api_key.clone();
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(header(
            "authorization",
            format!("Bearer {existing_key}").as_str(),
        ))
        .and(body_partial_json(
            json!({"model":"model-one","input":"test"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "object":"response","status":"completed","output":[{
                "type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]
            }]
        })))
        .expect(1)
        .with_priority(1)
        .mount(&f.server)
        .await;
    // A retry reconciles the existing key and the successful probe authorizes the library write.
    let mut retry = request(&f.server.uri());
    retry.model_id = "model-one".into();
    retry.protocol = Protocol::OpenaiResponses;
    retry.context_window = Some(128000);
    let retried = f.connector.prepare_import(retry).await.unwrap();
    assert!(retried.reused);
    assert_eq!(retried.model.id, first.model.id);
    crate::model_probe::test_model(&retried.model)
        .await
        .unwrap();
    let model = engine
        .upsert_from_new_api(retried.model, &retried.siblings)
        .unwrap();
    let preview = engine
        .preview_apply(&model.id, &[AgentKind::Codex])
        .unwrap();
    assert_eq!(preview.files.len(), 2);
    let applied = engine.apply(&preview.token).unwrap();
    let config = std::fs::read_to_string(paths.home.join(".codex/config.toml")).unwrap();
    assert!(config.contains("wire_api = \"responses\""));
    assert!(config.contains("model-one"));
    assert!(paths.home.join(".codex/power-switch-models.json").exists());
    assert_eq!(engine.data().unwrap().models.len(), 1);
    assert_eq!(f.tokens.lock().unwrap().len(), 1);

    let restore = engine.preview_restore(&applied.backup_id).unwrap();
    engine.apply(&restore.token).unwrap();
    assert!(!paths.home.join(".codex/config.toml").exists());
    assert!(!paths.home.join(".codex/power-switch-models.json").exists());
}
