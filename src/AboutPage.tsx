import type { MouseEvent } from "react";
import { ExternalLink, Github, LoaderCircle, RotateCw } from "lucide-react";
import packageJson from "../package.json";
import { isDesktop } from "./api";
import { aboutLinkUrl, openAboutLink, type AboutLink } from "./about-api";
import type { Settings } from "./types";
import type { UpdateState } from "./updater";

/** Present app identity and update preferences while App owns the ongoing update lifecycle. */
export function AboutPage({
  settings,
  busy,
  isStoreBuild,
  updateState,
  onUpdateSave,
  onCheckUpdate,
  onShowUpdate,
  onError,
}: {
  settings: Pick<Settings, "autoUpdate" | "receiveRc">;
  busy: boolean;
  isStoreBuild: boolean;
  updateState: UpdateState;
  onUpdateSave: (
    preferences: Pick<Settings, "autoUpdate" | "receiveRc">,
  ) => void;
  onCheckUpdate: () => void;
  onShowUpdate: () => void;
  onError: (message: string) => void;
}) {
  const updateLocked =
    busy || updateState.kind === "installing" || updateState.kind === "ready";

  /** Keep browser links native; route desktop clicks to the OS and report opening failures. */
  function openLink(event: MouseEvent<HTMLAnchorElement>, link: AboutLink) {
    if (!isDesktop) return;
    event.preventDefault();
    void openAboutLink(link).catch((error) =>
      onError(`无法打开链接：${String(error)}`),
    );
  }

  return (
    <div className="about-page">
      <section className="about-card" aria-labelledby="about-app-name">
        <div className="about-identity">
          <img src="/icon.png" alt="power-switch 图标" />
          <div className="about-app-details">
            <h2 id="about-app-name">power-switch</h2>
            <p>v{packageJson.version}</p>
          </div>
          {!isStoreBuild && (
            <button
              type="button"
              className="button secondary about-check-update"
              disabled={
                updateLocked || !isDesktop || updateState.kind === "checking"
              }
              onClick={onCheckUpdate}
            >
              {updateState.kind === "checking" ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <RotateCw size={17} />
              )}
              {updateState.kind === "checking" ? "正在检查" : "检查更新"}
            </button>
          )}
        </div>
        <div className="about-updates">
          {isStoreBuild ? (
            <p className="about-store-note">
              此版本由 Microsoft Store 管理更新，请在商店中查看新版本。
            </p>
          ) : (
            <>
              <div className="update-preference-row">
                <div>
                  <strong>启动时检查更新</strong>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="启动时检查更新"
                  aria-checked={settings.autoUpdate}
                  className="settings-switch"
                  disabled={updateLocked}
                  onClick={() =>
                    onUpdateSave({
                      autoUpdate: !settings.autoUpdate,
                      receiveRc: settings.autoUpdate
                        ? false
                        : settings.receiveRc,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <div className="update-preference-row">
                <div>
                  <strong>测试计划</strong>
                  <p id="about-rc-description">接收 RC 预发布版本。</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="测试计划"
                  aria-describedby="about-rc-description"
                  aria-checked={settings.receiveRc}
                  className="settings-switch"
                  disabled={updateLocked || !settings.autoUpdate}
                  onClick={() =>
                    onUpdateSave({
                      autoUpdate: true,
                      receiveRc: !settings.receiveRc,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              {updateState.kind === "available" && (
                <button
                  type="button"
                  className="button secondary update-available-button"
                  onClick={onShowUpdate}
                >
                  发现 v{updateState.version}，查看更新
                </button>
              )}
              {updateState.kind === "error" && (
                <p role="status" className="update-error-text">
                  {updateState.message}
                </p>
              )}
            </>
          )}
        </div>
        <div className="about-links">
          <a
            href={aboutLinkUrl("github")}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => openLink(event, "github")}
          >
            <Github size={15} aria-hidden="true" /> GitHub
          </a>
          <a
            href={aboutLinkUrl("changelog")}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => openLink(event, "changelog")}
          >
            <ExternalLink size={15} aria-hidden="true" /> 更新日志
          </a>
        </div>
      </section>
    </div>
  );
}
