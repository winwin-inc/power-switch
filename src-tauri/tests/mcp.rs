use power_switch::{
    engine::Engine,
    mcp::{AuthMode, McpDraft, McpTarget, BUILTIN_INTERNAL_ID, BUILTIN_X_ID},
    paths::Paths,
};
use serde_json::{json, Value};
use std::{fs, process::Command};

/// Create an isolated home so tests never read or write real Agent configuration.
fn isolated() -> (tempfile::TempDir, Engine) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let engine = Engine::open(Paths {
        home,
        data: temp.path().join("app"),
        workbuddy_env: None,
        codex_env: None,
    })
    .unwrap();
    (temp, engine)
}

/// Supply a fake PAT that must never appear in metadata or previews.
fn draft() -> McpDraft {
    McpDraft {
        id: BUILTIN_X_ID.into(),
        name: "马上赢 X 平台".into(),
        server_id: "msy-x-lightdash".into(),
        url: "https://mcp-x.brandct.com/mcp".into(),
        auth_mode: AuthMode::CustomHeader,
        header_name: "x-api-key".into(),
        token: "ldpat-TEST-ONLY".into(),
    }
}

/// Verify the private library stores a PAT while the UI receives only metadata.
#[test]
fn library_is_separate_and_redacted() {
    let (_temp, mut engine) = isolated();
    let saved = engine.mcp_upsert(draft()).unwrap();
    assert!(saved.has_token);
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("ldpat-TEST"));
    let path = engine.paths.data.join("mcp-connectors.json");
    assert!(fs::read_to_string(&path).unwrap().contains("ldpat-TEST"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(engine.mcp_list().unwrap().len(), 2);
    assert!(saved.built_in);
    assert!(engine.mcp_delete(&saved.id).is_err());
    let mut custom = draft();
    custom.id.clear();
    custom.name = "内部 Lightdash".into();
    custom.server_id = "internal-lightdash".into();
    custom.url = "http://mcp.lightdash.banmahui.cn/mcp".into();
    let custom = engine.mcp_upsert(custom).unwrap();
    assert!(!custom.built_in);
    assert_eq!(engine.mcp_list().unwrap().len(), 3);
    engine.mcp_delete(&custom.id).unwrap();
    assert_eq!(engine.mcp_list().unwrap().len(), 2);
}

/// Show the built-in connector without writing a credential file on first launch.
#[test]
fn builtin_is_available_before_configuring_a_token() {
    let (_temp, mut engine) = isolated();
    let rows = engine.mcp_list().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, BUILTIN_X_ID);
    assert!(rows[0].built_in);
    assert!(!rows[0].has_token);
    assert_eq!(rows[0].url, "https://mcp-x.brandct.com/mcp");
    assert_eq!(rows[1].id, BUILTIN_INTERNAL_ID);
    assert_eq!(rows[1].name, "马上赢内部 LightDash");
    assert_eq!(rows[1].server_id, "msy-internal-lightdash");
    assert_eq!(rows[1].url, "https://mcp-lightdash.banmahui.cn/mcp");
    assert!(rows[1].built_in);
    assert!(!rows[1].has_token);
    assert!(engine
        .preview_mcp_apply(BUILTIN_INTERNAL_ID, &[McpTarget::Codex], None)
        .is_err());
    assert!(!engine.paths.data.join("mcp-connectors.json").exists());
    assert!(engine
        .preview_mcp_apply(BUILTIN_X_ID, &[McpTarget::Codex], None)
        .is_err());
    let mut missing_token = draft();
    missing_token.auth_mode = AuthMode::None;
    missing_token.token.clear();
    fs::write(
        engine.paths.data.join("mcp-connectors.json"),
        json!({"connectors":[missing_token]}).to_string(),
    )
    .unwrap();
    assert!(engine
        .preview_mcp_apply(BUILTIN_X_ID, &[McpTarget::Codex], None)
        .is_err());
}

