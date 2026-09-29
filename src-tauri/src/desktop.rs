use crate::{
    engine::{AppData, ApplyPreview, ApplyResult, Engine, ImportPreview},
    model::{AgentKind, AppResult, ModelConfig},
    paths::{Paths, Settings},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tokio::{sync::Semaphore, task::JoinSet};

type Shared<'a> = State<'a, Mutex<Engine>>;
type Verifications<'a> = State<'a, Mutex<VerifiedModels>>;

#[derive(Default)]
struct VerifiedModels(HashMap<String, (Vec<u8>, Instant)>);

impl VerifiedModels {
    /// Issue a bounded receipt for one successfully tested draft.
    fn issue(&mut self, fingerprint: Vec<u8>) -> String {
        self.0.retain(|_, (_, expires)| *expires > Instant::now());
        if self.0.len() >= 256 {
            if let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, (_, expires))| *expires)
                .map(|(token, _)| token.clone())
            {
                self.0.remove(&oldest);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.0.insert(
            token.clone(),
            (fingerprint, Instant::now() + Duration::from_secs(600)),
        );
        token
    }

    /// Accept only a fresh receipt for the exact normalized draft.
    fn valid(&self, token: &str, fingerprint: &[u8]) -> bool {
        self.0
            .get(token)
            .is_some_and(|(expected, expires)| *expires > Instant::now() && expected == fingerprint)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFailure {
    index: usize,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportOutcome {
    saved_count: usize,
    failures: Vec<ImportFailure>,
}

/// Check the Codex catalog when needed, then require a real response in the selected protocol.
async fn verify_import_candidate(model: ModelConfig) -> AppResult<()> {
    if model.protocol == crate::model::Protocol::OpenaiResponses {
        let ids = crate::model_catalog::list_models(crate::model_catalog::ModelConnection {
            protocol: model.protocol,
            base_url: model.base_url.clone(),
            api_key: model.api_key.clone(),
        })
        .await?;
        if !ids.contains(&model.model_id) {
            return Err("模型 ID 不在服务商返回的模型清单中".into());
        }
    }
    crate::model_probe::test_model(&model).await?;
    Ok(())
}

/// Hash a validated draft, including its credentials, without retaining the draft in the receipt store.
fn model_fingerprint(mut model: ModelConfig) -> AppResult<Vec<u8>> {
    model.validate()?;
    let bytes = serde_json::to_vec(&model).map_err(|_| "无法校验模型配置")?;
    Ok(Sha256::digest(bytes).to_vec())
}

/// Serialize desktop operations through a single engine and propagate safe errors.
fn with_engine<T>(state: Shared<'_>, f: impl FnOnce(&mut Engine) -> AppResult<T>) -> AppResult<T> {
    let mut engine = state.lock().map_err(|_| "应用数据锁异常，请重启")?;
    f(&mut engine)
}

/// Load models, settings, paths and redacted backup summaries.
#[tauri::command]
fn get_data(state: Shared<'_>) -> AppResult<AppData> {
    with_engine(state, |e| e.data())
}
/// Save one validated model.
#[tauri::command]
fn save_model(
    state: Shared<'_>,
    verified: Verifications<'_>,
    model: ModelConfig,
    verification_token: String,
) -> AppResult<ModelConfig> {
    let fingerprint = model_fingerprint(model.clone())?;
    let mut receipts = verified.lock().map_err(|_| "模型验证状态不可用")?;
    if !receipts.valid(&verification_token, &fingerprint) {
        return Err("测试凭据无效或已过期，请重新测试当前配置".into());
    }
    let saved = with_engine(state, |e| e.upsert(model))?;
    receipts.0.remove(&verification_token);
    Ok(saved)
}
/// Test a draft without holding the model-store lock or writing any Agent configuration.
#[tauri::command]
async fn test_model(
    verified: Verifications<'_>,
    model: ModelConfig,
) -> AppResult<crate::model_probe::ModelTestResult> {
    let fingerprint = model_fingerprint(model.clone())?;
    if model.protocol == crate::model::Protocol::OpenaiResponses {
        let ids = crate::model_catalog::list_models(crate::model_catalog::ModelConnection {
            protocol: model.protocol,
            base_url: model.base_url.clone(),
            api_key: model.api_key.clone(),
        })
        .await?;
        if !ids.contains(&model.model_id) {
            return Err("模型 ID 不在服务商返回的模型清单中".into());
        }
    }
    let mut result = crate::model_probe::test_model(&model).await?;
    let mut receipts = verified.lock().map_err(|_| "模型验证状态不可用")?;
    result.verification_token = Some(receipts.issue(fingerprint));
    Ok(result)
}

/// Fetch selectable model IDs from the draft connection without saving it.
#[tauri::command]
async fn list_models(connection: crate::model_catalog::ModelConnection) -> AppResult<Vec<String>> {
    crate::model_catalog::list_models(connection).await
}
/// Delete a library record without changing an Agent's files.
#[tauri::command]
fn delete_model(state: Shared<'_>, id: String) -> AppResult<()> {
    with_engine(state, |e| e.delete(&id))
}
/// Update appearance, config locations and update-channel preferences.
#[tauri::command]
fn save_settings(state: Shared<'_>, settings: Settings) -> AppResult<()> {
    with_engine(state, |e| e.settings(settings))
}
/// Update only the last checked New API address, keeping other settings intact.
#[tauri::command]
fn save_new_api_url(state: Shared<'_>, url: String) -> AppResult<()> {
    with_engine(state, |e| e.new_api_url(url))
}
/// Prepare a model application for user review.
#[tauri::command]
fn preview_apply(
    state: Shared<'_>,
    id: String,
    agents: Vec<AgentKind>,
    select_workbuddy_model: bool,
) -> AppResult<ApplyPreview> {
    with_engine(state, |e| {
        e.preview_apply_with_selection(&id, &agents, select_workbuddy_model)
    })
}
/// Commit the confirmed preview, then allow WorkBuddy to reload its model list before opening home.
#[tauri::command]
async fn apply_preview(
    app: tauri::AppHandle,
    state: Shared<'_>,
    token: String,
) -> AppResult<ApplyResult> {
    let mut result = with_engine(state, |e| e.apply(&token))?;
    // The model-file watcher reloads asynchronously; wait before opening the new-task page.
    if result.workbuddy_model_id.is_some() {
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
    }
    crate::workbuddy_link::finish_selection(&mut result, |url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "无法唤起 WorkBuddy".into())
    });
    Ok(result)
}
/// Release canceled preview contents.
#[tauri::command]
fn cancel_preview(state: Shared<'_>, token: String) -> AppResult<()> {
    with_engine(state, |e| {
        e.cancel_preview(&token);
        Ok(())
    })
}
/// Prepare an existing backup for restoration.
#[tauri::command]
fn preview_restore(state: Shared<'_>, id: String) -> AppResult<ApplyPreview> {
    with_engine(state, |e| e.preview_restore(&id))
}
/// Remove one confirmed backup without affecting any configured Agent.
#[tauri::command]
fn delete_backup(state: Shared<'_>, id: String) -> AppResult<()> {
    with_engine(state, |e| e.delete_backup(&id))
}
/// Remove all confirmed backup records without changing model or Agent configuration files.
#[tauri::command]
fn delete_all_backups(state: Shared<'_>) -> AppResult<usize> {
    with_engine(state, |e| e.delete_all_backups())
}
/// Decode an incoming model link without applying it.
#[tauri::command]
fn preview_import(state: Shared<'_>, link: String) -> AppResult<ImportPreview> {
    with_engine(state, |e| e.preview_import(&link))
}
/// Test selected rows without holding the engine lock, then save only verified rows.
#[tauri::command]
async fn confirm_import(
    state: Shared<'_>,
    token: String,
    updates: Vec<usize>,
) -> AppResult<ImportOutcome> {
    let plan = with_engine(state.clone(), |e| e.import_plan(&token, &updates))?;
    let limiter = Arc::new(Semaphore::new(8));
    let mut tasks = JoinSet::new();
    for (index, model) in &plan.candidates {
        let index = *index;
        let model = model.clone();
        let limiter = limiter.clone();
        tasks.spawn(async move {
            let _permit = limiter
                .acquire_owned()
                .await
                .map_err(|_| "测试任务已取消".to_string())?;
            Ok::<_, String>((index, verify_import_candidate(model).await))
        });
    }
    let mut passed = Vec::new();
    let mut failures = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(Ok((index, outcome))) = result {
            match outcome {
                Ok(()) => passed.push(index),
                Err(message) => failures.push(ImportFailure { index, message }),
            }
        }
    }
    for (index, _) in &plan.candidates {
        if !passed.contains(index) && !failures.iter().any(|failure| failure.index == *index) {
            failures.push(ImportFailure {
                index: *index,
                message: "模型测试任务异常，请重试".into(),
            });
        }
    }
    failures.sort_by_key(|failure| failure.index);
    let saved_count = with_engine(state, |e| {
        e.commit_verified_import(&token, &updates, &plan, &passed)
    })?;
    Ok(ImportOutcome {
        saved_count,
        failures,
    })
}
/// Generate a share link with opt-in credential inclusion.
#[tauri::command]
fn share_model(state: Shared<'_>, id: String, include_secret: bool) -> AppResult<String> {
    with_engine(state, |e| e.share(&id, include_secret))
}

/// Configure single-instance delivery before registering the deep-link plugin.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let paths = Paths::discover().map_err(std::io::Error::other)?;
            let data = paths.data.clone();
            let engine = Engine::open(paths).map_err(std::io::Error::other)?;
            crate::new_api_desktop::setup(app.handle(), data);
            app.manage(Mutex::new(engine));
            app.manage(Mutex::new(VerifiedModels::default()));
            app.manage(Mutex::new(crate::skills::SkillManager::default()));
            // Packaged Windows builds register power-switch:// through AppxManifest.xml.
            #[cfg(any(
                target_os = "linux",
                all(target_os = "windows", not(feature = "store-msix"))
            ))]
            app.deep_link().register_all()?;
            app.deep_link().on_open_url({
                let handle = app.handle().clone();
                move |_| {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            save_model,
            test_model,
            list_models,
            delete_model,
            save_settings,
            save_new_api_url,
            preview_apply,
            apply_preview,
            cancel_preview,
            preview_restore,
            delete_backup,
            delete_all_backups,
            preview_import,
            confirm_import,
            share_model,
            crate::skills_desktop::skills_list,
            crate::skills_desktop::skills_detail,
            crate::skills_desktop::skills_preview_install,
            crate::skills_desktop::skills_preview_link,
            crate::skills_desktop::skills_preview_delete,
            crate::skills_desktop::skills_commit,
            crate::skills_desktop::skills_cancel,
            crate::new_api_desktop::new_api_check,
            crate::new_api_desktop::new_api_status,
            crate::new_api_desktop::new_api_login,
            crate::new_api_desktop::new_api_cancel_login,
            crate::new_api_desktop::new_api_catalog,
            crate::new_api_desktop::new_api_import,
            crate::new_api_desktop::new_api_test,
            crate::new_api_desktop::new_api_disconnect,
            crate::update_desktop::check_app_update,
            crate::update_desktop::install_app_update
        ])
        .run(tauri::generate_context!())
        .expect("power-switch 启动失败");
}

