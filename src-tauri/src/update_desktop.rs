use crate::{engine::Engine, model::AppResult};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const RELEASES_API: &str = "https://api.github.com/repos/winwin-inc/power-switch/releases";
const RELEASE_ASSET_PREFIX: &str = "https://github.com/winwin-inc/power-switch/releases/download/";
const STABLE_MANIFEST_URL: &str =
    "https://github.com/winwin-inc/power-switch/releases/latest/download/latest.json";
const GHFAST_PREFIX: &str = "https://ghfast.top/";
const UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const RELEASE_PAGE_ATTEMPTS: u32 = 3;

struct ReleasePageError {
    message: String,
    retryable: bool,
}

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

/// Proxy only this repository's HTTPS release assets through the download accelerator.
fn ghfast_url(original: &Url) -> AppResult<Url> {
    let path = original.path();
    if original.scheme() != "https"
        || original.host_str() != Some("github.com")
        || original.port().is_some()
        || !original.username().is_empty()
        || original.password().is_some()
        || original.query().is_some()
        || original.fragment().is_some()
        || !(path.starts_with("/winwin-inc/power-switch/releases/download/")
            || path.starts_with("/winwin-inc/power-switch/releases/latest/download/"))
    {
        return Err("更新资源地址不是受支持的 GitHub Release 地址".into());
    }
    Url::parse(&format!("{GHFAST_PREFIX}{original}")).map_err(|_| "GitHub 加速地址无效".into())
}

/// 校验 HTTP 状态及完整 JSON；瞬时传输、截断和网关响应允许重试，限流和字段错误不重试。
async fn release_page(
    client: &reqwest::Client,
    api: &str,
    page: u32,
) -> Result<Vec<GithubRelease>, ReleasePageError> {
    let response = client
        .get(api)
        .query(&[("per_page", 100), ("page", page)])
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| ReleasePageError {
            message: format!("无法连接 GitHub 更新服务：{error}"),
            retryable: true,
        })?;
    let status = response.status();
    if !status.is_success() {
        let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || (status == reqwest::StatusCode::FORBIDDEN
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|remaining| remaining == "0"));
        return Err(ReleasePageError {
            message: if rate_limited {
                "GitHub 更新检查请求受到限流，请稍后重试".into()
            } else {
                format!("GitHub 更新服务返回 HTTP {status}，请稍后重试")
            },
            retryable: status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT,
        });
    }
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| {
            let mime = mime.trim();
            mime.eq_ignore_ascii_case("application/json")
                || mime.eq_ignore_ascii_case("application/vnd.github+json")
        });
    if !is_json {
        return Err(ReleasePageError {
            message: "GitHub 更新服务返回了非 JSON 响应，请稍后重试".into(),
            retryable: true,
        });
    }
    let bytes = response.bytes().await.map_err(|error| ReleasePageError {
        message: format!("GitHub 发布列表接收中断：{error}"),
        retryable: true,
    })?;
    serde_json::from_slice(&bytes).map_err(|error| ReleasePageError {
        message: if error.is_eof() {
            "GitHub 发布列表响应不完整，请稍后重试".into()
        } else {
            format!(
                "GitHub 发布列表格式异常（第 {} 行，第 {} 列），请稍后重试",
                error.line(),
                error.column()
            )
        },
        retryable: error.is_eof() || error.is_syntax(),
    })
}

/// 按页有限退避重试；失败页不会被当作空列表，也不会重复累加已成功的页面。
async fn github_releases_from(
    client: &reqwest::Client,
    api: &str,
    retry_delay: Duration,
) -> AppResult<Vec<GithubRelease>> {
    let mut releases = Vec::new();
    for page in 1..=10 {
        let mut attempt = 0;
        let batch = loop {
            attempt += 1;
            match release_page(client, api, page).await {
                Ok(batch) => break batch,
                Err(error) if error.retryable && attempt < RELEASE_PAGE_ATTEMPTS => {
                    tokio::time::sleep(retry_delay * attempt).await;
                }
                Err(error) => {
                    return Err(format!(
                        "{}（第 {page} 页，已尝试 {attempt} 次）",
                        error.message
                    ));
                }
            }
        };
        let count = batch.len();
        releases.extend(batch);
        if count < 100 {
            return Ok(releases);
        }
    }
    Err("发布列表过长，无法安全判断最新版本".into())
}