/// Keep each built-in PAT independent while applying both to the same native Agent file.
#[test]
fn internal_builtin_is_fixed_and_keeps_credentials_separate() {
    let (_temp, mut engine) = isolated();
    let x = engine.mcp_upsert(draft()).unwrap();
    let mut internal_draft = draft();
    internal_draft.id = BUILTIN_INTERNAL_ID.into();
    internal_draft.name = "tampered".into();
    internal_draft.server_id = "other-id".into();
    internal_draft.url = "https://wrong.example/mcp".into();
    internal_draft.auth_mode = AuthMode::None;
    internal_draft.token = "INTERNAL-TEST-PAT".into();
    let internal = engine.mcp_upsert(internal_draft.clone()).unwrap();
    assert_eq!(internal.name, "马上赢内部 LightDash");
    assert_eq!(internal.server_id, "msy-internal-lightdash");
    assert_eq!(internal.url, "https://mcp-lightdash.banmahui.cn/mcp");
    assert_eq!(internal.auth_mode, AuthMode::CustomHeader);
    assert_eq!(internal.header_name, "x-api-key");
    assert!(internal.built_in);
    assert!(engine.mcp_delete(&internal.id).is_err());
    internal_draft.token.clear();
    assert!(engine.mcp_upsert(internal_draft).unwrap().has_token);
    for id in [&x.id, &internal.id] {
        let preview = engine
            .preview_mcp_apply(id, &[McpTarget::Workbuddy], None)
            .unwrap();
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("TEST-PAT"));
        engine.apply(&preview.token).unwrap();
    }
    let applied: Value =
        serde_json::from_slice(&fs::read(engine.paths.home.join(".workbuddy/mcp.json")).unwrap())
            .unwrap();
    assert_eq!(
        applied["mcpServers"]["msy-x-lightdash"]["headers"]["x-api-key"],
        "ldpat-TEST-ONLY"
    );
    assert_eq!(
        applied["mcpServers"]["msy-internal-lightdash"]["headers"]["x-api-key"],
        "INTERNAL-TEST-PAT"
    );
    assert_eq!(
        applied["mcpServers"]["msy-internal-lightdash"]["type"],
        "streamableHttp"
    );
    let mut reserved = draft();
    reserved.id.clear();
    reserved.server_id = "msy-internal-lightdash".into();
    assert!(engine.mcp_upsert(reserved).is_err());
}

/// Adopt an existing internal server record without moving or exposing its credential.
#[test]
fn internal_builtin_adopts_legacy_record() {
    let (_temp, mut engine) = isolated();
    let old_id = uuid::Uuid::new_v4().to_string();
    let path = engine.paths.data.join("mcp-connectors.json");
    let original = json!({"connectors":[{
        "id":old_id,"name":"internal old","serverId":"msy-internal-lightdash",
        "url":"http://old.example/mcp","authMode":"bearer","headerName":"",
        "token":"LEGACY-INTERNAL-PAT"
    }]})
    .to_string();
    fs::write(&path, &original).unwrap();
    let rows = engine.mcp_list().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(!rows[0].has_token);
    assert_eq!(rows[1].id, old_id);
    assert!(rows[1].has_token);
    assert!(rows[1].built_in);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let preview = engine
        .preview_mcp_apply(BUILTIN_INTERNAL_ID, &[McpTarget::Codex], None)
        .unwrap();
    engine.apply(&preview.token).unwrap();
    let target = fs::read_to_string(engine.paths.home.join(".codex/config.toml")).unwrap();
    assert!(target.contains("LEGACY-INTERNAL-PAT"));
    assert!(target.contains("https://mcp-lightdash.banmahui.cn/mcp"));
    assert!(!target.contains("msy-x-lightdash"));
}

