import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Cable,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  Copy,
  Download,
  FileClock,
  Info,
  FlaskConical,
  FolderCog,
  FolderOpen,
  BookOpen,
  Layers3,
  Link2,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import packageJson from "../package.json";
import { api, isDesktop } from "./api";
import { backupAgents } from "./backup-platform";
import {
  checkForUpdate,
  installPendingUpdate,
  restartUpdatedApp,
  type UpdateState,
} from "./updater";
import { pickLocalPath } from "./file-picker";
import { AboutPage } from "./AboutPage";
import { Brand } from "./Brand";
import { SkillsPage } from "./SkillsPage";
import { McpPage } from "./McpPage";
import { NewApiDialog } from "./NewApiDialog";
import { NewcomerGuide } from "./NewcomerGuide";
import {
  InitializationSection,
  InitializationConfirmation,
} from "./ConfigurationInitialization";
import {
  AgentPicker,
  ApplyReview,
  Modal,
  ModalFooter,
  ModelForm,
  ModelTestFeedback,
  ProtocolMark,
} from "./components";
import { MoreActions, PageHeader } from "./ui";
import {
  agentLabels,
  formatTime,
  nativeAgent,
  newModel,
  modelTestKey,
  modelTestSuccess,
  protocolLabels,
  type AppData,
  type AgentKind,
  type ApplyPreview,
  type BackupRecord,
  type ImportPreview,
  type ImportOutcome,
  type ModelConfig,
  type ModelTestState,
  type Settings,
  type InitializationOptions,
} from "./types";

const isStoreBuild = import.meta.env.VITE_STORE_MSIX === "1";

type Page = "models" | "backups" | "settings" | "about" | "skills" | "mcp";
type ModalState =
  | { kind: "initialize"; options: InitializationOptions }
  | { kind: "guide" }
  | { kind: "new-api" }
  | { kind: "model"; model: ModelConfig; copy?: boolean }
  | { kind: "agents"; model: ModelConfig }
  | { kind: "review"; preview: ApplyPreview }
  | { kind: "import" }
  | { kind: "import-review"; preview: ImportPreview }
  | { kind: "import-result"; outcome: ImportOutcome }
  | { kind: "share"; model: ModelConfig }
  | { kind: "delete"; model: ModelConfig }
  | { kind: "delete-backup"; backup: BackupRecord }
  | { kind: "delete-all-backups" }
  | { kind: "update-confirm"; version: string }
  | null;
type Notice = { kind: "success" | "error"; text: string } | null;

