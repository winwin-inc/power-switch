import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  Cable,
  Check,
  CircleAlert,
  ExternalLink,
  FlaskConical,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ApplyReview, Modal } from "./components";
import { isDesktop } from "./api";
import { pickLocalPath } from "./file-picker";
import {
  mcpApi,
  mcpPatUrl,
  internalMcpPatUrl,
  type McpDraft,
  type McpSummary,
  type McpTarget,
} from "./mcp-api";
import type { ApplyPreview } from "./types";
import "./mcp.css";

const platforms: {
  label: string;
  targets: {
    id: McpTarget;
    label: string;
    detail: string;
    disabled?: boolean;
  }[];
}[] = [
  {
    label: "WorkBuddy",
    targets: [
      { id: "workbuddy", label: "用户全局", detail: "~/.workbuddy/mcp.json" },
      {
        id: "workbuddyProject",
        label: "项目级",
        detail: "暂不支持",
        disabled: true,
      },
    ],
  },
  {
    label: "Claude Code",
    targets: [
      { id: "claudeUser", label: "用户全局", detail: "~/.claude.json" },
      { id: "claudeProject", label: "项目级", detail: "<项目>/.mcp.json" },
    ],
  },
  {
    label: "Codex",
    targets: [
      { id: "codex", label: "用户全局", detail: "~/.codex/config.toml" },
      {
        id: "codexProject",
        label: "项目级",
        detail: "<项目>/.codex/config.toml",
      },
    ],
  },
];

/** Identify project targets to share directory selection and validation across platforms. */
function isProjectTarget(target: McpTarget) {
  return target.endsWith("Project");
}

type DialogState =
  | { kind: "form"; builtIn: boolean }
  | { kind: "apply"; connector: McpSummary }
  | { kind: "review"; preview: ApplyPreview }
  | { kind: "delete"; connector: McpSummary }
  | null;
type Feedback = { status: "passed" | "failed"; message: string };
type ActiveTest = { kind: "connector"; id: string } | { kind: "draft" } | null;

/** Create an empty custom remote MCP draft. */
export function emptyMcpDraft(): McpDraft {
  return {
    id: "",
    name: "",
    serverId: "",
    url: "",
    authMode: "none",
    headerName: "x-api-key",
    token: "",
  };
}

/** Reconstruct an edit form from a redacted summary; blank token means keep saved PAT. */
function editDraft(summary: McpSummary): McpDraft {
  return {
    id: summary.id,
    name: summary.name,
    serverId: summary.serverId,
    url: summary.url,
    authMode: summary.authMode,
    headerName: summary.headerName,
    token: "",
  };
}