/// Adopt an earlier X template record without changing its identity or losing its PAT.
#[test]
fn builtin_preserves_legacy_record_and_fixes_its_metadata() {
    let (_temp, mut engine) = isolated();
    let old_id = uuid::Uuid::new_v4().to_string();
    let library = engine.paths.data.join("mcp-connectors.json");
    let original = json!({"connectors":[{
        "id":old_id,"name":"旧 X 模板","serverId":"msy-x-lightdash",
        "url":"https://old.example/mcp","authMode":"bearer","headerName":"",
        "token":"LEGACY-TEST-PAT"
    }]})
    .to_string();
    fs::write(&library, &original).unwrap();
    let rows = engine.mcp_list().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, old_id);
    assert_eq!(rows[0].name, "马上赢 X 平台");
    assert_eq!(rows[0].url, "https://mcp-x.brandct.com/mcp");
    assert_eq!(fs::read_to_string(&library).unwrap(), original);
    let mut edit = draft();
    edit.id = old_id.clone();
    edit.url = "https://tampered.example/mcp".into();
    edit.auth_mode = AuthMode::None;
    edit.token.clear();
    let saved = engine.mcp_upsert(edit).unwrap();
    assert_eq!(saved.id, old_id);
    assert_eq!(saved.auth_mode, AuthMode::CustomHeader);
    assert!(saved.has_token);
    let preview = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::Codex], None)
        .unwrap();
    engine.apply(&preview.token).unwrap();
    let target = fs::read_to_string(engine.paths.home.join(".codex/config.toml")).unwrap();
    assert!(target.contains("LEGACY-TEST-PAT"));
    assert!(target.contains("https://mcp-x.brandct.com/mcp"));
    assert!(!target.contains("tampered.example"));
}

/// Apply all native formats while preserving unrelated records and TOML comments.
#[test]
fn projection_merges_native_configs_and_restores_backup() {
    let (_temp, mut engine) = isolated();
    let home = engine.paths.home.clone();
    fs::create_dir_all(home.join(".workbuddy")).unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".workbuddy/mcp.json"),
        r#"{"other":true,"mcpServers":{"existing":{"type":"stdio","command":"echo"}}}"#,
    )
    .unwrap();
    fs::write(
        home.join(".claude.json"),
        r#"{"projects":{"other":{}},"mcpServers":{"existing":{"url":"https://old.example/mcp"}}}"#,
    )
    .unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "# keep comment\n[mcp_servers.existing]\ncommand = \"echo\"\n",
    )
    .unwrap();
    let saved = engine.mcp_upsert(draft()).unwrap();
    let preview = engine
        .preview_mcp_apply(
            &saved.id,
            &[
                McpTarget::Workbuddy,
                McpTarget::Codex,
                McpTarget::ClaudeUser,
            ],
            None,
        )
        .unwrap();
    assert_eq!(preview.files.len(), 3);
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("ldpat-TEST"));
    let result = engine.apply(&preview.token).unwrap();
    assert_eq!(result.paths.len(), 3);
    let workbuddy: Value =
        serde_json::from_slice(&fs::read(home.join(".workbuddy/mcp.json")).unwrap()).unwrap();
    assert_eq!(workbuddy["other"], true);
    assert_eq!(workbuddy["mcpServers"]["existing"]["command"], "echo");
    assert_eq!(
        workbuddy["mcpServers"]["msy-x-lightdash"]["type"],
        "streamableHttp"
    );
    assert_eq!(
        workbuddy["mcpServers"]["msy-x-lightdash"]["headers"]["x-api-key"],
        "ldpat-TEST-ONLY"
    );
    let claude: Value =
        serde_json::from_slice(&fs::read(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(claude["mcpServers"]["msy-x-lightdash"]["type"], "http");
    assert!(claude["projects"]["other"].is_object());
    let codex = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(codex.contains("# keep comment"));
    assert!(codex.contains("[mcp_servers.existing]"));
    assert!(codex.contains("ldpat-TEST-ONLY"));
    let restore = engine.preview_restore(&result.backup_id).unwrap();
    engine.apply(&restore.token).unwrap();
    assert_eq!(
        fs::read_to_string(home.join(".codex/config.toml")).unwrap(),
        "# keep comment\n[mcp_servers.existing]\ncommand = \"echo\"\n"
    );
    assert!(!fs::read_to_string(home.join(".workbuddy/mcp.json"))
        .unwrap()
        .contains("ldpat-TEST"));
}

/// Flag a same-name replacement and stop if a target changes after preview.
#[test]
fn replacement_and_stale_preview_are_guarded() {
    let (_temp, mut engine) = isolated();
    let home = engine.paths.home.clone();
    fs::create_dir_all(home.join(".workbuddy")).unwrap();
    let path = home.join(".workbuddy/mcp.json");
    fs::write(
        &path,
        json!({"mcpServers":{"msy-x-lightdash":{"url":"https://old.example/mcp"}}}).to_string(),
    )
    .unwrap();
    let saved = engine.mcp_upsert(draft()).unwrap();
    let preview = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::Workbuddy], None)
        .unwrap();
    assert!(preview.notices.iter().any(|n| n.contains("同名服务")));
    fs::write(&path, "{}\n").unwrap();
    assert!(engine.apply(&preview.token).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
}

