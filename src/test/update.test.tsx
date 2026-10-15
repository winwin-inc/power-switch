import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import App from "../App";
import { newModel } from "../types";
import { openAboutLink } from "../about-api";

vi.mock("../about-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../about-api")>()),
  openAboutLink: vi.fn(),
}));

const {
  checkForUpdate,
  installPendingUpdate,
  restartUpdatedApp,
  apiData,
  apiSettings,
} = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installPendingUpdate: vi.fn(),
  restartUpdatedApp: vi.fn(),
  apiData: vi.fn(),
  apiSettings: vi.fn(),
}));

vi.mock("../updater", () => ({
  checkForUpdate,
  installPendingUpdate,
  restartUpdatedApp,
}));

vi.mock("../api", () => ({
  isDesktop: true,
  api: { data: apiData, settings: apiSettings },
}));

const sampleData = {
  models: [{ ...newModel(), id: "model-1", name: "Sample model" }],
  settings: {
    theme: "system",
    workbuddyPath: null,
    claudePath: null,
    codexDir: null,
    autoUpdate: true,
    receiveRc: false,
  },
  agents: [],
  dataDir: "/test/app",
  backups: [],
};

describe("About and sidebar app updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiData.mockResolvedValue(structuredClone(sampleData));
    apiSettings.mockResolvedValue(undefined);
    checkForUpdate.mockResolvedValue({
      version: "0.1.7",
      notes: "This release note must not appear in the confirmation.",
    });
    installPendingUpdate.mockImplementation(
      async (_version, reportProgress) => {
        reportProgress(64);
      },
    );
    restartUpdatedApp.mockResolvedValue(undefined);
    vi.mocked(openAboutLink).mockReset().mockResolvedValue();
  });

  it("shows a green version icon, confirms only the versions, and installs on confirmation", async () => {
    render(<App />);
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", {
            name: /发现新版本 v0\.1\.7，查看更新/,
          }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    const updateIcon = screen.getByRole("button", {
      name: /发现新版本 v0\.1\.7，查看更新/,
    });
    expect(updateIcon).toHaveClass("version-update-trigger");
    fireEvent.click(updateIcon);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      `当前版本 v${packageJson.version}，可以升级为 v0.1.7`,
    );
    expect(dialog).not.toHaveTextContent("release note");
    fireEvent.click(screen.getByRole("button", { name: "暂不更新" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(installPendingUpdate).not.toHaveBeenCalled();

    fireEvent.click(updateIcon);
    fireEvent.click(await screen.findByRole("button", { name: "确认更新" }));
    await waitFor(() =>
      expect(installPendingUpdate).toHaveBeenCalledWith(
        "0.1.7",
        expect.any(Function),
      ),
    );
    const restartButton = await screen.findByRole("button", {
      name: /更新完成，重启应用/,
    });
    fireEvent.click(restartButton);

    await waitFor(() => expect(restartUpdatedApp).toHaveBeenCalledOnce());
  });

  it("shows no update action beside the version when the latest check finds nothing", async () => {
    checkForUpdate.mockResolvedValueOnce(null);
    const { container } = render(<App />);

    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce(), {
      timeout: 3000,
    });

    expect(container.querySelector(".version-update-trigger")).toBeNull();
    expect(container.querySelector(".update-control")).toBeNull();
    expect(screen.queryByText("检查更新")).not.toBeInTheDocument();
  });

  it("shows manual update results in the fixed global tip", async () => {
    checkForUpdate.mockResolvedValue(null);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    const message = await screen.findByText("当前更新通道已是最新版本。");
    const notice = message.closest('[role="status"]');
    expect(notice).toHaveTextContent("当前更新通道已是最新版本。");
    expect(notice?.parentElement).toHaveClass("app-shell");
  });

  it("combines software updates and app identity in About", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));

    const sectionTitles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(sectionTitles).toEqual(["外观", "Agent 配置位置", "本地数据"]);
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("关于");
    expect(
      within(screen.getByRole("region", { name: "power-switch" })).getByText(
        `v${packageJson.version}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["power-switch"]);
    expect(screen.getByRole("button", { name: "关于" })).toHaveClass("active");
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(
      Array.from(navigation.querySelectorAll("button"))
        .slice(-2)
        .map((button) => button.textContent),
    ).toEqual(["设置", "关于"]);
  });

  it("skips startup checks when automatic updates are off but permits a manual check", async () => {
    apiData.mockResolvedValue({
      ...structuredClone(sampleData),
      settings: { ...sampleData.settings, autoUpdate: false },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    expect(screen.getByRole("switch", { name: "测试计划" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 1900));
    expect(checkForUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
    expect(installPendingUpdate).not.toHaveBeenCalled();
  });

  it("saves RC opt-in only while automatic checks are enabled", async () => {
    let saved = structuredClone(sampleData);
    apiData.mockImplementation(async () => structuredClone(saved));
    apiSettings.mockImplementation(async (settings) => {
      saved = { ...saved, settings: structuredClone(settings) };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    const rcSwitch = screen.getByRole("switch", { name: "测试计划" });
    expect(rcSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(rcSwitch);
    await waitFor(() =>
      expect(rcSwitch).toHaveAttribute("aria-checked", "true"),
    );
    expect(apiSettings).toHaveBeenLastCalledWith({
      ...sampleData.settings,
      receiveRc: true,
    });
    fireEvent.click(screen.getByRole("switch", { name: "启动时检查更新" }));
    await waitFor(() => expect(rcSwitch).toBeDisabled());
    expect(rcSwitch).toHaveAttribute("aria-checked", "false");
    expect(apiSettings).toHaveBeenLastCalledWith({
      ...sampleData.settings,
      autoUpdate: false,
      receiveRc: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText("设置已保存。");
    expect(apiSettings).toHaveBeenLastCalledWith({
      ...sampleData.settings,
      autoUpdate: false,
      receiveRc: false,
    });
  });

  it("preserves checks and downloads across page changes and installs only after confirmation", async () => {
    apiData.mockResolvedValue({
      ...structuredClone(sampleData),
      settings: { ...sampleData.settings, autoUpdate: false },
    });
    let resolveCheck!: (value: { version: string; notes: null }) => void;
    let finishInstall!: () => void;
    let progress!: (percentage: number) => void;
    checkForUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    installPendingUpdate.mockImplementation((_version, reportProgress) => {
      progress = reportProgress;
      return new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(screen.getByRole("button", { name: "正在检查" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(screen.getByRole("button", { name: "正在检查" })).toBeDisabled();
    expect(checkForUpdate).toHaveBeenCalledOnce();
    await act(async () => resolveCheck({ version: "0.1.10", notes: null }));
    fireEvent.click(
      screen.getByRole("button", { name: "发现 v0.1.10，查看更新" }),
    );
    expect(installPendingUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    act(() => progress(42));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(
      screen.getByRole("status", { name: "正在下载更新 42%" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "启动时检查更新" }),
    ).toBeDisabled();
    expect(installPendingUpdate).toHaveBeenCalledExactlyOnceWith(
      "0.1.10",
      expect.any(Function),
    );
    await act(async () => finishInstall());
    expect(
      screen.getByRole("button", { name: "更新完成，重启应用" }),
    ).toBeInTheDocument();
  });

  it("opens the selected project link in the system browser and reports failures globally", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    fireEvent.click(screen.getByRole("link", { name: "GitHub" }));
    expect(openAboutLink).toHaveBeenCalledWith("github");
    vi.mocked(openAboutLink).mockRejectedValueOnce(new Error("浏览器不可用"));
    fireEvent.click(screen.getByRole("link", { name: "更新日志" }));
    expect(openAboutLink).toHaveBeenLastCalledWith("changelog");
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("无法打开链接：Error: 浏览器不可用");
    expect(message.parentElement).toHaveClass("app-shell");
  });

  it("keeps failed update checks visible in About and allows a retry", async () => {
    apiData.mockResolvedValue({
      ...structuredClone(sampleData),
      settings: { ...sampleData.settings, autoUpdate: false },
    });
    checkForUpdate.mockRejectedValueOnce(new Error("更新服务暂不可用"));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "关于" }));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.getByText("Error: 更新服务暂不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByRole("button", { name: "发现 v0.1.7，查看更新" });
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
