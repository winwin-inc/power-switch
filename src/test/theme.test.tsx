import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { api } from "../api";
import type { AppData } from "../types";

vi.mock("../api", () => ({
  isDesktop: false,
  api: { data: vi.fn(), settings: vi.fn(), apply: vi.fn() },
}));

const initialData: AppData = {
  models: [],
  settings: {
    theme: "light",
    workbuddyPath: null,
    claudePath: null,
    codexDir: null,
  },
  agents: [],
  dataDir: "/test/app",
  backups: [],
};
let persistedData: AppData;

beforeEach(() => {
  vi.clearAllMocks();
  persistedData = structuredClone(initialData);
  vi.mocked(api.data).mockImplementation(async () =>
    structuredClone(persistedData),
  );
  vi.mocked(api.settings).mockImplementation(async (settings) => {
    persistedData.settings = structuredClone(settings);
  });
});

/** Open the settings through the same navigation used in the desktop app. */
async function renderSettings() {
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("button", { name: "深色" });
  return { user, ...view };
}

describe("appearance settings", () => {
  it("saves a selected theme immediately and keeps it after navigation", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByRole("button", { name: "深色" }));
    await screen.findByText("主题已保存。");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "浅色" }));
    await screen.findByText("主题已保存。");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "深色" }));
    await screen.findByText("主题已保存。");
    expect(api.settings).toHaveBeenLastCalledWith({
      ...initialData.settings,
      theme: "dark",
    });
    expect(api.apply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^模型库/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the saved appearance across navigation and loads it on the next app mount", async () => {
    vi.mocked(api.settings).mockImplementation(async (settings) => {
      vi.mocked(api.data).mockResolvedValue({
        ...structuredClone(initialData),
        settings: structuredClone(settings),
      });
    });
    const { user, unmount } = await renderSettings();
    await user.click(screen.getByRole("button", { name: "深色" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText("设置已保存。");
    expect(api.settings).toHaveBeenCalledWith({
      ...initialData.settings,
      theme: "dark",
    });
    await user.click(screen.getByRole("button", { name: /^模型库/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    unmount();
    await renderSettings();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("responds to system appearance changes only when following the system", async () => {
    let prefersDark = true;
    const changes = new EventTarget();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      get matches() {
        return prefersDark;
      },
      addEventListener: changes.addEventListener.bind(changes),
      removeEventListener: changes.removeEventListener.bind(changes),
    } as MediaQueryList);
    /** Emit an OS appearance change without replacing the active media query. */
    function changeSystemTheme(dark: boolean) {
      prefersDark = dark;
      act(() => {
        changes.dispatchEvent(new Event("change"));
      });
    }

    const { user } = await renderSettings();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    changeSystemTheme(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    changeSystemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await user.click(screen.getByRole("button", { name: "深色" }));
    changeSystemTheme(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "浅色" }));
    changeSystemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("restores the saved theme when an automatic theme save fails", async () => {
    vi.mocked(api.settings).mockRejectedValueOnce(new Error("设置保存失败"));
    const { user } = await renderSettings();
    await user.click(screen.getByRole("button", { name: "深色" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("设置保存失败");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.queryByText("设置已保存。")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^模型库/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