/// Discard a staged native write when its connector is edited after preview.
#[test]
fn connector_edit_invalidates_pending_preview() {
    let (_temp, mut engine) = isolated();
    let saved = engine.mcp_upsert(draft()).unwrap();
    let preview = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::Codex], None)
        .unwrap();
    let mut edited = draft();
    edited.id = saved.id;
    edited.token = "ROTATED-TEST-PAT".into();
    engine.mcp_upsert(edited).unwrap();
    assert!(engine.apply(&preview.token).is_err());
    assert!(!engine.paths.home.join(".codex/config.toml").exists());
}

/// Require an ignored, untracked project file before writing a literal PAT.
#[test]
fn claude_project_requires_git_ignore() {
    let (_temp, mut engine) = isolated();
    let project = engine.paths.home.join("project");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg("-q")
        .arg(&project)
        .status()
        .unwrap()
        .success());
    let saved = engine.mcp_upsert(draft()).unwrap();
    assert!(engine
        .preview_mcp_apply(&saved.id, &[McpTarget::ClaudeProject], Some(&project))
        .is_err());
    fs::write(project.join(".gitignore"), ".mcp.json\n").unwrap();
    let preview = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::ClaudeProject], Some(&project))
        .unwrap();
    engine.apply(&preview.token).unwrap();
    assert!(fs::read_to_string(project.join(".mcp.json"))
        .unwrap()
        .contains("ldpat-TEST-ONLY"));
    let second = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::ClaudeProject], Some(&project))
        .unwrap();
    let original = fs::read(project.join(".mcp.json")).unwrap();
    fs::remove_file(project.join(".gitignore")).unwrap();
    assert!(engine.apply(&second.token).is_err());
    assert_eq!(fs::read(project.join(".mcp.json")).unwrap(), original);
}

/// Merge supported global and project formats, keep preview structure, and restore all files.
#[test]
fn supported_scopes_merge_and_restore() {
    let (_temp, mut engine) = isolated();
    let project = engine.paths.home.join("project");
    fs::create_dir_all(engine.paths.home.join(".workbuddy")).unwrap();
    fs::create_dir_all(project.join(".codex")).unwrap();
    let wb = engine.paths.home.join(".workbuddy/mcp.json");
    let codex = project.join(".codex/config.toml");
    fs::write(&wb, r#"{"mcpServers":{"existing":{"command":"echo"}}}"#).unwrap();
    fs::write(
        &codex,
        "# preserve project\nmodel = 'test'\n[mcp_servers.existing]\ncommand = 'echo'\n",
    )
    .unwrap();
    let original_wb = fs::read(&wb).unwrap();
    let original_codex = fs::read(&codex).unwrap();
    let saved = engine.mcp_upsert(draft()).unwrap();
    let targets = [
        McpTarget::Workbuddy,
        McpTarget::CodexProject,
        McpTarget::ClaudeProject,
    ];
    let preview = engine
        .preview_mcp_apply(&saved.id, &targets, Some(&project))
        .unwrap();
    assert_eq!(preview.files.len(), 3);
    let json_preview: Value = serde_json::from_str(&preview.files[0].after).unwrap();
    assert_eq!(
        json_preview["mcpServers"]["msy-x-lightdash"]["headers"]["x-api-key"],
        "••••••••"
    );
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("ldpat-TEST"));
    let result = engine.apply(&preview.token).unwrap();
    let wb_value: Value = serde_json::from_slice(&fs::read(&wb).unwrap()).unwrap();
    assert_eq!(
        wb_value["mcpServers"]["msy-x-lightdash"]["type"],
        "streamableHttp"
    );
    assert_eq!(wb_value["mcpServers"]["existing"]["command"], "echo");
    let codex_text = fs::read_to_string(&codex).unwrap();
    assert!(codex_text.contains("# preserve project"));
    assert!(codex_text.contains("ldpat-TEST-ONLY"));
    let second = engine
        .preview_mcp_apply(&saved.id, &targets, Some(&project))
        .unwrap();
    assert_eq!(
        second
            .notices
            .iter()
            .filter(|n| n.contains("同名服务"))
            .count(),
        3
    );
    engine.cancel_preview(&second.token);
    let restore = engine.preview_restore(&result.backup_id).unwrap();
    engine.apply(&restore.token).unwrap();
    assert_eq!(fs::read(wb).unwrap(), original_wb);
    assert_eq!(fs::read(codex).unwrap(), original_codex);
    assert!(!project.join(".mcp.json").exists());
}