/// 保留单次请求 15 秒及整次扫描 30 秒上限，防止重试或分页让检查无限等待。
async fn github_releases() -> AppResult<Vec<GithubRelease>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("power-switch-updater")
        .build()
        .map_err(|error| format!("无法初始化更新检查：{error}"))?;
    tokio::time::timeout(
        Duration::from_secs(30),
        github_releases_from(&client, RELEASES_API, Duration::from_millis(300)),
    )
    .await
    .map_err(|_| "获取 GitHub 发布列表超时，请稍后重试".to_string())?
}

/// Retry malformed, unreachable, or invalid accelerated manifests from GitHub.
async fn check_manifest(
    app: &AppHandle,
    original: &Url,
    selected_tag: Option<&str>,
) -> AppResult<Option<Update>> {
    let accelerated = ghfast_url(original)?;
    let mut accelerated_error = None;
    for (endpoint, timeout) in [
        (accelerated, Duration::from_secs(10)),
        (original.clone(), Duration::from_secs(30)),
    ] {
        let result: AppResult<Option<Update>> = async {
            let update = app
                .updater_builder()
                .timeout(timeout)
                .endpoints(vec![endpoint])
                .map_err(|error| format!("更新地址无效：{error}"))?
                .build()
                .map_err(|error| format!("无法初始化更新器：{error}"))?
                .check()
                .await
                .map_err(|error| format!("检查更新失败：{error}"))?;
            match update {
                Some(update) if version_allowed(&update.version, selected_tag)? => {
                    ghfast_url(&update.download_url)?;
                    Ok(Some(update))
                }
                Some(_) => Err("更新清单的版本不在当前通道".into()),
                None => Ok(None),
            }
        }
        .await;
        match result {
            Ok(update) => return Ok(update),
            Err(error) => {
                if let Some(first_error) = accelerated_error.take() {
                    return Err(format!(
                        "加速源和 GitHub 均无法检查更新：加速源：{first_error}；GitHub：{error}"
                    ));
                }
                accelerated_error = Some(error);
            }
        }
    }
    Err("无法检查更新".into())
}

/// Let Tauri compare the selected release manifest with this installed app version.
async fn find_update(app: &AppHandle, include_rc: bool) -> AppResult<Option<Update>> {
    let (manifest, selected_tag) = if include_rc {
        let releases = github_releases().await?;
        let latest = newest_release(&releases, true).ok_or("没有可用的正式版或 RC 发布")?;
        (manifest_url(latest)?, Some(latest.tag_name.clone()))
    } else {
        (
            Url::parse(STABLE_MANIFEST_URL).map_err(|_| "正式版更新地址无效")?,
            None,
        )
    };
    check_manifest(app, &manifest, selected_tag.as_deref()).await
}

/// Download and verify a package while reporting progress for the current source.
async fn download_update(update: &Update, app: &AppHandle) -> AppResult<Vec<u8>> {
    let mut downloaded = 0_u64;
    update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let percent = total
                    .filter(|size| *size > 0)
                    .map(|size| downloaded.saturating_mul(100).saturating_div(size).min(100) as u8);
                let _ = app.emit(UPDATE_PROGRESS_EVENT, percent);
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载安装失败：{error}"))
}

