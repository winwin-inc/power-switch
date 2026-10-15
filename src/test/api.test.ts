import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

beforeEach(() => invoke.mockReset());

// False must reach native IPC explicitly; omission delegates to the backend default rule.
it.each([true, false, undefined])(
  "passes Claude 1M override %s to native preview",
  async (claude1m) => {
    await api.preview("model-id", ["claude"], false, claude1m);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("preview_apply", {
      id: "model-id",
      agents: ["claude"],
      selectWorkbuddyModel: false,
      claude1m,
    });
  },
);