/// Check nested Codex project files before their parent exists and recheck Git rules at commit.
#[test]
fn nested_project_secrets_require_ignore_and_untracked_files() {
    let target = McpTarget::CodexProject;
    let relative = ".codex/config.toml";
    let (_temp, mut engine) = isolated();
    let project = engine.paths.home.join("repo");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(&project)
        .status()
        .unwrap()
        .success());
    let saved = engine.mcp_upsert(draft()).unwrap();
    assert!(engine
        .preview_mcp_apply(&saved.id, &[target], Some(&project))
        .err()
        .unwrap()
        .contains("尚未被 Git 忽略"));
    fs::write(project.join(".gitignore"), format!("{relative}\n")).unwrap();
    let preview = engine
        .preview_mcp_apply(&saved.id, &[McpTarget::Codex, target], Some(&project))
        .unwrap();
    fs::remove_file(project.join(".gitignore")).unwrap();
    assert!(engine.apply(&preview.token).is_err());
    assert!(!engine.paths.home.join(".codex/config.toml").exists());
    assert!(!project.join(relative).exists());
    fs::create_dir_all(project.join(relative).parent().unwrap()).unwrap();
    fs::write(project.join(relative), "").unwrap();
    assert!(Command::new("git")
        .args(["add", "--", relative])
        .current_dir(&project)
        .status()
        .unwrap()
        .success());
    fs::write(project.join(".gitignore"), format!("{relative}\n")).unwrap();
    assert!(engine
        .preview_mcp_apply(&saved.id, &[target], Some(&project))
        .err()
        .unwrap()
        .contains("已被 Git 跟踪"));
}

/// Reject unsupported WorkBuddy project targets before staging any mixed-target writes.
#[test]
fn workbuddy_project_is_rejected_without_changing_files() {
    let (_temp, mut engine) = isolated();
    let project = engine.paths.home.join("project");
    fs::create_dir_all(project.join(".workbuddy")).unwrap();
    let path = project.join(".workbuddy/mcp.json");
    fs::write(&path, "{}\n").unwrap();
    let saved = engine.mcp_upsert(draft()).unwrap();
    for targets in [
        vec![McpTarget::WorkbuddyProject],
        vec![McpTarget::Workbuddy, McpTarget::WorkbuddyProject],
    ] {
        let error = engine
            .preview_mcp_apply(&saved.id, &targets, Some(&project))
            .err()
            .unwrap();
        assert!(error.contains("WorkBuddy 暂不支持 MCP 项目级配置"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
        assert!(!engine.paths.home.join(".workbuddy/mcp.json").exists());
    }
}

/// Apply an unauthenticated connector to all supported scopes without credential headers.
#[test]
fn unauthenticated_connector_supports_all_scopes() {
    let (_temp, mut engine) = isolated();
    let project = engine.paths.home.join("repo");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(&project)
        .status()
        .unwrap()
        .success());
    let mut custom = draft();
    custom.id.clear();
    custom.server_id = "public-tools".into();
    custom.auth_mode = AuthMode::None;
    custom.token.clear();
    let saved = engine.mcp_upsert(custom).unwrap();
    let targets = [
        McpTarget::Workbuddy,
        McpTarget::Codex,
        McpTarget::CodexProject,
        McpTarget::ClaudeUser,
        McpTarget::ClaudeProject,
    ];
    assert!(engine.preview_mcp_apply(&saved.id, &targets, None).is_err());
    let preview = engine
        .preview_mcp_apply(&saved.id, &targets, Some(&project))
        .unwrap();
    assert_eq!(preview.files.len(), 5);
    engine.apply(&preview.token).unwrap();
    for file in preview.files {
        assert!(!fs::read_to_string(file.path).unwrap().contains("headers"));
    }
}