/// Check metadata only; package download is reserved for the separate confirmed command.
#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, Mutex<Engine>>,
) -> AppResult<Option<UpdateInfo>> {
    if cfg!(feature = "store-msix") {
        return Ok(None);
    }
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
    if cfg!(feature = "store-msix") {
        return Err("Microsoft Store 版本由商店管理更新".into());
    }
    let include_rc = receive_rc(&state)?;
    let mut update = find_update(&app, include_rc)
        .await?
        .ok_or("当前没有可用更新，请重新检查")?;
    if update.version != version {
        return Err("可用版本已变化，请重新检查后确认".into());
    }
    let mut accelerated = update.clone();
    accelerated.download_url = ghfast_url(&update.download_url)?;
    accelerated.timeout = Some(Duration::from_secs(30));
    update.timeout = Some(Duration::from_secs(60));
    let bytes = match download_update(&accelerated, &app).await {
        Ok(bytes) => bytes,
        Err(accelerated_error) => {
            let _ = app.emit(UPDATE_PROGRESS_EVENT, None::<u8>);
            download_update(&update, &app).await.map_err(|original_error| {
                format!(
                    "加速源和 GitHub 均无法下载更新：加速源：{accelerated_error}；GitHub：{original_error}"
                )
            })?
        }
    };
    update
        .install(bytes)
        .map_err(|error| format!("下载安装失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use wiremock::{
        matchers::{header, method, path, query_param},
        Mock, MockServer, Request, ResponseTemplate,
    };

    /// 使用无代理本地客户端，使发布响应与重试测试不依赖真实 GitHub 或系统代理。
    fn local_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    /// 生成包含真实必需字段及可忽略扩展字段的 GitHub 发布列表样本。
    fn release_json(tag: &str) -> serde_json::Value {
        let release = release(tag, tag.contains("-rc"));
        serde_json::json!({
            "tag_name": release.tag_name,
            "draft": release.draft,
            "prerelease": release.prerelease,
            "new_github_field": null,
            "assets": release.assets.iter().map(|asset| serde_json::json!({
                "name": asset.name,
                "browser_download_url": asset.browser_download_url,
                "size": asset.size,
                "state": asset.state
            })).collect::<Vec<_>>()
        })
    }

    /// 截断 JSON、200 HTML 网关页及 502 均会有限重试，并正确恢复发布和 RC 版本选择。
    #[tokio::test]
    async fn recovers_transient_release_page_failures() {
        for failed in [
            ResponseTemplate::new(200).set_body_raw("[{\"tag_name\":", "application/json"),
            ResponseTemplate::new(200).set_body_raw("not json", "application/json"),
            ResponseTemplate::new(200).set_body_raw("<html>gateway</html>", "text/html"),
            ResponseTemplate::new(502),
        ] {
            let server = MockServer::start().await;
            let attempts = Arc::new(AtomicUsize::new(0));
            let received = attempts.clone();
            Mock::given(method("GET"))
                .and(path("/releases"))
                .and(query_param("per_page", "100"))
                .and(query_param("page", "1"))
                .and(header("accept", "application/vnd.github+json"))
                .and(header("x-github-api-version", "2022-11-28"))
                .and(header("accept-encoding", "gzip"))
                .respond_with(move |_: &Request| {
                    if received.fetch_add(1, Ordering::SeqCst) == 0 {
                        failed.clone()
                    } else {
                        ResponseTemplate::new(200).set_body_json(serde_json::json!([
                            release_json("v0.1.11"),
                            release_json("v0.1.12-rc.1")
                        ]))
                    }
                })
                .expect(2)
                .mount(&server)
                .await;
            let releases = github_releases_from(
                &local_client(),
                &format!("{}/releases", server.uri()),
                Duration::ZERO,
            )
            .await
            .unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), 2);
            assert_eq!(
                newest_release(&releases, false).unwrap().tag_name,
                "v0.1.11"
            );
            assert_eq!(
                newest_release(&releases, true).unwrap().tag_name,
                "v0.1.12-rc.1"
            );
        }
    }

    /// 字段不兼容、限流和不存在的仓库不盲目重试，也不能伪装成无更新。
    #[tokio::test]
    async fn rejects_schema_and_rate_limit_errors_without_retrying() {
        for (response, message) in [
            (
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "tag_name": "v0.1.12", "draft": false, "prerelease": false
                }])),
                "格式异常",
            ),
            (
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"message": "upstream error"})),
                "格式异常",
            ),
            (
                ResponseTemplate::new(403).insert_header("x-ratelimit-remaining", "0"),
                "受到限流",
            ),
            (ResponseTemplate::new(429), "受到限流"),
            (ResponseTemplate::new(404), "HTTP 404"),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(response)
                .expect(1)
                .mount(&server)
                .await;
            let error = github_releases_from(&local_client(), &server.uri(), Duration::ZERO)
                .await
                .err()
                .unwrap();
            assert!(error.contains(message), "{error}");
            assert!(error.contains("已尝试 1 次"), "{error}");
        }
    }

    /// 单次请求超时后重新请求，不让一次缓慢连接导致整次更新检查立即失败。
    #[tokio::test]
    async fn recovers_a_timed_out_release_request() {
        let server = MockServer::start().await;
        let attempts = AtomicUsize::new(0);
        Mock::given(method("GET"))
            .respond_with(move |_: &Request| {
                let response =
                    ResponseTemplate::new(200).set_body_json(vec![release_json("v0.1.11")]);
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    response.set_delay(Duration::from_millis(500))
                } else {
                    response
                }
            })
            .expect(2)
            .mount(&server)
            .await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let releases = github_releases_from(&client, &server.uri(), Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v0.1.11");
    }

    /// 请求 gzip 并透明解压；压缩流被截断时重试完整响应，覆盖真实读取阶段错误。
    #[tokio::test]
    async fn recovers_a_truncated_gzip_release_response() {
        use base64::Engine as _;

        let gzip = base64::engine::general_purpose::STANDARD
            .decode("H4sIAAAAAAAAE4uuVipJTI/PS8xNVbJSKjPQM9QzNFTSUUopSkwrUbJKS8wpTtVRKihKLUrNSU0sToULJRYXp5YUK1lFx9bGAgC71jsyRQAAAA==")
            .unwrap();
        let server = MockServer::start().await;
        let attempts = AtomicUsize::new(0);
        Mock::given(method("GET"))
            .and(header("accept-encoding", "gzip"))
            .respond_with(move |_: &Request| {
                let mut body = gzip.clone();
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    body.truncate(body.len() / 2);
                }
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .insert_header("content-encoding", "gzip")
                    .set_body_bytes(body)
            })
            .expect(2)
            .mount(&server)
            .await;
        let releases = github_releases_from(&local_client(), &server.uri(), Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v0.1.11");
    }

    /// 持续错误最多请求三次，保留失败结果，不把损坏的响应当作空发布列表。
    #[tokio::test]
    async fn stops_after_three_invalid_responses() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("[", "application/json"))
            .expect(3)
            .mount(&server)
            .await;
        let error = github_releases_from(&local_client(), &server.uri(), Duration::ZERO)
            .await
            .err()
            .unwrap();
        assert!(error.contains("响应不完整"));
        assert!(error.contains("已尝试 3 次"));
    }

    /// 第二页失败只重试第二页；已经读取的第一页不会重复或被部分结果替代。
    #[tokio::test]
    async fn retries_only_the_failed_page() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("page", "1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(vec![release_json("v0.1.11"); 100]),
            )
            .expect(1)
            .mount(&server)
            .await;
        let attempts = AtomicUsize::new(0);
        Mock::given(method("GET"))
            .and(query_param("page", "2"))
            .respond_with(move |_: &Request| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(200).set_body_raw("[", "application/json")
                } else {
                    ResponseTemplate::new(200).set_body_json(vec![release_json("v0.1.12-rc.1")])
                }
            })
            .expect(2)
            .mount(&server)
            .await;
        let releases = github_releases_from(&local_client(), &server.uri(), Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(releases.len(), 101);
        assert_eq!(
            newest_release(&releases, true).unwrap().tag_name,
            "v0.1.12-rc.1"
        );
    }

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

    /// Mirror only trusted release paths, including stable and versioned manifests.
    #[test]
    fn builds_trusted_ghfast_urls() {
        let stable = Url::parse(STABLE_MANIFEST_URL).unwrap();
        assert_eq!(
            ghfast_url(&stable).unwrap().as_str(),
            format!("{GHFAST_PREFIX}{STABLE_MANIFEST_URL}")
        );
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = config["plugins"]["updater"]["endpoints"]
            .as_array()
            .unwrap();
        assert_eq!(
            endpoints[0].as_str(),
            Some(ghfast_url(&stable).unwrap().as_str())
        );
        assert_eq!(endpoints[1].as_str(), Some(STABLE_MANIFEST_URL));
        let package = Url::parse(
            "https://github.com/winwin-inc/power-switch/releases/download/v0.1.6/power-switch-v0.1.6-macos-universal.tar.gz",
        )
        .unwrap();
        assert_eq!(
            ghfast_url(&package).unwrap().as_str(),
            format!("{GHFAST_PREFIX}{package}")
        );
        assert!(ghfast_url(&Url::parse("https://example.com/update.tar.gz").unwrap()).is_err());
        assert!(ghfast_url(
            &Url::parse(
                "http://github.com/winwin-inc/power-switch/releases/download/v0.1.6/latest.json"
            )
            .unwrap()
        )
        .is_err());
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
