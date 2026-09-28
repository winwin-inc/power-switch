use crate::{engine::Engine, model::AppResult};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const RELEASES_API: &str = "https://api.github.com/repos/winwin-inc/power-switch/releases";
const RELEASE_ASSET_PREFIX: &str = "https://github.com/winwin-inc/power-switch/releases/download/";
const UPDATE_PROGRESS_EVENT: &str = "app-update-progress";

#[derive(Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    state: String,
}

#[derive(Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Read the saved channel choice without holding the Engine lock during network requests.
fn receive_rc(state: &State<'_, Mutex<Engine>>) -> AppResult<bool> {
    let engine = state.lock().map_err(|_| "无法读取更新设置")?;
    let settings = engine.current_settings()?;
    Ok(settings.auto_update && settings.receive_rc)
}

/// Accept only published stable releases and opted-in RC releases.
fn release_version(release: &GithubRelease, include_rc: bool) -> Option<Version> {
    if release.draft || !release.tag_name.starts_with('v') {
        return None;
    }
    let version = Version::parse(&release.tag_name[1..]).ok()?;
    let is_stable = !release.prerelease && version.pre.is_empty();
    let is_rc = release.prerelease
        && (version.pre.as_str() == "rc" || version.pre.as_str().starts_with("rc."));
    (is_stable || (include_rc && is_rc)).then_some(version)
}

/// Choose the highest eligible semantic version, independent of GitHub's display order.
fn newest_release(releases: &[GithubRelease], include_rc: bool) -> Option<&GithubRelease> {
    releases
        .iter()
        .filter_map(|release| {
            release_version(release, include_rc).map(|version| (release, version))
        })
        .max_by(|(_, left), (_, right)| left.cmp(right))
        .map(|(release, _)| release)
}

/// Reject prerelease metadata on the stable channel and mismatched RC manifests.
fn version_allowed(version: &str, selected_tag: Option<&str>) -> AppResult<bool> {
    let parsed = Version::parse(version).map_err(|_| "更新清单中的版本号无效")?;
    if let Some(tag) = selected_tag {
        let expected =
            Version::parse(tag.trim_start_matches('v')).map_err(|_| "所选发布的版本号无效")?;
        if parsed != expected {
            return Err("更新清单与所选发布版本不一致".into());
        }
        return Ok(true);
    }
    Ok(parsed.pre.is_empty())
}

/// Require the signed manifest and every updater package before considering a release usable.
fn manifest_url(release: &GithubRelease) -> AppResult<Url> {
    let expected = [
        format!("power-switch-{}-macos-universal.tar.gz", release.tag_name),
        format!("power-switch-{}-windows-x64.msi", release.tag_name),
        format!("power-switch-{}-windows-arm64.msi", release.tag_name),
        format!("power-switch-{}-linux-x64.AppImage", release.tag_name),
        format!("power-switch-{}-linux-arm64.AppImage", release.tag_name),
    ];
    if expected.iter().any(|name| {
        !release
            .assets
            .iter()
            .any(|asset| asset.name == *name && asset.state == "uploaded" && asset.size > 0)
    }) {
        return Err("最新发布缺少更新包，请稍后再检查".into());
    }
    let manifest = release
        .assets
        .iter()
        .find(|asset| asset.name == "latest.json" && asset.state == "uploaded" && asset.size > 0)
        .ok_or("最新发布缺少更新清单，请稍后再检查")?;
    let expected_url = format!("{RELEASE_ASSET_PREFIX}{}/latest.json", release.tag_name);
    if manifest.browser_download_url != expected_url {
        return Err("更新清单地址与发布版本不匹配".into());
    }
    Url::parse(&manifest.browser_download_url).map_err(|_| "更新清单地址无效".into())
}

/// List published releases through the official API so RC builds can be found without changing the stable feed.
async fn github_releases() -> AppResult<Vec<GithubRelease>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("power-switch-updater")
        .build()
        .map_err(|error| format!("无法初始化更新检查：{error}"))?;
    let mut releases = Vec::new();
    for page in 1..=10 {
        let batch: Vec<GithubRelease> = client
            .get(format!("{RELEASES_API}?per_page=100&page={page}"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("无法获取 GitHub 发布列表：{error}"))?
            .json()
            .await
            .map_err(|error| format!("无法解析 GitHub 发布列表：{error}"))?;
        let count = batch.len();
        releases.extend(batch);
        if count < 100 {
            return Ok(releases);
        }
    }
    Err("发布列表过长，无法安全判断最新版本".into())
}

