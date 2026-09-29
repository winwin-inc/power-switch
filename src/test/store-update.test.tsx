import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, expect, it, vi } from "vitest";

const { apiData, checkForUpdate, installPendingUpdate } = vi.hoisted(() => ({
  apiData: vi.fn(),
  checkForUpdate: vi.fn(),
  installPendingUpdate: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktop: true,
  api: { data: apiData },
}));
vi.mock("../updater", () => ({
  checkForUpdate,
  installPendingUpdate,
  restartUpdatedApp: vi.fn(),
}));

/** Confirm that the Store build does not offer or trigger GitHub MSI updates. */
it("uses Microsoft Store updates instead of the GitHub updater", async () => {
  vi.stubEnv("VITE_STORE_MSIX", "1");
  apiData.mockResolvedValue({
    models: [],
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
  });
  const { default: App } = await import("../App");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  expect(
    screen.getByText(
      "此版本由 Microsoft Store 管理更新，请在商店中查看新版本。",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "自动更新" })).toBeNull();
  await waitFor(() => expect(apiData).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 1900));
  expect(checkForUpdate).not.toHaveBeenCalled();
  expect(installPendingUpdate).not.toHaveBeenCalled();
});

afterAll(() => vi.unstubAllEnvs());
