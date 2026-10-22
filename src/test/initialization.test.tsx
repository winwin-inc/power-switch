import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../App";
import { api } from "../api";
import { newModel, type AppData } from "../types";

vi.mock("../api", () => ({
  isDesktop: false,
  api: { data: vi.fn(), settings: vi.fn(), initialize: vi.fn() },
}));

let persisted: AppData;
beforeEach(() => {
  vi.clearAllMocks();
  persisted = {
    models: [{ ...newModel(), id: "test-model", name: "待清理模型" }],
    settings: {
      theme: "dark",
      workbuddyPath: null,
      claudePath: null,
      codexDir: null,
      autoUpdate: false,
      receiveRc: false,
    },
    backups: [],
    agents: [],
    dataDir: "/test/app",
  };
  vi.mocked(api.data).mockImplementation(async () =>
    structuredClone(persisted),
  );
  vi.mocked(api.initialize)
    .mockReset()
    .mockImplementation(async (options) => {
      if (options.models) persisted.models = [];
    });
});

/** 打开设置并返回用户事件驱动器，所有调用均由内存 mock 承接。 */
async function settings() {
  render(<App />);
  await screen.findByText("待清理模型");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "设置" }));
  return user;
}

it("requires at least one selection and canceling never clears data", async () => {
  const user = await settings();
  const initialize = screen.getByRole("button", { name: "配置初始化" });
  expect(initialize).toBeDisabled();
  const models = screen.getByRole("checkbox", { name: /模型库和模型备份/ });
  await user.click(models);
  expect(initialize).toBeEnabled();
  await user.click(models);
  expect(initialize).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /MCP 连接器配置/ }));
  await user.click(initialize);
  const dialog = within(screen.getByRole("dialog", { name: "确认配置初始化" }));
  expect(dialog.queryByText(/模型库和模型备份：/)).not.toBeInTheDocument();
  await user.click(dialog.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.initialize).not.toHaveBeenCalled();
});

it.each([
  { models: true, mcp: false },
  { models: false, mcp: true },
  { models: true, mcp: true },
])(
  "initializes only the confirmed options $models / $mcp and refreshes data",
  async (options) => {
    const user = await settings();
    if (options.models)
      await user.click(
        screen.getByRole("checkbox", { name: /模型库和模型备份/ }),
      );
    if (options.mcp)
      await user.click(
        screen.getByRole("checkbox", { name: /MCP 连接器配置/ }),
      );
    await user.click(screen.getByRole("button", { name: "配置初始化" }));
    expect(api.initialize).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认初始化" }));
    await screen.findByText("配置初始化完成。");
    expect(api.initialize).toHaveBeenCalledExactlyOnceWith(options);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(persisted.settings.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: /^模型库/ }));
    expect(Boolean(screen.queryByText("待清理模型"))).toBe(!options.models);
  },
);

it("keeps the confirmation open on failure and permits a deliberate retry", async () => {
  const user = await settings();
  vi.mocked(api.initialize).mockRejectedValueOnce(
    new Error("New API 服务端退出失败；本地数据尚未清空，请重试"),
  );
  await user.click(screen.getByRole("checkbox", { name: /模型库和模型备份/ }));
  await user.click(screen.getByRole("button", { name: "配置初始化" }));
  await user.click(screen.getByRole("button", { name: "确认初始化" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "本地数据尚未清空",
  );
  expect(persisted.models).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "确认初始化" }));
  await screen.findByText("配置初始化完成。");
  expect(api.initialize).toHaveBeenCalledTimes(2);
});

it("disables repeat submissions and dismissal while initialization is running", async () => {
  const user = await settings();
  let resolve!: () => void;
  vi.mocked(api.initialize).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await user.click(screen.getByRole("checkbox", { name: /MCP 连接器配置/ }));
  await user.click(screen.getByRole("button", { name: "配置初始化" }));
  await user.click(screen.getByRole("button", { name: "确认初始化" }));
  expect(screen.getByRole("button", { name: "正在初始化…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "正在初始化…" }));
  expect(api.initialize).toHaveBeenCalledTimes(1);
  resolve();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