/// Let Tauri parse the signed manifest and compare it with this installed app version.
async fn find_update(app: &AppHandle, include_rc: bool) -> AppResult<Option<Update>> {
    let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
    let mut selected_tag = None;
    if include_rc {
        let releases = github_releases().await?;
        let latest = newest_release(&releases, true).ok_or("没有可用的正式版或 RC 发布")?;
        selected_tag = Some(latest.tag_name.clone());
        builder = builder
            .endpoints(vec![manifest_url(latest)?])
            .map_err(|error| format!("更新地址无效：{error}"))?;
    }
    let update = builder
        .build()
        .map_err(|error| format!("无法初始化更新器：{error}"))?
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    match update {
        Some(update) if version_allowed(&update.version, selected_tag.as_deref())? => {
            Ok(Some(update))
        }
        _ => Ok(None),
    }
}

/// Check metadata only; package download is reserved for the separate confirmed command.
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, Mutex<Engine>>,
) -> AppResult<Option<UpdateInfo>> {
    let include_rc = receive_rc(&state)?;
    Ok(find_update(&app, include_rc)
        .await?
        .map(|update| UpdateInfo {
            version: update.version,
            notes: update.body,
        }))
}

/// Recheck the chosen version after confirmation, then download, verify and install it.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, Mutex<Engine>>,
    version: String,
) -> AppResult<()> {
    let include_rc = receive_rc(&state)?;
    let update = find_update(&app, include_rc)
        .await?
        .ok_or("当前没有可用更新，请重新检查")?;
    if update.version != version {
        return Err("可用版本已变化，请重新检查后确认".into());
    }
    let mut downloaded = 0_u64;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let percent = total
                    .filter(|size| *size > 0)
                    .map(|size| downloaded.saturating_mul(100).saturating_div(size).min(100) as u8);
                let _ = progress_app.emit(UPDATE_PROGRESS_EVENT, percent);
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载安装失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the published asset list used by update-channel selection tests.
    fn release(tag: &str, prerelease: bool) -> GithubRelease {
        let names = [
            format!("power-switch-{tag}-macos-universal.tar.gz"),
            format!("power-switch-{tag}-windows-x64.msi"),
            format!("power-switch-{tag}-windows-arm64.msi"),
            format!("power-switch-{tag}-linux-x64.AppImage"),
            format!("power-switch-{tag}-linux-arm64.AppImage"),
            "latest.json".into(),
        ];
        GithubRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease,
            assets: names
                .into_iter()
                .map(|name| GithubAsset {
                    browser_download_url: format!("{RELEASE_ASSET_PREFIX}{tag}/{name}"),
                    name,
                    size: 100,
                    state: "uploaded".into(),
                })
                .collect(),
        }
    }

    /// Stable users see only the final release; RC users see the highest eligible version.
    #[test]
    fn selects_the_requested_channel() {
        let releases = vec![
            release("v0.1.6-rc.1", true),
            release("v0.1.5", false),
            release("v0.1.6-rc.2", true),
            release("v0.1.7-beta.1", true),
            GithubRelease {
                draft: true,
                ..release("v0.1.8-rc.1", true)
            },
        ];
        assert_eq!(newest_release(&releases, false).unwrap().tag_name, "v0.1.5");
        assert_eq!(
            newest_release(&releases, true).unwrap().tag_name,
            "v0.1.6-rc.2"
        );
        let mut with_final = releases;
        with_final.push(release("v0.1.6", false));
        assert_eq!(
            newest_release(&with_final, true).unwrap().tag_name,
            "v0.1.6"
        );
    }

    /// An incomplete or redirected release cannot become an updater endpoint.
    #[test]
    fn rejects_incomplete_or_foreign_assets() {
        let mut candidate = release("v0.1.6-rc.2", true);
        candidate
            .assets
            .retain(|asset| !asset.name.ends_with(".msi"));
        assert!(manifest_url(&candidate).is_err());
        let mut candidate = release("v0.1.6-rc.2", true);
        candidate.assets.last_mut().unwrap().browser_download_url =
            "https://example.com/latest.json".into();
        assert!(manifest_url(&candidate).is_err());
    }

    /// A copied RC manifest cannot leak through the stable endpoint or impersonate another tag.
    #[test]
    fn validates_the_manifest_channel() {
        assert!(!version_allowed("0.1.6-rc.2", None).unwrap());
        assert!(version_allowed("0.1.6", None).unwrap());
        assert!(version_allowed("0.1.6-rc.2", Some("v0.1.6-rc.2")).unwrap());
        assert!(version_allowed("0.1.6-rc.1", Some("v0.1.6-rc.2")).is_err());
    }
}
