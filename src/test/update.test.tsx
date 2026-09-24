import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { newModel } from "../types";

const { checkForUpdate, installPendingUpdate, restartUpdatedApp, apiData } =
  vi.hoisted(() => ({
    checkForUpdate: vi.fn(),
    installPendingUpdate: vi.fn(),
    restartUpdatedApp: vi.fn(),
    apiData: vi.fn(),
  }));

vi.mock("../updater", () => ({
  checkForUpdate,
  installPendingUpdate,
  restartUpdatedApp,
}));

vi.mock("../api", () => ({
  isDesktop: true,
  api: { data: apiData },
}));

const sampleData = {
  models: [{ ...newModel(), id: "model-1", name: "Sample model" }],
  settings: {
    theme: "system",
    workbuddyPath: null,
    claudePath: null,
    codexDir: null,
  },
  agents: [],
  dataDir: "/test/app",
  backups: [],
};

describe("sidebar app updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiData.mockResolvedValue(structuredClone(sampleData));
    checkForUpdate.mockResolvedValue({ version: "0.1.5", notes: null });
    installPendingUpdate.mockImplementation(async (reportProgress) => {
      reportProgress(64);
    });
    restartUpdatedApp.mockResolvedValue(undefined);
  });

  it("announces an available update and offers installation then restart", async () => {
    render(<App />);
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", {
            name: /发现新版本 v0\.1\.5 · 点击更新/,
          }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    const updateButton = screen.getByRole("button", {
      name: /发现新版本 v0\.1\.5 · 点击更新/,
    });

    fireEvent.click(updateButton);
    await waitFor(() =>
      expect(installPendingUpdate).toHaveBeenCalledWith(expect.any(Function)),
    );
    const restartButton = await screen.findByRole("button", {
      name: /更新完成 · 重启应用/,
    });
    fireEvent.click(restartButton);

    await waitFor(() => expect(restartUpdatedApp).toHaveBeenCalledOnce());
  });
});
