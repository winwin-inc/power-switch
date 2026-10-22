use crate::{
    engine::Engine,
    initialization::{initialize, InitializationOptions},
    mcp::{AuthMode, McpDraft, BUILTIN_INTERNAL_ID, BUILTIN_X_ID},
    model::{AgentKind, ModelConfig, Protocol},
    new_api::{
        vault::{FileVault, Vault},
        NewApi,
    },
    paths::Paths,
};
use serde_json::json;
use std::{fs, sync::Mutex};
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

struct Fixture {
    _temp: tempfile::TempDir,
    engine: Mutex<Engine>,
    connector: NewApi,
    data: std::path::PathBuf,
    agent_path: std::path::PathBuf,
    agent_bytes: Vec<u8>,
}

/// 建立隔离模型、真实备份和三种 MCP 记录，绝不访问用户目录。
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let mut engine = Engine::open(Paths {
        home: home.clone(),
        data: data.clone(),
        workbuddy_env: None,
        codex_env: None,
    })
    .unwrap();
    engine
        .settings(crate::paths::Settings {
            theme: "dark".into(),
            ..Default::default()
        })
        .unwrap();
    let model = engine
        .upsert(ModelConfig {
            id: String::new(),
            name: "初始化测试".into(),
            protocol: Protocol::OpenaiChat,
            base_url: "https://api.example.com/v1".into(),
            model_id: "test-model".into(),
            api_key: "model-secret-test-only".into(),
            supports_tool_call: true,
            supports_images: true,
            context_window: Some(524_288),
            reasoning_levels: vec!["high".into()],
        })
        .unwrap();
    let preview = engine
        .preview_apply(&model.id, &[AgentKind::Workbuddy])
        .unwrap();
    engine.apply(&preview.token).unwrap();
    for (id, server_id) in [
        (BUILTIN_X_ID, "msy-x-lightdash"),
        (BUILTIN_INTERNAL_ID, "msy-internal-lightdash"),
        ("", "custom-test"),
    ] {
        engine
            .mcp_upsert(McpDraft {
                id: id.into(),
                name: "测试连接器".into(),
                server_id: server_id.into(),
                url: "https://mcp.example.com/mcp".into(),
                auth_mode: AuthMode::Bearer,
                header_name: String::new(),
                token: "mcp-secret-test-only".into(),
            })
            .unwrap();
    }
    fs::write(data.join("new-api.json"), "{\"version\":1,\"records\":[]}").unwrap();
    fs::write(data.join("skills-untouched.txt"), "skills remain").unwrap();
    let agent_path = home.join(".workbuddy/models.json");
    let agent_bytes = fs::read(&agent_path).unwrap();
    Fixture {
        _temp: temp,
        connector: NewApi::new(data.clone(), Box::new(FileVault::new(data.clone()))),
        engine: Mutex::new(engine),
        data,
        agent_path,
        agent_bytes,
    }
}

/// 写入独立的测试 Cookie 或 Bearer 会话，模拟应用重启后的私有凭据恢复。
fn session(f: &Fixture, base: &str, bearer: bool) {
    let auth = if bearer {
        json!({"mode":"bearer","access_token":"access-test-only","access_expires_at":1,"refresh_cookie":"new_api_refresh=refresh-test-only","session_id":"sid-test-only"})
    } else {
        json!({"mode":"cookie","cookie":"session=cookie-test-only"})
    };
    FileVault::new(f.data.clone()).set(base, &json!({"base_url":base,"user":{"id":77,"username":"tester","display_name":"测试用户","group":"default"},"expires_at":1,"auth":auth}).to_string()).unwrap();
}