#[cfg(test)]
mod verification_tests {
    use super::*;
    use crate::model::Protocol;

    /// A receipt belongs to one normalized configuration and cannot be reused after consumption.
    #[test]
    fn receipts_bind_all_fields_and_expire() {
        let model = ModelConfig {
            id: String::new(),
            name: "测试".into(),
            protocol: Protocol::OpenaiChat,
            base_url: "https://example.com/v1".into(),
            model_id: "test".into(),
            api_key: "secret".into(),
            supports_tool_call: true,
            supports_images: false,
            context_window: None,
            reasoning_levels: vec![],
        };
        let fingerprint = model_fingerprint(model.clone()).unwrap();
        let mut receipts = VerifiedModels::default();
        let token = receipts.issue(fingerprint.clone());
        assert!(receipts.valid(&token, &fingerprint));
        let mut changed = model;
        changed.api_key.push_str("-changed");
        assert!(!receipts.valid(&token, &model_fingerprint(changed).unwrap()));
        receipts.0.get_mut(&token).unwrap().1 = Instant::now() - Duration::from_secs(1);
        assert!(!receipts.valid(&token, &fingerprint));
        let fresh = receipts.issue(fingerprint.clone());
        receipts.0.remove(&fresh);
        assert!(!receipts.valid(&fresh, &fingerprint));
    }
}
