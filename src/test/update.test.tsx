import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import App from "../App";
import { newModel } from "../types";

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

describe("sidebar app updates", () => {
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

  it("places software updates after local data in Settings", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));

    const sectionTitles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(sectionTitles.slice(-2)).toEqual(["本地数据", "软件更新"]);
  });

  it("skips startup checks when automatic updates are off but permits a manual check", async () => {
    apiData.mockResolvedValue({
      ...structuredClone(sampleData),
      settings: { ...sampleData.settings, autoUpdate: false },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
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
    fireEvent.click(screen.getByRole("switch", { name: "自动更新" }));
    await waitFor(() => expect(rcSwitch).toBeDisabled());
    expect(rcSwitch).toHaveAttribute("aria-checked", "false");
    expect(apiSettings).toHaveBeenLastCalledWith({
      ...sampleData.settings,
      autoUpdate: false,
      receiveRc: false,
    });
  });
});