/// 三种选择组合只清理对应范围；服务端退出时本地凭据和模型必须仍存在。
#[tokio::test]
async fn selected_scopes_clear_only_app_owned_data_after_logout() {
    for options in [
        InitializationOptions {
            models: true,
            mcp: false,
        },
        InitializationOptions {
            models: false,
            mcp: true,
        },
        InitializationOptions {
            models: true,
            mcp: true,
        },
    ] {
        let mut f = fixture();
        let server = MockServer::start().await;
        session(&f, &server.uri(), false);
        f.engine.lock().unwrap().new_api_url(server.uri()).unwrap();
        let original_models = fs::read(f.data.join("models.json")).unwrap();
        let original_mcp = fs::read(f.data.join("mcp-connectors.json")).unwrap();
        let before_data = f.data.clone();
        Mock::given(method("GET"))
            .and(path("/api/user/logout"))
            .and(header("cookie", "session=cookie-test-only"))
            .respond_with(move |_: &wiremock::Request| {
                assert!(fs::read_to_string(before_data.join("models.json"))
                    .unwrap()
                    .contains("model-secret-test-only"));
                assert_eq!(
                    fs::read_dir(before_data.join("new-api/sessions"))
                        .unwrap()
                        .count(),
                    1
                );
                ResponseTemplate::new(200).set_body_json(json!({"success":true}))
            })
            .expect(u64::from(options.models))
            .mount(&server)
            .await;
        initialize(&f.engine, &mut f.connector, options)
            .await
            .unwrap();
        let engine = f.engine.lock().unwrap();
        let data = engine.data().unwrap();
        assert_eq!(data.models.is_empty(), options.models);
        assert_eq!(data.settings.theme, "dark");
        assert_eq!(data.settings.new_api_url.is_none(), options.models);
        assert_eq!(data.backups.is_empty(), options.models);
        assert_eq!(
            FileVault::new(f.data.clone())
                .accounts()
                .unwrap()
                .is_empty(),
            options.models
        );
        assert_eq!(f.data.join("new-api.json").exists(), !options.models);
        assert_eq!(fs::read(&f.agent_path).unwrap(), f.agent_bytes);
        assert_eq!(
            fs::read_to_string(f.data.join("skills-untouched.txt")).unwrap(),
            "skills remain"
        );
        if options.mcp {
            let connectors = engine.mcp_list().unwrap();
            assert_eq!(connectors.len(), 2);
            assert!(connectors.iter().all(|c| c.built_in && !c.has_token));
        } else {
            assert_eq!(
                fs::read(f.data.join("mcp-connectors.json")).unwrap(),
                original_mcp
            );
        }
        if !options.models {
            assert_eq!(
                fs::read(f.data.join("models.json")).unwrap(),
                original_models
            );
        }
    }
}

/// Bearer 注销使用刷新 Cookie、Origin 和 POST，不进行无关的刷新或密钥撤销。
#[tokio::test]
async fn bearer_logout_uses_refresh_cookie_and_origin_before_cleanup() {
    let mut f = fixture();
    let server = MockServer::start().await;
    session(&f, &server.uri(), true);
    Mock::given(method("POST"))
        .and(path("/api/user/auth/logout"))
        .and(header("cookie", "new_api_refresh=refresh-test-only"))
        .and(header("Origin", server.uri()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true})))
        .expect(1)
        .mount(&server)
        .await;
    initialize(
        &f.engine,
        &mut f.connector,
        InitializationOptions {
            models: true,
            mcp: false,
        },
    )
    .await
    .unwrap();
    assert!(FileVault::new(f.data.clone())
        .accounts()
        .unwrap()
        .is_empty());
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    assert_eq!(
        f.connector.status(&server.uri()).await.unwrap().phase,
        "disconnected"
    );
}