/** Manage connector records, connection checks, and guarded Agent application. */
export function McpPage() {
  const [connectors, setConnectors] = useState<McpSummary[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [draft, setDraft] = useState<McpDraft>(emptyMcpDraft);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [savedTests, setSavedTests] = useState<Record<string, Feedback>>({});
  const [selectedTargets, setSelectedTargets] = useState<McpTarget[]>([]);
  const [activePlatform, setActivePlatform] = useState(0);
  const [projectDir, setProjectDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTest, setActiveTest] = useState<ActiveTest>(null);
  const testing = activeTest !== null;
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const savedToken = connectors.some(
    (connector) => connector.id === draft.id && connector.hasToken,
  );
  const needsProject = selectedTargets.some(isProjectTarget);
  const patUrl =
    draft.serverId === "msy-internal-lightdash" ? internalMcpPatUrl : mcpPatUrl;
  const patLabel =
    draft.serverId === "msy-internal-lightdash"
      ? "申请马上赢内部 LightDash 令牌"
      : "申请马上赢 X 令牌";

  /** Reload only public connector metadata after a native mutation. */
  const refresh = useCallback(
    async () => setConnectors(await mcpApi.list()),
    [],
  );
  useEffect(() => {
    let active = true;
    void mcpApi
      .list()
      .then((rows) => active && setConnectors(rows))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, []);

  /** Open a fresh create or edit draft without ever revealing the stored PAT. */
  function openForm(next: McpDraft, builtIn = false) {
    setDraft(next);
    setFeedback(null);
    setError("");
    setMessage("");
    setDialog({ kind: "form", builtIn });
  }

  /** Replace a draft field and invalidate the previous connection-test result. */
  function updateDraft<K extends keyof McpDraft>(key: K, value: McpDraft[K]) {
    setDraft((old) => ({ ...old, [key]: value }));
    setFeedback(null);
  }

  /** Use the system browser on desktop and retain ordinary link navigation in web previews. */
  function openPatPage(event: MouseEvent<HTMLAnchorElement>) {
    if (!isDesktop) return;
    event.preventDefault();
    setError("");
    void mcpApi.openPatPage(patUrl).catch(() => {
      setError(`无法打开申请页面，请复制此地址到浏览器：${patUrl}`);
    });
  }

  /** Close an uncommitted preview and discard its in-memory secret-bearing token. */
  function closeDialog() {
    if (busy || testing) return;
    if (dialog?.kind === "review")
      void mcpApi.cancel(dialog.preview.token).catch(() => {});
    setDialog(null);
    setError("");
  }

  /** Run a single MCP check while binding its loading indicator to its originating control. */
  async function runTest(candidate: McpDraft, id?: string) {
    if (busy || testing) return;
    setActiveTest(id ? { kind: "connector", id } : { kind: "draft" });
    setError("");
    try {
      const result = await mcpApi.test(candidate);
      const next: Feedback = {
        status: "passed",
        message: `连接成功，发现 ${result.toolCount} 个工具。`,
      };
      if (id) setSavedTests((old) => ({ ...old, [id]: next }));
      else setFeedback(next);
    } catch (e) {
      const next: Feedback = { status: "failed", message: String(e) };
      if (id) setSavedTests((old) => ({ ...old, [id]: next }));
      else setFeedback(next);
    } finally {
      setActiveTest(null);
    }
  }

  /** Save a connector independently of whether its latest test passed. */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || testing) return;
    setBusy(true);
    setError("");
    try {
      const item = await mcpApi.save(draft);
      if (feedback) setSavedTests((old) => ({ ...old, [item.id]: feedback }));
      else
        setSavedTests((old) => {
          const next = { ...old };
          delete next[item.id];
          return next;
        });
      await refresh();
      setDialog(null);
      setMessage(`已保存 ${item.name}。编辑后的配置需要重新应用到 Agent。`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Select a connector and reset the target choice for its next application. */
  function openApply(connector: McpSummary) {
    setSelectedTargets([]);
    setActivePlatform(0);
    setProjectDir("");
    setError("");
    setDialog({ kind: "apply", connector });
  }

  /** Navigate platform tabs with standard arrow, Home, and End keyboard controls. */
  function navigatePlatform(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % platforms.length;
    else if (event.key === "ArrowLeft")
      next = (index + platforms.length - 1) % platforms.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = platforms.length - 1;
    else return;
    event.preventDefault();
    setActivePlatform(next);
    document.getElementById(`mcp-platform-${next}`)?.focus();
  }

  /** Request a redacted preview for each selected native Agent file. */
  async function previewApply() {
    if (dialog?.kind !== "apply" || busy) return;
    setBusy(true);
    setError("");
    try {
      const preview = await mcpApi.preview(
        dialog.connector.id,
        selectedTargets,
        projectDir || null,
      );
      setDialog({ kind: "review", preview });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Commit only the current preview, then show the native restart or trust notices. */
  async function confirmApply() {
    if (dialog?.kind !== "review" || busy) return;
    const preview = dialog.preview;
    setBusy(true);
    setError("");
    try {
      const result = await mcpApi.apply(preview.token);
      setDialog(null);
      setMessage(
        `${result.message} 已备份 ${result.paths.length} 个配置文件。${preview.notices.join(" ")}`,
      );
    } catch (e) {
      setDialog(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Delete the selected library record after a dedicated confirmation. */
  async function confirmDelete() {
    if (dialog?.kind !== "delete" || busy) return;
    setBusy(true);
    setError("");
    try {
      await mcpApi.delete(dialog.connector.id);
      await refresh();
      setDialog(null);
      setMessage("连接器记录已删除；已应用到 Agent 的配置未改变。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mcp-page" aria-label="MCP 连接器管理">
      <div className="mcp-intro">
        <div>
          <h2>把远程工具接入你的 Agent</h2>
          <p>
            地址和令牌保存在本机。选择 Agent 后，预览并复制为各平台的原生配置。
          </p>
        </div>
        <Cable size={36} aria-hidden="true" />
      </div>
      <div className="mcp-actions">
        <button
          className="button secondary"
          onClick={() => openForm(emptyMcpDraft())}
        >
          <Plus size={16} />
          自定义添加
        </button>
      </div>
      {message && (
        <p className="mcp-banner success" role="status">
          {message}
        </p>
      )}
      {error && !dialog && (
        <p className="mcp-banner error" role="alert">
          {error}
        </p>
      )}
      {connectors.length ? (
        <div className="mcp-list">
          {connectors.map((connector) => (
            <article className="mcp-card" key={connector.id}>
              <div className="mcp-card-main">
                <div className="mcp-card-icon">
                  <Cable size={22} />
                </div>
                <div className="mcp-card-copy">
                  <div className="mcp-card-heading">
                    <h3>
                      <span
                        className="mcp-connector-name"
                        title={connector.name}
                      >
                        {connector.name}
                      </span>
                      {connector.builtIn && (
                        <span className="mcp-built-in">内置</span>
                      )}
                    </h3>
                    <span className="mcp-server-id" title={connector.serverId}>
                      {connector.serverId}
                    </span>
                  </div>
                  <p title={connector.url}>{connector.url}</p>
                </div>
                <span className="mcp-secret-state">
                  {connector.hasToken
                    ? "令牌已保存"
                    : connector.authMode === "none"
                      ? "无需认证"
                      : "待填写令牌"}
                </span>
              </div>
              {savedTests[connector.id] && (
                <p
                  className={`mcp-test-result ${savedTests[connector.id].status}`}
                  role="status"
                >
                  {savedTests[connector.id].message}
                </p>
              )}
              <div className="mcp-card-actions">
                <button
                  className="button secondary"
                  aria-busy={
                    activeTest?.kind === "connector" &&
                    activeTest.id === connector.id
                  }
                  disabled={
                    testing ||
                    busy ||
                    (connector.builtIn && !connector.hasToken)
                  }
                  onClick={() =>
                    void runTest(editDraft(connector), connector.id)
                  }
                >
                  {activeTest?.kind === "connector" &&
                  activeTest.id === connector.id ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <FlaskConical size={15} />
                  )}
                  测试连接
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    openForm(editDraft(connector), connector.builtIn)
                  }
                >
                  <Pencil size={15} />
                  {connector.builtIn && !connector.hasToken
                    ? "配置令牌"
                    : "编辑"}
                </button>
                <button
                  className="button primary"
                  disabled={connector.builtIn && !connector.hasToken}
                  onClick={() => openApply(connector)}
                >
                  应用到 Agent
                </button>
                {!connector.builtIn && (
                  <button
                    className="mcp-delete icon-button"
                    aria-label={`删除连接器 ${connector.name}`}
                    onClick={() => {
                      setError("");
                      setDialog({ kind: "delete", connector });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state mcp-empty">
          <div className="empty-icon">
            <Cable size={28} />
          </div>
          <h2>{error ? "未能读取 MCP 连接器" : "正在读取 MCP 连接器"}</h2>
          <p>正在读取连接器，请稍候。</p>
        </div>
      )}

      {dialog?.kind === "form" && (
        <Modal
          title={
            dialog.builtIn
              ? `配置${draft.name}`
              : draft.id
                ? "编辑 MCP 连接器"
                : "添加 MCP 连接器"
          }
          description={
            dialog.builtIn
              ? "地址与认证方式已内置，填写访问令牌即可。"
              : "固定地址与令牌保存在本机，测试失败仍可保存。"
          }
          onClose={closeDialog}
          busy={busy || testing}
        >
          <form onSubmit={(e) => void save(e)}>
            {!dialog.builtIn && (
              <>
                <label className="field">
                  连接器名称
                  <input
                    required
                    maxLength={256}
                    value={draft.name}
                    onChange={(e) => updateDraft("name", e.target.value)}
                    placeholder="例如：马上赢 X 平台"
                  />
                </label>
                <label className="field">
                  服务 ID
                  <input
                    required
                    maxLength={80}
                    value={draft.serverId}
                    onChange={(e) => updateDraft("serverId", e.target.value)}
                    placeholder="例如：msy-x-lightdash"
                  />
                  <span className="field-hint">
                    在 Agent 配置中作为 MCP 服务标识。
                  </span>
                </label>
              </>
            )}
            <label className="field">
              MCP 地址
              <input
                type="url"
                required
                readOnly={dialog.builtIn}
                value={draft.url}
                onChange={(e) => updateDraft("url", e.target.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
            {!dialog.builtIn && (
              <label className="field">
                认证方式
                <select
                  value={draft.authMode}
                  onChange={(e) =>
                    updateDraft(
                      "authMode",
                      e.target.value as McpDraft["authMode"],
                    )
                  }
                >
                  <option value="customHeader">自定义请求头</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="none">无需认证</option>
                </select>
              </label>
            )}
            {!dialog.builtIn && draft.authMode === "customHeader" && (
              <label className="field">
                请求头名称
                <input
                  required
                  value={draft.headerName}
                  onChange={(e) => updateDraft("headerName", e.target.value)}
                  placeholder="x-api-key"
                />
              </label>
            )}
            {draft.authMode !== "none" && (
              <label className="field">
                访问令牌
                <input
                  type="password"
                  autoComplete="off"
                  required={!draft.id || (dialog.builtIn && !savedToken)}
                  value={draft.token}
                  onChange={(e) => updateDraft("token", e.target.value)}
                  placeholder={
                    savedToken
                      ? "留空则保持已保存令牌"
                      : dialog.builtIn
                        ? "粘贴你的令牌Token"
                        : "粘贴你的 PAT / API Key"
                  }
                />
                <span className="field-hint">
                  {savedToken
                    ? "不显示已保存令牌；留空则继续使用原令牌。"
                    : "令牌只在当前计算机保存。"}
                </span>
              </label>
            )}
            {dialog.builtIn && (
              <a
                className="mcp-pat-link"
                href={patUrl}
                onClick={openPatPage}
                target="_blank"
                rel="noopener noreferrer"
              >
                {patLabel} <ExternalLink size={14} />
              </a>
            )}
            {feedback && (
              <p
                className={`mcp-test-result ${feedback.status}`}
                role={feedback.status === "failed" ? "alert" : "status"}
              >
                {feedback.message}
              </p>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy || testing}
                onClick={closeDialog}
              >
                取消
              </button>
              <button
                type="button"
                className="button secondary"
                aria-busy={activeTest?.kind === "draft"}
                disabled={busy || testing}
                onClick={() => void runTest(draft)}
              >
                {activeTest?.kind === "draft" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <FlaskConical size={15} />
                )}
                测试连接
              </button>
              <button className="button primary" disabled={busy || testing}>
                {busy ? "保存中…" : "保存连接器"}
                <Check size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}

      {dialog?.kind === "apply" && (
        <Modal
          title={`应用 ${dialog.connector.name}`}
          description="选择要复制配置的 Agent。确认前会预览并备份目标文件。"
          onClose={closeDialog}
          busy={busy}
        >
          {savedTests[dialog.connector.id]?.status !== "passed" && (
            <p className="mcp-banner warning">
              <CircleAlert size={16} />
              此连接器尚未测试通过，可以继续应用；请在目标 Agent 中验证。
            </p>
          )}
          <div
            className="mcp-platform-tabs"
            role="tablist"
            aria-label="Agent 平台"
          >
            {platforms.map((platform, index) => (
              <button
                key={platform.label}
                id={`mcp-platform-${index}`}
                type="button"
                role="tab"
                aria-selected={activePlatform === index}
                aria-controls="mcp-platform-panel"
                tabIndex={activePlatform === index ? 0 : -1}
                onClick={() => setActivePlatform(index)}
                onKeyDown={(event) => navigatePlatform(event, index)}
              >
                {platform.label}
                {platform.targets.some((target) =>
                  selectedTargets.includes(target.id),
                ) && <Check size={13} aria-label="已选择" />}
              </button>
            ))}
          </div>
          <div
            className="mcp-targets"
            id="mcp-platform-panel"
            role="tabpanel"
            aria-labelledby={`mcp-platform-${activePlatform}`}
          >
            {platforms[activePlatform].targets.map((target) => (
              <label
                className={`mcp-target${target.disabled ? " mcp-target-disabled" : ""}`}
                key={target.id}
              >
                <input
                  type="checkbox"
                  disabled={target.disabled}
                  checked={selectedTargets.includes(target.id)}
                  onChange={(e) =>
                    setSelectedTargets((old) =>
                      e.target.checked
                        ? [...old, target.id]
                        : old.filter((id) => id !== target.id),
                    )
                  }
                />
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.detail}</small>
                </span>
              </label>
            ))}
          </div>
          {needsProject && (
            <label className="field">
              项目目录
              <div className="mcp-path-row">
                <input
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="选择项目根目录"
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    void pickLocalPath("directory", "选择项目目录", projectDir)
                      .then((path) => path && setProjectDir(path))
                      .catch((e) => setError(String(e)))
                  }
                >
                  <FolderOpen size={15} />
                  选择
                </button>
              </div>
              <span className="field-hint">
                所选项目级配置均应用到此目录。
                {dialog.connector.authMode !== "none" &&
                  " 配置包含明文令牌；Git 项目必须已忽略目标文件，且文件未被跟踪。"}
              </span>
            </label>
          )}
          {selectedTargets.length > 0 && (
            <p className="mcp-selected-targets" role="status">
              已选择：
              {platforms
                .flatMap((platform) =>
                  platform.targets
                    .filter((target) => selectedTargets.includes(target.id))
                    .map((target) => `${platform.label} · ${target.label}`),
                )
                .join("、")}
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={closeDialog}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !selectedTargets.length ||
                (needsProject && !projectDir.trim())
              }
              onClick={() => void previewApply()}
            >
              {busy ? "读取配置中…" : "预览变更"}
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === "review" && (
        <Modal
          title={dialog.preview.title}
          description="核对目标路径和脱敏变更后确认。"
          onClose={closeDialog}
          wide
          className="mcp-review-modal"
          busy={busy}
        >
          <ApplyReview
            preview={dialog.preview}
            onConfirm={() => void confirmApply()}
            onCancel={closeDialog}
            busy={busy}
          />
        </Modal>
      )}

      {dialog?.kind === "delete" && (
        <Modal
          title="删除连接器记录"
          description="仅删除 power-switch 中保存的记录。"
          onClose={closeDialog}
          busy={busy}
        >
          <p>
            确定删除“{dialog.connector.name}”吗？已应用到 Agent
            的配置不会自动删除。
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={closeDialog}
              disabled={busy}
            >
              取消
            </button>
            <button
              className="button danger"
              onClick={() => void confirmDelete()}
              disabled={busy}
            >
              删除记录
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
