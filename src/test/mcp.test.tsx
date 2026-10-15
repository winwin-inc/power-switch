import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../McpPage";
import { mcpApi, type McpSummary } from "../mcp-api";
import { pickLocalPath } from "../file-picker";

vi.mock("../mcp-api", () => ({
  mcpPatUrl: "https://x.brandct.com/generalSettings/personalAccessTokens",
  internalMcpPatUrl:
    "https://lightdash.banmahui.cn/generalSettings/personalAccessTokens",
  mcpApi: {
    openPatPage: vi.fn(),
    list: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    test: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock("../api", () => ({ isDesktop: true }));
vi.mock("../file-picker", () => ({ pickLocalPath: vi.fn() }));

const connector: McpSummary = {
  id: "c-1",
  name: "马上赢 X 平台",
  serverId: "msy-x-lightdash",
  url: "https://mcp-x.brandct.com/mcp",
  authMode: "customHeader",
  headerName: "x-api-key",
  hasToken: true,
  builtIn: true,
};
const unconfiguredConnector = { ...connector, hasToken: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mcpApi.list).mockResolvedValue([unconfiguredConnector]);
  vi.mocked(mcpApi.test).mockResolvedValue({ toolCount: 2 });
  vi.mocked(mcpApi.save).mockResolvedValue(connector);
  vi.mocked(mcpApi.cancel).mockResolvedValue();
  vi.mocked(mcpApi.openPatPage).mockResolvedValue();
  vi.mocked(pickLocalPath).mockResolvedValue("/work/project");
});

describe("MCP connector page", () => {
  /** Keep the loading indicator and result on the clicked connector, including failures. */
  it.each(["success", "failure"] as const)(
    "shows only the selected connector as testing and resets after %s",
    async (outcome) => {
      const user = userEvent.setup();
      const internal: McpSummary = {
        ...connector,
        id: "internal-1",
        name: "马上赢内部 LightDash",
        serverId: "msy-internal-lightdash",
        url: "https://mcp-lightdash.banmahui.cn/mcp",
      };
      vi.mocked(mcpApi.list).mockResolvedValue([connector, internal]);
      let finish!: () => void;
      vi.mocked(mcpApi.test).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === "success"
                ? resolve({ toolCount: 26 })
                : reject("401 Unauthorized");
          }),
      );
      render(<McpPage />);
      const first = (
        await screen.findByRole("heading", { name: /^马上赢 X 平台/ })
      ).closest("article")!;
      const second = screen
        .getByRole("heading", { name: /^马上赢内部 LightDash/ })
        .closest("article")!;
      const firstButton = within(first).getByRole("button", {
        name: "测试连接",
      });
      const secondButton = within(second).getByRole("button", {
        name: "测试连接",
      });
      await user.click(firstButton);
      expect(first.querySelectorAll(".spin")).toHaveLength(1);
      expect(second.querySelectorAll(".spin")).toHaveLength(0);
      expect(firstButton).toHaveAttribute("aria-busy", "true");
      expect(secondButton).toHaveAttribute("aria-busy", "false");
      await user.click(secondButton);
      expect(mcpApi.test).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: connector.id }),
      );
      await act(async () => finish());
      expect(firstButton).toHaveAttribute("aria-busy", "false");
      expect(firstButton).toBeEnabled();
      expect(secondButton).toBeEnabled();
      expect(first.querySelector(".spin")).not.toBeInTheDocument();
      expect(within(first).getByRole("status")).toHaveTextContent(
        outcome === "success" ? "发现 26 个工具" : "401 Unauthorized",
      );
      expect(within(second).queryByRole("status")).not.toBeInTheDocument();
    },
  );

  /** Draft tests must not show a loading indicator on any saved connector row. */
  it("shows draft testing only inside the edit dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.list).mockResolvedValue([connector]);
    let finish!: () => void;
    vi.mocked(mcpApi.test).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ toolCount: 2 });
        }),
    );
    render(<McpPage />);
    const row = (
      await screen.findByRole("heading", { name: /^马上赢 X 平台/ })
    ).closest("article")!;
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "测试连接" });
    await user.click(button);
    expect(dialog.querySelectorAll(".spin")).toHaveLength(1);
    expect(row.querySelectorAll(".spin")).toHaveLength(0);
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => finish());
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button).toBeEnabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "发现 2 个工具",
    );
    expect(within(row).queryByRole("status")).not.toBeInTheDocument();
  });

  it("configures the internal built-in using only its own fixed endpoint and token link", async () => {
    const user = userEvent.setup();
    const internal: McpSummary = {
      ...unconfiguredConnector,
      id: "internal-1",
      name: "马上赢内部 LightDash",
      serverId: "msy-internal-lightdash",
      url: "https://mcp-lightdash.banmahui.cn/mcp",
    };
    vi.mocked(mcpApi.list).mockResolvedValue([internal]);
    vi.mocked(mcpApi.save).mockResolvedValue({ ...internal, hasToken: true });
    render(<McpPage />);
    await user.click(await screen.findByRole("button", { name: "配置令牌" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "配置马上赢内部 LightDash",
    );
    expect(screen.getByLabelText("MCP 地址")).toHaveValue(
      "https://mcp-lightdash.banmahui.cn/mcp",
    );
    expect(screen.getByLabelText("MCP 地址")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("认证方式")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("请求头名称")).not.toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: "申请马上赢内部 LightDash 令牌",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://lightdash.banmahui.cn/generalSettings/personalAccessTokens",
    );
    await user.click(link);
    expect(mcpApi.openPatPage).toHaveBeenCalledWith(
      "https://lightdash.banmahui.cn/generalSettings/personalAccessTokens",
    );
    await user.type(
      screen.getByPlaceholderText("粘贴你的令牌Token"),
      "INTERNAL-TEST-PAT",
    );
    await user.click(screen.getByRole("button", { name: "保存连接器" }));
    expect(mcpApi.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "internal-1",
        serverId: "msy-internal-lightdash",
        token: "INTERNAL-TEST-PAT",
        authMode: "customHeader",
        headerName: "x-api-key",
      }),
    );
  });
  it("opens PAT application through the native browser and displays launch failures", async () => {
    const user = userEvent.setup();
    render(<McpPage />);
    await user.click(await screen.findByRole("button", { name: "配置令牌" }));
    const link = screen.getByRole("link", { name: /申请马上赢 X 令牌/ });
    await user.click(link);
    expect(mcpApi.openPatPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    vi.mocked(mcpApi.openPatPage).mockRejectedValueOnce(
      new Error("launch failed"),
    );
    await user.click(link);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法打开申请页面",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "https://x.brandct.com/generalSettings/personalAccessTokens",
    );
  });
  it("shows a built-in X connector with a fixed endpoint and a token-only setup form", async () => {
    const user = userEvent.setup();
    render(<McpPage />);
    await screen.findByRole("heading", {
      name: /^马上赢 X 平台/,
      level: 3,
    });
    expect(
      screen.queryByRole("button", { name: "添加马上赢 X" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("待填写令牌")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /删除连接器 马上赢/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用到 Agent" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "配置令牌" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByLabelText(/服务 ID/)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText("认证方式")).not.toBeInTheDocument();
    expect(dialog.queryByLabelText("请求头名称")).not.toBeInTheDocument();
    expect(screen.getByLabelText("MCP 地址")).toHaveValue(
      "https://mcp-x.brandct.com/mcp",
    );
    expect(screen.getByLabelText("MCP 地址")).toHaveAttribute("readonly");
    expect(screen.getByLabelText(/访问令牌/)).toHaveValue("");
    expect(screen.getByLabelText(/访问令牌/)).toHaveAttribute(
      "placeholder",
      "粘贴你的令牌Token",
    );
    expect(
      screen.getByRole("link", { name: /申请马上赢 X 令牌/ }),
    ).toHaveAttribute(
      "href",
      "https://x.brandct.com/generalSettings/personalAccessTokens",
    );
  });

  it("keeps all fields available for a custom connector", async () => {
    const user = userEvent.setup();
    render(<McpPage />);
    await user.click(screen.getByRole("button", { name: "自定义添加" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("连接器名称")).toHaveValue("");
    expect(dialog.getByLabelText(/服务 ID/)).toHaveValue("");
    expect(dialog.getByLabelText("MCP 地址")).not.toHaveAttribute("readonly");
    expect(dialog.getByLabelText("认证方式")).toHaveValue("none");
    expect(dialog.queryByLabelText("请求头名称")).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(/访问令牌/)).not.toBeInTheDocument();
    await user.selectOptions(dialog.getByLabelText("认证方式"), "customHeader");
    expect(dialog.getByLabelText("请求头名称")).toHaveValue("x-api-key");
    expect(
      dialog.queryByRole("link", { name: /申请马上赢/ }),
    ).not.toBeInTheDocument();
  });

  it("allows saving after a failed connection test and keeps the token out of the list", async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.test).mockRejectedValueOnce("401 Unauthorized");
    vi.mocked(mcpApi.list)
      .mockResolvedValueOnce([unconfiguredConnector])
      .mockResolvedValue([connector]);
    render(<McpPage />);
    await user.click(await screen.findByRole("button", { name: "配置令牌" }));
    await user.type(screen.getByLabelText(/访问令牌/), "ldpat-TEST");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "测试连接",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "401 Unauthorized",
    );
    await user.click(screen.getByRole("button", { name: "保存连接器" }));
    await waitFor(() => expect(mcpApi.save).toHaveBeenCalled());
    expect(vi.mocked(mcpApi.save).mock.calls[0][0].token).toBe("ldpat-TEST");
    expect(await screen.findByText("令牌已保存")).toBeInTheDocument();
    expect(screen.queryByText("ldpat-TEST")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "refreshes backups after applying the reviewed files (refresh fails: %s)",
    async (refreshFails) => {
      const user = userEvent.setup();
      const onApplied = vi.fn().mockImplementation(async () => {
        if (refreshFails) throw new Error("读取失败");
      });
      vi.mocked(mcpApi.list).mockResolvedValue([connector]);
      vi.mocked(mcpApi.preview).mockResolvedValue({
        token: "preview-1",
        title: "应用 MCP · 马上赢 X 平台",
        files: [
          {
            path: "/work/project/.mcp.json",
            before: "（文件不存在）",
            after: '{"x-api-key":"••••••••"}',
            fingerprint: "hash",
          },
        ],
        notices: ["Claude Code 首次使用时需要信任连接器。"],
      });
      vi.mocked(mcpApi.apply).mockResolvedValue({
        backupId: "backup-1",
        paths: ["/work/project/.mcp.json"],
        message: "MCP 配置已写入。",
      });
      render(<McpPage onApplied={onApplied} />);
      await user.click(
        await screen.findByRole("button", { name: "应用到 Agent" }),
      );
      expect(screen.getByText(/尚未测试通过/)).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "Claude Code" }));
      await user.click(screen.getByRole("checkbox", { name: /项目级/ }));
      await user.click(screen.getByRole("button", { name: "选择" }));
      await waitFor(() =>
        expect(screen.getByPlaceholderText("选择项目根目录")).toHaveValue(
          "/work/project",
        ),
      );
      await user.click(screen.getByRole("button", { name: "预览变更" }));
      await waitFor(() =>
        expect(mcpApi.preview).toHaveBeenCalledWith(
          "c-1",
          ["claudeProject"],
          "/work/project",
        ),
      );
      expect(mcpApi.apply).not.toHaveBeenCalled();
      expect(onApplied).not.toHaveBeenCalled();
      expect(
        await screen.findByText("/work/project/.mcp.json"),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "确认覆盖应用" }));
      await waitFor(() =>
        expect(mcpApi.apply).toHaveBeenCalledWith("preview-1"),
      );
      await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
      expect(screen.getByText(/MCP 配置已写入/)).toBeInTheDocument();
      if (refreshFails) {
        expect(
          await screen.findByText(/配置已应用，但备份列表刷新失败/),
        ).toBeInTheDocument();
      }
    },
  );

  it("cancels an uncommitted preview", async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.list).mockResolvedValue([connector]);
    vi.mocked(mcpApi.preview).mockResolvedValue({
      token: "preview-2",
      title: "应用 MCP",
      files: [],
      notices: [],
    });
    render(<McpPage />);
    await user.click(
      await screen.findByRole("button", { name: "应用到 Agent" }),
    );
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    await user.click(screen.getByRole("checkbox", { name: /用户全局/ }));
    await user.click(screen.getByRole("button", { name: "预览变更" }));
    await screen.findByText("应用 MCP", { selector: "h2" });
    await user.click(screen.getByRole("button", { name: "关闭弹窗" }));
    expect(mcpApi.cancel).toHaveBeenCalledWith("preview-2");
  });

  it("preserves scope selections across platform tabs and requires a shared project directory", async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.list).mockResolvedValue([connector]);
    vi.mocked(mcpApi.preview).mockResolvedValue({
      token: "scopes",
      title: "应用 MCP",
      files: [],
      notices: [],
    });
    render(<McpPage />);
    await user.click(
      await screen.findByRole("button", { name: "应用到 Agent" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /用户全局/ }));
    const unsupported = screen.getByRole("checkbox", { name: /项目级/ });
    expect(unsupported).toBeDisabled();
    expect(screen.getByText("暂不支持")).toBeInTheDocument();
    await user.click(unsupported);
    expect(unsupported).not.toBeChecked();
    expect(
      screen.queryByPlaceholderText("选择项目根目录"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览变更" })).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: "Codex" }));
    await user.click(screen.getByRole("checkbox", { name: /项目级/ }));
    expect(screen.getByRole("button", { name: "预览变更" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(
      screen.getByRole("checkbox", { name: /用户全局/ }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /项目级/ }));
    await user.click(screen.getByRole("tab", { name: /WorkBuddy/ }));
    expect(screen.getByRole("checkbox", { name: /用户全局/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /项目级/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /项目级/ })).not.toBeChecked();
    await user.type(
      screen.getByPlaceholderText("选择项目根目录"),
      "/work/shared",
    );
    await user.click(screen.getByRole("button", { name: "预览变更" }));
    expect(mcpApi.preview).toHaveBeenCalledWith(
      "c-1",
      ["workbuddy", "codexProject", "claudeProject"],
      "/work/shared",
    );
  });

  it("renders every line of a long preview with confirmation outside the scrolling content", async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.list).mockResolvedValue([connector]);
    const content = Array.from(
      { length: 180 },
      (_, index) => `line ${index}`,
    ).join("\n");
    vi.mocked(mcpApi.preview).mockResolvedValue({
      token: "long",
      title: "应用 MCP",
      files: [
        {
          path: "/home/.workbuddy/mcp.json",
          before: content,
          after: `${content}\nEND-OF-CONFIG`,
          fingerprint: "hash",
        },
      ],
      notices: [],
    });
    render(<McpPage />);
    await user.click(
      await screen.findByRole("button", { name: "应用到 Agent" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /用户全局/ }));
    await user.click(screen.getByRole("button", { name: "预览变更" }));
    const lastLine = await screen.findByText(/END-OF-CONFIG/);
    expect(lastLine).toHaveTextContent("END-OF-CONFIG");
    expect(lastLine.closest(".diff-line")).toHaveClass("diff-line-added");
    expect(
      lastLine.closest("pre")?.querySelectorAll(".diff-line"),
    ).toHaveLength(181);
    expect(
      lastLine.closest("pre")?.querySelectorAll(".diff-line-added"),
    ).toHaveLength(1);
    const confirm = screen.getByRole("button", { name: "确认覆盖应用" });
    expect(confirm.closest(".apply-review-content")).toBeNull();
    expect(lastLine.closest(".apply-review-content")).not.toBeNull();
  });
});
