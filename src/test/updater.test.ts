import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, installPendingUpdate } from "../updater";

const { invoke, listen, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

describe("native updater boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(unlisten);
  });

  it("checks release metadata without requesting an installation", async () => {
    invoke.mockResolvedValueOnce({ version: "0.1.6-rc.2", notes: null });
    expect(await checkForUpdate()).toEqual({
      version: "0.1.6-rc.2",
      notes: null,
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("check_app_update");
    expect(listen).not.toHaveBeenCalled();
  });

  it("installs only through the explicit command and removes its progress listener", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const onProgress = vi.fn();
    await installPendingUpdate("0.1.6-rc.2", onProgress);
    expect(listen).toHaveBeenCalledWith(
      "app-update-progress",
      expect.any(Function),
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith("install_app_update", {
      version: "0.1.6-rc.2",
    });
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