/// 退出接口失败时两种本地范围都不删除，并且错误不暴露上游响应内容。
#[tokio::test]
async fn logout_failure_preserves_models_backups_mcp_and_sessions() {
    let mut f = fixture();
    let server = MockServer::start().await;
    session(&f, &server.uri(), false);
    let before_models = fs::read(f.data.join("models.json")).unwrap();
    let before_mcp = fs::read(f.data.join("mcp-connectors.json")).unwrap();
    Mock::given(method("GET"))
        .and(path("/api/user/logout"))
        .respond_with(ResponseTemplate::new(503).set_body_string("upstream-secret-cookie"))
        .expect(1)
        .mount(&server)
        .await;
    let error = initialize(
        &f.engine,
        &mut f.connector,
        InitializationOptions {
            models: true,
            mcp: true,
        },
    )
    .await
    .unwrap_err();
    assert!(error.contains("退出失败"));
    assert!(!error.contains("upstream-secret"));
    assert_eq!(fs::read(f.data.join("models.json")).unwrap(), before_models);
    assert_eq!(
        fs::read(f.data.join("mcp-connectors.json")).unwrap(),
        before_mcp
    );
    assert_eq!(f.engine.lock().unwrap().data().unwrap().backups.len(), 1);
    assert_eq!(FileVault::new(f.data.clone()).accounts().unwrap().len(), 1);
    assert!(f.data.join("new-api.json").exists());
}

/// 空选择在网络和文件变更之前被拒绝；成功初始化后旧预览无法恢复被清理配置。
#[tokio::test]
async fn empty_selection_is_rejected_and_old_previews_are_invalidated() {
    let mut f = fixture();
    let old = fs::read(f.data.join("models.json")).unwrap();
    assert!(initialize(
        &f.engine,
        &mut f.connector,
        InitializationOptions {
            models: false,
            mcp: false
        }
    )
    .await
    .is_err());
    assert_eq!(fs::read(f.data.join("models.json")).unwrap(), old);
    let preview = {
        let mut engine = f.engine.lock().unwrap();
        let model_id = engine.data().unwrap().models[0].id.clone();
        engine
            .preview_apply(&model_id, &[AgentKind::Workbuddy])
            .unwrap()
    };
    initialize(
        &f.engine,
        &mut f.connector,
        InitializationOptions {
            models: true,
            mcp: true,
        },
    )
    .await
    .unwrap();
    assert!(f.engine.lock().unwrap().apply(&preview.token).is_err());
}

/// 文件集合变更或符号链接会阻止初始化，不覆盖外部目标。
#[test]
fn changes_after_preflight_are_rejected() {
    let f = fixture();
    let plan = f
        .engine
        .lock()
        .unwrap()
        .prepare_initialization(InitializationOptions {
            models: true,
            mcp: true,
        })
        .unwrap();
    fs::write(
        f.data.join("backups/new-backup.json"),
        "new external content",
    )
    .unwrap();
    assert!(f
        .engine
        .lock()
        .unwrap()
        .complete_initialization(plan)
        .is_err());
    assert!(fs::read_to_string(f.data.join("models.json"))
        .unwrap()
        .contains("model-secret-test-only"));
    #[cfg(unix)]
    {
        fs::remove_file(f.data.join("mcp-connectors.json")).unwrap();
        std::os::unix::fs::symlink(&f.agent_path, f.data.join("mcp-connectors.json")).unwrap();
        assert!(f
            .engine
            .lock()
            .unwrap()
            .prepare_initialization(InitializationOptions {
                models: false,
                mcp: true
            })
            .is_err());
        assert_eq!(fs::read(&f.agent_path).unwrap(), f.agent_bytes);
    }
}

/// 所有保存在磁盘中的实例都必须退出，不能只处理最后一次使用的实例。
#[tokio::test]
async fn all_saved_instances_are_logged_out() {
    let mut f = fixture();
    let first = MockServer::start().await;
    let second = MockServer::start().await;
    for server in [&first, &second] {
        session(&f, &server.uri(), false);
        Mock::given(method("GET"))
            .and(path("/api/user/logout"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true})))
            .expect(1)
            .mount(server)
            .await;
    }
    initialize(
        &f.engine,
        &mut f.connector,
        InitializationOptions {
            models: true,
            mcp: false,
        },
    )
    .await
    .unwrap();
    assert!(FileVault::new(f.data.clone())
        .accounts()
        .unwrap()
        .is_empty());
}
