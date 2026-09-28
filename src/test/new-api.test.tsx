import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewApiDialog } from "../NewApiDialog";
import { newApi, type NewApiImported, type NewApiStatus } from "../new-api-api";

vi.mock("../api", () => ({ isDesktop: true }));
vi.mock("../new-api-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../new-api-api")>();
  return {
    ...original,
    newApi: {
      check: vi.fn(),
      status: vi.fn(),
      login: vi.fn(),
      cancelLogin: vi.fn(),
      catalog: vi.fn(),
      importModel: vi.fn(),
      test: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

const baseUrl = "https://new-api.banmahui.cn";
const connected: NewApiStatus = {
  baseUrl,
  phase: "connected",
  user: {
    id: 77,
    username: "tester",
    display_name: "测试用户",
    group: "staff",
  },
  loginId: null,
  error: null,
};
const imported: NewApiImported = {
  model: {
    id: "owned-model",
    name: "winwin · auto",
    modelId: "auto",
    protocol: "openai-chat",
    baseUrl: `${baseUrl}/v1`,
    apiKey: "sk-test-not-real",
    supportsToolCall: true,
    supportsImages: false,
    contextWindow: null,
    reasoningLevels: [],
  },
  reused: false,
  message: "模型测试通过并已保存，尚未应用到 Agent。",
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(newApi.check).mockResolvedValue({
    baseUrl,
    version: "v1.0.0-rc.40",
    provider: { name: "Keycloak", slug: "keycloak" },
  });
  vi.mocked(newApi.status).mockResolvedValue(connected);
  vi.mocked(newApi.catalog).mockResolvedValue({
    groups: [{ id: "staff", label: "员工组" }],
    selectedGroup: "staff",
    models: [
      {
        modelId: "chat-model",
        protocols: ["openai-chat", "anthropic-messages"],
      },
      { modelId: "responses-model", protocols: ["openai-responses"] },
      {
        modelId: "auto",
        protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
      },
    ],
  });
  vi.mocked(newApi.importModel).mockResolvedValue(imported);
  vi.mocked(newApi.login).mockResolvedValue("opaque-flow");
  vi.mocked(newApi.cancelLogin).mockResolvedValue();
  vi.mocked(newApi.disconnect).mockResolvedValue();
  vi.mocked(newApi.test).mockResolvedValue("调用已验证。");
});

describe("New API connector", () => {
  it("imports with the displayed identity after native verification and keeps the secret masked", async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn().mockResolvedValue(undefined);
    render(<NewApiDialog onClose={vi.fn()} onAdded={onAdded} />);
    await screen.findByRole("option", { name: "chat-model" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^模型/ })).toHaveValue(
        "auto",
      ),
    );
    expect(screen.getByRole("textbox", { name: "平台名称" })).toHaveValue(
      "winwin",
    );
    expect(screen.getByLabelText(/上下文窗口/)).toHaveValue(1_000_000);
    expect(
      screen.queryByRole("combobox", { name: "分组" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建并添加" }));
    await screen.findByText("模型测试通过并已保存，尚未应用到 Agent。");
    expect(newApi.importModel).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl,
        userId: 77,
        group: "default",
        modelId: "auto",
        name: "winwin · auto",
        protocol: "openai-chat",
        contextWindow: 1_000_000,
        replaceInvalid: false,
        restartUncertain: false,
      }),
    );
    expect(newApi.catalog).toHaveBeenCalledWith(baseUrl, 77, "default");
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "winwin · auto" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("已创建的 API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(newApi.test).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(screen.getByLabelText("已创建的 API Key")).toHaveAttribute(
      "type",
      "text",
    );
    await user.click(screen.getByRole("button", { name: "再次测试" }));
    expect(await screen.findByText("调用已验证。")).toBeInTheDocument();
    expect(newApi.test).toHaveBeenCalledWith("owned-model");
  });

  it("offers Codex candidates even when New API labels them openai", async () => {
    render(
      <NewApiDialog
        onClose={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByRole("option", { name: "chat-model" });
    const client = screen.getByLabelText("目前客户端");
    expect(client.querySelector('option[value="codex"]')).toBeEnabled();
    await userEvent.selectOptions(client, "codex");
    expect(
      screen.getByRole("option", { name: "responses-model" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "auto" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^模型/ })).toHaveValue("auto");
    expect(
      screen.queryByRole("option", { name: "chat-model" }),
    ).not.toBeInTheDocument();
  });

  it("lets an uncertain creation reconcile before the user explicitly opts into a new attempt", async () => {
    vi.mocked(newApi.importModel).mockRejectedValue({
      code: "creation_uncertain",
      message: "创建结果待确认",
    });
    const user = userEvent.setup();
    render(
      <NewApiDialog
        onClose={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByRole("option", { name: "chat-model" });
    await user.click(screen.getByRole("button", { name: "创建并添加" }));
    await screen.findByText("创建结果待确认");
    await user.click(screen.getByRole("button", { name: "重新检查并继续" }));
    await screen.findByText("创建结果待确认");
    expect(newApi.importModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ restartUncertain: false }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "我已核对 New API 令牌列表，允许新建一把密钥",
      }),
    );
    await user.click(screen.getByRole("button", { name: "创建并添加" }));
    await waitFor(() =>
      expect(newApi.importModel).toHaveBeenLastCalledWith(
        expect.objectContaining({ restartUncertain: true }),
      ),
    );
  });

  it("cancels its pending native login when the dialog closes", async () => {
    vi.mocked(newApi.status)
      .mockResolvedValueOnce({
        ...connected,
        phase: "disconnected",
        user: null,
      })
      .mockResolvedValue({
        ...connected,
        phase: "pending",
        user: null,
        loginId: "opaque-flow",
      });
    const user = userEvent.setup();
    const view = render(
      <NewApiDialog
        onClose={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "钉钉 / Keycloak 登录",
    });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByText("等待钉钉授权");
    view.unmount();
    expect(newApi.cancelLogin).toHaveBeenCalledWith("opaque-flow");
  });

  it("disconnects the selected account without issuing model or token deletion", async () => {
    const user = userEvent.setup();
    render(
      <NewApiDialog
        onClose={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByRole("option", { name: "chat-model" });
    await user.click(screen.getByRole("button", { name: "断开 New API 连接" }));
    await screen.findByText("连接你的 New API 账号");
    expect(newApi.disconnect).toHaveBeenCalledWith(baseUrl);
    expect(newApi.importModel).not.toHaveBeenCalled();
  });

  it("shows unsupported OAuth contract errors without offering login or creating anything", async () => {
    vi.mocked(newApi.check).mockRejectedValue({
      code: "oauth_contract",
      message: "当前实例缺少可用的 OAuth 配置",
    });
    render(
      <NewApiDialog
        onClose={vi.fn()}
        onAdded={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前实例缺少可用的 OAuth 配置",
    );
    expect(
      screen.getByRole("button", { name: "钉钉 / Keycloak 登录" }),
    ).toBeDisabled();
    expect(newApi.login).not.toHaveBeenCalled();
    expect(newApi.importModel).not.toHaveBeenCalled();
  });
});