/** Coordinate desktop state and the explicitly confirmed model/apply/import workflows. */
export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [themePreview, setThemePreview] = useState<Settings["theme"] | null>(
    null,
  );
  const theme = themePreview ?? data?.settings.theme ?? "system";
  const [page, setPage] = useState<Page>("models");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [backupFilter, setBackupFilter] = useState<"all" | AgentKind>("all");
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [initializationError, setInitializationError] = useState("");
  const [notice, setNoticeState] = useState<Notice>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const updateCheckRevision = useRef(0);
  const updateInstallation = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeRevision = useRef(0);
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>(
    {},
  );
  const pendingTests = useRef(new Map<string, symbol>());
  const [links, setLinks] = useState<string[]>([]);
  const seenLinks = useRef(new Map<string, number>());
  /** Show a notice for five seconds, restarting its timer when replaced or manually dismissed. */
  const setNotice = useCallback((next: Notice) => {
    noticeRevision.current += 1;
    const revision = noticeRevision.current;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNoticeState(next);
    if (!next) return;
    noticeTimer.current = setTimeout(() => {
      if (noticeRevision.current !== revision) return;
      noticeTimer.current = null;
      setNoticeState(null);
    }, 5000);
  }, []);
  useEffect(
    () => () => {
      noticeRevision.current += 1;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  /** Reload authoritative native state following a successful mutation. */
  const refresh = useCallback(async () => {
    setData(await api.data());
  }, []);
  /** 首次读取失败时保留可重试错误状态，重试期间重新显示加载状态。 */
  const loadLibrary = useCallback(async () => {
    setLoadError("");
    try {
      await refresh();
    } catch (error) {
      setLoadError(String(error));
    }
  }, [refresh]);
  /** Ignore older checks when a manual retry or saved channel change starts a newer one. */
  const requestUpdateCheck = useCallback(
    (manual = false) => {
      if (updateInstallation.current) return;
      const revision = ++updateCheckRevision.current;
      setUpdateState({ kind: "checking" });
      void checkForUpdate()
        .then((update) => {
          if (revision !== updateCheckRevision.current) return;
          setUpdateState(
            update
              ? { kind: "available", version: update.version }
              : { kind: "idle" },
          );
          if (manual && !update)
            setNotice({ kind: "success", text: "当前更新通道已是最新版本。" });
        })
        .catch((error) => {
          if (revision !== updateCheckRevision.current) return;
          setUpdateState({ kind: "error", message: String(error) });
          if (manual) setNotice({ kind: "error", text: String(error) });
        });
    },
    [setNotice],
  );
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);
  useEffect(() => {
    if (!isDesktop || !data || isStoreBuild) return;
    if (updateInstallation.current) return;
    updateCheckRevision.current += 1;
    setUpdateState({ kind: "idle" });
    if (!data.settings.autoUpdate) {
      return;
    }
    const timer = setTimeout(() => {
      requestUpdateCheck();
    }, 1800);
    return () => {
      updateCheckRevision.current += 1;
      clearTimeout(timer);
    };
  }, [data?.settings.autoUpdate, data?.settings.receiveRc, requestUpdateCheck]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** Apply explicit appearance or react to OS appearance changes. */
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        theme === "dark" || (theme === "system" && media.matches)
          ? "dark"
          : "light";
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);
  useEffect(() => {
    if (!isDesktop) return;
    let canceled = false;
    let unlisten: (() => void) | undefined;
    /** Queue delivered URLs once across cold-start and running-instance events. */
    function receive(urls: string[] | null) {
      if (canceled) return;
      const now = Date.now();
      for (const [url, time] of seenLinks.current)
        if (now - time > 10000) seenLinks.current.delete(url);
      const accepted = (urls ?? []).filter((url) => {
        if (seenLinks.current.has(url)) return false;
        seenLinks.current.set(url, now);
        return true;
      });
      if (accepted.length)
        setLinks((old) => [...old, ...accepted].slice(0, 10));
    }
    void import("@tauri-apps/plugin-deep-link")
      .then(async (plugin) => {
        const off = await plugin.onOpenUrl(receive);
        if (canceled) {
          off();
          return;
        }
        unlisten = off;
        receive(await plugin.getCurrent());
      })
      .catch(() => {
        if (!canceled)
          setNotice({
            kind: "error",
            text: "链接监听未就绪；仍可使用“导入链接”粘贴导入。",
          });
      });
    return () => {
      canceled = true;
      unlisten?.();
    };
  }, [setNotice]);
  useEffect(() => {
    if (!links.length || modal || busy || !data) return;
    const link = links[0];
    setLinks((old) => old.slice(1));
    setBusy(true);
    void api
      .importPreview(link)
      .then((preview) => setModal({ kind: "import-review", preview }))
      .catch((e) => setNotice({ kind: "error", text: String(e) }))
      .finally(() => setBusy(false));
  }, [links, modal, busy, data, setNotice]);

  /** Run one UI mutation with visible progress and safe error reporting. */
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }
  /** 确认后才开始安装；安装失败以明确通知反馈，保留关于页的错误和重试入口。 */
  function beginUpdateInstall() {
    if (updateState.kind !== "available") return;
    const version = updateState.version;
    updateInstallation.current = true;
    updateCheckRevision.current += 1;
    setModal(null);
    setUpdateState({ kind: "installing", percentage: 0 });
    void installPendingUpdate(version, (percentage) =>
      setUpdateState({ kind: "installing", percentage }),
    )
      .then(() => setUpdateState({ kind: "ready" }))
      .catch((error) => {
        updateInstallation.current = false;
        setUpdateState({ kind: "error", message: String(error) });
        setNotice({ kind: "error", text: String(error) });
      });
  }
  /** Discard staged native contents when the user cancels either kind of preview. */
  function closeModal() {
    if (busy) return;
    if (modal?.kind === "review" || modal?.kind === "import-review")
      void api.cancel(modal.preview.token).catch(() => {});
    setModal(null);
  }
  /** Refresh persisted data and display a concise successful outcome. */
  async function done(text: string) {
    setModal(null);
    await refresh();
    setNotice({ kind: "success", text });
  }
  /** Test one saved model on demand; bind its transient indicator to the exact saved configuration. */
  async function testLibraryModel(model: ModelConfig) {
    if (pendingTests.current.has(model.id)) return;
    const request = Symbol();
    pendingTests.current.set(model.id, request);
    const key = modelTestKey(model);
    setModelTests((old) => ({
      ...old,
      [model.id]: {
        key,
        status: "testing",
        message: "正在发送 test，最长等待 30 秒…",
      },
    }));
    try {
      const result = await api.testModel(structuredClone(model));
      if (pendingTests.current.get(model.id) !== request) return;
      setModelTests((old) =>
        old[model.id]?.key === key && old[model.id]?.status === "testing"
          ? {
              ...old,
              [model.id]: {
                key,
                status: "passed",
                message: modelTestSuccess(result),
                expiresAt: Date.now() + 5000,
              },
            }
          : old,
      );
    } catch (error) {
      if (pendingTests.current.get(model.id) !== request) return;
      setModelTests((old) =>
        old[model.id]?.key === key && old[model.id]?.status === "testing"
          ? {
              ...old,
              [model.id]: {
                key,
                status: "failed",
                message: String(error),
                expiresAt: Date.now() + 5000,
              },
            }
          : old,
      );
    } finally {
      if (pendingTests.current.get(model.id) === request)
        pendingTests.current.delete(model.id);
    }
  }
  const visible = (data?.models ?? []).filter(
    (m) =>
      (filter === "all" || nativeAgent[m.protocol] === filter) &&
      `${m.name} ${m.modelId} ${m.baseUrl}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const visibleBackups = (data?.backups ?? []).filter(
    (backup) =>
      backupFilter === "all" ||
      backupAgents(backup, data?.agents ?? []).includes(backupFilter),
  );
  const titles = {
    models: "模型库",
    backups: "模型配置备份",
    settings: "设置",
    about: "关于",
    skills: "技能",
    mcp: "MCP 连接器",
  };
  const descriptions: Record<Page, string> = {
    models: "管理模型连接，为不同 Agent 选择合适的模型。",
    backups: "查看配置变更，在需要时恢复到之前的版本。",
    settings: "管理应用外观、配置位置和本地数据。",
    about: "查看应用版本、更新设置和项目信息。",
    skills: "管理 Agent 可使用的本地技能。",
    mcp: "管理远程工具连接，预览后应用到 Agent。",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand onNavigate={() => setPage("models")} />
        <nav aria-label="主导航">
          <button
            className={page === "models" ? "nav-item active" : "nav-item"}
            aria-current={page === "models" ? "page" : undefined}
            onClick={() => setPage("models")}
          >
            <Layers3 size={19} />
            模型库<span className="nav-count">{data?.models.length ?? 0}</span>
          </button>
          <button
            className={page === "backups" ? "nav-item active" : "nav-item"}
            aria-current={page === "backups" ? "page" : undefined}
            onClick={() => setPage("backups")}
          >
            <FileClock size={19} />
            模型配置备份
          </button>
          <button
            className={page === "mcp" ? "nav-item active" : "nav-item"}
            aria-current={page === "mcp" ? "page" : undefined}
            onClick={() => setPage("mcp")}
          >
            <Cable size={19} />
            MCP 连接器
          </button>
          <button className="nav-item" disabled title="待开放">
            <BookOpen size={19} />
            SKILL 技能<span className="nav-pending">待开放</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <nav className="sidebar-utilities" aria-label="应用与帮助">
            <button
              className={page === "settings" ? "nav-item active" : "nav-item"}
              aria-current={page === "settings" ? "page" : undefined}
              onClick={() => setPage("settings")}
            >
              <Settings2 size={19} />
              设置
            </button>
            <button
              className={page === "about" ? "nav-item active" : "nav-item"}
              aria-current={page === "about" ? "page" : undefined}
              onClick={() => setPage("about")}
            >
              <Info size={19} />
              关于
            </button>
            <button
              className="nav-item"
              type="button"
              onClick={() => setModal({ kind: "guide" })}
            >
              <CircleHelp size={19} /> 新手指引
            </button>
          </nav>
          <div className="sidebar-status">
            <div className="sidebar-status-row">
              <div className="privacy-box">
                <ShieldCheck size={14} aria-hidden="true" />
                <span>本机存储</span>
              </div>
              <div className="version">
                <span className="version-meta">
                  <span className="version-number">v{packageJson.version}</span>
                  {isDesktop && updateState.kind === "available" && (
                    <button
                      className="version-update-trigger"
                      type="button"
                      aria-label={`发现新版本 v${updateState.version}，查看更新`}
                      title={`可以升级到 v${updateState.version}`}
                      onClick={() =>
                        setModal({
                          kind: "update-confirm",
                          version: updateState.version,
                        })
                      }
                    >
                      <Download size={12} aria-hidden="true" />
                    </button>
                  )}
                  {isDesktop && updateState.kind === "checking" && (
                    <span
                      className="version-update-status"
                      role="status"
                      aria-label="正在检查更新"
                    >
                      <LoaderCircle size={13} className="spin" />
                    </span>
                  )}
                  {isDesktop && updateState.kind === "installing" && (
                    <span
                      className="version-update-status"
                      role="status"
                      aria-label={
                        updateState.percentage === null
                          ? "正在下载更新"
                          : `正在下载更新 ${updateState.percentage}%`
                      }
                    >
                      <LoaderCircle size={13} className="spin" />
                      {updateState.percentage !== null && (
                        <span className="version-update-progress">
                          {updateState.percentage}%
                        </span>
                      )}
                    </span>
                  )}
                  {isDesktop && updateState.kind === "ready" && (
                    <button
                      className="version-update-trigger"
                      type="button"
                      aria-label="更新完成，重启应用"
                      title="更新完成，点击重启应用"
                      onClick={() =>
                        void restartUpdatedApp().catch((error) => {
                          updateInstallation.current = false;
                          setUpdateState({
                            kind: "error",
                            message: String(error),
                          });
                          setNotice({ kind: "error", text: String(error) });
                        })
                      }
                    >
                      <RotateCw size={12} aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="page-content">
          {!isDesktop && (
            <div className="environment demo demo-banner">
              <span className="status-dot" /> 浏览器演示 · 不写入文件
            </div>
          )}
          {(page !== "mcp" || !data) && (
            <PageHeader
              title={titles[page]}
              description={descriptions[page]}
              actions={
                page === "models" ? (
                  <>
                    <button
                      className="button ghost"
                      disabled={busy}
                      onClick={() => setModal({ kind: "import" })}
                    >
                      <Link2 size={16} /> 导入链接
                    </button>
                    <button
                      className="button new-api-add"
                      disabled={busy}
                      onClick={() => setModal({ kind: "new-api" })}
                    >
                      <Download size={16} /> 从 New API 添加
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        setModal({ kind: "model", model: newModel() })
                      }
                    >
                      <Plus size={18} /> 添加模型
                    </button>
                  </>
                ) : undefined
              }
            />
          )}
          {!data ? (
            <div className="empty-state" role={loadError ? "alert" : "status"}>
              {loadError ? (
                <CircleAlert size={28} />
              ) : (
                <LoaderCircle className="spin" aria-hidden="true" />
              )}
              <h2>{loadError ? "无法打开模型库" : "正在打开模型库"}</h2>
              {loadError && (
                <>
                  <p>{loadError}</p>
                  <button
                    className="button secondary"
                    onClick={() => void loadLibrary()}
                  >
                    <RotateCw size={16} /> 重新加载
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              {page === "models" && (
                <>
                  <div className="collection-tools">
                    <div className="filter-tabs" aria-label="按 Agent 筛选">
                      {[
                        ["all", "全部模型"],
                        ["workbuddy", "WorkBuddy"],
                        ["claude", "Claude Code"],
                        ["codex", "Codex"],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={filter === value ? "selected" : ""}
                          aria-pressed={filter === value}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                          {value === "all" && <span>{data.models.length}</span>}
                        </button>
                      ))}
                    </div>
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="搜索模型"
                        placeholder="搜索名称、ID 或地址"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon-button"
                          aria-label="清空搜索"
                          onClick={() => setQuery("")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                  </div>
                  {visible.length ? (
                    <div className="model-list">
                      {visible.map((model) => {
                        const probe =
                          modelTests[model.id]?.key === modelTestKey(model)
                            ? modelTests[model.id]
                            : undefined;
                        return (
                          <article className="model-card" key={model.id}>
                            <div className="card-main">
                              <ProtocolMark
                                protocol={model.protocol}
                                name={model.name}
                              />
                              <div className="model-title">
                                <h2>
                                  {model.name}
                                  {(probe?.status === "passed" ||
                                    probe?.status === "failed") && (
                                    <span
                                      className={
                                        "model-test-status " + probe.status
                                      }
                                      role="img"
                                      aria-label={
                                        probe.status === "passed"
                                          ? "模型测试通过"
                                          : "模型测试未通过"
                                      }
                                      title={probe.message}
                                    >
                                      {probe.status === "passed" ? (
                                        <CheckCircle2
                                          size={14}
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <CircleAlert
                                          size={14}
                                          aria-hidden="true"
                                        />
                                      )}
                                      {probe.status === "passed"
                                        ? "测试通过"
                                        : "测试失败"}
                                    </span>
                                  )}
                                </h2>
                                <div className="model-meta">
                                  <span className="model-agent">
                                    {agentLabels[nativeAgent[model.protocol]]}
                                  </span>
                                  <span className="model-id">
                                    {model.modelId}
                                  </span>
                                </div>
                              </div>
                              <span
                                className={`tag protocol-tag ${model.protocol}`}
                              >
                                {protocolLabels[model.protocol]}
                              </span>
                            </div>
                            <div className="card-details">
                              <div>
                                <span className="detail-label">API 地址</span>
                                <span
                                  className="endpoint"
                                  title={model.baseUrl}
                                >
                                  {model.baseUrl}
                                </span>
                              </div>
                              <div className="credential">
                                <span className="detail-label">API KEY</span>
                                <span
                                  className={!model.apiKey ? "missing-key" : ""}
                                >
                                  {model.apiKey ? "••••••••••••" : "未设置"}
                                </span>
                              </div>
                            </div>
                            <div className="card-footer">
                              <div className="capability-tags">
                                {model.supportsToolCall && (
                                  <span>工具调用</span>
                                )}
                                {model.supportsImages && <span>图像输入</span>}
                                {model.contextWindow && (
                                  <span>
                                    {Math.round(model.contextWindow / 1000)}K
                                    上下文
                                  </span>
                                )}
                                {!!model.reasoningLevels.length && (
                                  <span>推理模型</span>
                                )}
                              </div>
                              <div className="card-actions">
                                <button
                                  className="button ghost"
                                  aria-label={"编辑 " + model.name}
                                  disabled={busy}
                                  onClick={() =>
                                    setModal({
                                      kind: "model",
                                      model: structuredClone(model),
                                    })
                                  }
                                >
                                  <Pencil size={16} /> 编辑
                                </button>
                                <button
                                  className="button secondary"
                                  aria-label={"测试模型 " + model.name}
                                  disabled={busy || probe?.status === "testing"}
                                  onClick={() => void testLibraryModel(model)}
                                >
                                  {probe?.status === "testing" ? (
                                    <LoaderCircle size={16} className="spin" />
                                  ) : (
                                    <FlaskConical size={16} />
                                  )}
                                  {probe?.status === "testing"
                                    ? "测试中"
                                    : "测试模型"}
                                </button>
                                <button
                                  className="button primary"
                                  disabled={busy}
                                  onClick={() =>
                                    setModal({ kind: "agents", model })
                                  }
                                >
                                  应用到 Agent <ArrowRight size={16} />
                                </button>
                                <MoreActions
                                  label={"更多操作 " + model.name}
                                  disabled={busy}
                                  actions={[
                                    {
                                      label: "复制模型",
                                      accessibleLabel: "复制 " + model.name,
                                      icon: <Copy size={16} />,
                                      onSelect: () =>
                                        setModal({
                                          kind: "model",
                                          copy: true,
                                          model: {
                                            ...structuredClone(model),
                                            id: "",
                                            name: model.name + " · 副本",
                                          },
                                        }),
                                    },
                                    {
                                      label: "分享链接",
                                      accessibleLabel: "分享 " + model.name,
                                      icon: <Link2 size={16} />,
                                      onSelect: () =>
                                        setModal({ kind: "share", model }),
                                    },
                                    {
                                      label: "删除模型",
                                      accessibleLabel: "删除 " + model.name,
                                      icon: <Trash2 size={16} />,
                                      danger: true,
                                      onSelect: () =>
                                        setModal({ kind: "delete", model }),
                                    },
                                  ]}
                                />
                              </div>
                            </div>
                            {probe && (
                              <ModelTestFeedback
                                probe={probe}
                                className="card-test-feedback"
                                onDismiss={() =>
                                  setModelTests((old) =>
                                    old[model.id] === probe
                                      ? {
                                          ...old,
                                          [model.id]: {
                                            ...probe,
                                            dismissed: true,
                                          },
                                        }
                                      : old,
                                  )
                                }
                              />
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <Layers3 size={30} />
                      </div>
                      <h2>
                        {query || filter !== "all"
                          ? "没有找到匹配的模型"
                          : "从你的第一个模型开始"}
                      </h2>
                      <p>
                        {query || filter !== "all"
                          ? "试试其他关键词或筛选条件。"
                          : "添加 API 地址和模型 ID，让不同 Agent 连接你的模型。"}
                      </p>
                      {query || filter !== "all" ? (
                        <button
                          className="button secondary"
                          onClick={() => {
                            setQuery("");
                            setFilter("all");
                          }}
                        >
                          清除筛选
                        </button>
                      ) : (
                        <button
                          className="button primary"
                          onClick={() =>
                            setModal({ kind: "model", model: newModel() })
                          }
                        >
                          <Plus size={17} />
                          添加第一个模型
                        </button>
                      )}
                    </div>
                  )}
                  <div className="collection-footnote">
                    <ShieldCheck size={15} />
                    <span>
                      保存模型不会修改 Agent
                      配置。应用前，你可以先预览全部变更。
                    </span>
                    <span className="footnote-count">
                      {visible.length} 个模型
                    </span>
                  </div>
                </>
              )}
              {page === "backups" && (
                <>
                  <div className="backup-toolbar">
                    <div className="filter-tabs" aria-label="备份按平台筛选">
                      {(["all", "workbuddy", "claude", "codex"] as const).map(
                        (value) => (
                          <button
                            key={value}
                            className={backupFilter === value ? "selected" : ""}
                            aria-pressed={backupFilter === value}
                            onClick={() => setBackupFilter(value)}
                          >
                            {value === "all" ? "全部" : agentLabels[value]}
                            {value === "all" && (
                              <span>{data.backups.length}</span>
                            )}
                          </button>
                        ),
                      )}
                    </div>
                    <button
                      className="button danger"
                      disabled={busy || data.backups.length === 0}
                      onClick={() => setModal({ kind: "delete-all-backups" })}
                    >
                      <Trash2 size={15} />
                      清空备份
                    </button>
                  </div>
                  <div className="info-note">
                    <FileClock size={19} />
                    <span>
                      每次确认写入前，自动保存原始文件。恢复前也会创建一份新备份。
                    </span>
                  </div>
                  {visibleBackups.length ? (
                    <div className="backup-list">
                      {visibleBackups.map((backup) => (
                        <article className="backup-row" key={backup.id}>
                          <span className="backup-icon">
                            <FileClock size={22} />
                          </span>
                          <div>
                            <h3>{backup.title}</h3>
                            <p>
                              {formatTime(backup.createdAt)} ·{" "}
                              {backup.paths.length} 个文件
                            </p>
                            <details>
                              <summary>查看文件路径</summary>
                              {backup.paths.map((path) => (
                                <code key={path}>{path}</code>
                              ))}
                            </details>
                          </div>
                          <span
                            className={`tag ${backup.status === "completed" ? "green" : "amber"}`}
                          >
                            {{
                              completed: "已完成",
                              pending: "写入中断 · 可恢复",
                              rolled_back: "失败后已回滚",
                              rollback_failed: "需要恢复",
                            }[backup.status] ?? backup.status}
                          </span>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () =>
                                setModal({
                                  kind: "review",
                                  preview: await api.restore(backup.id),
                                }),
                              )
                            }
                          >
                            预览恢复
                            <ArrowRight size={15} />
                          </button>
                          <button
                            className="icon-button delete-button"
                            disabled={busy}
                            aria-label={`删除备份 ${backup.title}`}
                            onClick={() =>
                              setModal({ kind: "delete-backup", backup })
                            }
                          >
                            <Trash2 size={16} />
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <FileClock size={30} />
                      </div>
                      <h2>
                        {backupFilter === "all"
                          ? "还没有模型配置备份"
                          : `还没有 ${agentLabels[backupFilter]} 的模型配置备份`}
                      </h2>
                      <p>
                        {backupFilter === "all"
                          ? "第一次应用模型后，备份就会出现在这里。"
                          : "向该平台应用模型后，备份就会出现在这里。"}
                      </p>
                    </div>
                  )}
                </>
              )}
              {page === "skills" && <SkillsPage />}
              {page === "mcp" && <McpPage onApplied={refresh} />}
              {page === "settings" && (
                <SettingsPage
                  data={data}
                  theme={theme}
                  busy={busy}
                  onInitialize={(options) => {
                    setInitializationError("");
                    setModal({ kind: "initialize", options });
                  }}
                  onThemeSave={(theme) => {
                    setThemePreview(theme);
                    void run(async () => {
                      try {
                        await api.settings({ ...data.settings, theme });
                        await refresh();
                        setNotice({
                          kind: "success",
                          text: "主题已保存。",
                        });
                      } catch (error) {
                        setThemePreview(null);
                        throw error;
                      }
                      setThemePreview(null);
                    });
                  }}
                  onSave={(settings) =>
                    void run(async () => {
                      await api.settings(settings);
                      await refresh();
                      setNotice({ kind: "success", text: "设置已保存。" });
                    })
                  }
                />
              )}
              {page === "about" && (
                <AboutPage
                  settings={data.settings}
                  busy={busy}
                  isStoreBuild={isStoreBuild}
                  onError={(text) => setNotice({ kind: "error", text })}
                  onUpdateSave={(preferences) =>
                    void run(async () => {
                      await api.settings({ ...data.settings, ...preferences });
                      await refresh();
                      setNotice({ kind: "success", text: "更新设置已保存。" });
                    })
                  }
                  onCheckUpdate={() => requestUpdateCheck(true)}
                  updateState={updateState}
                  onShowUpdate={() => {
                    if (updateState.kind === "available")
                      setModal({
                        kind: "update-confirm",
                        version: updateState.version,
                      });
                  }}
                />
              )}
            </>
          )}
        </div>
      </main>
      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`notification ${notice.kind}`}
        >
          {notice.kind === "success" ? (
            <CheckCircle2 size={19} />
          ) : (
            <CircleHelp size={19} />
          )}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal?.kind === "guide" && (
        <NewcomerGuide
          onClose={closeModal}
          onStart={() => {
            setPage("models");
            setModal({ kind: "new-api" });
          }}
        />
      )}
      {modal?.kind === "new-api" && (
        <NewApiDialog
          onClose={closeModal}
          onAdded={refresh}
          onPreferenceSaved={refresh}
          savedBaseUrl={data?.settings.newApiUrl}
        />
      )}
      {modal?.kind === "update-confirm" && updateState.kind === "available" && (
        <Modal
          title="版本更新"
          description={`当前版本 v${packageJson.version}，可以升级为 v${modal.version}`}
          onClose={closeModal}
          className="update-confirm-modal"
        >
          <ModalFooter>
            <button className="button secondary" onClick={closeModal}>
              暂不更新
            </button>
            <button className="button primary" onClick={beginUpdateInstall}>
              确认更新
            </button>
          </ModalFooter>
        </Modal>
      )}
      {modal?.kind === "model" && (
        <Modal
          title={
            modal.copy ? "复制模型" : modal.model.id ? "编辑模型" : "添加模型"
          }
          description="把服务商的连接信息保存在你的本地模型库。"
          onClose={closeModal}
          busy={busy}
        >
          <ModelForm
            initial={modal.model}
            copy={modal.copy}
            busy={busy}
            onCancel={closeModal}
            onSave={(model, result) =>
              void run(async () => {
                const saved = await api.save(model, result.verificationToken!);
                pendingTests.current.delete(saved.id);
                setModelTests((old) => ({
                  ...old,
                  [saved.id]: {
                    key: modelTestKey(saved),
                    status: "passed",
                    message: modelTestSuccess(result),
                    expiresAt: Date.now() + 5000,
                  },
                }));
                await done(
                  isDesktop
                    ? "模型已保存，尚未应用到 Agent。"
                    : "演示模型已保存至内存，刷新页面后重置。",
                );
              })
            }
          />
        </Modal>
      )}
      {modal?.kind === "agents" && (
        <Modal
          title="应用到 Agent"
          description="选择使用这个模型的软件。只显示原生协议兼容的选项。"
          onClose={closeModal}
          busy={busy}
        >
          <AgentPicker
            model={modal.model}
            busy={busy}
            onPreview={(agents, selectWorkbuddyModel, claude1m) =>
              void run(async () =>
                setModal({
                  kind: "review",
                  preview: await api.preview(
                    modal.model.id,
                    agents,
                    selectWorkbuddyModel,
                    claude1m,
                  ),
                }),
              )
            }
          />
        </Modal>
      )}
      {modal?.kind === "review" && (
        <Modal
          title={modal.preview.title}
          description="请在确认覆盖前核对脱敏后的配置变更。"
          onClose={closeModal}
          wide
          busy={busy}
        >
          <ApplyReview
            preview={modal.preview}
            busy={busy}
            onCancel={closeModal}
            onConfirm={() =>
              void run(async () => {
                const result = await api.apply(modal.preview.token);
                await done(
                  [result.message, result.workbuddySelection]
                    .filter(Boolean)
                    .join(" "),
                );
              })
            }
          />
        </Modal>
      )}
      {modal?.kind === "import" && (
        <Modal
          title="从链接导入"
          description="粘贴 power-switch:// 链接，先预览，再决定保存。"
          onClose={closeModal}
          busy={busy}
        >
          <ImportLinkForm
            busy={busy}
            onPreview={(link) =>
              void run(async () =>
                setModal({
                  kind: "import-review",
                  preview: await api.importPreview(link),
                }),
              )
            }
          />
        </Modal>
      )}
      {modal?.kind === "import-review" && (
        <Modal
          title="确认导入模型"
          description="只加入模型库，不会修改任何 Agent 配置。"
          onClose={closeModal}
          busy={busy}
        >
          <ImportReview
            preview={modal.preview}
            busy={busy}
            onConfirm={(updates) =>
              void run(async () => {
                const outcome = await api.importConfirm(
                  modal.preview.token,
                  updates,
                );
                await refresh();
                setModal({ kind: "import-result", outcome });
              })
            }
          />
        </Modal>
      )}
      {modal?.kind === "import-result" && (
        <Modal
          title="导入结果"
          description="仅通过模型调用测试的条目已保存。"
          onClose={closeModal}
        >
          <p role="status">
            已保存 {modal.outcome.savedCount} 个模型，尚未应用到 Agent。
          </p>
          {modal.outcome.failures.map((failure) => (
            <p role="alert" key={failure.index}>
              第 {failure.index + 1} 项未保存：{failure.message}
            </p>
          ))}
          <ModalFooter>
            <button className="button primary" onClick={closeModal}>
              完成
            </button>
          </ModalFooter>
        </Modal>
      )}
      {modal?.kind === "share" && (
        <Modal
          title="分享模型配置"
          description="生成可在浏览器中打开的 power-switch 模型链接。"
          onClose={closeModal}
        >
          <ShareModel model={modal.model} />
        </Modal>
      )}
      {modal?.kind === "initialize" && (
        <InitializationConfirmation
          options={modal.options}
          busy={busy}
          error={initializationError}
          onClose={closeModal}
          onConfirm={() =>
            void run(async () => {
              setInitializationError("");
              try {
                await api.initialize(modal.options);
                if (modal.options.models) {
                  pendingTests.current.clear();
                  setModelTests({});
                  setQuery("");
                  setBackupFilter("all");
                }
                setLinks([]);
                await done("配置初始化完成。");
              } catch (error) {
                setInitializationError(String(error));
              }
            })
          }
        />
      )}
      {modal?.kind === "delete-backup" && (
        <Modal
          title="删除模型配置备份"
          description={`二次确认：删除“${modal.backup.title}”的备份？`}
          onClose={closeModal}
          busy={busy}
        >
          <div className="warning-note">
            <Trash2 size={18} />
            <div>
              删除后无法使用这条记录恢复配置。当前 Agent 配置文件不受影响。
            </div>
          </div>
          <p className="field-hint">
            {formatTime(modal.backup.createdAt)} · {modal.backup.paths.length}{" "}
            个文件
          </p>
          <ModalFooter>
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeModal}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.deleteBackup(modal.backup.id);
                  await done("模型配置备份已删除，Agent 配置保持不变。");
                })
              }
            >
              确认删除备份
            </button>
          </ModalFooter>
        </Modal>
      )}
      {modal?.kind === "delete-all-backups" && (
        <Modal
          title="清空所有模型配置备份"
          description={`确认删除全部 ${data?.backups.length ?? 0} 条历史备份记录？`}
          onClose={closeModal}
          busy={busy}
        >
          <div className="warning-note">
            <Trash2 size={18} />
            <div>
              此操作无法撤销。只会删除备份记录，不会修改当前模型库或 Agent
              配置。
            </div>
          </div>
          <ModalFooter>
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeModal}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy || !data?.backups.length}
              onClick={() =>
                void run(async () => {
                  try {
                    const count = await api.deleteAllBackups();
                    await done(`已清空 ${count} 条历史备份记录。`);
                  } catch (error) {
                    setModal(null);
                    await refresh().catch(() => {});
                    throw error;
                  }
                })
              }
            >
              确认清空备份
            </button>
          </ModalFooter>
        </Modal>
      )}
      {modal?.kind === "delete" && (
        <Modal
          title="删除模型"
          description={`将“${modal.model.name}”从 power-switch 模型库中移除。`}
          onClose={closeModal}
          busy={busy}
        >
          <div className="info-note">
            <CircleHelp size={18} />
            <span>已应用的 Agent 配置保留，可通过模型配置备份恢复。</span>
          </div>
          <ModalFooter>
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeModal}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.delete(modal.model.id);
                  await done("模型已从模型库删除。");
                })
              }
            >
              确认删除
              <Trash2 size={16} />
            </button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

/** Accept a pasted deep link without putting its potentially sensitive value in logs. */
function ImportLinkForm({
  busy,
  onPreview,
}: {
  busy: boolean;
  onPreview: (link: string) => void;
}) {
  const [link, setLink] = useState("");
  const formId = useId();
  return (
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        onPreview(link);
      }}
    >
      <label className="field">
        模型链接
        <textarea
          autoFocus
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="power-switch://model/import?v=1&data=…"
          rows={5}
          spellCheck={false}
          required
          maxLength={65536}
        />
      </label>
      <div className="info-note">
        <Link2 size={18} />
        <span>支持单个或批量模型。链接中的 API Key 在预览中保持隐藏。</span>
      </div>
      <ModalFooter>
        <button
          type="submit"
          form={formId}
          className="button primary"
          disabled={busy || !link.trim()}
        >
          {busy ? "正在解析…" : "预览导入"}
          <ArrowRight size={16} />
        </button>
      </ModalFooter>
    </form>
  );
}

/** Let duplicate imports opt in to replacement while new rows import by default. */
function ImportReview({
  preview,
  busy,
  onConfirm,
}: {
  preview: ImportPreview;
  busy: boolean;
  onConfirm: (indexes: number[]) => void;
}) {
  const [updates, setUpdates] = useState<number[]>([]);
  return (
    <>
      <div className="import-rows">
        {preview.rows.map((row) => (
          <div className="import-row" key={row.index}>
            <ProtocolMark protocol={row.protocol} name={row.name} small />
            <div>
              <strong>{row.name}</strong>
              <p>{row.modelId}</p>
              <small>{row.baseUrl}</small>
              <span className="field-hint">
                {row.hasApiKey ? "已包含密钥（隐藏）" : "未包含密钥"}
              </span>
            </div>
            {row.duplicate ? (
              <label className="duplicate-choice">
                <input
                  type="checkbox"
                  checked={updates.includes(row.index)}
                  onChange={(e) =>
                    setUpdates(
                      e.target.checked
                        ? [...updates, row.index]
                        : updates.filter((i) => i !== row.index),
                    )
                  }
                />
                更新重复项
              </label>
            ) : (
              <span className="tag green">新增</span>
            )}
          </div>
        ))}
      </div>
      <ModalFooter>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => onConfirm(updates)}
        >
          确认导入
          <Download size={16} />
        </button>
      </ModalFooter>
    </>
  );
}

/** Generate credential-free links by default and guard asynchronous key-inclusion toggles. */
function ShareModel({ model }: { model: ModelConfig }) {
  const [include, setInclude] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    setLink("");
    setCopied(false);
    setError("");
    void api
      .share(model.id, include)
      .then((value) => {
        if (alive) setLink(value);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [model.id, include]);
  /** Copy only the current completed link after the user explicitly presses the button. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("复制失败，请选中下方链接手动复制。");
    }
  }
  return (
    <>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => setInclude(e.target.checked)}
        />
        包含 API Key（接收者将获得该密钥）
      </label>
      <textarea
        aria-label="分享链接"
        value={link}
        readOnly
        rows={5}
        spellCheck={false}
      />
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <ModalFooter>
        <button
          className="button primary"
          disabled={!link}
          onClick={() => void copy()}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
          {copied ? "已复制" : "复制链接"}
        </button>
      </ModalFooter>
    </>
  );
}

/** 编辑路径草稿；外观始终跟随父级预览或已保存状态，保存失败时可同步回滚。 */
function SettingsPage({
  data,
  theme,
  busy,
  onThemeSave,
  onSave,
  onInitialize,
}: {
  data: AppData;
  theme: Settings["theme"];
  busy: boolean;
  onThemeSave: (theme: Settings["theme"]) => void;
  onSave: (settings: Settings) => void;
  onInitialize: (options: InitializationOptions) => void;
}) {
  const [settings, setSettings] = useState(data.settings);
  const [pickerError, setPickerError] = useState("");
  const [picking, setPicking] = useState(false);
  /** Update the editable path only after a native selection; saving remains explicit. */
  async function choosePath(
    key: "workbuddyPath" | "claudePath" | "codexDir",
    kind: "file" | "directory",
    label: string,
  ) {
    setPicking(true);
    setPickerError("");
    try {
      const chosen = await pickLocalPath(
        kind,
        `选择 ${label} 配置${kind === "file" ? "文件" : "目录"}`,
        settings[key] || undefined,
      );
      if (chosen) {
        const file = key === "workbuddyPath" ? "models.json" : "settings.json";
        const separator = chosen.includes("\\") ? "\\" : "/";
        const value =
          kind === "directory" && key !== "codexDir"
            ? chosen.replace(/[\\/]+$/, "") + separator + file
            : chosen;
        setSettings((old) => ({ ...old, [key]: value }));
      }
    } catch (error) {
      setPickerError(String(error));
    } finally {
      setPicking(false);
    }
  }
  /** 保存路径草稿时携带当前外观，避免使用页面挂载时捕获的旧主题。 */
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      ...settings,
      theme,
      autoUpdate: data.settings.autoUpdate,
      receiveRc: data.settings.receiveRc,
    });
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <section className="settings-section">
        <div className="section-title">
          <Monitor size={19} />
          <div>
            <h2>外观</h2>
            <p>主题选择后自动保存；配置路径修改后需点击下方保存设置。</p>
          </div>
        </div>
        <div className="theme-options">
          {(
            [
              { value: "light", label: "浅色", Icon: Sun },
              { value: "dark", label: "深色", Icon: Moon },
              { value: "system", label: "跟随系统", Icon: Monitor },
            ] as const
          ).map(({ value, label, Icon }) => (
            <button
              type="button"
              key={value}
              className={theme === value ? "selected" : ""}
              aria-pressed={theme === value}
              disabled={busy}
              onClick={() => {
                if (theme === value) return;
                onThemeSave(value);
              }}
            >
              <Icon size={22} />
              {label}
              {theme === value && <Check size={15} />}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <FolderCog size={19} />
          <div>
            <h2>Agent 配置位置</h2>
            <p>自动识别当前用户目录，也可选择本地文件或目录，保存后生效。</p>
          </div>
        </div>
        {data.agents.map((agent) => {
          const key =
            agent.agent === "workbuddy"
              ? "workbuddyPath"
              : agent.agent === "claude"
                ? "claudePath"
                : "codexDir";
          return (
            <div className="field path-field" key={agent.agent}>
              <span>
                {agentLabels[agent.agent]}{" "}
                {agent.agent === "codex" ? "配置目录" : "配置文件"}
                <span className={`tag ${agent.exists ? "green" : ""}`}>
                  {agent.exists ? "已找到配置" : "尚未创建"}
                </span>
              </span>
              <div className="path-picker-row">
                <input
                  aria-label={`${agentLabels[agent.agent]} 配置路径`}
                  value={settings[key] ?? ""}
                  placeholder="自动识别（推荐）"
                  disabled={busy || picking}
                  onChange={(e) =>
                    setSettings({ ...settings, [key]: e.target.value || null })
                  }
                  spellCheck={false}
                />
                {agent.agent !== "codex" && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || picking}
                    onClick={() =>
                      void choosePath(key, "file", agentLabels[agent.agent])
                    }
                    aria-label={`选择 ${agentLabels[agent.agent]} 配置文件`}
                  >
                    <FolderOpen size={15} />
                    选择文件
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || picking}
                  onClick={() =>
                    void choosePath(key, "directory", agentLabels[agent.agent])
                  }
                  aria-label={`选择 ${agentLabels[agent.agent]} 配置目录`}
                >
                  <FolderOpen size={15} />
                  选择目录
                </button>
              </div>
              <span className="resolved-path">当前路径：{agent.path}</span>
            </div>
          );
        })}
      </section>
      {pickerError && (
        <p role="alert" className="inline-error">
          {pickerError}
        </p>
      )}
      <section className="settings-section storage-section">
        <div className="section-title">
          <ShieldCheck size={19} />
          <div>
            <h2>本地数据</h2>
            <p>模型、API Key、New API 会话和备份均以明文保存在此目录。</p>
          </div>
        </div>
        <code>{data.dataDir}</code>
      </section>
      <InitializationSection busy={busy} onRequest={onInitialize} />
      <div className="settings-actions">
        <span>
          <ArrowDownToLine size={15} />
          保存设置不会应用模型
        </span>
        <button className="button primary" disabled={busy}>
          保存设置
          <Check size={16} />
        </button>
      </div>
    </form>
  );
}
