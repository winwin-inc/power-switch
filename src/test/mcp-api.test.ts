import { expect, it, vi } from "vitest";
import capability from "../../src-tauri/capabilities/default.json";
import { internalMcpPatUrl, mcpApi, mcpPatUrl } from "../mcp-api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../api", () => ({ isDesktop: true }));

// Guard both the command and its capability scope: a valid link alone cannot open on desktop.
it("opens the exact PAT URL using the native command permitted by the desktop capability", async () => {
  invoke.mockResolvedValueOnce(undefined);
  await mcpApi.openPatPage();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin:opener|open_url", {
    url: "https://x.brandct.com/generalSettings/personalAccessTokens",
  });
  expect(capability.permissions).toContainEqual({
    identifier: "opener:allow-open-url",
    allow: [{ url: mcpPatUrl }, { url: internalMcpPatUrl }],
  });
  await mcpApi.openPatPage(internalMcpPatUrl);
  expect(invoke).toHaveBeenLastCalledWith("plugin:opener|open_url", {
    url: "https://lightdash.banmahui.cn/generalSettings/personalAccessTokens",
  });
});
